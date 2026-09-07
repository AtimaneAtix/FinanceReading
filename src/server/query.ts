import type { DB } from '../db/index.ts';
import type { TaxonomyFile } from '../config.ts';

export type Since = '24h' | '7d' | '30d' | 'all';
export type Sort = 'newest' | 'oldest';

export interface ItemQuery {
  tags: string[];
  institutions: string[];
  q: string | null;
  since: Since;
  sort: Sort;
  cursor: string | null;
  limit: number;
}

export interface ItemView {
  id: number;
  url: string;
  title: string;
  summary: string | null;
  institution: string;
  sourceName: string;
  publishedAt: number;
  dateEstimated: boolean;
  tags: string[];
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface QueryResult {
  items: ItemView[];
  nextCursor: string | null;
  total: number;
  facets: Record<string, FacetCount[]>;
}

const SINCE_MS: Record<Exclude<Since, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface Clause {
  sql: string;
  params: unknown[];
}

function facetOf(tag: string): string {
  return tag.slice(0, tag.indexOf(':'));
}

/**
 * Tags within one facet are OR-ed, facets are AND-ed together:
 * `asset:credit + asset:equities + scope:macro` means
 * "(credit or equities) and macro". That is what makes multi-select feel right.
 */
function tagClauses(tags: string[], skipFacet?: string): Clause[] {
  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const facet = facetOf(tag);
    if (facet === '' || facet === skipFacet) continue;
    const list = groups.get(facet) ?? [];
    list.push(tag);
    groups.set(facet, list);
  }
  return [...groups.values()].map((values) => ({
    sql: `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = items.id AND t.tag IN (${values
      .map(() => '?')
      .join(',')}))`,
    params: values,
  }));
}

function baseClauses(query: ItemQuery, options: { skipFacet?: string; skipInstitution?: boolean } = {}): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (query.since !== 'all') {
    parts.push('items.published_at >= ?');
    params.push(Date.now() - SINCE_MS[query.since]);
  }
  if (query.q) {
    parts.push('(items.title LIKE ? ESCAPE \'\\\' OR IFNULL(items.summary, \'\') LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(query.q)}%`;
    params.push(like, like);
  }
  if (!options.skipInstitution && query.institutions.length > 0) {
    parts.push(`items.institution IN (${query.institutions.map(() => '?').join(',')})`);
    params.push(...query.institutions);
  }
  for (const clause of tagClauses(query.tags, options.skipFacet)) {
    parts.push(clause.sql);
    params.push(...clause.params);
  }

  return { sql: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

/** LIKE treats % and _ as wildcards; a user searching for "10%" means the character. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function queryItems(db: DB, query: ItemQuery, taxonomy: TaxonomyFile): QueryResult {
  const where = baseClauses(query);
  const desc = query.sort === 'newest';

  const params = [...where.params];
  let cursorSql = '';
  if (query.cursor) {
    const [at, id] = query.cursor.split('.').map(Number);
    if (Number.isFinite(at) && Number.isFinite(id)) {
      // Keyset pagination: stable even while the worker inserts new rows.
      cursorSql = desc
        ? ' AND (items.published_at < ? OR (items.published_at = ? AND items.id < ?))'
        : ' AND (items.published_at > ? OR (items.published_at = ? AND items.id > ?))';
      params.push(at, at, id);
    }
  }

  const order = desc
    ? 'items.published_at DESC, items.id DESC'
    : 'items.published_at ASC, items.id ASC';

  const rows = db
    .prepare(
      `SELECT items.id, items.url, items.title, items.summary, items.institution,
              items.published_at, items.date_estimated, sources.name AS source_name
         FROM items JOIN sources ON sources.id = items.source_id
        WHERE ${where.sql}${cursorSql}
        ORDER BY ${order}
        LIMIT ?`,
    )
    .all(...params, query.limit + 1) as {
    id: number;
    url: string;
    title: string;
    summary: string | null;
    institution: string;
    published_at: number;
    date_estimated: number;
    source_name: string;
  }[];

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const tagsById = new Map<number, string[]>();
  if (page.length > 0) {
    const placeholders = page.map(() => '?').join(',');
    const tagRows = db
      .prepare(`SELECT item_id, tag FROM item_tags WHERE item_id IN (${placeholders}) ORDER BY tag`)
      .all(...page.map((r) => r.id)) as { item_id: number; tag: string }[];
    for (const { item_id, tag } of tagRows) {
      const list = tagsById.get(item_id) ?? [];
      list.push(tag);
      tagsById.set(item_id, list);
    }
  }

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM items WHERE ${where.sql}`)
    .get(...where.params) as { n: number };

  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      summary: r.summary,
      institution: r.institution,
      sourceName: r.source_name,
      publishedAt: r.published_at,
      dateEstimated: r.date_estimated === 1,
      tags: tagsById.get(r.id) ?? [],
    })),
    nextCursor: hasMore && last ? `${last.published_at}.${last.id}` : null,
    total: total.n,
    facets: facetCounts(db, query, taxonomy),
  };
}

/**
 * Counts for the sidebar. Each facet is counted with its own selection removed,
 * so choosing "credit" still shows how many equities articles you could add —
 * a facet that counted itself would show zero for every unselected option.
 */
export function facetCounts(
  db: DB,
  query: ItemQuery,
  taxonomy: TaxonomyFile,
): Record<string, FacetCount[]> {
  const out: Record<string, FacetCount[]> = {};

  const institutionWhere = baseClauses(query, { skipInstitution: true });
  out['institution'] = db
    .prepare(
      `SELECT items.institution AS value, COUNT(*) AS count
         FROM items WHERE ${institutionWhere.sql}
        GROUP BY items.institution ORDER BY count DESC, value ASC`,
    )
    .all(...institutionWhere.params) as FacetCount[];

  for (const facet of taxonomy.facets) {
    const w = baseClauses(query, { skipFacet: facet.id });
    const rows = db
      .prepare(
        `SELECT t.tag AS value, COUNT(*) AS count
           FROM item_tags t JOIN items ON items.id = t.item_id
          WHERE ${w.sql} AND t.tag LIKE ? ESCAPE '\\'
          GROUP BY t.tag`,
      )
      .all(...w.params, `${facet.id}:%`) as FacetCount[];

    const counts = new Map(rows.map((r) => [r.value, r.count]));
    // Keep the taxonomy's declared order, and keep zero-count values visible so
    // the sidebar does not reshuffle under the pointer as filters change.
    out[facet.id] = facet.values.map((v) => ({
      value: `${facet.id}:${v}`,
      count: counts.get(`${facet.id}:${v}`) ?? 0,
    }));
  }

  return out;
}

export interface HealthRow {
  id: string;
  institution: string;
  name: string;
  status: string | null;
  error: string | null;
  lastFetchAt: number | null;
  itemCount: number | null;
  adapter: string;
  failures: number;
}

export function sourceHealth(db: DB): HealthRow[] {
  return (
    db
      .prepare(
        `SELECT id, institution, name, last_status, last_error, last_fetch_at,
                last_item_count, adapter_kind, consecutive_failures
           FROM sources WHERE in_config = 1 AND enabled = 1
          ORDER BY institution, name`,
      )
      .all() as {
      id: string;
      institution: string;
      name: string;
      last_status: string | null;
      last_error: string | null;
      last_fetch_at: number | null;
      last_item_count: number | null;
      adapter_kind: string;
      consecutive_failures: number;
    }[]
  ).map((r) => ({
    id: r.id,
    institution: r.institution,
    name: r.name,
    status: r.last_status,
    error: r.last_error,
    lastFetchAt: r.last_fetch_at,
    itemCount: r.last_item_count,
    adapter: r.adapter_kind,
    failures: r.consecutive_failures,
  }));
}
