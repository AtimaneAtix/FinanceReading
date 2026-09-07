import Parser from 'rss-parser';
import { httpFetch, throttled } from '../http.ts';
import { toExcerpt } from '../canonical.ts';
import { AdapterError, type AdapterContext, type AdapterResult, type RawItem } from './types.ts';

const parser = new Parser({
  customFields: { item: [['dc:date', 'dcDate'], ['dc:subject', 'dcSubject']] },
});

interface FeedItem {
  link?: string;
  guid?: string;
  title?: string;
  contentSnippet?: string;
  content?: string;
  summary?: string;
  isoDate?: string;
  pubDate?: string;
  dcDate?: string;
  categories?: (string | { _?: string })[];
  dcSubject?: string;
}

export async function fetchRss(
  config: { url: string },
  ctx: AdapterContext,
): Promise<AdapterResult> {
  const res = await throttled(config.url, () =>
    httpFetch(config.url, {
      etag: ctx.etag,
      lastModified: ctx.lastModified,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    }),
  );
  if (res.notModified) return { items: [], notModified: true };
  if (!res.ok) throw new AdapterError(`HTTP ${res.status} from ${config.url}`);

  let feed: { items?: FeedItem[] };
  try {
    feed = await parser.parseString(res.body);
  } catch (err) {
    const looksLikeHtml = /^\s*<!doctype html|^\s*<html/i.test(res.body);
    throw new AdapterError(
      looksLikeHtml
        ? `${config.url} returned an HTML page, not a feed — the feed URL is probably wrong`
        : `Could not parse feed at ${config.url}: ${(err as Error).message}`,
      !looksLikeHtml,
    );
  }

  const items: RawItem[] = [];
  for (const entry of feed.items ?? []) {
    const link = entry.link ?? (isHttpUrl(entry.guid) ? entry.guid : undefined);
    const title = entry.title?.trim();
    if (!link || !title) continue;
    items.push({
      url: link,
      title,
      summary: toExcerpt(entry.contentSnippet ?? entry.summary ?? entry.content),
      publishedAt: entry.isoDate ?? entry.pubDate ?? entry.dcDate,
      categories: normaliseCategories(entry),
    });
  }
  return { items, etag: res.etag, lastModified: res.lastModified };
}

function isHttpUrl(value: string | undefined): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function normaliseCategories(entry: FeedItem): string[] {
  const out: string[] = [];
  for (const c of entry.categories ?? []) {
    const value = typeof c === 'string' ? c : c?._;
    if (value && value.trim() !== '') out.push(value.trim());
  }
  if (entry.dcSubject) out.push(entry.dcSubject.trim());
  return out;
}
