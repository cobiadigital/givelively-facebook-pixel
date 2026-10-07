import type { Kind } from "./filter";

export interface Env {
  DB: D1Database;

  // Give Lively
  GL_ORG_ID?: string;
  GL_API_KEY?: string; // secret

  // Meta
  META_PIXEL_ID?: string;
  META_ACCESS_TOKEN?: string; // secret
  META_API_VERSION?: string;
  META_TEST_EVENT_CODE?: string;
  META_ACTION_SOURCE?: string;

  // Event targeting
  EVENT_MATCH?: string;
  EVENT_PAGE_URL?: string;
  CURRENCY?: string;

  // Behavior
  TRACK?: string;
  VALUE_FIELD?: string;
  SEND_LOCATION?: string;
  SEND_TO_META?: string;
  OVERLAP_MS?: string;
  BACKFILL_HOURS?: string;

  // Admin
  ADMIN_TOKEN?: string; // secret
}

export interface Config {
  glOrgId: string;
  glApiKey: string;
  metaPixelId: string;
  metaAccessToken: string;
  metaApiVersion: string;
  metaTestEventCode: string;
  actionSource: string;
  eventMatch: string;
  eventPageUrl: string;
  currency: string;
  track: Kind[];
  valueField: string;
  sendLocation: boolean;
  sendEnabled: boolean;
  overlapMs: number;
  backfillHours: number;
  adminToken: string;
}

const clean = (v: string | undefined): string => (v ?? "").trim();

function num(v: string | undefined, fallback: number): number {
  const n = Number(clean(v));
  return clean(v) !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** TRACK: "tickets" (default), "donations" or "both". */
function parseTrack(v: string | undefined): Kind[] {
  const t = clean(v).toLowerCase();
  if (t === "both" || t === "all") return ["ticket", "donation"];
  if (t === "donations" || t === "donation") return ["donation"];
  return ["ticket"];
}

export function loadConfig(env: Env): Config {
  return {
    glOrgId: clean(env.GL_ORG_ID),
    glApiKey: clean(env.GL_API_KEY),
    metaPixelId: clean(env.META_PIXEL_ID),
    metaAccessToken: clean(env.META_ACCESS_TOKEN),
    metaApiVersion: clean(env.META_API_VERSION) || "v26.0",
    metaTestEventCode: clean(env.META_TEST_EVENT_CODE),
    actionSource: clean(env.META_ACTION_SOURCE) || "website",
    eventMatch: clean(env.EVENT_MATCH),
    eventPageUrl: clean(env.EVENT_PAGE_URL),
    currency: (clean(env.CURRENCY) || "USD").toUpperCase(),
    track: parseTrack(env.TRACK),
    valueField: clean(env.VALUE_FIELD) || "original_amount",
    sendLocation: clean(env.SEND_LOCATION).toLowerCase() !== "false",
    sendEnabled: clean(env.SEND_TO_META).toLowerCase() === "true",
    overlapMs: num(env.OVERLAP_MS, 600_000),
    backfillHours: num(env.BACKFILL_HOURS, 0),
    adminToken: clean(env.ADMIN_TOKEN),
  };
}

/** Names of settings required to read from Give Lively. */
export function missingForFetch(cfg: Config): string[] {
  const missing: string[] = [];
  if (!cfg.glOrgId) missing.push("GL_ORG_ID");
  if (!cfg.glApiKey) missing.push("GL_API_KEY");
  return missing;
}

/** Names of settings required to filter, map and send to Meta. */
export function missingForSend(cfg: Config): string[] {
  const missing = missingForFetch(cfg);
  if (!cfg.metaPixelId) missing.push("META_PIXEL_ID");
  if (!cfg.metaAccessToken) missing.push("META_ACCESS_TOKEN");
  if (!cfg.eventMatch) missing.push("EVENT_MATCH");
  return missing;
}
