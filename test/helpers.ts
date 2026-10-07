import type { Config } from "../src/config";
import type { EventRow, FinalStatus, Store } from "../src/db";
import type { GLRecord } from "../src/fields";

/**
 * Fixture records. Field names are GUESSES modeled on common Give Lively report
 * columns. Replace with the real shape after running GET /sample. All data is fake.
 */
export const NOW = Date.parse("2026-10-07T15:00:00Z");

export function ticket(overrides: GLRecord = {}): GLRecord {
  return {
    id: "li_1001",
    created_at: "2026-10-07T14:55:00Z",
    line_item_type: "Ticket",
    event_name: "Art Soup 2026",
    ticket_name: "General Admission",
    status: "succeeded",
    amount: "125.00",
    quantity: 2,
    first_name: "Jane",
    last_name: "Doe",
    email: " Test@Example.com ",
    phone: "(251) 555-0123",
    ...overrides,
  };
}

export function donation(overrides: GLRecord = {}): GLRecord {
  return {
    id: "don_2001",
    created_at: "2026-10-07T14:50:00Z",
    line_item_type: "Donation",
    campaign_name: "Art Soup 2026",
    status: "succeeded",
    amount: "50.00",
    first_name: "John",
    last_name: "Roe",
    email: "john@example.com",
    ...overrides,
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    glOrgId: "org-test",
    glApiKey: "SECRETKEY123",
    metaPixelId: "1234567890",
    metaAccessToken: "TOKEN_ABC",
    metaApiVersion: "v26.0",
    metaTestEventCode: "",
    actionSource: "website",
    eventMatch: "art soup 2026",
    eventPageUrl: "https://example.org/art-soup",
    currency: "USD",
    sendEnabled: true,
    overlapMs: 600_000,
    backfillHours: 0,
    adminToken: "admin-secret",
    ...overrides,
  };
}

export class MemoryStore implements Store {
  state = new Map<string, string>();
  rows = new Map<string, EventRow & { attempts: number }>();
  lock: { owner: string; until: number } | null = null;

  async init() {}
  async getState(key: string) {
    return this.state.get(key) ?? null;
  }
  async setState(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) this.state.set(k, v);
  }
  async getFinalIds(ids: string[]) {
    return new Set(ids.filter((id) => {
      const r = this.rows.get(id);
      return r && r.status !== "failed";
    }));
  }
  async recordFinal(
    rows: { event_id: string; status: FinalStatus; value: number | null; reason: string | null }[],
    nowIso: string,
  ) {
    for (const r of rows) {
      const existing = this.rows.get(r.event_id);
      if (existing && existing.status !== "failed") continue;
      this.rows.set(r.event_id, { ...r, sent_at: nowIso, attempts: existing?.attempts ?? 0 });
    }
  }
  async recordFailures(rows: { event_id: string; value: number | null; reason: string }[], nowIso: string) {
    const out = new Map<string, number>();
    for (const r of rows) {
      const existing = this.rows.get(r.event_id);
      if (existing && existing.status !== "failed") continue;
      const attempts = (existing?.attempts ?? 0) + 1;
      this.rows.set(r.event_id, { ...r, status: "failed", sent_at: nowIso, attempts });
      out.set(r.event_id, attempts);
    }
    return out;
  }
  async acquireLock(owner: string, nowMs: number, ttlMs: number) {
    if (this.lock && this.lock.until >= nowMs) return false;
    this.lock = { owner, until: nowMs + ttlMs };
    return true;
  }
  async releaseLock(owner: string) {
    if (this.lock?.owner === owner) this.lock = null;
  }
  async counts() {
    const out: Record<string, number> = { sent: 0, skipped: 0, rejected: 0, failed: 0 };
    for (const r of this.rows.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
  async recent(limit: number) {
    return [...this.rows.values()].slice(-limit);
  }
}

export interface FakeCall {
  url: string;
  body?: any;
}

/**
 * A fake fetch: Give Lively requests get `records`, Meta requests get whatever
 * `meta(body)` returns (default: success).
 */
export function fakeFetch(
  records: GLRecord[] | (() => Response),
  meta: (body: any) => Response = (b) => Response.json({ events_received: b.data.length }),
) {
  const calls: FakeCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("givelively.org")) {
      return typeof records === "function" ? records() : Response.json(records);
    }
    if (url.includes("graph.facebook.com")) return meta(body);
    throw new Error("unexpected url");
  }) as typeof fetch;
  return { fn, calls, metaCalls: () => calls.filter((c) => c.url.includes("graph.facebook.com")) };
}
