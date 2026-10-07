import { FIELDS, parseTimeMs, pick, pickText, type GLRecord } from "./fields";
import { GiveLivelyError } from "./giveLively";
import { sha256Hex } from "./hash";
import { WORKER_UA } from "./probe";

/**
 * Give Lively's shareable event-ticketing CSV ("dataclip") link. One row per
 * purchase, no ID columns, and no time filter, so the whole file is fetched and
 * rows are filtered by purchase time here.
 *
 * The link itself is a secret: anyone who has it can download attendee details.
 * It is never logged or put into an error message.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Turn CSV text into records keyed by header. */
export function csvToRecords(text: string): GLRecord[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/**
 * A stable ID for a CSV row, since the export has none: a hash of the buyer's
 * email, purchase time and tier. Hashed so D1 and logs never hold the email.
 */
export async function rowId(record: GLRecord): Promise<string> {
  const parts = [
    (pickText(record, FIELDS.email) ?? "").toLowerCase(),
    pickText(record, FIELDS.time) ?? "",
    pickText(record, FIELDS.ticketId) ?? "",
  ];
  return `csv-${(await sha256Hex(parts.join("|"))).slice(0, 32)}`;
}

export async function fetchCsvRecords(
  csvUrl: string,
  startTimeMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GLRecord[]> {
  let res: Response;
  try {
    res = await fetchImpl(csvUrl, { headers: { accept: "text/csv", "user-agent": WORKER_UA } });
  } catch {
    throw new GiveLivelyError("Give Lively CSV network error");
  }
  if (!res.ok) {
    if (res.headers.has("x-datadome") || res.headers.has("x-datadome-cid")) {
      throw new GiveLivelyError(
        `Give Lively's bot protection (DataDome) blocked the CSV request (HTTP ${res.status})`,
        res.status,
      );
    }
    throw new GiveLivelyError(
      res.status === 404
        ? "Give Lively CSV link returned 404 (check GL_CSV_URL)"
        : `Give Lively CSV link returned HTTP ${res.status}`,
      res.status,
    );
  }
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (/html/i.test(type) || /^\s*</.test(text)) {
    throw new GiveLivelyError("Give Lively CSV link returned a web page, not CSV (check GL_CSV_URL)");
  }

  const out: GLRecord[] = [];
  for (const record of csvToRecords(text)) {
    // Keep rows in the window, and rows whose time can't be read (they are skipped later).
    const t = parseTimeMs(pick(record, FIELDS.time)?.value);
    if (t !== undefined && t < startTimeMs) continue;
    const id = await rowId(record);
    // One row is one purchase, so it is its own order.
    out.push({ ...record, line_item_id: id, order_id: id });
  }
  return out;
}
