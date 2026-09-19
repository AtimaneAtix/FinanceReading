import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ROOT, type SourceConfig } from '../config.ts';

export type DB = Database.Database;

const SCHEMA_VERSION = 2;

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
  if (current < 2) {
    // Replaying schema.sql adds the tables an older database is missing and
    // leaves the rest alone, because every statement in it is IF NOT EXISTS.
    // That covers a migration that only adds tables; one that alters an
    // existing table needs its own explicit step here.
    db.exec(readFileSync(resolve(ROOT, 'src/db/schema.sql'), 'utf8'));
    db.pragma('user_version = 2');
  }
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

  // Both tables, so an article that was deliberately pruned cannot be
  // re-inserted by a feed that still lists it.
  const byHash = db.prepare(
    `SELECT 1 FROM items WHERE canonical_hash = ?
      UNION ALL
     SELECT 1 FROM pruned_urls WHERE canonical_hash = ? LIMIT 1`,
  );
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
      if (byHash.get(it.canonicalHash, it.canonicalHash)) {
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

// --- pruning ---------------------------------------------------------------

/**
 * What "older than the cutoff" means, per article.
 *
 * `published_at` carries two different kinds of fact. When the publisher stated
 * a date it is a publication date and can be judged directly. When
 * `date_estimated` is set it is a guess -- a sitemap `lastmod`, which tracks
 * CMS rebuilds rather than publication, or simply the moment of first sight
 * when nothing parsed at all -- and deleting on a guess is not something to do
 * quietly.
 *
 * So an estimated article is judged on the one date that is not in doubt:
 * how long it has been in your list. It goes a year after it arrived, rather
 * than a year after a timestamp nobody vouched for.
 */
const OLDER_THAN = `(
  (items.date_estimated = 0 AND items.published_at < ?)
  OR
  (items.date_estimated = 1 AND items.first_seen_at < ?)
)`;

export interface PrunePreview {
  total: number;
  /** Of `total`, those judged on a date the publisher stated. */
  stated: number;
  /** Of `total`, those judged on how long they have been in the list. */
  estimated: number;
  keeping: number;
  byInstitution: { institution: string; count: number }[];
  /** Tag rows whose article is already gone; see `sweepOrphanTags`. */
  orphanTags: number;
}

/** What a cut at `cutoff` would remove, without removing it. */
export function prunePreview(db: DB, cutoff: number): PrunePreview {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${OLDER_THAN}`)
    .get(cutoff, cutoff) as { n: number }).n;
  const stated = (db.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE ${OLDER_THAN} AND items.date_estimated = 0`,
  ).get(cutoff, cutoff) as { n: number }).n;
  const keeping = (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE NOT ${OLDER_THAN}`)
    .get(cutoff, cutoff) as { n: number }).n;
  const byInstitution = db
    .prepare(
      `SELECT institution, COUNT(*) AS count FROM items
        WHERE ${OLDER_THAN} GROUP BY institution ORDER BY count DESC, institution ASC`,
    )
    .all(cutoff, cutoff) as { institution: string; count: number }[];
  return {
    total,
    stated,
    estimated: total - stated,
    keeping,
    byInstitution,
    orphanTags: countOrphanTags(db),
  };
}

function countOrphanTags(db: DB): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM item_tags WHERE item_id NOT IN (SELECT id FROM items)',
  ).get() as { n: number }).n;
}

/**
 * Removes tag rows whose article is no longer there.
 *
 * ON DELETE CASCADE handles this whenever an article is deleted through the
 * app, because `openDb` turns foreign keys on. A deletion from a sqlite3
 * session does not: the pragma is per-connection and the CLI leaves it off, so
 * the tags stay behind. They are invisible either way -- every query reaches
 * item_tags through a join on items -- which is exactly why they accumulate
 * unnoticed.
 */
export function sweepOrphanTags(db: DB): number {
  return db
    .prepare('DELETE FROM item_tags WHERE item_id NOT IN (SELECT id FROM items)')
    .run().changes;
}

export interface PruneResult {
  deleted: number;
  tags: number;
  orphanTags: number;
  bytesFreed: number;
}

/**
 * Deletes every article published before `cutoff`, and remembers their URLs.
 *
 * The remembering is the part that makes this work at all. A feed's window
 * reaches back much further than its length suggests, and rss and json sources
 * judge novelty against the items table alone -- so without a tombstone a
 * pruned article that is still listed comes back on the very next run, is
 * pruned again on the next pass, and churns forever.
 */
export function pruneOlderThan(db: DB, cutoff: number): PruneResult {
  const sizeBefore = pageBytes(db);
  let deleted = 0;
  let tags = 0;
  let orphanTags = 0;

  db.transaction(() => {
    tags = (db.prepare(
      `SELECT COUNT(*) AS n FROM item_tags
        WHERE item_id IN (SELECT id FROM items WHERE ${OLDER_THAN})`,
    ).get(cutoff, cutoff) as { n: number }).n;

    // Tombstones first: once the rows are gone their hashes are gone too.
    db.prepare(
      `INSERT OR IGNORE INTO pruned_urls (canonical_hash, pruned_at)
       SELECT canonical_hash, ? FROM items WHERE ${OLDER_THAN}`,
    ).run(Date.now(), cutoff, cutoff);

    // item_tags follows by ON DELETE CASCADE, which openDb enables.
    deleted = db.prepare(`DELETE FROM items WHERE ${OLDER_THAN}`).run(cutoff, cutoff).changes;
    orphanTags = sweepOrphanTags(db);
  })();

  // Outside the transaction, because VACUUM cannot run inside one -- and only
  // when something went, since it rewrites the whole file.
  if (deleted > 0 || orphanTags > 0) db.exec('VACUUM');
  return { deleted, tags, orphanTags, bytesFreed: Math.max(0, sizeBefore - pageBytes(db)) };
}

function pageBytes(db: DB): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const size = db.pragma('page_size', { simple: true }) as number;
  return pages * size;
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

/**
 * Which of these canonical hashes are already stored, from any source, or were
 * pruned on purpose. Both count as known: the per-run ration should be spent on
 * articles that can actually land, and a pruned one never can.
 */
export function knownHashes(db: DB, hashes: string[]): Set<string> {
  const stmt = db.prepare(
    `SELECT 1 FROM items WHERE canonical_hash = ?
      UNION ALL
     SELECT 1 FROM pruned_urls WHERE canonical_hash = ? LIMIT 1`,
  );
  const out = new Set<string>();
  for (const h of hashes) if (stmt.get(h, h)) out.add(h);
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
