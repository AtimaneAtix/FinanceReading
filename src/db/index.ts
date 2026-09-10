import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ROOT, type SourceConfig } from '../config.ts';

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

export function openDb(path = process.env.DB_PATH ?? resolve(ROOT, 'data/feeds.db')): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL lets the worker write while the web server reads.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current === 0) {
    db.exec(readFileSync(resolve(ROOT, 'src/db/schema.sql'), 'utf8'));
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema is version ${current}, but this build understands ${SCHEMA_VERSION}. ` +
        'Use a newer build, or remove data/feeds.db to start over.',
    );
  }
  // Future migrations land here, guarded by `current < n`.
}

// --- sources ---------------------------------------------------------------

export interface SourceRow {
  id: string;
  institution: string;
  name: string;
  homepage: string;
  adapter_kind: string;
  config_json: string;
  static_tags: string;
  poll_minutes: number;
  enabled: number;
  in_config: number;
  etag: string | null;
  last_modified: string | null;
  last_fetch_at: number | null;
  last_status: string | null;
  last_error: string | null;
  last_item_count: number | null;
  consecutive_failures: number;
}

/**
 * Makes the sources table match the YAML. Sources dropped from the config are
 * marked `in_config = 0` rather than deleted, so their articles stay readable.
 */
export function syncSources(
  db: DB,
  sources: SourceConfig[],
  defaultPoll: number,
  defaultTake: number,
): void {
  const upsert = db.prepare(`
    INSERT INTO sources (id, institution, name, homepage, adapter_kind, config_json,
                         static_tags, poll_minutes, enabled, in_config)
    VALUES (@id, @institution, @name, @homepage, @adapter_kind, @config_json,
            @static_tags, @poll_minutes, @enabled, 1)
    ON CONFLICT(id) DO UPDATE SET
      institution = excluded.institution,
      name = excluded.name,
      homepage = excluded.homepage,
      adapter_kind = excluded.adapter_kind,
      config_json = excluded.config_json,
      static_tags = excluded.static_tags,
      poll_minutes = excluded.poll_minutes,
      enabled = excluded.enabled,
      in_config = 1
  `);

  db.transaction(() => {
    db.prepare('UPDATE sources SET in_config = 0').run();
    for (const s of sources) {
      upsert.run({
        id: s.id,
        institution: s.institution,
        name: s.name,
        homepage: s.homepage,
        adapter_kind: s.adapter.kind,
        config_json: JSON.stringify({
          adapter: s.adapter,
          fallback: s.fallback,
          takePerRun: s.take_per_run ?? defaultTake,
        }),
        static_tags: JSON.stringify(s.static_tags),
        poll_minutes: s.poll_minutes ?? defaultPoll,
        enabled: s.enabled ? 1 : 0,
      });
    }
  })();
}

export function allSources(db: DB): SourceRow[] {
  return db.prepare('SELECT * FROM sources ORDER BY institution, name').all() as SourceRow[];
}

export function dueSources(db: DB, now: number): SourceRow[] {
  return db
    .prepare(
      // Repeated failures back off: the wait doubles per failure, capped at 16x
      // the normal interval, so a dead source stops costing a request every cycle.
      `SELECT * FROM sources
        WHERE enabled = 1 AND in_config = 1
          AND (last_fetch_at IS NULL
               OR last_fetch_at + (poll_minutes * 60000 * (1 << MIN(consecutive_failures, 4))) <= ?)
        ORDER BY COALESCE(last_fetch_at, 0) ASC`,
    )
    .all(now) as SourceRow[];
}

export function recordFetch(
  db: DB,
  sourceId: string,
  result: {
    status: string;
    error?: string | null;
    itemCount?: number | null;
    etag?: string | null;
    lastModified?: string | null;
  },
): void {
  const ok = result.status === 'ok' || result.status === 'not-modified';
  db.prepare(
    `UPDATE sources SET
       last_fetch_at = ?, last_status = ?, last_error = ?, last_item_count = ?,
       etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
       consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END
     WHERE id = ?`,
  ).run(
    Date.now(),
    result.status,
    result.error ?? null,
    result.itemCount ?? null,
    result.etag ?? null,
    result.lastModified ?? null,
    ok ? 1 : 0,
    sourceId,
  );
}

// --- items -----------------------------------------------------------------

export interface NewItem {
  sourceId: string;
  institution: string;
  url: string;
  canonicalHash: string;
  title: string;
  titleKey: string;
  summary: string | null;
  publishedAt: number;
  dateEstimated: boolean;
  nativeCategories: string[];
  tags: string[];
}

/** How far apart two identical titles may be and still count as one article. */
const NEAR_DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface InsertStats {
  inserted: number;
  duplicateUrl: number;
  duplicateTitle: number;
}

export function insertItems(db: DB, items: NewItem[]): InsertStats {
  const stats: InsertStats = { inserted: 0, duplicateUrl: 0, duplicateTitle: 0 };

  const byHash = db.prepare('SELECT id FROM items WHERE canonical_hash = ?');
  const byTitle = db.prepare(
    `SELECT id FROM items
      WHERE institution = ? AND title_key = ?
        AND ABS(published_at - ?) <= ?
      LIMIT 1`,
  );
  const insertItem = db.prepare(
    `INSERT INTO items (source_id, institution, url, canonical_hash, title, title_key,
                        summary, published_at, date_estimated, first_seen_at, native_categories)
     VALUES (@source_id, @institution, @url, @canonical_hash, @title, @title_key,
             @summary, @published_at, @date_estimated, @first_seen_at, @native_categories)`,
  );
  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)',
  );

  db.transaction(() => {
    for (const it of items) {
      if (byHash.get(it.canonicalHash)) {
        stats.duplicateUrl++;
        continue;
      }
      // A title_key of '' means the title was unusable for matching; never let
      // that collapse unrelated articles together.
      if (
        it.titleKey !== '' &&
        byTitle.get(it.institution, it.titleKey, it.publishedAt, NEAR_DUPLICATE_WINDOW_MS)
      ) {
        stats.duplicateTitle++;
        continue;
      }
      const info = insertItem.run({
        source_id: it.sourceId,
        institution: it.institution,
        url: it.url,
        canonical_hash: it.canonicalHash,
        title: it.title,
        title_key: it.titleKey,
        summary: it.summary,
        published_at: it.publishedAt,
        date_estimated: it.dateEstimated ? 1 : 0,
        first_seen_at: Date.now(),
        native_categories: JSON.stringify(it.nativeCategories),
      });
      for (const tag of new Set(it.tags)) insertTag.run(info.lastInsertRowid, tag);
      stats.inserted++;
    }
  })();

  return stats;
}

export function markUrlsSeen(db: DB, sourceId: string, hashes: string[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO seen_urls (source_id, canonical_hash, seen_at) VALUES (?, ?, ?)',
  );
  const now = Date.now();
  db.transaction(() => {
    for (const h of hashes) stmt.run(sourceId, h, now);
  })();
}

/** Which of these canonical hashes are already stored, from any source. */
export function knownHashes(db: DB, hashes: string[]): Set<string> {
  const stmt = db.prepare('SELECT 1 FROM items WHERE canonical_hash = ?');
  const out = new Set<string>();
  for (const h of hashes) if (stmt.get(h)) out.add(h);
  return out;
}

export function filterUnseen(db: DB, sourceId: string, hashes: string[]): Set<string> {
  const stmt = db.prepare(
    'SELECT 1 FROM seen_urls WHERE source_id = ? AND canonical_hash = ?',
  );
  const out = new Set<string>();
  for (const h of hashes) if (!stmt.get(sourceId, h)) out.add(h);
  return out;
}
