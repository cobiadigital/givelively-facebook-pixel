/**
 * Where to find each piece of data in a Give Lively record.
 *
 * Field names come from the Give Lively Zapier JSON feed (json_dataclips), which
 * returns one record per line item. Each list is tried in order and the first
 * non-empty field wins. Matching ignores case, spaces, dashes and underscores.
 */
export const FIELDS = {
  /** One record per line item (one ticket, or one donation). */
  lineId: ["line_item_id"],
  /** Line items bought together share an order ID. Sent to Meta as order_id. */
  orderId: ["order_id"],

  /** When the payment went through. */
  time: ["payment_succeeded_date", "payment_platform_donation_date", "date"],

  email: ["email"],
  firstName: ["first_name"],
  lastName: ["last_name"],
  fullName: ["full_name"],
  phone: ["donor_phone_number"],
  city: ["donor_mailing_city"],
  state: ["donor_mailing_state"],
  zip: ["donor_mailing_zip", "donor_billing_zip_code"],
  country: ["donor_mailing_country", "donor_billing_country"],

  /**
   * Purchase value fields, used when VALUE_FIELD is not set or is empty on a record.
   * original_amount: ticket price or donation amount.
   * gross_amount: what the buyer paid, including fees they chose to cover.
   * net_amount: what the nonprofit receives after fees.
   */
  amount: ["original_amount", "gross_amount"],

  status: ["payment_status"],
  refundedAmount: ["total_refunded_amount"],
  refundStatus: ["refund_status"],
  disputedAt: ["disputed_at"],

  /** Only filled in on ticket line items (the ticket type ID). */
  ticketId: ["ticket_id"],

  /** Fields searched for EVENT_MATCH (case-insensitive substring). */
  match: ["page_name", "page_slug", "event_name", "internal_name", "campaign_name", "page_url"],
  /** Shown as Meta content_name. */
  contentName: ["event_name", "campaign_name", "page_name"],
  /** Sent as event_source_url. Falls back to EVENT_PAGE_URL. */
  pageUrl: ["page_url"],
} as const;

/** payment_status values that count as paid. */
export const OK_STATUSES = ["succeeded", "success", "successful", "completed", "complete", "paid"];

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
