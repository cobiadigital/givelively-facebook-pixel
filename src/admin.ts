import { loadConfig, missingForFetch, missingForSend, type Env } from "./config";
import { D1Store } from "./db";
import { classify } from "./filter";
import { GiveLivelyError, fetchRecords } from "./giveLively";
import { runPoll } from "./poll";
import { describeSchema, describeShapes, distinctValues } from "./schema";
import { CONSOLE_HTML } from "./console";

export const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...data }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time bearer token check. Denies everything if ADMIN_TOKEN is not set. */
export async function authorized(req: Request, adminToken: string): Promise<boolean> {
  if (!adminToken) return false;
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]!.trim()), digest(adminToken)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const cfg = loadConfig(env);

  if (url.pathname === "/" && req.method === "GET") {
    return new Response(CONSOLE_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const routes = ["/status", "/run", "/sample"];
  if (!routes.includes(url.pathname)) return json({ error: "not found" }, 404);

  if (!cfg.adminToken) return json({ error: "ADMIN_TOKEN secret is not set" }, 503);
  if (!(await authorized(req, cfg.adminToken))) return json({ error: "unauthorized" }, 401);

  const store = new D1Store(env.DB);

  if (url.pathname === "/status" && req.method === "GET") {
    await store.init();
    const [cursor, lastRun, counts, recent] = await Promise.all([
      store.getState("cursor_ms"),
      store.getState("last_run"),
      store.counts(),
      store.recent(10),
    ]);
    return json({
      now: new Date().toISOString(),
      send_to_meta: cfg.sendEnabled,
      test_events_mode: !!cfg.metaTestEventCode,
      track: cfg.track,
      value_field: cfg.valueField,
      send_location: cfg.sendLocation,
      action_source: cfg.actionSource,
      meta_api_version: cfg.metaApiVersion,
      event_match_set: !!cfg.eventMatch,
      missing_settings: missingForSend(cfg),
      cursor: cursor ? new Date(Number(cursor)).toISOString() : null,
      last_run: lastRun ? JSON.parse(lastRun) : null,
      counts,
      recent,
    });
  }

  if (url.pathname === "/run" && req.method === "POST") {
    const wantDry = url.searchParams.get("dry") === "1";
    const dryRun = wantDry || !cfg.sendEnabled;
    const hours = Number(url.searchParams.get("hours"));
    const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : undefined;
    const summary = await runPoll(
      cfg,
      { store, fetch: (...a) => fetch(...a), now: Date.now, log },
      { trigger: "manual", dryRun, windowHours: dryRun ? windowHours : undefined },
    );
    return json({
      ...(dryRun && !wantDry
        ? { note: "SEND_TO_META is not \"true\", so this was a dry run. Nothing was sent or saved." }
        : {}),
      ...summary,
    });
  }

  if (url.pathname === "/sample" && req.method === "GET") {
    const missing = missingForFetch(cfg);
    if (missing.length) return json({ error: `Missing settings: ${missing.join(", ")}` }, 400);

    const hours = Math.min(Math.max(Number(url.searchParams.get("hours") ?? 24) || 24, 1), 24 * 400);
    const valuePaths = (url.searchParams.get("values") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let records;
    try {
      records = await fetchRecords(cfg, Date.now() - hours * 3600 * 1000);
    } catch (e) {
      return json({ error: e instanceof GiveLivelyError ? e.message : "fetch failed" }, 502);
    }
    const sampled = records.slice(0, 200);

    let classification: Record<string, number> | undefined;
    if (cfg.eventMatch) {
      classification = {};
      for (const r of records) {
        const c = classify(r, cfg);
        const k = c.ok ? "ticket_sale" : c.reason;
        classification[k] = (classification[k] ?? 0) + 1;
      }
    }

    return json({
      window_hours: hours,
      fetched: records.length,
      sampled: sampled.length,
      note: "Field names and types only. Add ?values=field1,field2 to see distinct values of non-personal fields.",
      shapes: describeShapes(sampled),
      schema: describeSchema(sampled),
      ...(valuePaths.length ? { values: distinctValues(sampled, valuePaths) } : {}),
      ...(classification ? { current_filter: classification } : {}),
    });
  }

  return json({ error: "method not allowed" }, 405);
}
