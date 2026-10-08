import { describe, expect, it } from "vitest";
import { csvToRecords, fetchCsvRecords, parseCsv, rowId } from "../src/csv";
import { parseTimeMs } from "../src/fields";
import { classify } from "../src/filter";
import { toMetaEvent } from "../src/map";
import { runPoll, type Deps } from "../src/poll";
import { sha256Hex } from "../src/hash";
import { CSV_URL, MemoryStore, NOW, csvConfig, csvRow, fakeFetch, toCsv } from "./helpers";

describe("parseCsv", () => {
  it("handles quotes, embedded commas, quotes and newlines, CRLF and a BOM", () => {
    const text = '﻿a,b,c\r\n"1, one","say ""hi""","multi\nline"\r\n2,,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1, one", 'say "hi"', "multi\nline"],
      ["2", "", ""],
    ]);
  });

  it("keys rows by header", () => {
    expect(csvToRecords(toCsv([csvRow()]))[0]).toMatchObject({ Email: "Test@Example.com", city: "Mobile" });
  });
});

describe("CSV times", () => {
  it("parses 12-hour times with US zone abbreviations", () => {
    expect(parseTimeMs("2026-10-07 09:55:00 AM CDT")).toBe(Date.parse("2026-10-07T14:55:00Z"));
    expect(parseTimeMs("2026-10-07 12:05:00 AM CDT")).toBe(Date.parse("2026-10-07T05:05:00Z"));
    expect(parseTimeMs("2026-10-07 12:05:00 PM CST")).toBe(Date.parse("2026-10-07T18:05:00Z"));
    expect(parseTimeMs("2026-10-07 04:34:38 PM")).toBe(Date.parse("2026-10-07T16:34:38Z"));
    expect(parseTimeMs("2026-10-07 04:34:38 PM XYZ")).toBeUndefined();
  });
});

describe("fetchCsvRecords", () => {
  it("filters by purchase time and adds a stable hashed ID", async () => {
    const rows = [csvRow(), csvRow({ "Date/Time of Purchase": "2026-09-01 09:00:00 AM CDT" })];
    const f = fakeFetch(rows);
    const out = await fetchCsvRecords(CSV_URL, NOW - 3600_000, f.fn);
    expect(out).toHaveLength(1);
    expect(out[0]!.line_item_id).toMatch(/^csv-[0-9a-f]{32}$/);
    expect(out[0]!.order_id).toBe(out[0]!.line_item_id);
    expect(await rowId(csvRow())).toBe(out[0]!.line_item_id);
    // Case of the email doesn't change the ID; tier does.
    expect(await rowId(csvRow({ Email: "test@example.com" }))).toBe(out[0]!.line_item_id);
    expect(await rowId(csvRow({ "Tier Purchased": "Other" }))).not.toBe(out[0]!.line_item_id);
    expect(JSON.stringify(out[0]!.line_item_id)).not.toContain("example");
  });

  it("explains errors without leaking the link", async () => {
    for (const [res, msg] of [
      [new Response("x", { status: 404 }), "Give Lively CSV link returned 404 (check GL_CSV_URL)"],
      [new Response("x", { status: 403, headers: { "x-datadome": "protected" } }), /DataDome/],
      [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), /web page/],
    ] as const) {
      const f = fakeFetch(() => res.clone());
      const err = await fetchCsvRecords(CSV_URL, 0, f.fn).catch((e) => e);
      expect(err.message).toMatch(msg);
      expect(err.message).not.toContain("SECRET-CSV-ID");
    }
  });
});

describe("CSV rows through filter and map", () => {
  it("classifies a CSV purchase as a ticket without EVENT_MATCH", () => {
    const [r] = csvToRecords(toCsv([csvRow()]));
    expect(classify(r!, csvConfig())).toEqual({ ok: true, kind: "ticket" });
    expect(classify(r!, csvConfig({ eventMatch: "spring gala" }))).toEqual({ ok: false, reason: "other_page" });
  });

  it("skips refunded and unpaid rows", () => {
    const refunded = csvToRecords(toCsv([csvRow({ "Amount Refunded": "$500.00" })]))[0]!;
    expect(classify(refunded, csvConfig())).toEqual({ ok: false, reason: "refunded" });
    const pending = csvToRecords(toCsv([csvRow({ Status: "pending" })]))[0]!;
    expect(classify(pending, csvConfig())).toEqual({ ok: false, reason: "status_pending" });
  });

  it("maps a CSV row to a Purchase", async () => {
    const [r] = await fetchCsvRecords(CSV_URL, 0, fakeFetch([csvRow({ "Tickets Purchased": "2" })]).fn);
    const m = await toMetaEvent([r!], "ticket", "e1", { ...csvConfig(), eventPageUrl: "https://example.org/t" }, NOW);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.event).toMatchObject({
      event_name: "Purchase",
      event_time: Date.parse("2026-10-07T14:55:00Z") / 1000,
      event_source_url: "https://example.org/t",
      custom_data: {
        value: 500,
        content_name: "Art Soup 2026 Tickets",
        content_category: "Event Ticket",
        content_ids: ["Table Sponsor"],
        num_items: 2,
      },
    });
    expect(m.event.user_data).toMatchObject({
      em: [await sha256Hex("test@example.com")],
      ph: [await sha256Hex("12515550123")],
      ct: [await sha256Hex("mobile")],
      st: [await sha256Hex("al")],
      zp: [await sha256Hex("36602")],
    });
    expect(m.event.user_data.country).toBeUndefined();
  });
});

describe("runPoll with the CSV source", () => {
  function setup(rows: Record<string, string>[]) {
    const store = new MemoryStore();
    const f = fakeFetch(() => new Response(toCsv(rows), { headers: { "content-type": "text/csv" } }));
    let now = NOW;
    const logs: unknown[] = [];
    const deps: Deps = { store, fetch: f.fn, now: () => now, log: (e, d) => logs.push([e, d]) };
    return { store, f, deps, logs, tick: (ms: number) => (now += ms) };
  }

  it("sends new purchases once, never before the first run", async () => {
    const rows = [
      csvRow({ "Date/Time of Purchase": "2026-10-07 09:55:00 AM CDT" }), // 5 min before first run
      csvRow({ Email: "old@example.com", "Date/Time of Purchase": "2026-10-06 09:00:00 AM CDT" }),
    ];
    const x = setup(rows);
    const first = await runPoll(csvConfig(), x.deps, { trigger: "cron", dryRun: false });
    expect(first).toMatchObject({ result: "ok", fetched: 1, sent: 1 });
    expect(x.f.calls[0]!.url).toBe(CSV_URL);

    rows.push(csvRow({ Email: "new@example.com", "Date/Time of Purchase": "2026-10-07 10:03:00 AM CDT" }));
    x.tick(5 * 60_000);
    const second = await runPoll(csvConfig(), x.deps, { trigger: "cron", dryRun: false });
    expect(second).toMatchObject({ fetched: 2, already_done: 1, sent: 1 });
    expect(x.f.metaCalls()).toHaveLength(2);
  });

  it("picks up a pending purchase once it succeeds, even after the cursor moves on", async () => {
    const rows = [csvRow({ Status: "pending" })];
    const x = setup(rows);
    expect(await runPoll(csvConfig(), x.deps, { trigger: "cron", dryRun: false })).toMatchObject({ sent: 0 });
    x.tick(3 * 3600_000);
    rows[0] = csvRow();
    expect(await runPoll(csvConfig(), x.deps, { trigger: "cron", dryRun: false })).toMatchObject({ sent: 1 });
  });

  it("keeps the CSV link out of logs and summaries", async () => {
    const x = setup([csvRow()]);
    const s = await runPoll(csvConfig(), x.deps, { trigger: "cron", dryRun: false });
    expect(JSON.stringify([s, x.logs, [...x.store.state.values()]])).not.toMatch(/SECRET-CSV-ID|example\.com|Jane/);
  });
});

describe("dry run beyond Meta's 7-day limit", () => {
  it("lists old CSV purchases as too_old", async () => {
    const store = new MemoryStore();
    const old = csvRow({ "Date/Time of Purchase": "2026-09-02 10:00:00 AM CDT" });
    const f = fakeFetch(() => new Response(toCsv([old]), { headers: { "content-type": "text/csv" } }));
    const deps: Deps = { store, fetch: f.fn, now: () => NOW, log: () => {} };
    const s = await runPoll(csvConfig(), deps, { trigger: "manual", dryRun: true, windowHours: 24 * 60 });
    expect(s).toMatchObject({ fetched: 1, matched: 1, skipped: 1 });
    expect(s.preview![0]).toMatchObject({ decision: "would_skip", reason: "too_old" });
    expect(store.rows.size).toBe(0);
  });
});
