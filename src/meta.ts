import type { MetaEvent } from "./map";

export interface MetaConfig {
  metaPixelId: string;
  metaAccessToken: string;
  metaApiVersion: string;
  metaTestEventCode: string;
}

export type SendResult =
  | { ok: true; received: number }
  | { ok: false; status: number; retryable: boolean; message: string };

/**
 * Meta error codes that mean "try again later" or "fix the configuration", not
 * "this event is bad". Events that fail with these are never marked rejected.
 * 1/2: unknown/temporary, 4/17/32/613/80004: rate limits, 190/10/200: token or permission.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 10, 17, 32, 190, 200, 613, 80004]);

/** POST a batch of events to the Conversions API. The token goes in the body, not the URL. */
export async function sendEvents(
  cfg: MetaConfig,
  events: MetaEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const url =
    `https://graph.facebook.com/${encodeURIComponent(cfg.metaApiVersion)}` +
    `/${encodeURIComponent(cfg.metaPixelId)}/events`;
  const body: Record<string, unknown> = { data: events, access_token: cfg.metaAccessToken };
  if (cfg.metaTestEventCode) body.test_event_code = cfg.metaTestEventCode;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, retryable: true, message: "Meta network error" };
  }

  let json: any = undefined;
  try {
    json = await res.json();
  } catch {
    // fall through with no body
  }

  if (res.ok) {
    const received = Number(json?.events_received);
    return { ok: true, received: Number.isFinite(received) ? received : events.length };
  }

  const err = json?.error ?? {};
  const code = Number(err.code);
  const parts = [
    err.error_user_title,
    err.error_user_msg || err.message,
    Number.isFinite(code) ? `code ${code}` : undefined,
    err.error_subcode ? `subcode ${err.error_subcode}` : undefined,
    err.fbtrace_id ? `trace ${err.fbtrace_id}` : undefined,
  ].filter(Boolean);
  let message = parts.join("; ") || `HTTP ${res.status}`;
  if (cfg.metaAccessToken) message = message.split(cfg.metaAccessToken).join("[redacted]");
  message = message.slice(0, 500);

  // Subcode 33: the pixel ID does not exist or the token cannot see it (config, not data).
  const retryable =
    res.status >= 500 ||
    res.status === 429 ||
    RETRYABLE_CODES.has(code) ||
    Number(err.error_subcode) === 33;
  return { ok: false, status: res.status, retryable, message };
}
