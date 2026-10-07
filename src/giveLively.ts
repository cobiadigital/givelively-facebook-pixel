import type { GLRecord } from "./fields";

export class GiveLivelyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GiveLivelyError";
  }
}

export interface GiveLivelyConfig {
  glOrgId: string;
  glApiKey: string;
}

/**
 * The API key is part of the URL path, so the URL itself is a secret. It is built
 * here and never returned, logged or put into an error message.
 */
function dataUrl(cfg: GiveLivelyConfig, startTimeMs?: number): string {
  const base =
    `https://secure.givelively.org/nonprofits/${encodeURIComponent(cfg.glOrgId)}` +
    `/json_dataclips/${encodeURIComponent(cfg.glApiKey)}.json`;
  return startTimeMs === undefined
    ? base
    : `${base}?start_time_ms=${Math.max(0, Math.floor(startTimeMs))}`;
}

/** Fetch donation records created or updated since startTimeMs (most recent first). */
export async function fetchRecords(
  cfg: GiveLivelyConfig,
  startTimeMs: number | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<GLRecord[]> {
  let res: Response;
  try {
    res = await fetchImpl(dataUrl(cfg, startTimeMs), {
      headers: { accept: "application/json" },
    });
  } catch {
    // Network errors can include the URL in their message, so drop the original.
    throw new GiveLivelyError("Give Lively network error");
  }
  if (!res.ok) {
    throw new GiveLivelyError(
      res.status === 404
        ? "Give Lively returned 404 (check GL_ORG_ID and GL_API_KEY)"
        : `Give Lively returned HTTP ${res.status}`,
      res.status,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GiveLivelyError("Give Lively returned invalid JSON");
  }

  // Documented as a bare array; tolerate a wrapper object just in case.
  if (Array.isArray(body)) return body.filter(isRecord);
  if (isRecord(body)) {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v.filter(isRecord);
  }
  throw new GiveLivelyError("Give Lively response was not a list of records");
}

function isRecord(v: unknown): v is GLRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
