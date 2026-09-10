import { httpFetch, throttled } from '../http.ts';
import { toExcerpt, parseDate } from '../canonical.ts';
import { AdapterError, type AdapterContext, type AdapterResult, type RawItem } from './types.ts';
import type { Auth } from '../../config.ts';

type JsonAdapterConfig = Extract<
  import('../../config.ts').AdapterConfig,
  { kind: 'json' }
>;

/**
 * Reads a dot path out of a JSON value: "data.results", "hits[0].title".
 * An empty path returns the value itself, which is what a top-level array needs.
 */
export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  // A "[]" segment fans the rest of the path out across an array:
  // "primaryTopic[].title" collects the title of every topic. A CMS hands over
  // its taxonomy as objects far more often than as bare strings, and without
  // this the best tagging signal a source has is unreachable.
  const fan = path.indexOf('[]');
  if (fan !== -1) {
    const array = getPath(value, path.slice(0, fan));
    if (!Array.isArray(array)) return undefined;
    const rest = path.slice(fan + 2).replace(/^\./, '');
    return array.map((element) => getPath(element, rest)).filter((v) => v !== undefined);
  }
  let current: unknown = value;
  for (const segment of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const [, key = '', indices = ''] = match;
    if (key !== '') {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    for (const idx of indices.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(idx[1])];
    }
  }
  return current;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim() !== '');
    return typeof first === 'string' ? first : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => {
      const s = asString(v);
      return s === null ? [] : [s];
    });
  }
  const single = asString(value);
  return single === null ? [] : [single];
}

/** Substitutes {{token}}, {{offset}} and {{page_size}} into a URL or body template. */
export function render(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * Search APIs behind insight hubs hand out short-lived tokens from the page,
 * so we re-derive the token on every run instead of storing one that expires.
 */
async function resolveToken(auth: Auth): Promise<string | null> {
  if (auth.kind === 'none') return null;

  if (auth.kind === 'env') {
    const value = process.env[auth.var];
    if (!value) {
      throw new AdapterError(
        `Environment variable ${auth.var} is not set, and this source needs it for authentication`,
        false,
      );
    }
    return value;
  }

  const res = await throttled(auth.page_url, () => httpFetch(auth.page_url));
  if (!res.ok) {
    throw new AdapterError(`HTTP ${res.status} fetching token page ${auth.page_url}`);
  }
  let re: RegExp;
  try {
    re = new RegExp(auth.token_regex);
  } catch (err) {
    throw new AdapterError(`Invalid token_regex: ${(err as Error).message}`, false);
  }
  const match = re.exec(res.body);
  const token = match?.[1];
  if (!token) {
    throw new AdapterError(
      `token_regex did not match anything on ${auth.page_url}. The page may mint its ` +
        'token in JavaScript — re-run `npm run discover` to capture the current request.',
    );
  }
  return token;
}

export async function fetchJson(
  config: JsonAdapterConfig,
  _ctx: AdapterContext,
): Promise<AdapterResult> {
  const token = await resolveToken(config.auth);
  const notes: string[] = [];
  const items: RawItem[] = [];
  const seen = new Set<string>();

  const declared = config.fields.categories;
  const categoryPaths = declared === undefined ? [] : [declared].flat();

  const pageSize = config.pagination.kind === 'offset' ? config.pagination.page_size : 0;
  const maxPages = config.pagination.kind === 'offset' ? config.pagination.max_pages : 1;

  for (let page = 0; page < maxPages; page++) {
    const vars: Record<string, string | number> = {
      token: token ?? '',
      offset: page * pageSize,
      page: page,
      page_size: pageSize,
    };

    const url = render(config.request.url, vars);
    const headers: Record<string, string> = {
      'content-type': config.request.method === 'POST' ? 'application/json' : 'application/json',
      accept: 'application/json',
    };
    for (const [k, v] of Object.entries(config.request.headers)) headers[k] = render(v, vars);
    if (token && !hasAuthHeader(headers)) headers['authorization'] = `Bearer ${token}`;

    const res = await throttled(url, () =>
      httpFetch(url, {
        method: config.request.method,
        headers,
        body: config.request.body === undefined ? undefined : render(config.request.body, vars),
        accept: 'application/json',
      }),
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new AdapterError(
          `HTTP ${res.status} from ${url} — the search token was rejected. ` +
            'Re-run `npm run discover` to capture how the page mints it now.',
        );
      }
      throw new AdapterError(`HTTP ${res.status} from ${url}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(res.body);
    } catch (err) {
      throw new AdapterError(`${url} did not return JSON: ${(err as Error).message}`);
    }

    const records = getPath(payload, config.items_path);
    if (!Array.isArray(records)) {
      throw new AdapterError(
        `items_path "${config.items_path || '(root)'}" is not an array in the response from ${url}`,
        false,
      );
    }
    if (records.length === 0) break;

    let usable = 0;
    for (const record of records) {
      const url_ = asString(getPath(record, config.fields.url));
      const title = asString(getPath(record, config.fields.title));
      if (!url_ || !title) continue;
      if (seen.has(url_)) continue;
      seen.add(url_);
      usable++;
      items.push({
        url: url_,
        title,
        summary: config.fields.summary
          ? toExcerpt(asString(getPath(record, config.fields.summary)))
          : null,
        publishedAt: config.fields.published_at
          ? getPath(record, config.fields.published_at)
          : undefined,
        categories: categoryPaths.flatMap((path) => asStringArray(getPath(record, path))),
      });
    }
    if (usable === 0) {
      notes.push(
        `page ${page + 1} returned ${records.length} record(s) but none had both a title ` +
          `("${config.fields.title}") and a url ("${config.fields.url}") — check the field paths`,
      );
      break;
    }
    if (config.pagination.kind !== 'offset' || records.length < pageSize) break;
  }

  // Newest first, then capped. An endpoint with no pagination hands over
  // everything it has, and the ordering it chose is its own -- relevance, or
  // whatever the CMS wrote last -- so the cap has to rank before it cuts or it
  // keeps an arbitrary slice of the archive instead of the recent work.
  if (items.length > config.max_new_per_run) {
    const ranked = [...items]
      .sort((a, b) => dateKey(b) - dateKey(a))
      .slice(0, config.max_new_per_run);
    notes.push(`kept the ${config.max_new_per_run} most recent of ${items.length} records`);
    return { items: ranked, notes };
  }

  return { items, notes };
}

/** Undated records sort last, which is where a landing page belongs. */
function dateKey(item: RawItem): number {
  const parsed = parseDate(item.publishedAt);
  return parsed.estimated ? 0 : parsed.ms;
}

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
}
