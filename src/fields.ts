/**
 * Where to find each piece of data in a Give Lively record.
 *
 * Give Lively does not document the field names in its JSON feed, so these are
 * candidate lists: the first candidate that exists on a record (and is not empty)
 * wins. Matching ignores case, spaces, dashes and underscores, so "Donor Email",
 * "donor_email" and "donorEmail" are all the same. Dotted paths reach into nested
 * objects ("donor.email").
 *
 * After running GET /sample against the real feed, reorder or replace these lists
 * so the real field name comes first. This is the main file to edit.
 */
export const FIELDS = {
  /** Unique ID for the record. Also used as Meta's event_id for dedupe. */
  id: ["line_item_id", "donation_id", "transaction_id", "id", "uuid"],

  /** When the purchase happened. */
  time: [
    "created_at",
    "donated_at",
    "transaction_date",
    "donation_date",
    "completed_at",
    "submitted_at",
    "date",
    "updated_at",
  ],

  email: ["email", "donor_email", "email_address", "purchaser_email", "donor.email"],
  firstName: ["first_name", "donor_first_name", "firstname", "donor.first_name"],
  lastName: ["last_name", "donor_last_name", "lastname", "donor.last_name"],
  /** Used only when first/last name fields are missing. */
  fullName: ["donor_name", "full_name", "name", "donor.name"],
  phone: ["phone", "phone_number", "donor_phone", "mobile", "donor.phone"],

  /**
   * Purchase value. If a field name contains "cents" the value is divided by 100.
   * Put the field that matches your choice about tips/fees first.
   */
  amount: [
    "ticket_amount",
    "ticket_price",
    "amount",
    "donation_amount",
    "total_amount",
    "gross_amount",
    "amount_cents",
    "amount_in_cents",
  ],

  quantity: ["quantity", "ticket_quantity", "num_tickets", "tickets_count"],

  status: ["status", "donation_status", "payment_status", "state"],

  /** A field whose value says what kind of line item this is ("ticket", "donation", ...). */
  type: [
    "line_item_type",
    "item_type",
    "product_type",
    "transaction_type",
    "donation_type",
    "type",
    "kind",
    "category",
  ],

  /** A field that only exists (or is only filled in) on ticket purchases. */
  ticket: ["ticket_name", "ticket_type", "ticket_level", "ticket_tier", "tickets", "ticket"],

  /** Fields searched for EVENT_MATCH (case-insensitive substring). */
  event: [
    "event_name",
    "event_title",
    "event_slug",
    "event",
    "campaign_name",
    "campaign_title",
    "campaign",
    "page_name",
    "page_title",
    "page_slug",
    "fundraising_page",
    "page_url",
    "url",
    "source",
  ],
} as const;

/** Status values that count as a completed payment. */
export const OK_STATUSES = [
  "succeeded",
  "success",
  "successful",
  "completed",
  "complete",
  "paid",
  "settled",
  "captured",
  "approved",
];

export type GLRecord = Record<string, unknown>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function getKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (key in o) return o[key];
  const want = norm(key);
  for (const k of Object.keys(o)) if (norm(k) === want) return o[k];
  return undefined;
}

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

/** Return the first non-empty candidate field, with the candidate name that matched. */
export function pick(
  record: GLRecord,
  candidates: readonly string[],
): { key: string; value: unknown } | undefined {
  for (const path of candidates) {
    let cur: unknown = record;
    for (const part of path.split(".")) cur = getKey(cur, part);
    if (!isEmpty(cur)) return { key: path, value: cur };
  }
  return undefined;
}

/** Like pick(), but only returns string or number values, as a trimmed string. */
export function pickText(record: GLRecord, candidates: readonly string[]): string | undefined {
  for (const path of candidates) {
    const hit = pick(record, [path]);
    if (hit && (typeof hit.value === "string" || typeof hit.value === "number")) {
      const s = String(hit.value).trim();
      if (s) return s;
    }
  }
  return undefined;
}

/** All string values among the candidates, for substring searches. */
export function allText(record: GLRecord, candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of candidates) {
    const s = pickText(record, [path]);
    if (s) out.push(s);
  }
  return out;
}

/** Parse "$1,234.50", 1234.5 or a cents field into dollars. */
export function pickAmount(record: GLRecord, candidates: readonly string[]): number | undefined {
  for (const path of candidates) {
    const hit = pick(record, [path]);
    if (!hit) continue;
    let n: number;
    if (typeof hit.value === "number") n = hit.value;
    else if (typeof hit.value === "string") n = Number(hit.value.replace(/[$,\s]/g, ""));
    else continue;
    if (!Number.isFinite(n)) continue;
    if (/cents/i.test(hit.key)) n = n / 100;
    return Math.round(n * 100) / 100;
  }
  return undefined;
}

/** Parse ISO strings, "YYYY-MM-DD HH:MM:SS -0500", epoch seconds or epoch ms into epoch ms. */
export function parseTimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (/^\d+$/.test(s)) return parseTimeMs(Number(s));
  const iso = s
    .replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/, "$1T$2")
    .replace(/\s*UTC$/i, "Z")
    .replace(/\s+([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}
