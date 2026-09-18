import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { httpFetch, throttled, robotsAllows } from '../http.ts';
import { canonicalizeUrl, canonicalHash, parseDate } from '../canonical.ts';
import { extractArticleMeta } from '../meta.ts';
import { filterUnseen, markUrlsSeen } from '../../db/index.ts';
import { AdapterError, type AdapterContext, type AdapterResult, type RawItem } from './types.ts';

type SitemapConfig = Extract<import('../../config.ts').AdapterConfig, { kind: 'sitemap' }>;

/** Child sitemaps read from an index, newest first. */
const MAX_CHILD_SITEMAPS = 5;
const MAX_URLS_CONSIDERED = 5000;

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

/** The two bytes every gzip stream starts with. */
function isGzip(bytes: Buffer): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function fetchSitemapXml(url: string): Promise<string> {
  // Fetched as bytes because a .gz sitemap is a compressed *body*, not a
  // compressed transfer: fetch does not unwrap it, and reading it as text
  // mangles it beyond recovery -- every byte that is not valid UTF-8 becomes a
  // replacement character, and gunzip then rejects its own header.
  const res = await throttled(url, () =>
    httpFetch(url, { accept: 'application/xml, text/xml, */*;q=0.5', binary: true }),
  );
  if (!res.ok) throw new AdapterError(`HTTP ${res.status} from ${url}`);
  // Sniffed rather than taken from the extension: a server may gzip a plain
  // .xml URL, and it may equally serve a .gz path that Content-Encoding has
  // already unwrapped by the time it reaches us.
  if (res.bytes && isGzip(res.bytes)) {
    try {
      return gunzipSync(res.bytes).toString('utf8');
    } catch {
      throw new AdapterError(`Could not decompress gzipped sitemap ${url}`, false);
    }
  }
  return res.body;
}

function parseSitemap(xml: string): { entries: SitemapEntry[]; isIndex: boolean } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const isIndex = $('sitemapindex').length > 0;
  const entries: SitemapEntry[] = [];
  $(isIndex ? 'sitemap' : 'url').each((_, el) => {
    const node = $(el);
    const loc = node.find('loc').first().text().trim();
    if (loc === '') return;
    const lastmod =
      node.find('lastmod').first().text().trim() ||
      node.find('news\\:publication_date, publication_date').first().text().trim() ||
      null;
    entries.push({ loc, lastmod: lastmod === '' ? null : lastmod });
  });
  return { entries, isIndex };
}

function compileFilters(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  });
}

/**
 * Finds new articles through a site's sitemap, then reads each one's own
 * OpenGraph/JSON-LD metadata for the title and date.
 *
 * This is the fallback for insight hubs whose listing pages render client-side:
 * the sitemap is published for crawlers, so it works where CSS selectors cannot.
 * It costs one request per new article, so `max_new_per_run` caps the burst.
 */
export async function fetchSitemap(
  config: SitemapConfig,
  ctx: AdapterContext,
): Promise<AdapterResult> {
  if (!(await robotsAllows(config.url))) {
    throw new AdapterError(`robots.txt disallows ${config.url}`, false);
  }

  const notes: string[] = [];
  const root = parseSitemap(await fetchSitemapXml(config.url));

  let entries: SitemapEntry[] = [];
  if (root.isIndex) {
    // Child sitemaps are usually chronological; the freshest ones are what we want.
    const children = [...root.entries]
      .sort((a, b) => sortKey(b.lastmod) - sortKey(a.lastmod))
      .slice(0, MAX_CHILD_SITEMAPS);
    if (children.length === 0) notes.push('sitemap index listed no child sitemaps');
    for (const child of children) {
      try {
        const parsed = parseSitemap(await fetchSitemapXml(child.loc));
        entries.push(...parsed.entries);
      } catch (err) {
        notes.push(`child sitemap ${child.loc}: ${(err as Error).message}`);
      }
    }
  } else {
    entries = root.entries;
  }

  if (entries.length === 0) {
    throw new AdapterError(`No URLs found in sitemap ${config.url}`, false);
  }

  const include = compileFilters(config.include);
  const exclude = compileFilters(config.exclude);
  let candidates = entries.filter(
    (e) =>
      (include.length === 0 || include.some((re) => re.test(e.loc))) &&
      !exclude.some((re) => re.test(e.loc)),
  );
  if (candidates.length === 0) {
    throw new AdapterError(
      `Sitemap ${config.url} had ${entries.length} URLs but none matched the include ` +
        `patterns [${config.include.join(', ')}]`,
      false,
    );
  }

  // Newest first, so a capped run picks up the most recent articles.
  candidates.sort((a, b) => sortKey(b.lastmod) - sortKey(a.lastmod));

  // Cap only after filtering and sorting. Capping the raw sitemap instead --
  // as this did originally -- discards by document order, and a big site lists
  // author and product pages long before the articles: BIS puts 6153 /author
  // URLs ahead of its publications. The newest article can sit past the cut.
  if (candidates.length > MAX_URLS_CONSIDERED) {
    candidates = candidates.slice(0, MAX_URLS_CONSIDERED);
    notes.push(`considered the ${MAX_URLS_CONSIDERED} most recent matching URLs`);
  }

  const hashes = new Map<string, SitemapEntry>();
  for (const entry of candidates) {
    const canonical = canonicalizeUrl(entry.loc);
    if (!canonical) continue;
    const hash = canonicalHash(canonical);
    if (!hashes.has(hash)) hashes.set(hash, entry);
  }

  const unseen = filterUnseen(ctx.db, ctx.sourceId, [...hashes.keys()]);
  const fresh = [...hashes.entries()]
    .filter(([hash]) => unseen.has(hash))
    .slice(0, config.max_new_per_run);

  if (fresh.length === 0) {
    // Everything in the sitemap is already known: healthy, not broken.
    return { items: [], notes: [...notes, 'no new URLs in sitemap'], healthyEmpty: true };
  }

  const items: RawItem[] = [];
  const processed: string[] = [];
  let undated = 0;

  for (const [hash, entry] of fresh) {
    // Stop once this run has taken its allowance of articles that date
    // themselves nowhere. Every URL visited below is marked seen, so the next
    // run resumes past this point rather than re-reading the same stretch, and
    // the source arrives a few at a time instead of as one dump that lands in
    // the panel's estimated block whole.
    //
    // This bounds the volume. It does not identify the newest articles, and it
    // must not be read as doing so: `fresh` is in lastmod order, lastmod is a
    // rebuild timestamp, and Morgan Stanley's most recently rebuilt pages are
    // articles from 2024. Reading the publisher's own date is the only real
    // answer, which is what `extractArticleMeta` is for; this is the ceiling
    // for what that fails to find.
    if (undated >= config.max_undated_per_run) {
      notes.push(
        `stopped at ${config.max_undated_per_run} article(s) with no date of their own; ` +
          'the rest of the sitemap follows next run',
      );
      break;
    }
    processed.push(hash);
    if (!config.fetch_metadata) {
      undated++;
      // lastmod is all we have here, and it tracks CMS rebuilds, not publication.
      items.push({
        url: entry.loc,
        title: titleFromUrl(entry.loc),
        publishedAt: entry.lastmod,
        dateIsWeak: true,
      });
      continue;
    }
    try {
      if (!(await robotsAllows(entry.loc))) {
        notes.push(`robots.txt disallows ${entry.loc}`);
        continue;
      }
      const res = await throttled(entry.loc, () => httpFetch(entry.loc));
      if (!res.ok) {
        notes.push(`HTTP ${res.status} for ${entry.loc}`);
        continue;
      }
      const meta = extractArticleMeta(res.body);
      const title = meta.title ?? titleFromUrl(entry.loc);
      // Prefer the article's own date. Falling back to the sitemap's lastmod
      // keeps an ordering to work with, but lastmod is a rebuild timestamp --
      // publishers re-stamp whole sections at once -- so it is marked weak and
      // surfaces in the panel as an estimate rather than as fresh news.
      const ownDate = parseDate(meta.publishedAt);
      const useLastmod = ownDate.estimated && entry.lastmod !== null;
      if (ownDate.estimated) undated++;
      items.push({
        url: res.finalUrl || entry.loc,
        title,
        summary: meta.summary,
        publishedAt: useLastmod ? entry.lastmod : meta.publishedAt,
        dateIsWeak: ownDate.estimated,
        categories: meta.categories,
      });
    } catch (err) {
      notes.push(`${entry.loc}: ${(err as Error).message}`);
    }
  }

  // Record every URL we considered, successful or not, so a permanently broken
  // page is not retried on every single run.
  markUrlsSeen(ctx.db, ctx.sourceId, processed);

  return { items, notes };
}

function sortKey(lastmod: string | null): number {
  const parsed = parseDate(lastmod);
  return parsed.estimated ? 0 : parsed.ms;
}

/** A readable last resort when a page offers no title at all. */
function titleFromUrl(url: string): string {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const cleaned = slug.replace(/\.(html?|aspx|php)$/i, '').replace(/[-_]+/g, ' ').trim();
    if (cleaned === '') return url;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } catch {
    return url;
  }
}
