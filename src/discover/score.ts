import { parseDate } from '../ingest/canonical.ts';

export interface RecordArray {
  /** Dot path from the payload root to the array. */
  path: string;
  records: Record<string, unknown>[];
  score: number;
}

export interface FieldGuess {
  title: string | null;
  url: string | null;
  published_at: string | null;
  summary: string | null;
  categories: string | null;
}

const MAX_DEPTH = 6;
const MIN_RECORDS = 2;

/**
 * Walks a JSON payload looking for the array of articles.
 *
 * A search API buries its results at a different path on every site
 * ("results", "data.hits", "response.docs"), so rather than knowing them all we
 * look for the shape: an array of objects that carry something URL-like and
 * something title-like.
 */
export function findRecordArrays(payload: unknown): RecordArray[] {
  const found: RecordArray[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      const objects = value.filter(
        (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
      );
      if (objects.length >= MIN_RECORDS) {
        const score = scoreRecords(objects);
        if (score > 0) found.push({ path, records: objects.slice(0, 50), score });
      }
      // Records often nest their real payload one level down (Coveo's `raw`).
      for (const [i, v] of value.slice(0, 3).entries()) walk(v, `${path}[${i}]`, depth + 1);
      return;
    }

    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path === '' ? key : `${path}.${key}`, depth + 1);
    }
  };

  walk(payload, '', 0);
  return found.sort((a, b) => b.score - a.score);
}

function scoreRecords(records: Record<string, unknown>[]): number {
  const sample = records.slice(0, 20);
  const flat = sample.map((r) => flatten(r));
  const withUrl = flat.filter((r) => Object.values(r).some(looksLikeUrl)).length;
  const withTitle = flat.filter((r) => Object.values(r).some(looksLikeTitle)).length;
  const withDate = flat.filter((r) => Object.values(r).some(looksLikeDate)).length;

  if (withUrl === 0 || withTitle === 0) return 0;
  // A date is a strong signal but not required; some APIs date-stamp elsewhere.
  return (
    (withUrl / sample.length) * 3 +
    (withTitle / sample.length) * 3 +
    (withDate / sample.length) * 2 +
    Math.min(records.length / 20, 1)
  );
}

/** Flattens one level of nesting so "raw.title" is visible as a candidate field. */
export function flatten(record: Record<string, unknown>, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < 2) {
      Object.assign(out, flatten(value as Record<string, unknown>, path, depth + 1));
    } else {
      out[path] = value;
    }
  }
  return out;
}

export function looksLikeUrl(value: unknown): boolean {
  return typeof value === 'string' && /^(https?:\/\/|\/[^/\s])/.test(value.trim()) && !value.includes(' ');
}

export function looksLikeTitle(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length >= 12 &&
    trimmed.length <= 300 &&
    /\s/.test(trimmed) &&
    !looksLikeUrl(trimmed) &&
    !/^[{[<]/.test(trimmed)
  );
}

export function looksLikeDate(value: unknown): boolean {
  if (typeof value === 'number') return !parseDate(value).estimated;
  if (typeof value !== 'string') return false;
  // Require date-ish punctuation so an arbitrary number-string is not "a date".
  if (!/\d{4}|\d{9,14}/.test(value)) return false;
  return !parseDate(value).estimated;
}

/** Picks the best field path for each of our normalised fields. */
export function guessFields(records: Record<string, unknown>[]): FieldGuess {
  const flat = records.map((r) => flatten(r));
  const keys = new Set(flat.flatMap((r) => Object.keys(r)));

  const rate = (key: string, test: (v: unknown) => boolean): number => {
    const present = flat.filter((r) => r[key] !== undefined && r[key] !== null);
    if (present.length === 0) return 0;
    return present.filter((r) => test(r[key])).length / flat.length;
  };

  const best = (
    test: (v: unknown) => boolean,
    prefer: RegExp,
    exclude: Set<string> = new Set(),
  ): string | null => {
    let winner: string | null = null;
    let winningScore = 0;
    for (const key of keys) {
      if (exclude.has(key)) continue;
      const score = rate(key, test) + (prefer.test(key) ? 0.6 : 0);
      if (score > winningScore && score >= 0.5) {
        winner = key;
        winningScore = score;
      }
    }
    return winner;
  };

  const url = best(looksLikeUrl, /(clickuri|^uri$|^url$|link|href|permalink|path|slug)/i);
  const title = best(looksLikeTitle, /(title|headline|name|heading)/i);
  const published_at = best(looksLikeDate, /(publish|date|created|posted|updated|time)/i);

  const summaryExclude = new Set([title, url].filter((k): k is string => k !== null));
  const summary = best(
    (v) => typeof v === 'string' && v.trim().length > 60,
    /(excerpt|summary|description|abstract|teaser|snippet|body)/i,
    summaryExclude,
  );

  let categories: string | null = null;
  let categoriesScore = 0;
  for (const key of keys) {
    const score =
      rate(key, (v) => Array.isArray(v) && v.some((x) => typeof x === 'string')) +
      (/(categor|tag|topic|section|subject|theme)/i.test(key) ? 0.6 : 0);
    if (score > categoriesScore && score >= 0.5) {
      categories = key;
      categoriesScore = score;
    }
  }

  return { title, url, published_at, summary, categories };
}
