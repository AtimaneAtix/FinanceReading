import { AdapterConfig } from '../config.ts';
import {
  canonicalizeUrl,
  absoluteUrl,
  canonicalHash,
  titleKey,
  displayTitle,
  parseDate,
} from './canonical.ts';
import { Tagger } from './tagger.ts';
import { runAdapter, AdapterError, type AdapterResult, type RawItem } from './adapters/index.ts';
import {
  insertItems,
  knownHashes,
  recordFetch,
  type DB,
  type SourceRow,
  type InsertStats,
} from '../db/index.ts';

export interface SourceOutcome {
  sourceId: string;
  institution: string;
  name: string;
  status: 'ok' | 'not-modified' | 'empty' | 'error';
  adapterUsed: string | null;
  fetched: number;
  stats: InsertStats;
  notes: string[];
  error: string | null;
}

interface StoredConfig {
  adapter: AdapterConfig;
  fallback: AdapterConfig[];
  takePerRun: number;
}

/** Used when a row was stored before `take_per_run` existed. */
const DEFAULT_TAKE_PER_RUN = 5;

export function parseSourceConfig(row: SourceRow): StoredConfig {
  const raw = JSON.parse(row.config_json) as unknown;
  const parsed = AdapterConfig.safeParse((raw as StoredConfig).adapter);
  if (!parsed.success) {
    throw new Error(`Stored adapter config for "${row.id}" is invalid: ${parsed.error.message}`);
  }
  const fallbackRaw = (raw as StoredConfig).fallback ?? [];
  const fallback: AdapterConfig[] = [];
  for (const f of fallbackRaw) {
    const p = AdapterConfig.safeParse(f);
    if (p.success) fallback.push(p.data);
  }
  const take = (raw as StoredConfig).takePerRun;
  return {
    adapter: parsed.data,
    fallback,
    takePerRun: Number.isFinite(take) && take > 0 ? take : DEFAULT_TAKE_PER_RUN,
  };
}

type Normalised = ReturnType<typeof normaliseItems>['items'][number];

/**
 * Picks the newest few articles this source has that are not stored already.
 *
 * Skipping what is stored *before* the cap is the whole trick. Take the newest
 * five outright and the same five are chosen again on every run, so the sixth
 * article never arrives however long the panel runs; skipping them first turns
 * the cap into a queue that drains a few at a time.
 *
 * Articles the publisher dated win over ones the crawler had to guess at,
 * which is the order the panel reads in too.
 */
export function selectNewest(
  db: DB,
  items: Normalised[],
  limit: number,
): { items: Normalised[]; held: number; known: number } {
  const known = knownHashes(
    db,
    items.map((i) => i.canonicalHash),
  );
  const fresh = items.filter((i) => !known.has(i.canonicalHash));
  if (fresh.length <= limit) return { items: fresh, held: 0, known: known.size };

  const ranked = [...fresh]
    .sort(
      (a, b) =>
        Number(a.dateEstimated) - Number(b.dateEstimated) || b.publishedAt - a.publishedAt,
    )
    .slice(0, limit);
  return { items: ranked, held: fresh.length - limit, known: known.size };
}

/**
 * Turns whatever a source returned into rows ready for the database:
 * absolute URLs, a deduplication hash, a real timestamp and a tag set.
 */
export function normaliseItems(
  raw: RawItem[],
  source: Pick<SourceRow, 'id' | 'institution' | 'homepage' | 'static_tags'>,
  tagger: Tagger,
  now = Date.now(),
) {
  const staticTags = JSON.parse(source.static_tags) as string[];
  const out = [];
  const skipped: string[] = [];

  for (const item of raw) {
    const canonical = canonicalizeUrl(item.url, source.homepage);
    if (!canonical) {
      skipped.push(`unusable URL: ${item.url}`);
      continue;
    }
    const title = displayTitle(item.title, source.institution);
    if (title === '') {
      skipped.push(`empty title for ${canonical}`);
      continue;
    }
    const date = parseDate(item.publishedAt, now);
    const categories = (item.categories ?? []).filter((c) => c.trim() !== '');

    out.push({
      sourceId: source.id,
      institution: source.institution,
      // The stored URL keeps whatever the publisher gave us, so the link works;
      // only the deduplication key is canonicalised. Resolving is still
      // needed: a content API may hand over a path rather than a URL.
      url: absoluteUrl(item.url, source.homepage),
      canonicalHash: canonicalHash(canonical),
      title,
      titleKey: titleKey(title),
      summary: item.summary ?? null,
      publishedAt: date.ms,
      // A date the adapter flagged as a proxy is an estimate even though it
      // parsed cleanly.
      dateEstimated: date.estimated || item.dateIsWeak === true,
      nativeCategories: categories,
      tags: tagger.tag({ title, summary: item.summary, nativeCategories: categories, staticTags }),
    });
  }
  return { items: out, skipped };
}

/**
 * Fetches one source and stores what it returned.
 *
 * The primary adapter is tried first; a failure or an unexpectedly empty result
 * falls through to the declared fallbacks, so an API change degrades to fewer
 * fields instead of to silence.
 */
export async function ingestSource(
  db: DB,
  row: SourceRow,
  tagger: Tagger,
): Promise<SourceOutcome> {
  const outcome: SourceOutcome = {
    sourceId: row.id,
    institution: row.institution,
    name: row.name,
    status: 'error',
    adapterUsed: null,
    fetched: 0,
    stats: { inserted: 0, duplicateUrl: 0, duplicateTitle: 0 },
    notes: [],
    error: null,
  };

  let config: StoredConfig;
  try {
    config = parseSourceConfig(row);
  } catch (err) {
    outcome.error = (err as Error).message;
    recordFetch(db, row.id, { status: 'error', error: outcome.error, itemCount: 0 });
    return outcome;
  }

  const chain = [config.adapter, ...config.fallback];
  let result: AdapterResult | null = null;
  let resultIsFallback = false;
  const errors: string[] = [];

  for (const [index, adapter] of chain.entries()) {
    const isFallback = index > 0;
    try {
      const attempt = await runAdapter(adapter, {
        sourceId: row.id,
        homepage: row.homepage,
        // Conditional-request headers belong to the primary adapter only; a
        // fallback fetches a different URL and would be misled by them.
        etag: isFallback ? null : row.etag,
        lastModified: isFallback ? null : row.last_modified,
        db,
      });
      outcome.adapterUsed = adapter.kind;
      if (attempt.notes) outcome.notes.push(...attempt.notes);

      if (attempt.notModified || attempt.items.length > 0 || attempt.healthyEmpty) {
        result = attempt;
        resultIsFallback = isFallback;
        break;
      }
      errors.push(`${adapter.kind}: returned no items`);
      result = attempt;
      resultIsFallback = isFallback;
    } catch (err) {
      const message = err instanceof AdapterError ? err.message : (err as Error).message;
      errors.push(`${adapter.kind}: ${message}`);
      if (isFallback || chain.length === 1) result = null;
    }
  }

  if (!result) {
    outcome.error = errors.join(' | ');
    outcome.status = 'error';
    recordFetch(db, row.id, { status: 'error', error: outcome.error, itemCount: 0 });
    return outcome;
  }

  if (result.notModified) {
    outcome.status = 'not-modified';
    recordFetch(db, row.id, { status: 'not-modified', error: null, itemCount: 0 });
    return outcome;
  }

  const { items, skipped } = normaliseItems(result.items, row, tagger);
  outcome.notes.push(...skipped.slice(0, 5));
  outcome.fetched = items.length;

  const selection = selectNewest(db, items, config.takePerRun);
  if (selection.held > 0) {
    outcome.notes.push(
      `took the newest ${config.takePerRun}; ${selection.held} more are waiting for the next run`,
    );
  }
  outcome.stats = insertItems(db, selection.items);
  // Articles skipped because they are already stored are duplicates found one
  // step earlier than they used to be, and still worth reporting as such.
  outcome.stats.duplicateUrl += selection.known;

  // Emptiness is judged on what the source returned, not on what survived the
  // cap: a feed whose every article is already stored is quiet, not broken.
  if (items.length === 0 && !result.healthyEmpty) {
    // Zero items from a source that should have some is a broken scraper, and
    // saying so is the difference between noticing and silently losing a feed.
    outcome.status = 'empty';
    outcome.error = errors.length > 0 ? errors.join(' | ') : 'source returned no usable items';
    recordFetch(db, row.id, { status: 'empty', error: outcome.error, itemCount: 0 });
    return outcome;
  }

  outcome.status = 'ok';
  recordFetch(db, row.id, {
    status: 'ok',
    error: null,
    itemCount: items.length,
    // The stored validators are replayed to the *primary* adapter on the next
    // run, so a fallback's must never be kept: they describe a different URL,
    // and `recordFetch` coalesces rather than clears, so one wrong ETag would
    // outlive every later run.
    etag: resultIsFallback ? null : result.etag ?? null,
    lastModified: resultIsFallback ? null : result.lastModified ?? null,
  });
  return outcome;
}
