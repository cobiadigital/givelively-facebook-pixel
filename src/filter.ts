import { FIELDS, OK_STATUSES, allText, pick, pickAmount, pickText, type GLRecord } from "./fields";

export interface FilterConfig {
  /** Case-insensitive substring identifying the target event. */
  eventMatch: string;
}

export type FilterResult = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a Give Lively record is a completed, paid ticket sale for the
 * target event. Pure function: edit freely once the real feed schema is known.
 *
 * Reasons are short codes (never record values except the status word), so they
 * are safe to log and to show in /status and dry runs.
 */
export function classify(record: GLRecord, cfg: FilterConfig): FilterResult {
  const match = cfg.eventMatch.trim().toLowerCase();
  if (!match) return { ok: false, reason: "event_match_not_set" };

  // 1. Ticket line item, not a plain donation.
  const type = (pickText(record, FIELDS.type) ?? "").toLowerCase();
  const hasTicketField = pick(record, FIELDS.ticket) !== undefined;
  if (!type.includes("ticket") && !hasTicketField) return { ok: false, reason: "not_ticket" };

  // 2. Belongs to the target event.
  const haystack = allText(record, FIELDS.event).join(" | ").toLowerCase();
  if (!haystack.includes(match)) return { ok: false, reason: "other_event" };

  // 3. Payment completed. Records without a status field are allowed through.
  const status = pickText(record, FIELDS.status)?.toLowerCase();
  if (status !== undefined && !OK_STATUSES.includes(status)) {
    return { ok: false, reason: `status_${status.replace(/[^a-z_]/g, "").slice(0, 30)}` };
  }

  // 4. Paid (excludes complimentary tickets).
  const amount = pickAmount(record, FIELDS.amount);
  if (amount === undefined || amount <= 0) return { ok: false, reason: "zero_amount" };

  return { ok: true };
}

export function isTicketSale(record: GLRecord, cfg: FilterConfig): boolean {
  return classify(record, cfg).ok;
}
