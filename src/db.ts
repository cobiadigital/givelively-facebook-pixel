/**
 * Persistence for dedupe, the poll cursor and run history.
 *
 * Only IDs, timestamps, values and status codes are stored. Never raw PII.
 */

/** Final statuses: an event_id with one of these is never sent again. */
export const FINAL_STATUSES = ["sent", "skipped", "rejected"] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

export interface EventRow {
  event_id: string;
  status: FinalStatus | "failed";
  value: number | null;
  reason: string | null;
  sent_at: string;
  attempts?: number;
}

export interface Store {
  init(): Promise<void>;
  getState(key: string): Promise<string | null>;
  setState(entries: Record<string, string>): Promise<void>;
  /** IDs among `ids` that have a final status. */
  getFinalIds(ids: string[]): Promise<Set<string>>;
  /** Insert final rows. Existing final rows are never overwritten. */
  recordFinal(rows: { event_id: string; status: FinalStatus; value: number | null; reason: string | null }[], nowIso: string): Promise<void>;
  /** Count a failed attempt for each id and return the new attempt counts. */
  recordFailures(rows: { event_id: string; value: number | null; reason: string }[], nowIso: string): Promise<Map<string, number>>;
  acquireLock(owner: string, nowMs: number, ttlMs: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  counts(): Promise<Record<string, number>>;
  recent(limit: number): Promise<EventRow[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sent_events (
    event_id TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL,
    value REAL,
    status TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)`,
];

/** D1 allows 100 bound parameters per statement. */
const CHUNK = 90;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async init(): Promise<void> {
    await this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql)));
  }

  async getState(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM state WHERE key = ?1")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setState(entries: Record<string, string>): Promise<void> {
    const stmts = Object.entries(entries).map(([k, v]) =>
      this.db
        .prepare(
          "INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(k, v),
    );
    if (stmts.length) await this.db.batch(stmts);
  }

  async getFinalIds(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const part of chunks(ids, CHUNK)) {
      const placeholders = part.map((_, i) => `?${i + 1}`).join(",");
      const { results } = await this.db
        .prepare(
          `SELECT event_id FROM sent_events WHERE status IN ('sent','skipped','rejected') AND event_id IN (${placeholders})`,
        )
        .bind(...part)
        .all<{ event_id: string }>();
      for (const r of results) found.add(r.event_id);
    }
    return found;
  }

  async recordFinal(
    rows: { event_id: string; status: FinalStatus; value: number | null; reason: string | null }[],
    nowIso: string,
  ): Promise<void> {
    if (!rows.length) return;
    const stmts = rows.map((r) =>
      this.db
        .prepare(
          `INSERT INTO sent_events (event_id, sent_at, value, status, reason) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(event_id) DO UPDATE SET sent_at = excluded.sent_at, value = excluded.value,
             status = excluded.status, reason = excluded.reason
           WHERE sent_events.status = 'failed'`,
        )
        .bind(r.event_id, nowIso, r.value, r.status, r.reason),
    );
    await this.db.batch(stmts);
  }

  async recordFailures(
    rows: { event_id: string; value: number | null; reason: string }[],
    nowIso: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!rows.length) return out;
    const stmts = rows.map((r) =>
      this.db
        .prepare(
          `INSERT INTO sent_events (event_id, sent_at, value, status, reason, attempts) VALUES (?1, ?2, ?3, 'failed', ?4, 1)
           ON CONFLICT(event_id) DO UPDATE SET sent_at = excluded.sent_at, reason = excluded.reason,
             attempts = sent_events.attempts + 1
           WHERE sent_events.status = 'failed'
           RETURNING event_id, attempts`,
        )
        .bind(r.event_id, nowIso, r.value, r.reason),
    );
    const results = await this.db.batch<{ event_id: string; attempts: number }>(stmts);
    for (const res of results) for (const row of res.results) out.set(row.event_id, row.attempts);
    return out;
  }

  async acquireLock(owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO locks (name, owner, until) VALUES ('poll', ?1, ?2)
         ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until = excluded.until
         WHERE locks.until < ?3`,
      )
      .bind(owner, nowMs + ttlMs, nowMs)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async releaseLock(owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM locks WHERE name = 'poll' AND owner = ?1").bind(owner).run();
  }

  async counts(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM sent_events GROUP BY status")
      .all<{ status: string; n: number }>();
    const out: Record<string, number> = { sent: 0, skipped: 0, rejected: 0, failed: 0 };
    for (const r of results) out[r.status] = r.n;
    return out;
  }

  async recent(limit: number): Promise<EventRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT event_id, status, value, reason, sent_at, attempts FROM sent_events ORDER BY sent_at DESC LIMIT ?1",
      )
      .bind(limit)
      .all<EventRow>();
    return results;
  }
}
