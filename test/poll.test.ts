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

describe("runPoll", () => {
  it("sends only ticket sales, in one batch", async () => {
    const t = setup([ticket(), donation(), ticket({ id: "li_1002", event_name: "Other Gala" })]);
    const s = await run(t.deps);
    expect(s).toMatchObject({ result: "ok", fetched: 3, matched: 1, sent: 1, cursor_advanced: true });
    expect(t.f.metaCalls()).toHaveLength(1);
    expect(t.f.metaCalls()[0]!.body.data.map((e: any) => e.event_id)).toEqual(["li_1001"]);
    expect(t.store.rows.get("li_1001")?.status).toBe("sent");
    expect(t.store.rows.has("don_2001")).toBe(false);
  });

  it("never sends the same event_id twice", async () => {
    const t = setup([ticket(), ticket()]); // feed repeats the record
    await run(t.deps);
    t.tick(5 * 60_000);
    const second = await run(t.deps);
    expect(second).toMatchObject({ sent: 0, already_done: 1 });
    expect(t.f.metaCalls()).toHaveLength(1);
    expect(t.f.metaCalls()[0]!.body.data).toHaveLength(1);
  });

  it("starts from now minus BACKFILL_HOURS, then cursor minus overlap", async () => {
    const t = setup([]);
    await run(t.deps, config({ backfillHours: 2 }));
    const firstUrl = new URL(t.f.calls[0]!.url);
    expect(Number(firstUrl.searchParams.get("start_time_ms"))).toBe(NOW - 2 * 3600_000);
    t.tick(300_000);
    await run(t.deps);
    const secondUrl = new URL(t.f.calls[1]!.url);
    expect(Number(secondUrl.searchParams.get("start_time_ms"))).toBe(NOW - 600_000);
  });

  it("does not advance the cursor or mark sent when Meta fails (retryable)", async () => {
    const t = setup([ticket()], metaError(500, { message: "oops", code: 2 }));
    const s = await run(t.deps);
    expect(s).toMatchObject({ result: "error", sent: 0, failed: 1, cursor_advanced: false });
    expect(t.store.state.get("cursor_ms")).toBeUndefined();
    expect(t.store.rows.size).toBe(0);
  });

  it("treats a bad token as retryable, never rejecting events", async () => {
    const t = setup([ticket(), ticket({ id: "li_2" })], metaError(400, { message: "Invalid OAuth access token", code: 190 }));
    const s = await run(t.deps);
    expect(s).toMatchObject({ result: "error", rejected: 0, failed: 2 });
    expect(t.f.metaCalls()).toHaveLength(1); // no one-by-one retries
  });

  it("on a rejected batch, retries one by one and records accepted IDs only", async () => {
    const t = setup([ticket({ id: "good" }), ticket({ id: "bad" })], (body) =>
      body.data.some((e: any) => e.event_id === "bad")
        ? Response.json({ error: { message: "Invalid parameter", code: 100 } }, { status: 400 })
        : Response.json({ events_received: body.data.length }),
    );
    const s = await run(t.deps);
    expect(s).toMatchObject({ result: "partial", sent: 1, rejected: 1, cursor_advanced: true });
    expect(t.store.rows.get("good")?.status).toBe("sent");
    expect(t.store.rows.get("bad")?.status).toBe("rejected");
    expect(t.f.metaCalls()).toHaveLength(3);
  });

  it("gives up on a lone invalid event only after several runs", async () => {
    const t = setup([ticket({ id: "bad" })], metaError(400, { message: "Invalid parameter", code: 100 }));
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const s = await run(t.deps);
      expect(s).toMatchObject({ failed: 1, rejected: 0, cursor_advanced: false });
      t.tick(300_000);
    }
    const last = await run(t.deps);
    expect(last).toMatchObject({ rejected: 1, cursor_advanced: true });
    expect(t.store.rows.get("bad")?.status).toBe("rejected");
  });

  it("marks unmappable ticket records as skipped, once", async () => {
    const t = setup([ticket({ email: undefined })]);
    const s = await run(t.deps);
    expect(s).toMatchObject({ skipped: 1, sent: 0 });
    expect(t.store.rows.get("li_1001")).toMatchObject({ status: "skipped", reason: "no_email" });
    expect(t.f.metaCalls()).toHaveLength(0);
    const again = await run(t.deps);
    expect(again).toMatchObject({ skipped: 0, already_done: 1 });
  });

  it("does not record pending tickets, so they send once paid", async () => {
    const records = [ticket({ status: "pending" })];
    const t = setup(() => Response.json(records));
    expect(await run(t.deps)).toMatchObject({ sent: 0, filtered: { status_pending: 1 } });
    records[0] = ticket({ status: "succeeded" });
    expect(await run(t.deps)).toMatchObject({ sent: 1 });
  });

  it("does nothing when SEND_TO_META is off", async () => {
    const t = setup([ticket()]);
    const s = await run(t.deps, config({ sendEnabled: false }));
    expect(s.result).toBe("disabled");
    expect(t.f.calls).toHaveLength(0);
  });

  it("dry run previews without sending or saving", async () => {
    const t = setup([ticket(), ticket({ id: "x", email: undefined }), donation()]);
    const s = await run(t.deps, config({ sendEnabled: false }), true);
    expect(s.preview).toEqual([
      { event_id: "li_1001", decision: "would_send", value: 125, event_time: "2026-10-07T14:55:00.000Z", num_items: 2 },
      { event_id: "x", decision: "would_skip", reason: "no_email" },
    ]);
    expect(t.f.metaCalls()).toHaveLength(0);
    expect(t.store.rows.size).toBe(0);
    expect(t.store.state.size).toBe(0);
  });

  it("includes test_event_code when set", async () => {
    const t = setup([ticket()]);
    const s = await run(t.deps, config({ metaTestEventCode: "TEST123" }));
    expect(s.mode).toBe("test_events");
    expect(t.f.metaCalls()[0]!.body.test_event_code).toBe("TEST123");
  });

  it("reports missing settings", async () => {
    const t = setup([]);
    const s = await run(t.deps, config({ metaAccessToken: "", eventPageUrl: "" }));
    expect(s).toMatchObject({ result: "config_missing", error: "Missing settings: META_ACCESS_TOKEN, EVENT_PAGE_URL" });
  });

  it("skips the run if another run holds the lock", async () => {
    const t = setup([ticket()]);
    await t.store.acquireLock("other", NOW, 60_000);
    expect((await run(t.deps)).result).toBe("locked");
    expect(t.f.calls).toHaveLength(0);
  });

  it("keeps secrets and PII out of logs and summaries", async () => {
    const t = setup(() => new Response("nope", { status: 404 }));
    const s = await run(t.deps);
    expect(s.error).toBe("Give Lively returned 404 (check GL_ORG_ID and GL_API_KEY)");

    const t2 = setup([ticket()], metaError(400, { message: "bad token TOKEN_ABC", code: 190 }));
    const s2 = await run(t2.deps);
    const everything = JSON.stringify([s, s2, t.logs, t2.logs, [...t2.store.state.values()]]);
    for (const secret of ["SECRETKEY123", "TOKEN_ABC", "givelively.org/nonprofits", "example.com", "Jane"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("does not leak the URL on network errors", async () => {
    const t = setup(() => {
      throw new TypeError("fetch failed: https://secure.givelively.org/nonprofits/org-test/json_dataclips/SECRETKEY123.json");
    });
    const s = await run(t.deps);
    expect(s.error).toBe("Give Lively network error");
    expect(JSON.stringify([s, t.logs])).not.toContain("SECRETKEY123");
  });
});
