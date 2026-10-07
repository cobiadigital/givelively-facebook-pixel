import { describe, expect, it } from "vitest";
import { describeSchema, describeShapes, distinctValues, isPiiPath } from "../src/schema";
import { donation, ticket } from "./helpers";

describe("describeSchema", () => {
  it("returns field names and types but no values", () => {
    const records = [ticket({ donor: { email: "x@example.com", tags: ["a"] } }), donation()];
    const schema = describeSchema(records);
    expect(schema.email).toEqual({ types: ["string"], present: 2, looks_like: ["email"] });
    expect(schema.ticket_id).toMatchObject({ types: ["null", "string"], present: 2 });
    expect(schema["donor.email"]).toMatchObject({ types: ["string"] });
    expect(schema["donor.tags[]"]).toMatchObject({ types: ["string"] });
    expect(schema.date!.looks_like).toEqual(["datetime"]);

    const text = JSON.stringify(schema);
    for (const v of ["Jane", "example.com", "Art Soup", "Example St", "2515550123"]) {
      expect(text).not.toContain(v);
    }
  });

  it("groups records by shape", () => {
    const shapes = describeShapes([ticket(), ticket(), { ...donation(), extra: 1 }]);
    expect(shapes.map((s) => s.count)).toEqual([2, 1]);
    expect(shapes[1]!.keys).toContain("extra");
  });
});

describe("distinctValues", () => {
  it("shows values of non-personal fields", () => {
    const out = distinctValues([ticket(), donation(), ticket()], ["page_type", "payment_status", "nope"]);
    expect(out.page_type).toEqual({ values: { Event: 2, Campaign: 1 }, truncated: false });
    expect(out.payment_status).toEqual({ values: { Succeeded: 3 }, truncated: false });
    expect(out.nope).toEqual({ values: {}, truncated: false });
  });

  it("blocks personal fields", () => {
    const out = distinctValues([ticket()], [
      "email", "first_name", "full_name", "donor_phone_number", "donor_mailing_address",
      "donor_mailing_zip", "donor_billing_zip_code", "dedication_name", "donor_organization_name",
    ]);
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
