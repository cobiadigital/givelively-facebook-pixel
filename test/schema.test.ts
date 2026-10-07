import { describe, expect, it } from "vitest";
import { describeSchema, describeShapes, distinctValues, isPiiPath } from "../src/schema";
import { donation, ticket } from "./helpers";

describe("describeSchema", () => {
  it("returns field names and types but no values", () => {
    const records = [ticket({ donor: { email: "x@example.com", tags: ["a"] } }), donation()];
    const schema = describeSchema(records);
    expect(schema.email).toEqual({ types: ["string"], present: 2, looks_like: ["email"] });
    expect(schema.ticket_name).toMatchObject({ present: 1 });
    expect(schema["donor.email"]).toMatchObject({ types: ["string"] });
    expect(schema["donor.tags[]"]).toMatchObject({ types: ["string"] });
    expect(schema.created_at!.looks_like).toEqual(["datetime"]);

    const text = JSON.stringify(schema);
    for (const v of ["Jane", "example.com", "Art Soup", "125.00", "General Admission"]) {
      expect(text).not.toContain(v);
    }
  });

  it("groups records by shape", () => {
    const shapes = describeShapes([ticket(), ticket({ id: "2" }), donation()]);
    expect(shapes.map((s) => s.count)).toEqual([2, 1]);
    expect(shapes[0]!.keys).toContain("ticket_name");
  });
});

describe("distinctValues", () => {
  it("shows values of non-personal fields", () => {
    const out = distinctValues([ticket(), donation(), ticket({ id: "3" })], ["line_item_type", "status"]);
    expect(out.line_item_type).toEqual({ values: { Ticket: 2, Donation: 1 }, truncated: false });
  });

  it("blocks personal fields", () => {
    const out = distinctValues([ticket()], ["email", "first_name", "donor.email", "phone", "name"]);
    for (const v of Object.values(out)) expect(v).toEqual({ blocked: "personal data field" });
  });

  it("hides email- and phone-like values in any field", () => {
    const out = distinctValues([ticket({ memo_x: "jane@example.com" }), ticket({ memo_x: "251-555-0123" })], ["memo_x"]);
    expect(out.memo_x).toEqual({ values: { "[hidden]": 2 }, truncated: false });
  });

  it("tells thing names from people names", () => {
    expect(isPiiPath("event_name")).toBe(false);
    expect(isPiiPath("ticketName")).toBe(false);
    expect(isPiiPath("campaign.name")).toBe(true); // ambiguous segment "name" alone
    expect(isPiiPath("donor_name")).toBe(true);
    expect(isPiiPath("billing_zip")).toBe(true);
  });
});
