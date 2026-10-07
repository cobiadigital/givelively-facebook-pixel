import type { Config } from "./config";
import { fetchCsvRecords } from "./csv";
import type { GLRecord } from "./fields";
import { fetchRecords } from "./giveLively";

/**
 * Load Give Lively records from whichever source is configured: the CSV link
 * (GL_CSV_URL) when set, otherwise the Zapier JSON feed (GL_ORG_ID + GL_API_KEY).
 */
export function loadRecords(
  cfg: Config,
  startTimeMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<GLRecord[]> {
  return cfg.source === "csv"
    ? fetchCsvRecords(cfg.csvUrl, startTimeMs, fetchImpl)
    : fetchRecords(cfg, startTimeMs, fetchImpl);
}
