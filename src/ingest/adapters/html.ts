import * as cheerio from 'cheerio';
import { httpFetch, throttled, robotsAllows } from '../http.ts';
import { toExcerpt } from '../canonical.ts';
import { AdapterError, type AdapterContext, type AdapterResult, type RawItem } from './types.ts';
import type { SelectorSet } from '../../config.ts';

/**
 * Splits our compact selector syntax: "a@href" reads the href attribute,
 * "h3" reads the text.
 */
function splitSelector(selector: string): { css: string; attr: string | null } {
  const at = selector.lastIndexOf('@');
  if (at <= 0) return { css: selector.trim(), attr: null };
  return { css: selector.slice(0, at).trim(), attr: selector.slice(at + 1).trim() };
}

function read(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<any>,
  selector: string | undefined,
): string | null {
  if (!selector) return null;
  const { css, attr } = splitSelector(selector);
  // An empty css part means "this element", e.g. "@href" on the item itself.
  const el = css === '' ? scope : scope.find(css).first();
  if (el.length === 0) return null;
  const value = attr ? el.attr(attr) : el.text();
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Shared by the html adapter and the browser adapter, which renders then reuses this. */
export function extractFromHtml(
  html: string,
  selectors: SelectorSet,
  baseUrl: string,
): { items: RawItem[]; notes: string[] } {
  const $ = cheerio.load(html);
  const nodes = $(selectors.item);
  const items: RawItem[] = [];
  const notes: string[] = [];
  let missingLink = 0;
  let missingTitle = 0;

  nodes.each((_, node) => {
    const scope = $(node);
    const href = read($, scope, selectors.link);
    const title = read($, scope, selectors.title);
    if (!href) {
      missingLink++;
      return;
    }
    if (!title) {
      missingTitle++;
      return;
    }
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      missingLink++;
      return;
    }
    items.push({
      url: absolute,
      title,
      summary: toExcerpt(read($, scope, selectors.summary)),
      publishedAt: read($, scope, selectors.date),
    });
  });

  if (nodes.length === 0) {
    notes.push(`item selector "${selectors.item}" matched nothing`);
  }
  if (missingLink > 0) notes.push(`${missingLink} node(s) had no usable link`);
  if (missingTitle > 0) notes.push(`${missingTitle} node(s) had no title`);
  return { items, notes };
}

export async function fetchHtml(
  config: { url: string; selectors: SelectorSet },
  ctx: AdapterContext,
): Promise<AdapterResult> {
  if (!(await robotsAllows(config.url))) {
    throw new AdapterError(`robots.txt disallows ${config.url}`, false);
  }
  const res = await throttled(config.url, () =>
    httpFetch(config.url, { etag: ctx.etag, lastModified: ctx.lastModified }),
  );
  if (res.notModified) return { items: [], notModified: true };
  if (!res.ok) throw new AdapterError(`HTTP ${res.status} from ${config.url}`);

  const { items, notes } = extractFromHtml(res.body, config.selectors, res.finalUrl);
  if (items.length === 0) {
    notes.push(
      'No articles extracted. If this page is a JavaScript search app, HTML selectors ' +
        'cannot work — run `npm run discover` to find the JSON endpoint behind it.',
    );
  }
  return { items, etag: res.etag, lastModified: res.lastModified, notes };
}
