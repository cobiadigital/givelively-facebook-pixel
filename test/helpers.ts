import type { Config } from "../src/config";
import type { EventRow, FinalRow, Store } from "../src/db";
import type { GLRecord } from "../src/fields";

/**
 * Fixture records with the real Give Lively feed field names (json_dataclips).
 * Every value is made up.
 */
export const NOW = Date.parse("2026-10-07T15:00:00Z");

export function ticket(overrides: GLRecord = {}): GLRecord {
  return {
    line_item_id: "00000000-0000-4000-8000-000000000001",
    order_id: "00000000-0000-4000-8000-0000000000a1",
    date: "2026-10-07T14:55:00.000Z",
    full_name: "Jane Doe",
    first_name: "Jane",
    last_name: "Doe",
    email: " Test@Example.com ",
    original_amount: 110,
    covered_transaction_fee_amount: 3.49,
    gross_amount: 113.49,
    transaction_fee_amount: 3.49,
    disbursement_fee: 0,
    platform_fee_amount: null,
    covered_platform_fee_amount: null,
    total_refunded_amount: 0,
    refund_status: null,
    net_amount: 110,
    frequency: "One-time",
    anonymous_to_public: false,
    dedication_name: null,
    dedication_type: null,
    last_receipt_sent_at: "2026-10-07T14:55:04.000Z",
    payment_status: "Succeeded",
    payment_method: "card",
    payment_processor: "stripe",
    payment_platform_donation_date: "2026-10-07T14:55:00.000Z",
    smart_donations_payment_platform_charge_id: "ch_TEST",
    smart_donations_charge_id: "00000000-0000-4000-8000-0000000000c1",
    subscription_item_id: null,
    subscription_id: null,
    payment_platform_subscription_id: null,
    donor_mailing_address: "100 Example St, Mobile, AL, 36602",
    donor_mailing_street_1: "100 Example St",
    donor_mailing_street_2: "",
    donor_mailing_city: "Mobile",
    donor_mailing_state: "AL",
    donor_mailing_zip: "36602",
    donor_mailing_country: null,
    donor_billing_zip_code: "36602",
    donor_billing_country: "US",
    donor_phone_number: "2515550123",
    donor_organization_name: null,
    lead_source: "Give Lively LLC",
    internal_name: "Art Soup 2026 Tickets",
    page_name: "Art Soup 2026 Tickets",
    page_type: "Event",
    page_url: "https://secure.givelively.org/event/example-nonprofit/art-soup-2026-tickets",
    page_slug: "art-soup-2026-tickets",
    referrer_url: "",
    utm_source: null,
    nonprofit_id: "00000000-0000-4000-8000-0000000000e1",
    campaign_id: null,
    event_id: "00000000-0000-4000-8000-0000000000e2",
    event_start_date: "2026-11-06T00:00:00.000Z",
    event_end_date: "2026-11-06T03:00:00.000Z",
    event_name: "Art Soup 2026 Tickets",
    event_beneficiary_type: "Nonprofit",
    ticket_id: "00000000-0000-4000-8000-0000000000t1",
    campaign_name: null,
    disputed_at: null,
    disputed_amount: null,
    dispute_status: null,
    payment_succeeded_date: "2026-10-07T14:55:02.000Z",
    payable_amount: 110,
    data_modified_timestamp: NOW - 60_000,
    ...overrides,
  };
}

/** A plain donation on a campaign page (no ticket_id). */
export function donation(overrides: GLRecord = {}): GLRecord {
  return ticket({
    line_item_id: "00000000-0000-4000-8000-000000000d01",
    order_id: "00000000-0000-4000-8000-000000000d0a",
    email: "john@example.com",
    first_name: "John",
    last_name: "Roe",
    full_name: "John Roe",
    original_amount: 50,
    gross_amount: 50,
    page_type: "Campaign",
    page_name: "Art Soup 2026 Sponsorships",
    internal_name: "Art Soup 2026 Sponsorships",
    page_slug: "art-soup-2026-sponsorships",
    page_url: "https://secure.givelively.org/donate/example-nonprofit/art-soup-2026-sponsorships",
    event_id: null,
    event_name: null,
    ticket_id: null,
    campaign_name: "Art Soup 2026 Sponsorships",
    ...overrides,
  });
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
    eventPageUrl: "",
    currency: "USD",
    track: ["ticket"],
    valueField: "original_amount",
    sendLocation: true,
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
    return new Set(
      ids.filter((id) => {
        const r = this.rows.get(id);
        return r && r.status !== "failed";
      }),
    );
  }
  async getSentOrderIds(orderIds: string[]) {
    const sent = new Set([...this.rows.values()].filter((r) => r.status === "sent").map((r) => r.order_id));
    return new Set(orderIds.filter((o) => sent.has(o)));
  }
  async recordFinal(rows: FinalRow[], nowIso: string) {
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
