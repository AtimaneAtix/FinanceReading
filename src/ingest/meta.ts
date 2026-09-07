import * as cheerio from 'cheerio';
import { toExcerpt } from './canonical.ts';

export interface ArticleMeta {
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  categories: string[];
}

/**
 * Reads an article's own description of itself: OpenGraph, JSON-LD and the
 * standard meta tags. This is what makes the sitemap adapter viable — the
 * metadata is there for search engines, so it is present and well-formed even
 * on sites whose listing pages are JavaScript applications.
 */
export function extractArticleMeta(html: string): ArticleMeta {
  const $ = cheerio.load(html);

  const meta = (selector: string): string | null => {
    const value = $(selector).first().attr('content');
    return value && value.trim() !== '' ? value.trim() : null;
  };

  const jsonLd = readJsonLd($);

  const title =
    meta('meta[property="og:title"]') ??
    meta('meta[name="twitter:title"]') ??
    firstString(jsonLd, ['headline', 'name']) ??
    nonEmpty($('title').first().text());

  const summary =
    meta('meta[property="og:description"]') ??
    meta('meta[name="description"]') ??
    firstString(jsonLd, ['description']);

  const publishedAt =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="article:published_time"]') ??
    meta('meta[itemprop="datePublished"]') ??
    meta('meta[name="date"]') ??
    meta('meta[name="publish-date"]') ??
    meta('meta[name="pubdate"]') ??
    meta('meta[name="dc.date"]') ??
    meta('meta[name="DC.date.issued"]') ??
    firstString(jsonLd, ['datePublished', 'dateCreated', 'dateModified']) ??
    nonEmpty($('time[datetime]').first().attr('datetime') ?? '');

  const categories = new Set<string>();
  $('meta[property="article:section"], meta[property="article:tag"]').each((_, el) => {
    const value = $(el).attr('content')?.trim();
    if (value) categories.add(value);
  });
  for (const key of ['articleSection', 'keywords', 'about', 'genre']) {
    for (const value of stringsAt(jsonLd, key)) categories.add(value);
  }
  const keywords = meta('meta[name="keywords"]');
  if (keywords) {
    for (const k of keywords.split(',')) {
      const trimmed = k.trim();
      if (trimmed !== '') categories.add(trimmed);
    }
  }

  return {
    title: title ? collapse(title) : null,
    summary: toExcerpt(summary),
    publishedAt,
    categories: [...categories].slice(0, 20),
  };
}

function readJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      collectObjects(JSON.parse(raw), out);
    } catch {
      // A malformed JSON-LD block is common and never worth failing a fetch over.
    }
  });
  return out;
}

function collectObjects(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectObjects(v, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  out.push(obj);
  if (Array.isArray(obj['@graph'])) collectObjects(obj['@graph'], out, depth + 1);
}

function firstString(objects: Record<string, unknown>[], keys: string[]): string | null {
  for (const key of keys) {
    for (const obj of objects) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  }
  return null;
}

function stringsAt(objects: Record<string, unknown>[], key: string): string[] {
  const out: string[] = [];
  for (const obj of objects) {
    const value = obj[key];
    if (typeof value === 'string') {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed !== '') out.push(trimmed);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string' && v.trim() !== '') out.push(v.trim());
        else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>)['name'] === 'string') {
          out.push(((v as Record<string, unknown>)['name'] as string).trim());
        }
      }
    }
  }
  return out;
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
