import { missingForFetch, missingForSend, type Config } from "./config";
import type { FinalRow, Store } from "./db";
import { FIELDS, pickAmount, pickText, type GLRecord } from "./fields";
import { classify, valueFields, type Kind } from "./filter";
import { GiveLivelyError, fetchRecords } from "./giveLively";
import { toMetaEvent, type MetaEvent } from "./map";
import { sendEvents } from "./meta";

/** Meta accepts up to 1000 events per request. Stay well below. */
export const MAX_BATCH = 500;
/** When a batch is rejected, events are retried one by one, up to this many per run. */
export const MAX_SINGLE_SENDS = 25;
/** An event rejected this many runs in a row (with nothing else succeeding) is given up on. */
export const MAX_ATTEMPTS = 5;
const LOCK_TTL_MS = 2 * 60 * 1000;

export interface Deps {
  store: Store;
  fetch: typeof fetch;
  now: () => number;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export interface RunOptions {
  trigger: "cron" | "manual";
  dryRun: boolean;
}

export interface PreviewRow {
  event_id: string;
  line_item_ids: string[];
  decision: "would_send" | "would_skip";
  event_name?: MetaEvent["event_name"];
  reason?: string;
  value?: number;
  event_time?: string;
  num_items?: number;
}

export interface RunSummary {
  started_at: string;
  finished_at?: string;
  trigger: RunOptions["trigger"];
  mode: "live" | "test_events" | "dry_run";
  result: "ok" | "partial" | "error" | "disabled" | "locked" | "config_missing";
  error?: string;
  window_start?: string;
  /** Line items in the feed window. */
  fetched: number;
  /** Line items that passed the filter. */
  matched: number;
  /** Matched line items already handled in an earlier run. */
  already_done: number;
  /** Meta events (one per order) sent, skipped, rejected or failed this run. */
  sent: number;
  skipped: number;
  rejected: number;
  failed: number;
  deferred: number;
  /** Line items that did not pass the filter, by reason. */
  filtered: Record<string, number>;
  cursor_advanced: boolean;
  preview?: PreviewRow[];
}

const iso = (ms: number) => new Date(ms).toISOString();

interface Line {
  id: string;
  record: GLRecord;
  value: number | null;
}

/** The new line items of one order and kind. They become one Meta event. */
interface Group {
  orderId: string | null;
  kind: Kind;
  lines: Line[];
  eventId: string;
  result?: Awaited<ReturnType<typeof toMetaEvent>>;
}

export async function runPoll(cfg: Config, deps: Deps, opts: RunOptions): Promise<RunSummary> {
  const startMs = deps.now();
  const s: RunSummary = {
    started_at: iso(startMs),
    trigger: opts.trigger,
    mode: opts.dryRun ? "dry_run" : cfg.metaTestEventCode ? "test_events" : "live",
    result: "ok",
    fetched: 0,
    matched: 0,
    already_done: 0,
    sent: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
    deferred: 0,
    filtered: {},
    cursor_advanced: false,
  };
  const finish = async (save: boolean) => {
    s.finished_at = iso(deps.now());
    if (save) await deps.store.setState({ last_run: JSON.stringify(s) });
    const { preview: _omit, ...logged } = s;
    deps.log("poll", logged);
    return s;
  };
  const bump = (reason: string) => (s.filtered[reason] = (s.filtered[reason] ?? 0) + 1);

  await deps.store.init();

  if (!opts.dryRun && !cfg.sendEnabled) {
    s.result = "disabled";
    return finish(true);
  }

  const missing = opts.dryRun ? missingForFetch(cfg) : missingForSend(cfg);
  if (missing.length) {
    s.result = "config_missing";
    s.error = `Missing settings: ${missing.join(", ")}`;
    return finish(!opts.dryRun);
  }

  const owner = crypto.randomUUID();
  if (!opts.dryRun && !(await deps.store.acquireLock(owner, startMs, LOCK_TTL_MS))) {
    s.result = "locked";
    return finish(false);
  }

  try {
    const cursor = Number(await deps.store.getState("cursor_ms"));
    const windowStart =
      cursor > 0 ? cursor - cfg.overlapMs : startMs - cfg.backfillHours * 3600 * 1000;
    s.window_start = iso(windowStart);

    const records = await fetchRecords(cfg, windowStart, deps.fetch);
    s.fetched = records.length;

    // 1. Filter line items. The feed can repeat a record, so keep the first copy of each.
    const matched = new Map<string, { line: Line; kind: Kind; orderId: string | null }>();
    for (const record of records) {
      const c = classify(record, cfg);
      if (!c.ok) {
        bump(c.reason);
        continue;
      }
      const id = pickText(record, FIELDS.lineId);
      if (!id) {
        bump("no_line_item_id");
        continue;
      }
      if (matched.has(id)) continue;
      s.matched++;
      matched.set(id, {
        line: { id, record, value: pickAmount(record, valueFields(cfg)) ?? null },
        kind: c.kind,
        orderId: pickText(record, FIELDS.orderId) ?? null,
      });
    }

    // 2. Drop line items handled in an earlier run.
    const done = await deps.store.getFinalIds([...matched.keys()]);
    s.already_done = done.size;

    // 3. Group the rest by order, so a 4-ticket order is one Purchase worth all 4.
    const groups = new Map<string, Group>();
    for (const m of matched.values()) {
      if (done.has(m.line.id)) continue;
      const key = `${m.kind}:${m.orderId ?? m.line.id}`;
      const g = groups.get(key);
      if (g) g.lines.push(m.line);
      else groups.set(key, { orderId: m.orderId, kind: m.kind, lines: [m.line], eventId: "" });
    }

    // The Meta event_id is the order ID. If part of the order was already sent in
    // an earlier run, use a distinct ID so Meta doesn't drop the rest as a duplicate.
    const orderIds = [...groups.values()].map((g) => g.orderId).filter((o): o is string => !!o);
    const partlySent = await deps.store.getSentOrderIds([...new Set(orderIds)]);
    for (const g of groups.values()) {
      g.lines.sort((a, b) => a.id.localeCompare(b.id));
      const base = g.orderId ?? g.lines[0]!.id;
      g.eventId = g.orderId && partlySent.has(g.orderId) ? `${base}:${g.lines[0]!.id}` : base;
      g.result = await toMetaEvent(g.lines.map((l) => l.record), g.kind, g.eventId, cfg, startMs);
    }

    const all = [...groups.values()];
    const toSkip = all.filter((g) => !g.result!.ok);
    const toSend = all.filter((g) => g.result!.ok);
    const eventOf = (g: Group) => (g.result as { ok: true; event: MetaEvent }).event;
    const reasonOf = (g: Group) => (g.result as { ok: false; reason: string }).reason;

    if (opts.dryRun) {
      s.preview = all.map((g) =>
        g.result!.ok
          ? {
              event_id: g.eventId,
              line_item_ids: g.lines.map((l) => l.id),
              decision: "would_send",
              event_name: eventOf(g).event_name,
              value: eventOf(g).custom_data.value,
              event_time: iso(eventOf(g).event_time * 1000),
              num_items: eventOf(g).custom_data.num_items,
            }
          : {
              event_id: g.eventId,
              line_item_ids: g.lines.map((l) => l.id),
              decision: "would_skip",
              reason: reasonOf(g),
            },
      );
      s.skipped = toSkip.length;
      return await finish(false);
    }

    const nowIso = iso(startMs);
    const finals: FinalRow[] = [];
    const finalize = (g: Group, status: FinalRow["status"], reason: string | null) => {
      for (const l of g.lines) {
        finals.push({ event_id: l.id, order_id: g.orderId, status, value: l.value, reason });
      }
    };

    for (const g of toSkip) {
      finalize(g, "skipped", reasonOf(g));
      deps.log("skipped_order", { event_id: g.eventId, reason: reasonOf(g) });
    }
    s.skipped = toSkip.length;

    const batch = toSend.slice(0, MAX_BATCH);
    s.deferred = toSend.length - batch.length;
    let pending = 0;

    if (batch.length) {
      const res = await sendEvents(cfg, batch.map(eventOf), deps.fetch);
      if (res.ok) {
        for (const g of batch) finalize(g, "sent", null);
        s.sent = batch.length;
      } else if (res.retryable) {
        pending = batch.length;
        s.failed = batch.length;
        s.error = `Meta HTTP ${res.status}: ${res.message}`;
      } else {
        // One or more events were invalid. Retry individually to find which.
        s.error = `Meta HTTP ${res.status}: ${res.message}`;
        const singles = batch.length === 1 ? [] : batch.slice(0, MAX_SINGLE_SENDS);
        const bad: { g: Group; message: string }[] =
          batch.length === 1 ? [{ g: batch[0]!, message: res.message }] : [];
        let stoppedAt = singles.length;
        for (let i = 0; i < singles.length; i++) {
          const g = singles[i]!;
          const r = await sendEvents(cfg, [eventOf(g)], deps.fetch);
          if (r.ok) {
            finalize(g, "sent", null);
            s.sent++;
          } else if (r.retryable) {
            stoppedAt = i;
            s.error = `Meta HTTP ${r.status}: ${r.message}`;
            break;
          } else {
            bad.push({ g, message: r.message });
          }
        }
        const untried = batch.length === 1 ? 0 : batch.length - stoppedAt;
        pending += untried;
        s.failed += untried;

        if (s.sent > 0) {
          // Other events went through, so the configuration is fine and these are bad data.
          for (const b of bad) {
            finalize(b.g, "rejected", b.message.slice(0, 200));
            s.rejected++;
          }
        } else if (bad.length) {
          // Nothing succeeded: could be configuration. Count attempts before giving up.
          const attempts = await deps.store.recordFailures(
            bad.flatMap((b) =>
              b.g.lines.map((l) => ({ event_id: l.id, value: l.value, reason: b.message.slice(0, 200) })),
            ),
            nowIso,
          );
          for (const b of bad) {
            const n = Math.max(...b.g.lines.map((l) => attempts.get(l.id) ?? 0));
            if (n >= MAX_ATTEMPTS) {
              finalize(b.g, "rejected", b.message.slice(0, 200));
              s.rejected++;
            } else {
              pending++;
              s.failed++;
            }
          }
        }
      }
    }

    await deps.store.recordFinal(finals, nowIso);

    if (pending === 0 && s.deferred === 0) {
      await deps.store.setState({ cursor_ms: String(startMs) });
      s.cursor_advanced = true;
    }
    if (s.error) s.result = s.sent > 0 ? "partial" : "error";
    else if (s.deferred > 0) s.result = "partial";
  } catch (e) {
    s.result = "error";
    s.error = e instanceof GiveLivelyError ? e.message : "Unexpected error";
    if (!(e instanceof GiveLivelyError)) {
      // Runtime/D1 error messages describe code, not record values.
      deps.log("unexpected_error", {
        name: e instanceof Error ? e.name : typeof e,
        message: e instanceof Error ? e.message.slice(0, 300) : undefined,
      });
    }
  } finally {
    if (!opts.dryRun) await deps.store.releaseLock(owner);
  }
  return finish(!opts.dryRun);
}
