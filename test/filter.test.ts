import { describe, expect, it } from "vitest";
import { classify, isTicketSale } from "../src/filter";
import { donation, ticket } from "./helpers";

const cfg = { eventMatch: "Art Soup 2026" };

describe("classify", () => {
  it("accepts a paid ticket for the target event", () => {
    expect(classify(ticket(), cfg)).toEqual({ ok: true });
    expect(isTicketSale(ticket(), cfg)).toBe(true);
  });

  it("rejects plain donations, even to the same campaign", () => {
    expect(classify(donation(), cfg)).toEqual({ ok: false, reason: "not_ticket" });
  });

  it("rejects tickets for other events", () => {
    expect(classify(ticket({ event_name: "Spring Gala 2026" }), cfg)).toEqual({
      ok: false,
      reason: "other_event",
    });
  });

  it("matches the event case-insensitively in any event field", () => {
    expect(isTicketSale(ticket({ event_name: undefined, page_slug: "ART-SOUP-2026-tickets" }), {
      eventMatch: "art-soup-2026",
    })).toBe(true);
  });

  it.each(["pending", "failed", "refunded", "Canceled"])("rejects status %s", (status) => {
    const r = classify(ticket({ status }), cfg);
    expect(r.ok).toBe(false);
  });

  it("accepts records without a status field", () => {
    expect(isTicketSale(ticket({ status: undefined }), cfg)).toBe(true);
  });

  it("rejects complimentary tickets", () => {
    expect(classify(ticket({ amount: "0.00" }), cfg)).toEqual({ ok: false, reason: "zero_amount" });
    expect(classify(ticket({ amount: undefined }), cfg)).toEqual({ ok: false, reason: "zero_amount" });
  });

  it("detects tickets by a ticket field when there is no type field", () => {
    expect(isTicketSale(ticket({ line_item_type: undefined }), cfg)).toBe(true);
    expect(isTicketSale(ticket({ line_item_type: undefined, ticket_name: undefined }), cfg)).toBe(false);
  });

  it("matches field names regardless of case and separators", () => {
    const r = {
      ID: "x1",
      "Line Item Type": "ticket",
      "Event Name": "Art Soup 2026",
      Status: "Completed",
      Amount: "$1,250.00",
    };
    expect(isTicketSale(r, cfg)).toBe(true);
  });

  it("refuses everything when EVENT_MATCH is empty", () => {
    expect(classify(ticket(), { eventMatch: "  " })).toEqual({ ok: false, reason: "event_match_not_set" });
  });
});
