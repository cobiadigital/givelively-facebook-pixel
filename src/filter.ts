import { FIELDS, OK_STATUSES, allText, pick, pickAmount, pickText, type GLRecord } from "./fields";

/** What a line item is. Tickets go to Meta as Purchase, donations as Donate. */
export type Kind = "ticket" | "donation";

export interface FilterConfig {
  /** Case-insensitive substring of the page/event/campaign name, slug or URL. */
  eventMatch: string;
  /** When true, an empty eventMatch matches everything (single-event CSV source). */
  allowEmptyMatch?: boolean;
  /** Which kinds to send (TRACK setting). */
  track: readonly Kind[];
  /** Field holding the value (VALUE_FIELD), tried before the defaults. */
  valueField: string;
}

export type FilterResult = { ok: true; kind: Kind } | { ok: false; reason: string };

export function kindOf(record: GLRecord): Kind {
  return pick(record, FIELDS.ticketId) ? "ticket" : "donation";
}

export function valueFields(cfg: Pick<FilterConfig, "valueField">): string[] {
  return cfg.valueField ? [cfg.valueField, ...FIELDS.amount] : [...FIELDS.amount];
}

/**
 * Decide whether a Give Lively line item should be sent to Meta. Pure function.
 *
 * Reasons are short codes (never record values except the status word), so they
 * are safe to log and to show in /status and dry runs.
 */
export function classify(record: GLRecord, cfg: FilterConfig): FilterResult {
  const match = cfg.eventMatch.trim().toLowerCase();
  if (!match && !cfg.allowEmptyMatch) return { ok: false, reason: "event_match_not_set" };

  // 1. Tickets have a ticket_id. Everything else is a donation.
  const kind = kindOf(record);
  if (!cfg.track.includes(kind)) return { ok: false, reason: `${kind}_not_tracked` };

  // 2. Belongs to the target page/event/campaign.
  const haystack = allText(record, FIELDS.match).join(" | ").toLowerCase();
  if (match && !haystack.includes(match)) return { ok: false, reason: "other_page" };

  // 3. Paid, and not refunded or disputed.
  const status = (pickText(record, FIELDS.status) ?? "").toLowerCase();
  if (!OK_STATUSES.includes(status)) {
    return { ok: false, reason: `status_${status.replace(/[^a-z_]/g, "").slice(0, 30) || "missing"}` };
  }
  if ((pickAmount(record, FIELDS.refundedAmount) ?? 0) > 0) return { ok: false, reason: "refunded" };
  const refundStatus = (pickText(record, FIELDS.refundStatus) ?? "").toLowerCase();
  if (refundStatus && refundStatus !== "none") return { ok: false, reason: "refunded" };
  if (pick(record, FIELDS.disputedAt)) return { ok: false, reason: "disputed" };

  // 4. Has a value (excludes complimentary tickets).
  const amount = pickAmount(record, valueFields(cfg));
  if (amount === undefined || amount <= 0) return { ok: false, reason: "zero_amount" };

  return { ok: true, kind };
}

export function isTicketSale(record: GLRecord, cfg: FilterConfig): boolean {
  const r = classify(record, cfg);
  return r.ok && r.kind === "ticket";
}
