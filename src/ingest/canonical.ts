import { createHash } from 'node:crypto';

/**
 * Query parameters that identify a campaign or a click, never a document.
 * Anything starting with `utm_` is dropped in addition to these.
 */
const TRACKING_PARAMS = new Set([
  'gclid', 'fbclid', 'msclkid', 'igshid', 'mc_cid', 'mc_eid', 'yclid',
  'dclid', '_ga', '_gl', 'ref', 'referrer', 'sc_camp', 'sc_channel',
  'trk', 'trkinfo', 'linkid', 'cmpid', 'campaignid', 'sfmc_id',
]);

/**
 * Reduces a URL to a stable identity for deduplication.
 *
 * The fragment is always dropped, which matters more here than it looks: the
 * insight hubs keep their entire filter state after `#`
 * (`#sort=%40publishz32xdate%20descending&f:category=[...]`), and every one of
 * those variants is the same listing page.
 *
 * Returns null for anything that is not a usable http(s) document URL.
 */
export function canonicalizeUrl(input: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  url.username = '';
  url.password = '';
  if ((url.port === '80' || url.port === '443')) url.port = '';

  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  // Trailing slashes are cosmetic; "/insights" and "/insights/" are one page.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  let out = url.toString();
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

export function canonicalHash(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex');
}

/**
 * Site-name suffixes such as "… | PIMCO" that carry no meaning for matching.
 *
 * Only pipe-style separators count. En and em dashes are ordinary headline
 * punctuation ("Credit spreads — where the value is"), and treating them as
 * separators truncates real titles, which then fail to match their own
 * regional duplicates. The tail is also capped at four words, because a site
 * name is short and a subtitle is not.
 */
const TITLE_SUFFIX = /\s+[|•·]\s+(?:\S+\s+){0,3}\S+$/;

/**
 * A normalised title used to spot the same article republished under a
 * different regional path — PIMCO's `/us/en/` and `/eu/en/` copies, say.
 *
 * Returns '' when the title is too short to be a safe matching key; callers
 * must treat that as "do not deduplicate on title".
 */
export function titleKey(title: string): string {
  const key = title
    .replace(TITLE_SUFFIX, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return key.length >= 8 ? key : '';
}

export interface ParsedDate {
  ms: number;
  /** True when the value could not be parsed and the caller must substitute now. */
  estimated: boolean;
}

const MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000;
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

/**
 * Parses whatever a source calls a date: ISO strings, RFC 822 feed dates,
 * epoch seconds and epoch milliseconds (as numbers or as strings).
 *
 * Dates far in the future are rejected rather than trusted — a mis-parsed date
 * pins an article to the top of the list permanently.
 */
export function parseDate(value: unknown, now = Date.now()): ParsedDate {
  const estimated: ParsedDate = { ms: now, estimated: true };
  if (value === null || value === undefined) return estimated;

  let ms: number | null = null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = epochToMs(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return estimated;
    if (/^\d{9,14}$/.test(trimmed)) {
      ms = epochToMs(Number(trimmed));
    } else {
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) ms = parsed;
    }
  } else if (value instanceof Date) {
    ms = value.getTime();
  }

  if (ms === null || !Number.isFinite(ms)) return estimated;
  if (ms < EARLIEST_PLAUSIBLE_MS) return estimated;
  if (ms > now + MAX_FUTURE_SKEW_MS) return estimated;
  return { ms, estimated: false };
}

function epochToMs(n: number): number {
  // Seconds until roughly the year 33658, then milliseconds.
  return n < 1e11 ? n * 1000 : n;
}

/** Collapses feed HTML into a short plain-text excerpt. */
export function toExcerpt(html: string | null | undefined, maxLength = 400): string | null {
  if (!html) return null;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
