import { missingForFetch, missingForSend, type Config } from "./config";
import type { FinalStatus, Store } from "./db";
import type { GLRecord } from "./fields";
import { classify } from "./filter";
import { GiveLivelyError, fetchRecords } from "./giveLively";
import { toMetaEvent, type MetaEvent } from "./map";
import { sendEvents } from "./meta";

/** Meta accepts up to 1000 events per request. Stay well below. */
export const MAX_BATCH = 500;
/** When a batch is rejected, events are retried one by one, up to this many per run. */
export const MAX_SINGLE_SENDS = 25;
/** A single event rejected this many runs in a row (with nothing else succeeding) is given up on. */
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
  decision: "would_send" | "would_skip" | "already_done";
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
  fetched: number;
  matched: number;
  already_done: number;
  sent: number;
  skipped: number;
  rejected: number;
  failed: number;
  deferred: number;
  filtered: Record<string, number>;
  cursor_advanced: boolean;
  preview?: PreviewRow[];
}

const iso = (ms: number) => new Date(ms).toISOString();

type Candidate = { id: string; value: number | null } & (
  | { ok: true; event: MetaEvent }
  | { ok: false; reason: string }
);

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

    const records: GLRecord[] = await fetchRecords(cfg, windowStart, deps.fetch);
    s.fetched = records.length;

    // Filter and map. The feed can repeat a record, so keep the first copy of each ID.
    const candidates = new Map<string, Candidate>();
    for (const record of records) {
      const c = classify(record, cfg);
      if (!c.ok) {
        s.filtered[c.reason] = (s.filtered[c.reason] ?? 0) + 1;
        continue;
      }
      s.matched++;
      const m = await toMetaEvent(record, cfg, startMs);
      if (!m.ok && !m.id) {
        s.filtered[m.reason] = (s.filtered[m.reason] ?? 0) + 1;
        deps.log("unmappable_record", { reason: m.reason });
        continue;
      }
      const id = m.id!;
      if (candidates.has(id)) continue;
      candidates.set(
        id,
        m.ok
          ? { id, value: m.value, ok: true, event: m.event }
          : { id, value: null, ok: false, reason: m.reason },
      );
    }

    const done = await deps.store.getFinalIds([...candidates.keys()]);
    s.already_done = done.size;
    const fresh = [...candidates.values()].filter((c) => !done.has(c.id));
    const toSkip = fresh.filter((c): c is Candidate & { ok: false } => !c.ok);
    const toSend = fresh.filter((c): c is Candidate & { ok: true } => c.ok);

    if (opts.dryRun) {
      s.preview = [...candidates.values()].map((c) => {
        if (done.has(c.id)) return { event_id: c.id, decision: "already_done" };
        if (!c.ok) return { event_id: c.id, decision: "would_skip", reason: c.reason };
        return {
          event_id: c.id,
          decision: "would_send",
          value: c.event.custom_data.value,
          event_time: iso(c.event.event_time * 1000),
          num_items: c.event.custom_data.num_items,
        };
      });
      s.skipped = toSkip.length;
      return await finish(false);
    }

    const nowIso = iso(startMs);
    const finals: { event_id: string; status: FinalStatus; value: number | null; reason: string | null }[] =
      toSkip.map((c) => ({ event_id: c.id, status: "skipped", value: c.value, reason: c.reason }));
    s.skipped = toSkip.length;
    for (const c of toSkip) deps.log("skipped_record", { event_id: c.id, reason: c.reason });

    const batch = toSend.slice(0, MAX_BATCH);
    s.deferred = toSend.length - batch.length;
    let pending = 0;

    if (batch.length) {
      const res = await sendEvents(cfg, batch.map((c) => c.event), deps.fetch);
      if (res.ok) {
        for (const c of batch) finals.push({ event_id: c.id, status: "sent", value: c.value, reason: null });
        s.sent = batch.length;
      } else if (res.retryable) {
        pending = batch.length;
        s.failed = batch.length;
        s.error = `Meta HTTP ${res.status}: ${res.message}`;
      } else {
        // One or more events were invalid. Retry individually to find which.
        s.error = `Meta HTTP ${res.status}: ${res.message}`;
        const singles = batch.length === 1 ? [] : batch.slice(0, MAX_SINGLE_SENDS);
        const bad: { c: Candidate & { ok: true }; message: string }[] =
          batch.length === 1 ? [{ c: batch[0]!, message: res.message }] : [];
        let stoppedAt = singles.length;
        for (let i = 0; i < singles.length; i++) {
          const c = singles[i]!;
          const r = await sendEvents(cfg, [c.event], deps.fetch);
          if (r.ok) {
            finals.push({ event_id: c.id, status: "sent", value: c.value, reason: null });
            s.sent++;
          } else if (r.retryable) {
            stoppedAt = i;
            s.error = `Meta HTTP ${r.status}: ${r.message}`;
            break;
          } else {
            bad.push({ c, message: r.message });
          }
        }
        const untried = batch.length === 1 ? 0 : batch.length - stoppedAt;
        pending += untried;
        s.failed += untried;

        if (s.sent > 0) {
          // Other events went through, so the configuration is fine and these are bad data.
          for (const b of bad) {
            finals.push({ event_id: b.c.id, status: "rejected", value: b.c.value, reason: b.message.slice(0, 200) });
            s.rejected++;
          }
        } else if (bad.length) {
          // Nothing succeeded: could be configuration. Count attempts before giving up.
          const attempts = await deps.store.recordFailures(
            bad.map((b) => ({ event_id: b.c.id, value: b.c.value, reason: b.message.slice(0, 200) })),
            nowIso,
          );
          for (const b of bad) {
            if ((attempts.get(b.c.id) ?? 0) >= MAX_ATTEMPTS) {
              finals.push({ event_id: b.c.id, status: "rejected", value: b.c.value, reason: b.message.slice(0, 200) });
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
