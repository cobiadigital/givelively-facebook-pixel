import { describe, expect, it } from "vitest";
import { parseTimeMs, pickAmount } from "../src/fields";
import {
  normalizeCity,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeState,
  normalizeZip,
  sha256Hex,
} from "../src/hash";
import { toMetaEvent, type MapConfig } from "../src/map";
import { NOW, donation, ticket } from "./helpers";

const cfg: MapConfig = {
  eventPageUrl: "",
  currency: "USD",
  actionSource: "website",
  valueField: "original_amount",
  sendLocation: true,
};

// Known SHA-256 vectors (computed with sha256sum).
const H_EMAIL = "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b"; // test@example.com
const H_JANE = "81f8f6dde88365f3928796ec7aa53f72820b06db8664f5fe76a7eb13e24546a2"; // jane
const H_PHONE = "a6ca6502b2f28e8500007a48a941da5f033de1f8d6210434d0a31ec4d690d202"; // 12515550123

describe("hashing", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await sha256Hex("test@example.com")).toBe(H_EMAIL);
    expect(await sha256Hex("jane")).toBe(H_JANE);
    expect(await sha256Hex("12515550123")).toBe(H_PHONE);
  });

  it("normalizes per Meta rules", () => {
    expect(normalizeEmail("  Test@Example.COM ")).toBe("test@example.com");
    expect(normalizeEmail("not an email")).toBeUndefined();
    expect(normalizeName(" Mary-Jane ")).toBe("maryjane");
    expect(normalizeName("José")).toBe("josé");
    expect(normalizePhone("2515550123")).toBe("12515550123");
    expect(normalizePhone("+1 (251) 555-0123")).toBe("12515550123");
    expect(normalizePhone("555-0123")).toBeUndefined();
    expect(normalizeCity("St. Louis")).toBe("stlouis");
    expect(normalizeState("AL")).toBe("al");
    expect(normalizeZip("36602-1234")).toBe("36602");
    expect(normalizeZip("SW1A 1AA")).toBe("sw1a1aa");
    expect(normalizeCountry("US")).toBe("us");
    expect(normalizeCountry("United States")).toBe("us");
    expect(normalizeCountry("Narnia")).toBeUndefined();
  });
});

describe("field parsing", () => {
  it("parses amounts", () => {
    expect(pickAmount({ amount: "$1,234.50" }, ["amount"])).toBe(1234.5);
    expect(pickAmount({ amount: 99 }, ["amount"])).toBe(99);
    expect(pickAmount({ amount_cents: 12550 }, ["amount_cents"])).toBe(125.5);
    expect(pickAmount({ amount: "n/a" }, ["amount"])).toBeUndefined();
  });

  it("parses timestamps", () => {
    const want = Date.parse("2026-10-07T14:55:00Z");
    expect(parseTimeMs("2026-10-07T14:55:00.000Z")).toBe(want);
    expect(parseTimeMs("2026-10-07 09:55:00 -0500")).toBe(want);
    expect(parseTimeMs(want)).toBe(want);
    expect(parseTimeMs(want / 1000)).toBe(want);
    expect(parseTimeMs("garbage")).toBeUndefined();
  });
});

describe("toMetaEvent", () => {
  it("builds a Purchase with hashed customer info and order details", async () => {
    const r = await toMetaEvent([ticket()], "ticket", "order-1", cfg, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toEqual({
      event_name: "Purchase",
      event_time: Date.parse("2026-10-07T14:55:02Z") / 1000,
      event_id: "order-1",
      action_source: "website",
      event_source_url: "https://secure.givelively.org/event/example-nonprofit/art-soup-2026-tickets",
      user_data: {
        em: [H_EMAIL],
        fn: [H_JANE],
        ln: [await sha256Hex("doe")],
        ph: [H_PHONE],
        ct: [await sha256Hex("mobile")],
        st: [await sha256Hex("al")],
        zp: [await sha256Hex("36602")],
        country: [await sha256Hex("us")],
      },
      custom_data: {
        value: 110,
        currency: "USD",
        order_id: "00000000-0000-4000-8000-0000000000a1",
        content_name: "Art Soup 2026 Tickets",
        content_category: "Event Ticket",
        content_type: "product",
        content_ids: ["00000000-0000-4000-8000-0000000000t1"],
        num_items: 1,
      },
    });
  });

  it("combines the tickets of one order into one event", async () => {
    const lines = [
      ticket(),
      ticket({ line_item_id: "li-2", payment_succeeded_date: "2026-10-07T14:55:01.000Z" }),
      ticket({ line_item_id: "li-3", ticket_id: "vip", original_amount: 250 }),
    ];
    const r = await toMetaEvent(lines, "ticket", "order-1", cfg, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(470);
    expect(r.event.custom_data).toMatchObject({
      value: 470,
      num_items: 3,
      content_ids: ["00000000-0000-4000-8000-0000000000t1", "vip"],
    });
    expect(r.event.event_time).toBe(Date.parse("2026-10-07T14:55:01Z") / 1000);
  });

  it("uses VALUE_FIELD for the value", async () => {
    const r = await toMetaEvent([ticket()], "ticket", "o", { ...cfg, valueField: "gross_amount" }, NOW);
    expect(r.ok && r.event.custom_data.value).toBe(113.49);
  });

  it("builds a Donate event for donations", async () => {
    const r = await toMetaEvent([donation()], "donation", "o", cfg, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.event_name).toBe("Donate");
    expect(r.event.custom_data).toEqual({
      value: 50,
      currency: "USD",
      order_id: "00000000-0000-4000-8000-000000000d0a",
      content_name: "Art Soup 2026 Sponsorships",
      content_category: "Donation",
    });
  });

  it("leaves out location when SEND_LOCATION is false", async () => {
    const r = await toMetaEvent([ticket()], "ticket", "o", { ...cfg, sendLocation: false }, NOW);
    expect(r.ok && Object.keys(r.event.user_data).sort()).toEqual(["em", "fn", "ln", "ph"]);
  });

  it("never includes unhashed PII", async () => {
    const r = await toMetaEvent([ticket()], "ticket", "o", cfg, NOW);
    const text = JSON.stringify(r).toLowerCase();
    for (const s of ["test@example.com", "jane", "doe", "2515550123", "mobile", "36602", "example st"]) {
      expect(text).not.toContain(s);
    }
  });

  it("splits full_name when first/last are missing", async () => {
    const r = await toMetaEvent(
      [ticket({ first_name: null, last_name: null, full_name: "Jane van Doe" })],
      "ticket",
      "o",
      cfg,
      NOW,
    );
    expect(r.ok && r.event.user_data.fn).toEqual([H_JANE]);
    expect(r.ok && r.event.user_data.ln).toEqual([await sha256Hex("vandoe")]);
  });

  it("falls back to EVENT_PAGE_URL and billing country", async () => {
    const r = await toMetaEvent(
      [ticket({ page_url: null, donor_mailing_country: null, donor_billing_country: "CA" })],
      "ticket",
      "o",
      { ...cfg, eventPageUrl: "https://example.org/tickets" },
      NOW,
    );
    expect(r.ok && r.event.event_source_url).toBe("https://example.org/tickets");
    expect(r.ok && r.event.user_data.country).toEqual([await sha256Hex("ca")]);
  });

  it.each([
    [{ payment_succeeded_date: null, payment_platform_donation_date: null, date: null }, "no_time"],
    [{ email: null }, "no_email"],
    [{ email: "bad" }, "no_email"],
    [{ payment_succeeded_date: "2026-09-29T14:55:00Z" }, "too_old"],
  ])("skips %j as %s", async (over, reason) => {
    const r = await toMetaEvent([ticket(over)], "ticket", "o", cfg, NOW);
    expect(r).toEqual({ ok: false, reason });
  });

  it("clamps future timestamps to now", async () => {
    const r = await toMetaEvent([ticket({ payment_succeeded_date: "2026-10-07T16:00:00Z" })], "ticket", "o", cfg, NOW);
    expect(r.ok && r.event.event_time).toBe(NOW / 1000);
  });
});
