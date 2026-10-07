import type { GiveLivelyConfig } from "./giveLively";

/**
 * Diagnostics for GET /probe: call the Give Lively endpoints from the Worker and
 * report what came back. Never returns the API key, the full URLs or record values.
 */

export const WORKER_UA =
  "givelively-capi-worker (+https://github.com/cobiadigital/givelively-facebook-pixel)";

export type UaMode = "worker" | "none";

export interface ProbeResult {
  name: string;
  /** The URL with the org ID and API key replaced. */
  target: string;
  status: number | null;
  ok: boolean;
  elapsed_ms: number;
  /** True when DataDome bot protection answered instead of Give Lively. */
  datadome: boolean;
  server?: string | null;
  content_type?: string | null;
  /** A short, redacted description of the body. Record values are never included. */
  body: string;
  error?: string;
}

export interface ProbeReport {
  user_agent: UaMode;
  verdict: string;
  worker_egress?: { ip?: string; colo?: string; loc?: string };
  probes: ProbeResult[];
}

function redact(text: string, cfg: GiveLivelyConfig): string {
  let t = text;
  for (const secret of [cfg.glApiKey, cfg.glOrgId]) {
    if (secret) t = t.split(secret).join("[redacted]");
    if (secret) t = t.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return t;
}

async function probe(
  name: string,
  url: string,
  target: string,
  kind: "validate" | "data" | "page",
  cfg: GiveLivelyConfig,
  ua: UaMode,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ProbeResult> {
  const headers: Record<string, string> = { accept: kind === "page" ? "text/html" : "application/json" };
  if (ua === "worker") headers["user-agent"] = WORKER_UA;
  const t0 = now();
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, redirect: "manual" });
  } catch (e) {
    return {
      name, target, status: null, ok: false, elapsed_ms: now() - t0, datadome: false,
      body: "", error: redact(e instanceof Error ? e.message : String(e), cfg).slice(0, 200),
    };
  }
  const datadome = res.headers.has("x-datadome") || res.headers.has("x-datadome-cid");
  const text = await res.text().catch(() => "");
  let body: string;
  if (datadome && /captcha-delivery\.com/.test(text)) {
    body = "DataDome CAPTCHA challenge (no Give Lively response)";
  } else if (kind === "data" && res.ok) {
    // The feed holds donor data: describe it, never echo it.
    try {
      const json = JSON.parse(text);
      body = Array.isArray(json)
        ? `JSON array with ${json.length} record(s) from the last hour`
        : `JSON ${typeof json} (not an array)`;
    } catch {
      body = `not JSON (${text.length} bytes)`;
    }
  } else {
    body = redact(text.replace(/\s+/g, " ").trim(), cfg).slice(0, 200) || "(empty)";
  }
  return {
    name, target, status: res.status, ok: res.ok, elapsed_ms: now() - t0, datadome,
    server: res.headers.get("server"), content_type: res.headers.get("content-type"), body,
  };
}

async function egress(fetchImpl: typeof fetch): Promise<ProbeReport["worker_egress"]> {
  try {
    const res = await fetchImpl("https://cloudflare.com/cdn-cgi/trace");
    const kv = Object.fromEntries(
      (await res.text()).split("\n").map((l) => l.split("=", 2) as [string, string]).filter((p) => p[1]),
    );
    return { ip: kv.ip, colo: kv.colo, loc: kv.loc };
  } catch {
    return undefined;
  }
}

export async function runProbe(
  cfg: GiveLivelyConfig,
  ua: UaMode,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ProbeReport> {
  const org = encodeURIComponent(cfg.glOrgId);
  const key = encodeURIComponent(cfg.glApiKey);
  const base = "https://secure.givelively.org";
  const since = now() - 3600 * 1000;

  const probes = await Promise.all([
    probe("home page (no key)", `${base}/`, `${base}/`, "page", cfg, ua, fetchImpl, now),
    probe(
      "validate key",
      `${base}/nonprofits/${org}/json_dataclips/validate/${key}.json`,
      `${base}/nonprofits/{ORG_ID}/json_dataclips/validate/{API_KEY}.json`,
      "validate", cfg, ua, fetchImpl, now,
    ),
    probe(
      "donation feed (last hour)",
      `${base}/nonprofits/${org}/json_dataclips/${key}.json?start_time_ms=${since}`,
      `${base}/nonprofits/{ORG_ID}/json_dataclips/{API_KEY}.json?start_time_ms=…`,
      "data", cfg, ua, fetchImpl, now,
    ),
  ]);

  const [, validate, data] = probes as [ProbeResult, ProbeResult, ProbeResult];
  let verdict: string;
  if (validate.ok && data.ok) verdict = "Not blocked: the key validates and the feed returned data.";
  else if (validate.datadome || data.datadome) {
    verdict = "Blocked: DataDome bot protection answered instead of Give Lively.";
  } else if (validate.status === 404) verdict = "Reached Give Lively, but the org ID or API key is wrong (404).";
  else verdict = "Inconclusive: see the individual results.";

  return { user_agent: ua, verdict, worker_egress: await egress(fetchImpl), probes };
}
