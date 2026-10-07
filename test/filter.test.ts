import { describe, expect, it } from "vitest";
import { classify, isTicketSale, kindOf, type FilterConfig } from "../src/filter";
import { donation, ticket } from "./helpers";

const cfg: FilterConfig = { eventMatch: "Art Soup 2026", track: ["ticket"], valueField: "original_amount" };

describe("classify", () => {
  it("accepts a paid ticket for the target event", () => {
    expect(classify(ticket(), cfg)).toEqual({ ok: true, kind: "ticket" });
    expect(isTicketSale(ticket(), cfg)).toBe(true);
  });

  it("tells tickets from donations by ticket_id", () => {
    expect(kindOf(ticket())).toBe("ticket");
    expect(kindOf(donation())).toBe("donation");
    // A donation made on the event page is still a donation.
    expect(kindOf(ticket({ ticket_id: null }))).toBe("donation");
  });

  it("ignores donations unless TRACK includes them", () => {
    expect(classify(donation(), cfg)).toEqual({ ok: false, reason: "donation_not_tracked" });
    expect(classify(donation(), { ...cfg, track: ["donation"] })).toEqual({ ok: true, kind: "donation" });
    expect(classify(ticket(), { ...cfg, track: ["donation"] })).toEqual({ ok: false, reason: "ticket_not_tracked" });
    expect(classify(donation(), { ...cfg, track: ["ticket", "donation"] }).ok).toBe(true);
  });

  it("rejects tickets for other events", () => {
    const other = ticket({
      page_name: "Spring Gala",
      internal_name: "Spring Gala",
      event_name: "Spring Gala",
      page_slug: "spring-gala",
      page_url: "https://secure.givelively.org/event/x/spring-gala",
    });
    expect(classify(other, cfg)).toEqual({ ok: false, reason: "other_page" });
  });

  it("matches the slug as well as the name", () => {
    expect(isTicketSale(ticket(), { ...cfg, eventMatch: "ART-SOUP-2026-tickets" })).toBe(true);
  });

  it.each([
    ["Pending", "status_pending"],
    ["Failed", "status_failed"],
    [null, "status_missing"],
  ])("rejects payment_status %s", (payment_status, reason) => {
    expect(classify(ticket({ payment_status }), cfg)).toEqual({ ok: false, reason });
  });

  it("rejects refunded and disputed line items", () => {
    expect(classify(ticket({ total_refunded_amount: 110 }), cfg)).toEqual({ ok: false, reason: "refunded" });
    expect(classify(ticket({ refund_status: "Refunded" }), cfg)).toEqual({ ok: false, reason: "refunded" });
    expect(classify(ticket({ disputed_at: "2026-10-08T00:00:00Z" }), cfg)).toEqual({ ok: false, reason: "disputed" });
  });

  it("rejects complimentary tickets", () => {
    expect(classify(ticket({ original_amount: 0, gross_amount: 0 }), cfg)).toEqual({ ok: false, reason: "zero_amount" });
  });

  it("refuses everything when EVENT_MATCH is empty", () => {
    expect(classify(ticket(), { ...cfg, eventMatch: "  " })).toEqual({ ok: false, reason: "event_match_not_set" });
  });
});
