import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import YAML from 'yaml';
import { httpFetch, throttled } from '../ingest/http.ts';
import { canonicalizeUrl } from '../ingest/canonical.ts';
import { findRecordArrays, guessFields, type FieldGuess } from './score.ts';

export interface NetworkCandidate {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  itemsPath: string;
  recordCount: number;
  score: number;
  fields: FieldGuess;
  sampleTitles: string[];
  sampleCategories: string[];
}

export interface FeedCandidate {
  url: string;
  title: string | null;
  itemCount: number;
  source: 'declared' | 'probed';
}

export interface SitemapCandidate {
  url: string;
  urlCount: number;
  matchingCount: number;
  sampleUrls: string[];
}

export interface HtmlCandidate {
  itemSelector: string;
  matches: number;
  sampleTitles: string[];
}

export interface DiscoveryReport {
  requestedUrl: string;
  finalUrl: string;
  renderedWithBrowser: boolean;
  warnings: string[];
  network: NetworkCandidate[];
  feeds: FeedCandidate[];
  sitemaps: SitemapCandidate[];
  html: HtmlCandidate[];
  suggestion: { adapter: string; yaml: string } | null;
}

const COMMON_FEED_PATHS = [
  '/rss', '/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml',
  '/feeds/all.xml', '/rss/all.xml', '/en/rss',
];

export async function discover(
  target: string,
  options: { useBrowser?: boolean } = {},
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    requestedUrl: target,
    finalUrl: target,
    renderedWithBrowser: false,
    warnings: [],
    network: [],
    feeds: [],
    sitemaps: [],
    html: [],
    suggestion: null,
  };

  let html = '';

  // --- probe 1: render the page and watch its network traffic -------------
  if (options.useBrowser !== false) {
    try {
      const { renderPage } = await import('../ingest/adapters/browser.ts');
      const captured: Parameters<
        NonNullable<Parameters<typeof renderPage>[1]>['onResponse'] & object
      >[0][] = [];

      const rendered = await renderPage(target, {
        scroll: 2,
        onResponse: (entry) => captured.push(entry),
      });
      html = rendered.html;
      report.finalUrl = rendered.finalUrl;
      report.renderedWithBrowser = true;
      report.network = rankNetworkCandidates(captured);
    } catch (err) {
      report.warnings.push(
        `Browser capture unavailable (${(err as Error).message.split('\n')[0]}). ` +
          'Falling back to a plain fetch, which cannot see a JavaScript search API.',
      );
    }
  }

  // --- fall back to a static fetch ---------------------------------------
  if (html === '') {
    const res = await throttled(target, () => httpFetch(target));
    if (!res.ok) {
      report.warnings.push(`HTTP ${res.status} fetching ${target}`);
      return report;
    }
    html = res.body;
    report.finalUrl = res.finalUrl;
  }

  const $ = cheerio.load(html);

  // --- probe 2: framework payloads embedded in the page -------------------
  $('script').each((_, node) => {
    const id = $(node).attr('id');
    const type = $(node).attr('type');
    if (id !== '__NEXT_DATA__' && type !== 'application/json') return;
    const raw = $(node).contents().text();
    if (!raw.trim()) return;
    try {
      const arrays = findRecordArrays(JSON.parse(raw));
      const best = arrays[0];
      if (best && best.score >= 3) {
        report.warnings.push(
          `The page embeds its articles in a <script${id ? ` id="${id}"` : ''}> block ` +
            `at "${best.path}" (${best.records.length} records). A json adapter pointed at ` +
            'the page URL will not work directly, but this confirms the data shape.',
        );
      }
    } catch {
      // Not JSON after all.
    }
  });

  // --- probe 3: declared and conventional feeds ---------------------------
  report.feeds = await findFeeds($, report.finalUrl);

  // --- probe 4: sitemaps --------------------------------------------------
  report.sitemaps = await findSitemaps(report.finalUrl);

  // --- probe 5: server-rendered listing structure -------------------------
  report.html = proposeSelectors($, report.finalUrl);

  report.suggestion = buildSuggestion(report);
  return report;
}

// --- probe 1 helpers -------------------------------------------------------

interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  body: string;
}

export function rankNetworkCandidates(captured: CapturedResponse[]): NetworkCandidate[] {
  const out: NetworkCandidate[] = [];

  for (const entry of captured) {
    if (entry.status >= 400) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(entry.body);
    } catch {
      continue;
    }
    const best = findRecordArrays(payload)[0];
    if (!best || best.score < 3) continue;

    const fields = guessFields(best.records);
    if (!fields.title || !fields.url) continue;

    out.push({
      method: entry.method,
      url: entry.url,
      requestHeaders: redactHeaders(entry.requestHeaders),
      requestBody: entry.requestBody,
      itemsPath: best.path,
      recordCount: best.records.length,
      score: best.score,
      fields,
      sampleTitles: sampleStrings(best.records, fields.title, 3),
      sampleCategories: fields.categories ? sampleStrings(best.records, fields.categories, 8) : [],
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Keeps the headers that make a request work and drops the ones that identify
 * a person. Cookies and tokens are replaced with a placeholder rather than
 * written into a config file that gets committed.
 */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const keep = ['content-type', 'accept', 'origin', 'referer', 'authorization', 'x-api-key'];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith(':') || !keep.includes(lower)) continue;
    out[lower] =
      lower === 'authorization' || lower === 'x-api-key'
        ? `${value.split(' ')[0] === 'Bearer' ? 'Bearer ' : ''}{{token}}`
        : value;
  }
  return out;
}

function sampleStrings(records: Record<string, unknown>[], path: string, limit: number): string[] {
  const out = new Set<string>();
  for (const record of records) {
    let value: unknown = record;
    for (const part of path.split('.')) {
      if (value === null || typeof value !== 'object') { value = undefined; break; }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === 'string' && value.trim() !== '') out.add(value.trim());
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && v.trim() !== '') out.add(v.trim());
    }
    if (out.size >= limit) break;
  }
  return [...out].slice(0, limit);
}

// --- probe 3 helpers -------------------------------------------------------

async function findFeeds($: cheerio.CheerioAPI, baseUrl: string): Promise<FeedCandidate[]> {
  const candidates = new Map<string, 'declared' | 'probed'>();

  $('link[rel="alternate"]').each((_, node) => {
    const type = ($(node).attr('type') ?? '').toLowerCase();
    const href = $(node).attr('href');
    if (!href) return;
    if (!type.includes('rss') && !type.includes('atom') && !type.includes('xml')) return;
    const absolute = canonicalizeUrl(href, baseUrl);
    if (absolute) candidates.set(absolute, 'declared');
  });

  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }
  for (const path of COMMON_FEED_PATHS) {
    const url = `${origin}${path}`;
    if (!candidates.has(url)) candidates.set(url, 'probed');
  }

  const found: FeedCandidate[] = [];
  for (const [url, source] of candidates) {
    try {
      const res = await throttled(url, () =>
        httpFetch(url, { timeoutMs: 12_000, accept: 'application/rss+xml, application/xml, */*;q=0.5' }),
      );
      if (!res.ok) continue;
      if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(res.body.slice(0, 2000))) continue;
      const $feed = cheerio.load(res.body, { xmlMode: true });
      const itemCount = $feed('item, entry').length;
      if (itemCount === 0) continue;
      found.push({
        url,
        title: $feed('channel > title, feed > title').first().text().trim() || null,
        itemCount,
        source,
      });
    } catch {
      // A probe that fails is simply not a feed.
    }
  }
  return found;
}

// --- probe 4 helpers -------------------------------------------------------

async function findSitemaps(baseUrl: string): Promise<SitemapCandidate[]> {
  let origin: string;
  let pathPrefix: string;
  try {
    const parsed = new URL(baseUrl);
    origin = parsed.origin;
    // "/eu/en/insights" -> "/insights", the part that identifies article URLs.
    pathPrefix = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return [];
  }

  const urls = new Set<string>([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  try {
    const robots = await throttled(origin, () =>
      httpFetch(`${origin}/robots.txt`, { timeoutMs: 10_000, accept: 'text/plain' }),
    );
    if (robots.ok) {
      for (const line of robots.body.split(/\r?\n/)) {
        const match = /^\s*sitemap:\s*(\S+)/i.exec(line);
        if (match?.[1]) urls.add(match[1].trim());
      }
    }
  } catch {
    // No robots.txt is fine; the conventional paths are still worth a try.
  }

  const found: SitemapCandidate[] = [];
  for (const url of [...urls].slice(0, 8)) {
    try {
      const res = await throttled(url, () =>
        httpFetch(url, { timeoutMs: 15_000, accept: 'application/xml, text/xml' }),
      );
      if (!res.ok) continue;
      const $ = cheerio.load(res.body, { xmlMode: true });
      const locs = $('url > loc, sitemap > loc')
        .map((_, node) => $(node).text().trim())
        .get()
        .filter(Boolean);
      if (locs.length === 0) continue;
      const matching = pathPrefix
        ? locs.filter((l) => l.toLowerCase().includes(`/${pathPrefix.toLowerCase()}`))
        : locs;
      found.push({
        url,
        urlCount: locs.length,
        matchingCount: matching.length,
        sampleUrls: (matching.length > 0 ? matching : locs).slice(0, 5),
      });
    } catch {
      // Not a sitemap.
    }
  }
  return found.sort((a, b) => b.matchingCount - a.matchingCount);
}

// --- probe 5 helpers -------------------------------------------------------

/**
 * Looks for the repeated structure that a server-rendered listing page uses:
 * the deepest class shared by several elements that each contain one article
 * link and some text.
 */
export function proposeSelectors($: cheerio.CheerioAPI, baseUrl: string): HtmlCandidate[] {
  // Links inside a listing page's own articles rarely share the listing's path
  // (a page at /insights can link to /articles/...), so the path is only a
  // ranking hint, never a filter. What identifies an article link is that it is
  // internal, carries real headline text, and repeats in a shared container.
  let pathHint = '';
  let origin = '';
  try {
    const parsed = new URL(baseUrl);
    pathHint = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    origin = parsed.origin;
  } catch {
    // Fall through with no hint.
  }

  const byClass = new Map<string, Set<Element>>();
  const hintedClasses = new Set<string>();

  $('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href') ?? '';
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    // Navigation, headers and footers repeat too, and are never the article list.
    if ($(anchor).closest('nav, header, footer').length > 0) return;
    if (($(anchor).text() ?? '').trim().length < 12) return;

    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (origin && !absolute.startsWith(origin)) return;
    const hinted = pathHint !== '' && absolute.toLowerCase().includes(pathHint.toLowerCase());

    // Walk up a few levels; the article "card" is usually within three.
    let node = $(anchor).parent();
    for (let depth = 0; depth < 4 && node.length > 0; depth++) {
      const classes = (node.attr('class') ?? '').split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        if (/^(is|has|js)-/.test(cls)) continue;
        const selector = `.${cssEscape(cls)}`;
        const set = byClass.get(selector) ?? new Set();
        set.add(node[0] as Element);
        byClass.set(selector, set);
        if (hinted) hintedClasses.add(selector);
      }
      node = node.parent();
    }
  });

  const candidates: HtmlCandidate[] = [];
  for (const [selector, nodes] of byClass) {
    if (nodes.size < 3) continue;
    const titles: string[] = [];
    for (const node of [...nodes].slice(0, 3)) {
      const text = $(node).find('a[href]').first().text().replace(/\s+/g, ' ').trim();
      if (text) titles.push(text.slice(0, 90));
    }
    if (titles.length === 0) continue;
    candidates.push({ itemSelector: selector, matches: nodes.size, sampleTitles: titles });
  }

  // Prefer containers whose links look like they belong to this section, then
  // the selector matching the most cards, then the more specific one.
  return candidates
    .sort(
      (a, b) =>
        Number(hintedClasses.has(b.itemSelector)) - Number(hintedClasses.has(a.itemSelector)) ||
        b.matches - a.matches ||
        b.itemSelector.length - a.itemSelector.length,
    )
    .slice(0, 5);
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// --- suggestion ------------------------------------------------------------

/**
 * Turns the best probe result into a config block that can be pasted straight
 * into config/sources.yaml.
 */
export function buildSuggestion(report: DiscoveryReport): { adapter: string; yaml: string } | null {
  const id = suggestId(report.finalUrl);
  const base = {
    id,
    institution: institutionFromUrl(report.finalUrl),
    name: 'Insights',
    homepage: originOf(report.finalUrl),
    static_tags: ['type:insight'],
  };

  const network = report.network[0];
  if (network) {
    const adapter: Record<string, unknown> = {
      kind: 'json',
      request: {
        method: network.method,
        url: network.url,
        headers: network.requestHeaders,
        ...(network.requestBody ? { body: network.requestBody } : {}),
      },
      items_path: network.itemsPath,
      fields: Object.fromEntries(
        Object.entries(network.fields).filter(([, v]) => v !== null),
      ),
    };
    if (Object.keys(network.requestHeaders).some((h) => h === 'authorization' || h === 'x-api-key')) {
      adapter['auth'] = {
        kind: 'from_page',
        page_url: report.finalUrl,
        token_regex: '"(?:accessToken|apiKey|searchToken)"\\s*:\\s*"([^"]+)"',
      };
    }
    return { adapter: 'json', yaml: YAML.stringify({ sources: [{ ...base, adapter }] }) };
  }

  const feed = report.feeds[0];
  if (feed) {
    return {
      adapter: 'rss',
      yaml: YAML.stringify({
        sources: [{ ...base, adapter: { kind: 'rss', url: feed.url } }],
      }),
    };
  }

  const sitemap = report.sitemaps.find((s) => s.matchingCount > 0);
  if (sitemap) {
    let include = '/insights/';
    try {
      const segment = new URL(report.finalUrl).pathname.split('/').filter(Boolean).pop();
      if (segment) include = `/${segment}/`;
    } catch {
      // Keep the default.
    }
    return {
      adapter: 'sitemap',
      yaml: YAML.stringify({
        sources: [
          {
            ...base,
            adapter: { kind: 'sitemap', url: sitemap.url, include: [include], max_new_per_run: 25 },
          },
        ],
      }),
    };
  }

  const html = report.html[0];
  if (html) {
    return {
      adapter: report.renderedWithBrowser ? 'browser' : 'html',
      yaml: YAML.stringify({
        sources: [
          {
            ...base,
            adapter: {
              kind: report.renderedWithBrowser ? 'browser' : 'html',
              url: report.finalUrl,
              ...(report.renderedWithBrowser ? { wait_for: html.itemSelector, scroll: 2 } : {}),
              selectors: {
                item: html.itemSelector,
                title: 'a',
                link: 'a@href',
                date: 'time@datetime',
              },
            },
          },
        ],
      }),
    };
  }

  return null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function suggestId(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').split('.')[0] ?? 'source';
    const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? 'feed';
    return `${host}-${segment}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  } catch {
    return 'new-source';
  }
}

function institutionFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'Unknown';
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return 'Unknown';
  }
}
