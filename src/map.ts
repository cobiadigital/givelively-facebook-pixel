import { FIELDS, parseTimeMs, pick, pickAmount, pickText, type GLRecord } from "./fields";
import type { Kind } from "./filter";
import { valueFields } from "./filter";
import {
  normalizeCity,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeState,
  normalizeZip,
  sha256Hex,
} from "./hash";

export interface MapConfig {
  eventPageUrl: string;
  currency: string;
  actionSource: string;
  valueField: string;
  /** Include hashed city, state, zip and country (SEND_LOCATION). */
  sendLocation: boolean;
}

type Hashed = string[];

export interface MetaEvent {
  event_name: "Purchase" | "Donate";
  event_time: number;
  event_id: string;
  action_source: string;
  event_source_url?: string;
  user_data: {
    em: Hashed;
    fn?: Hashed;
    ln?: Hashed;
    ph?: Hashed;
    ct?: Hashed;
    st?: Hashed;
    zp?: Hashed;
    country?: Hashed;
  };
  custom_data: {
    value: number;
    currency: string;
    order_id?: string;
    content_name?: string;
    content_category?: string;
    content_type?: "product";
    content_ids?: string[];
    num_items?: number;
  };
}

export type MapResult = { ok: true; value: number; event: MetaEvent } | { ok: false; reason: string };

/** Meta accepts events up to 7 days old. Keep a small safety margin. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600 * 1000 - 10 * 60 * 1000;

function splitFullName(full: string): { first?: string; last?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

async function hashed(value: string | undefined): Promise<Hashed | undefined> {
  return value ? [await sha256Hex(value)] : undefined;
}

/**
 * Turn the line items of one order (all the same kind) into a single Meta event:
 * Purchase for tickets, Donate for donations. Value is the sum of the line items.
 *
 * PII is hashed here and never leaves this function unhashed. Failure reasons are
 * short codes.
 */
export async function toMetaEvent(
  lines: GLRecord[],
  kind: Kind,
  eventId: string,
  cfg: MapConfig,
  nowMs: number,
): Promise<MapResult> {
  const first = lines[0];
  if (!first) return { ok: false, reason: "empty_order" };

  const times = lines.map((r) => parseTimeMs(pick(r, FIELDS.time)?.value));
  if (times.some((t) => t === undefined)) return { ok: false, reason: "no_time" };
  const timeMs = Math.min(...(times as number[]));
  if (nowMs - timeMs > MAX_EVENT_AGE_MS) return { ok: false, reason: "too_old" };

  let value = 0;
  for (const r of lines) {
    const v = pickAmount(r, valueFields(cfg));
    if (v === undefined || v <= 0) return { ok: false, reason: "zero_amount" };
    value += v;
  }
  value = Math.round(value * 100) / 100;

  const email = normalizeEmail(pickText(first, FIELDS.email) ?? "");
  if (!email) return { ok: false, reason: "no_email" };

  let firstName = pickText(first, FIELDS.firstName);
  let lastName = pickText(first, FIELDS.lastName);
  if (!firstName && !lastName) {
    const full = pickText(first, FIELDS.fullName);
    if (full) ({ first: firstName, last: lastName } = splitFullName(full));
  }

  const user_data: MetaEvent["user_data"] = { em: [await sha256Hex(email)] };
  const optional: [keyof MetaEvent["user_data"], string | undefined][] = [
    ["fn", firstName ? normalizeName(firstName) : undefined],
    ["ln", lastName ? normalizeName(lastName) : undefined],
    ["ph", normalizePhone(pickText(first, FIELDS.phone) ?? "")],
  ];
  if (cfg.sendLocation) {
    optional.push(
      ["ct", normalizeCity(pickText(first, FIELDS.city) ?? "")],
      ["st", normalizeState(pickText(first, FIELDS.state) ?? "")],
      ["zp", normalizeZip(pickText(first, FIELDS.zip) ?? "")],
      ["country", normalizeCountry(pickText(first, FIELDS.country) ?? "")],
    );
  }
  for (const [key, v] of optional) {
    const h = await hashed(v);
    if (h) user_data[key] = h;
  }

  const custom_data: MetaEvent["custom_data"] = { value, currency: cfg.currency };
  const orderId = pickText(first, FIELDS.orderId);
  if (orderId) custom_data.order_id = orderId;
  const contentName = pickText(first, FIELDS.contentName);
  if (contentName) custom_data.content_name = contentName.slice(0, 200);
  if (kind === "ticket") {
    custom_data.content_category = "Event Ticket";
    custom_data.content_type = "product";
    const ids = [...new Set(lines.map((r) => pickText(r, FIELDS.ticketId)).filter((s): s is string => !!s))];
    if (ids.length) custom_data.content_ids = ids;
    custom_data.num_items = lines.length;
  } else {
    custom_data.content_category = "Donation";
  }

  const event: MetaEvent = {
    event_name: kind === "ticket" ? "Purchase" : "Donate",
    event_time: Math.floor(Math.min(timeMs, nowMs) / 1000),
    event_id: eventId,
    action_source: cfg.actionSource,
    user_data,
    custom_data,
  };
  const url = pickText(first, FIELDS.pageUrl) || cfg.eventPageUrl;
  if (url) event.event_source_url = url;

  return { ok: true, value, event };
}
