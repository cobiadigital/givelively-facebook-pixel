import type { GLRecord } from "./fields";

/**
 * Describe the shape of feed records without exposing their values, for the
 * discovery step (GET /sample).
 */

export interface FieldInfo {
  /** JSON types seen at this path: string, number, boolean, null, object, array. */
  types: string[];
  /** How many of the sampled records have this path. */
  present: number;
  /** For strings: what they look like (iso_datetime, email, url, numeric, text...). */
  looks_like?: string[];
}

const MAX_DEPTH = 6;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A coarse description of a string that reveals its format but not its content. */
function stringKind(s: string): string {
  const t = s.trim();
  if (t === "") return "empty";
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}.*)?$/.test(t)) return "datetime";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return "email";
  if (/^https?:\/\//i.test(t)) return "url";
  if (/^-?\$?[\d,]+(\.\d+)?$/.test(t)) return "numeric";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return "uuid";
  if (/^[a-z0-9_]+$/.test(t) && t.length <= 40) return "lowercase_word";
  return "text";
}

export function describeSchema(records: GLRecord[]): Record<string, FieldInfo> {
  const out: Record<string, { types: Set<string>; present: number; kinds: Set<string> }> = {};
  for (const record of records) {
    const seen = new Set<string>();
    const walk = (v: unknown, path: string, depth: number) => {
      if (path) {
        const f = (out[path] ??= { types: new Set(), present: 0, kinds: new Set() });
        f.types.add(typeOf(v));
        if (typeof v === "string") f.kinds.add(stringKind(v));
        if (!seen.has(path)) {
          seen.add(path);
          f.present++;
        }
      }
      if (depth >= MAX_DEPTH) return;
      if (Array.isArray(v)) {
        for (const item of v) walk(item, `${path}[]`, depth + 1);
      } else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
      }
    };
    walk(record, "", 0);
  }
  const result: Record<string, FieldInfo> = {};
  for (const path of Object.keys(out).sort()) {
    const f = out[path]!;
    result[path] = { types: [...f.types].sort(), present: f.present };
    if (f.kinds.size) result[path].looks_like = [...f.kinds].sort();
  }
  return result;
}

/** Group records by their set of top-level keys, so ticket and donation shapes stand out. */
export function describeShapes(records: GLRecord[]): { count: number; keys: string[] }[] {
  const groups = new Map<string, { count: number; keys: string[] }>();
  for (const r of records) {
    const keys = Object.keys(r).sort();
    const sig = keys.join(",");
    const g = groups.get(sig);
    if (g) g.count++;
    else groups.set(sig, { count: 1, keys });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Words in a field name that mean the field holds personal data. Values of these
 * fields are never returned, even if asked for.
 */
const PII_WORDS = new Set([
  "email", "mail", "phone", "mobile", "cell", "tel", "first", "last", "firstname", "lastname",
  "fullname", "middle", "address", "address1", "address2", "street", "city", "zip", "zipcode",
  "postal", "postcode", "ip", "card", "last4", "token", "note", "notes", "comment", "comments",
  "message", "dedication", "honoree", "tribute", "employer", "occupation", "birthday", "dob",
  "donor", "user", "purchaser", "attendee", "guest", "billing", "answer", "answers", "question",
]);
/** "name" is personal unless it is the name of a thing (event, ticket, campaign...). */
const THING_WORDS = new Set([
  "event", "campaign", "page", "ticket", "fund", "nonprofit", "organization", "org",
  "designation", "product", "item", "tier", "level", "type", "fundraiser", "team",
]);

function words(path: string): string[] {
  return path
    .replace(/\[\]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isPiiPath(path: string): boolean {
  const segments = path.split(".");
  for (const seg of segments) {
    const w = words(seg);
    if (w.some((x) => PII_WORDS.has(x))) return true;
    if (w.includes("name") && !w.some((x) => THING_WORDS.has(x))) return true;
  }
  return false;
}

function getPath(record: unknown, path: string): unknown[] {
  let cur: unknown[] = [record];
  for (const part of path.split(".")) {
    const isArr = part.endsWith("[]");
    const key = isArr ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const c of cur) {
      if (!c || typeof c !== "object" || Array.isArray(c)) continue;
      const v = (c as Record<string, unknown>)[key];
      if (isArr && Array.isArray(v)) next.push(...v);
      else if (!isArr) next.push(v);
    }
    cur = next;
  }
  return cur;
}

/**
 * Distinct values for the requested (non-personal) paths, e.g. "status" or
 * "line_item_type". Values that look like emails or phone numbers are hidden anyway.
 */
export function distinctValues(
  records: GLRecord[],
  paths: string[],
  max = 25,
): Record<string, { values: Record<string, number>; truncated: boolean } | { blocked: string }> {
  const out: Record<string, { values: Record<string, number>; truncated: boolean } | { blocked: string }> = {};
  for (const path of paths.slice(0, 15)) {
    if (isPiiPath(path)) {
      out[path] = { blocked: "personal data field" };
      continue;
    }
    const values: Record<string, number> = {};
    let truncated = false;
    for (const r of records) {
      for (const v of getPath(r, path)) {
        if (v === undefined || (v !== null && typeof v === "object")) continue;
        let s = String(v);
        const isDate = /^\d{4}-\d{2}-\d{2}/.test(s);
        if (/@/.test(s) || (!isDate && /\d[\d\s().-]{8,}\d/.test(s))) s = "[hidden]";
        s = s.slice(0, 80);
        if (s in values) values[s]!++;
        else if (Object.keys(values).length < max) values[s] = 1;
        else truncated = true;
      }
    }
    out[path] = { values, truncated };
  }
  return out;
}
