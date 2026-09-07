import type { AdapterConfig } from '../../config.ts';
import { fetchRss } from './rss.ts';
import { fetchJson } from './json.ts';
import { fetchSitemap } from './sitemap.ts';
import { fetchHtml } from './html.ts';
import { fetchBrowser } from './browser.ts';
import type { AdapterContext, AdapterResult } from './types.ts';

export async function runAdapter(
  config: AdapterConfig,
  ctx: AdapterContext,
): Promise<AdapterResult> {
  switch (config.kind) {
    case 'rss':
      return fetchRss(config, ctx);
    case 'json':
      return fetchJson(config, ctx);
    case 'sitemap':
      return fetchSitemap(config, ctx);
    case 'html':
      return fetchHtml(config, ctx);
    case 'browser':
      return fetchBrowser(config, ctx);
  }
}

export * from './types.ts';
