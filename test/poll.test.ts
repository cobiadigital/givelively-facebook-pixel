import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, runPoll, type Deps } from "../src/poll";
import { MemoryStore, NOW, config, donation, fakeFetch, ticket } from "./helpers";
import type { GLRecord } from "../src/fields";

function setup(records: GLRecord[] | (() => Response), meta?: (body: any) => Response) {
  const store = new MemoryStore();
  const f = fakeFetch(records, meta);
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  let now = NOW;
  const deps: Deps = { store, fetch: f.fn, now: () => now, log: (event, data) => logs.push({ event, data }) };
  return { store, f, logs, deps, tick: (ms: number) => (now += ms) };
}

const run = (deps: Deps, cfg = config(), dryRun = false) => runPoll(cfg, deps, { trigger: "cron", dryRun });

const metaError = (status: number, error: Record<string, unknown>) => () =>
  Response.json({ error }, { status });

/** A ticket in its own order. */
const t = (n: number, over: GLRecord = {}) => ticket({ line_item_id: `li-${n}`, order_id: `order-${n}`, ...over });

const sentIds = (f: ReturnType<typeof fakeFetch>) =>
  f.metaCalls().flatMap((c) => c.body.data.map((e: any) => e.event_id));

describe("runPoll", () => {
  it("sends only ticket sales for the event, in one batch", async () => {
    const x = setup([t(1), donation(), t(2, { page_name: "Gala", internal_name: "Gala", event_name: "Gala", page_slug: "gala", page_url: "" })]);
    const s = await run(x.deps);
    expect(s).toMatchObject({ result: "ok", fetched: 3, matched: 1, sent: 1, cursor_advanced: true });
    expect(s.filtered).toEqual({ donation_not_tracked: 1, other_page: 1 });
    expect(x.f.metaCalls()).toHaveLength(1);
    expect(sentIds(x.f)).toEqual(["order-1"]);
    expect(x.store.rows.get("li-1")).toMatchObject({ status: "sent", order_id: "order-1", value: 110 });
  });

  it("sends one Purchase per order, worth all its tickets", async () => {
    const x = setup([
      t(1, { order_id: "order-A" }),
      t(2, { order_id: "order-A" }),
      t(3, { order_id: "order-B" }),
    ]);
    const s = await run(x.deps);
    expect(s).toMatchObject({ matched: 3, sent: 2 });
    const events = x.f.metaCalls()[0]!.body.data;
    expect(events.map((e: any) => [e.event_id, e.custom_data.value, e.custom_data.num_items])).toEqual([
      ["order-A", 220, 2],
      ["order-B", 110, 1],
    ]);
    expect(x.store.rows.get("li-2")?.status).toBe("sent");
  });

  it("sends late tickets of an already-sent order under a distinct event_id", async () => {
    const records = [t(1, { order_id: "order-A" })];
    const x = setup(() => Response.json(records));
    await run(x.deps);
    records.push(t(2, { order_id: "order-A" }));
    x.tick(300_000);
    const s = await run(x.deps);
    expect(s).toMatchObject({ sent: 1, already_done: 1 });
    expect(sentIds(x.f)).toEqual(["order-A", "order-A:li-2"]);
  });

  it("sends donations as Donate when TRACK includes them", async () => {
    const x = setup([t(1), donation()]);
    await run(x.deps, config({ track: ["ticket", "donation"] }));
    const names = x.f.metaCalls()[0]!.body.data.map((e: any) => e.event_name);
    expect(names).toEqual(["Purchase", "Donate"]);
  });

  it("never sends the same line item twice", async () => {
    const x = setup([t(1), t(1)]); // feed repeats the record
    await run(x.deps);
    x.tick(5 * 60_000);
    const second = await run(x.deps);
    expect(second).toMatchObject({ sent: 0, already_done: 1 });
    expect(x.f.metaCalls()).toHaveLength(1);
    expect(x.f.metaCalls()[0]!.body.data).toHaveLength(1);
  });

  it("starts from now minus BACKFILL_HOURS, then cursor minus overlap", async () => {
    const x = setup([]);
    await run(x.deps, config({ backfillHours: 2 }));
    expect(Number(new URL(x.f.calls[0]!.url).searchParams.get("start_time_ms"))).toBe(NOW - 2 * 3600_000);
    x.tick(300_000);
    await run(x.deps);
    expect(Number(new URL(x.f.calls[1]!.url).searchParams.get("start_time_ms"))).toBe(NOW - 600_000);
  });

  it("does not advance the cursor or mark sent when Meta fails (retryable)", async () => {
    const x = setup([t(1)], metaError(500, { message: "oops", code: 2 }));
    const s = await run(x.deps);
    expect(s).toMatchObject({ result: "error", sent: 0, failed: 1, cursor_advanced: false });
    expect(x.store.state.get("cursor_ms")).toBeUndefined();
    expect(x.store.rows.size).toBe(0);
  });

  it("treats a bad token as retryable, never rejecting events", async () => {
    const x = setup([t(1), t(2)], metaError(400, { message: "Invalid OAuth access token", code: 190 }));
    const s = await run(x.deps);
    expect(s).toMatchObject({ result: "error", rejected: 0, failed: 2 });
    expect(x.f.metaCalls()).toHaveLength(1); // no one-by-one retries
  });

  it("on a rejected batch, retries one by one and records accepted orders only", async () => {
    const x = setup([t(1), t(2)], (body) =>
      body.data.some((e: any) => e.event_id === "order-2")
        ? Response.json({ error: { message: "Invalid parameter", code: 100 } }, { status: 400 })
        : Response.json({ events_received: body.data.length }),
    );
    const s = await run(x.deps);
    expect(s).toMatchObject({ result: "partial", sent: 1, rejected: 1, cursor_advanced: true });
    expect(x.store.rows.get("li-1")?.status).toBe("sent");
    expect(x.store.rows.get("li-2")?.status).toBe("rejected");
    expect(x.f.metaCalls()).toHaveLength(3);
  });

  it("gives up on a lone invalid event only after several runs", async () => {
    const x = setup([t(1)], metaError(400, { message: "Invalid parameter", code: 100 }));
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const s = await run(x.deps);
      expect(s).toMatchObject({ failed: 1, rejected: 0, cursor_advanced: false });
      x.tick(300_000);
    }
    const last = await run(x.deps);
    expect(last).toMatchObject({ rejected: 1, cursor_advanced: true });
    expect(x.store.rows.get("li-1")?.status).toBe("rejected");
  });

  it("marks unmappable orders as skipped, once", async () => {
    const x = setup([t(1, { email: null })]);
    const s = await run(x.deps);
    expect(s).toMatchObject({ skipped: 1, sent: 0 });
    expect(x.store.rows.get("li-1")).toMatchObject({ status: "skipped", reason: "no_email" });
    expect(x.f.metaCalls()).toHaveLength(0);
    expect(await run(x.deps)).toMatchObject({ skipped: 0, already_done: 1 });
  });

  it("does not record pending payments, so they send once paid", async () => {
    const records = [t(1, { payment_status: "Pending" })];
    const x = setup(() => Response.json(records));
    expect(await run(x.deps)).toMatchObject({ sent: 0, filtered: { status_pending: 1 } });
    records[0] = t(1);
    expect(await run(x.deps)).toMatchObject({ sent: 1 });
  });

  it("does nothing when SEND_TO_META is off", async () => {
    const x = setup([t(1)]);
    const s = await run(x.deps, config({ sendEnabled: false }));
    expect(s.result).toBe("disabled");
    expect(x.f.calls).toHaveLength(0);
  });

  it("dry run previews without sending or saving", async () => {
    const x = setup([t(1), t(2, { email: null }), donation()]);
    const s = await run(x.deps, config({ sendEnabled: false }), true);
    expect(s.preview).toEqual([
      {
        event_id: "order-1",
        line_item_ids: ["li-1"],
        decision: "would_send",
        event_name: "Purchase",
        value: 110,
        event_time: "2026-10-07T14:55:02.000Z",
        num_items: 1,
      },
      { event_id: "order-2", line_item_ids: ["li-2"], decision: "would_skip", reason: "no_email" },
    ]);
    expect(x.f.metaCalls()).toHaveLength(0);
    expect(x.store.rows.size).toBe(0);
    expect(x.store.state.size).toBe(0);
  });

  it("includes test_event_code when set", async () => {
    const x = setup([t(1)]);
    const s = await run(x.deps, config({ metaTestEventCode: "TEST123" }));
    expect(s.mode).toBe("test_events");
    expect(x.f.metaCalls()[0]!.body.test_event_code).toBe("TEST123");
  });

  it("reports missing settings", async () => {
    const x = setup([]);
    const s = await run(x.deps, config({ metaAccessToken: "", eventMatch: "" }));
    expect(s).toMatchObject({ result: "config_missing", error: "Missing settings: META_ACCESS_TOKEN, EVENT_MATCH" });
  });

  it("skips the run if another run holds the lock", async () => {
    const x = setup([t(1)]);
    await x.store.acquireLock("other", NOW, 60_000);
    expect((await run(x.deps)).result).toBe("locked");
    expect(x.f.calls).toHaveLength(0);
  });

  it("keeps secrets and PII out of logs and summaries", async () => {
    const a = setup(() => new Response("nope", { status: 404 }));
    const s = await run(a.deps);
    expect(s.error).toBe("Give Lively returned 404 (check GL_ORG_ID and GL_API_KEY)");

    const b = setup([t(1)], metaError(400, { message: "bad token TOKEN_ABC", code: 190 }));
    const s2 = await run(b.deps);
    const everything = JSON.stringify([s, s2, a.logs, b.logs, [...b.store.state.values()]]);
    for (const secret of ["SECRETKEY123", "TOKEN_ABC", "givelively.org/nonprofits", "example.com", "Jane", "2515550123"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("does not leak the URL on network errors", async () => {
    const x = setup(() => {
      throw new TypeError("fetch failed: https://secure.givelively.org/nonprofits/org-test/json_dataclips/SECRETKEY123.json");
    });
    const s = await run(x.deps);
    expect(s.error).toBe("Give Lively network error");
    expect(JSON.stringify([s, x.logs])).not.toContain("SECRETKEY123");
  });
});
