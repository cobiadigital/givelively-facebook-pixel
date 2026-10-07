import { FIELDS, parseTimeMs, pick, pickAmount, pickText, type GLRecord } from "./fields";
import { normalizeEmail, normalizeName, normalizePhone, sha256Hex } from "./hash";

export interface MapConfig {
  eventPageUrl: string;
  currency: string;
  actionSource: string;
}

export interface MetaEvent {
  event_name: "Purchase";
  event_time: number;
  event_id: string;
  action_source: string;
  event_source_url?: string;
  user_data: { em: string[]; fn?: string[]; ln?: string[]; ph?: string[] };
  custom_data: { value: number; currency: string; content_name?: string; num_items?: number };
}

export type MapResult =
  | { ok: true; id: string; value: number; event: MetaEvent }
  | { ok: false; id?: string; reason: string };

/** Meta accepts events up to 7 days old. Keep a small safety margin. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600 * 1000 - 10 * 60 * 1000;

function splitFullName(full: string): { first?: string; last?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/**
 * Turn a qualifying Give Lively record into a Meta Purchase event. PII is hashed
 * here and never leaves this function unhashed. Failure reasons are short codes.
 */
export async function toMetaEvent(
  record: GLRecord,
  cfg: MapConfig,
  nowMs: number,
): Promise<MapResult> {
  const id = pickText(record, FIELDS.id);
  if (!id) return { ok: false, reason: "no_id" };

  const timeMs = parseTimeMs(pick(record, FIELDS.time)?.value);
  if (timeMs === undefined) return { ok: false, id, reason: "no_time" };
  if (nowMs - timeMs > MAX_EVENT_AGE_MS) return { ok: false, id, reason: "too_old" };

  const value = pickAmount(record, FIELDS.amount);
  if (value === undefined || value <= 0) return { ok: false, id, reason: "zero_amount" };

  const email = normalizeEmail(pickText(record, FIELDS.email) ?? "");
  if (!email) return { ok: false, id, reason: "no_email" };

  let first = pickText(record, FIELDS.firstName);
  let last = pickText(record, FIELDS.lastName);
  if (!first && !last) {
    const full = pickText(record, FIELDS.fullName);
    if (full) ({ first, last } = splitFullName(full));
  }
  const fn = first ? normalizeName(first) : undefined;
  const ln = last ? normalizeName(last) : undefined;
  const ph = normalizePhone(pickText(record, FIELDS.phone) ?? "");

  const user_data: MetaEvent["user_data"] = { em: [await sha256Hex(email)] };
  if (fn) user_data.fn = [await sha256Hex(fn)];
  if (ln) user_data.ln = [await sha256Hex(ln)];
  if (ph) user_data.ph = [await sha256Hex(ph)];

  const custom_data: MetaEvent["custom_data"] = { value, currency: cfg.currency };
  const eventName = pickText(record, FIELDS.event.slice(0, 7));
  if (eventName) custom_data.content_name = eventName.slice(0, 200);
  const qtyHit = pick(record, FIELDS.quantity);
  const qty = Number(qtyHit?.value);
  if (Number.isInteger(qty) && qty > 0) custom_data.num_items = qty;
  else {
    const tickets = pick(record, FIELDS.ticket)?.value;
    if (Array.isArray(tickets)) custom_data.num_items = tickets.length;
  }

  const event: MetaEvent = {
    event_name: "Purchase",
    event_time: Math.floor(Math.min(timeMs, nowMs) / 1000),
    event_id: id,
    action_source: cfg.actionSource,
    user_data,
    custom_data,
  };
  if (cfg.eventPageUrl) event.event_source_url = cfg.eventPageUrl;

  return { ok: true, id, value, event };
}
