import { describe, expect, it } from "vitest";
import { parseTimeMs, pickAmount } from "../src/fields";
import { normalizeEmail, normalizeName, normalizePhone, sha256Hex } from "../src/hash";
import { toMetaEvent } from "../src/map";
import { NOW, ticket } from "./helpers";

const cfg = { eventPageUrl: "https://example.org/art-soup", currency: "USD", actionSource: "website" };

// Known SHA-256 vectors (computed with sha256sum).
const H_EMAIL = "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b"; // test@example.com
const H_JANE = "81f8f6dde88365f3928796ec7aa53f72820b06db8664f5fe76a7eb13e24546a2"; // jane
const H_PHONE = "a6ca6502b2f28e8500007a48a941da5f033de1f8d6210434d0a31ec4d690d202"; // 12515550123

describe("hashing", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await sha256Hex("test@example.com")).toBe(H_EMAIL);
    expect(await sha256Hex("jane")).toBe(H_JANE);
  });

  it("normalizes per Meta rules", () => {
    expect(normalizeEmail("  Test@Example.COM ")).toBe("test@example.com");
    expect(normalizeEmail("not an email")).toBeUndefined();
    expect(normalizeName(" Mary-Jane ")).toBe("maryjane");
    expect(normalizeName("José")).toBe("josé");
    expect(normalizePhone("(251) 555-0123")).toBe("12515550123");
    expect(normalizePhone("+1 251 555 0123")).toBe("12515550123");
    expect(normalizePhone("555-0123")).toBeUndefined();
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
    expect(parseTimeMs("2026-10-07T14:55:00Z")).toBe(want);
    expect(parseTimeMs("2026-10-07 09:55:00 -0500")).toBe(want);
    expect(parseTimeMs("2026-10-07 14:55:00 UTC")).toBe(want);
    expect(parseTimeMs(want)).toBe(want);
    expect(parseTimeMs(want / 1000)).toBe(want);
    expect(parseTimeMs(String(want))).toBe(want);
    expect(parseTimeMs("garbage")).toBeUndefined();
  });
});

describe("toMetaEvent", () => {
  it("builds a Purchase event with hashed user data", async () => {
    const r = await toMetaEvent(ticket(), cfg, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toEqual({
      event_name: "Purchase",
      event_time: Date.parse("2026-10-07T14:55:00Z") / 1000,
      event_id: "li_1001",
      action_source: "website",
      event_source_url: "https://example.org/art-soup",
      user_data: {
        em: [H_EMAIL],
        fn: [H_JANE],
        ln: [await sha256Hex("doe")],
        ph: [H_PHONE],
      },
      custom_data: { value: 125, currency: "USD", content_name: "Art Soup 2026", num_items: 2 },
    });
  });

  it("never includes unhashed PII", async () => {
    const r = await toMetaEvent(ticket(), cfg, NOW);
    const text = JSON.stringify(r).toLowerCase();
    for (const s of ["test@example.com", "jane", "doe", "2515550123"]) expect(text).not.toContain(s);
  });

  it("splits a full name when first/last are missing", async () => {
    const r = await toMetaEvent(ticket({ first_name: undefined, last_name: undefined, donor_name: "Jane van Doe" }), cfg, NOW);
    expect(r.ok && r.event.user_data.fn).toEqual([H_JANE]);
    expect(r.ok && r.event.user_data.ln).toEqual([await sha256Hex("vandoe")]);
  });

  it("omits optional fields that are missing", async () => {
    const r = await toMetaEvent(ticket({ phone: undefined, quantity: undefined, ticket_name: undefined }), cfg, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.user_data.ph).toBeUndefined();
    expect(r.event.custom_data.num_items).toBeUndefined();
  });

  it.each([
    [{ id: undefined }, "no_id"],
    [{ created_at: undefined }, "no_time"],
    [{ email: undefined }, "no_email"],
    [{ email: "bad" }, "no_email"],
    [{ created_at: "2026-09-29T14:55:00Z" }, "too_old"],
  ])("skips %j as %s", async (over, reason) => {
    const r = await toMetaEvent(ticket(over), cfg, NOW);
    expect(r).toMatchObject({ ok: false, reason });
  });

  it("clamps future timestamps to now", async () => {
    const r = await toMetaEvent(ticket({ created_at: "2026-10-07T16:00:00Z" }), cfg, NOW);
    expect(r.ok && r.event.event_time).toBe(NOW / 1000);
  });
});
