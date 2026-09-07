import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, SEARCH_TOKEN, ARTICLE_COUNT, type Fixture } from './fixture-server.ts';
import { discover } from '../src/discover/index.ts';
import { shouldProxy } from '../src/ingest/http.ts';
import YAML from 'yaml';

let fixture: Fixture;
let browserAvailable = false;

beforeAll(async () => {
  fixture = await startFixtureServer();
  browserAvailable = await canLaunchBrowser();
});

/**
 * Whether this machine can actually drive a browser. Without this check the
 * capture tests pass vacuously through discover()'s graceful degradation,
 * which is worse than not having them.
 */
async function canLaunchBrowser(): Promise<boolean> {
  try {
    const { renderPage } = await import('../src/ingest/adapters/browser.ts');
    await renderPage('about:blank');
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await fixture.close();
});

describe('discover, without a browser', () => {
  it('still finds the feed and the sitemap on a JavaScript page', async () => {
    const report = await discover(`${fixture.base}/insights`, { useBrowser: false });

    expect(report.renderedWithBrowser).toBe(false);
    // Declared in a <link rel="alternate"> even though the articles are not in the HTML.
    expect(report.feeds.map((f) => f.url)).toContain(`${fixture.base}/rss.xml`);
    expect(report.sitemaps.map((s) => s.url)).toContain(`${fixture.base}/sitemap.xml`);
    // Without network capture it cannot see the search API, and says so.
    expect(report.network).toHaveLength(0);
  });

  it('suggests a config block that parses back into a valid source', async () => {
    const report = await discover(`${fixture.base}/insights`, { useBrowser: false });
    expect(report.suggestion).not.toBeNull();

    const parsed = YAML.parse(report.suggestion!.yaml) as { sources: { adapter: { kind: string } }[] };
    expect(parsed.sources).toHaveLength(1);
    // A real feed beats a sitemap, which beats scraping.
    expect(parsed.sources[0]?.adapter.kind).toBe('rss');
  });

  it('proposes selectors for a genuinely server-rendered listing', async () => {
    const report = await discover(`${fixture.base}/static-insights`, { useBrowser: false });
    expect(report.html[0]?.itemSelector).toBe('.insight-card');
    expect(report.html[0]?.matches).toBe(ARTICLE_COUNT);
  });
});

describe('discover, with a browser', () => {
  it('degrades with a clear warning when no browser is available', async () => {
    if (browserAvailable) return;
    const report = await discover(`${fixture.base}/insights`, { useBrowser: true });
    expect(report.renderedWithBrowser).toBe(false);
    expect(report.warnings.join(' ')).toContain('Browser capture unavailable');
    // The other probes still ran, so the command is still useful.
    expect(report.feeds.length).toBeGreaterThan(0);
  });

  it('captures the token-authenticated search API behind the page', async () => {
    if (!browserAvailable) return;
    const report = await discover(`${fixture.base}/insights`, { useBrowser: true });
    expect(report.renderedWithBrowser).toBe(true);

    const best = report.network[0];
    expect(best, 'expected the search API to be captured').toBeDefined();
    expect(best!.url).toBe(`${fixture.base}/api/search`);
    expect(best!.method).toBe('POST');
    expect(best!.itemsPath).toBe('results');
    expect(best!.fields.title).toBe('title');
    expect(best!.fields.url).toBe('clickUri');
    expect(best!.fields.published_at).toBe('raw.publishz32xdate');
    expect(best!.fields.categories).toBe('raw.category');
    expect(best!.sampleTitles[0]).toContain('Credit Spreads');
    // The publisher's own categories come back, ready for native_map.
    expect(best!.sampleCategories).toContain('Fixed Income');
  }, 90_000);

  it('never writes the captured bearer token into the suggested config', async () => {
    if (!browserAvailable) return;
    const report = await discover(`${fixture.base}/insights`, { useBrowser: true });
    expect(report.network.length).toBeGreaterThan(0);

    const yaml = report.suggestion!.yaml;
    expect(yaml).not.toContain(SEARCH_TOKEN);
    expect(yaml).toContain('{{token}}');
    // And it records how to re-mint the token instead.
    expect(yaml).toContain('from_page');
  }, 90_000);
});

describe('proxy bypass', () => {
  it('never sends loopback traffic to a proxy', () => {
    expect(shouldProxy('http://127.0.0.1:8080/x', '')).toBe(false);
    expect(shouldProxy('http://localhost:3000/x', '')).toBe(false);
  });

  it('honours NO_PROXY host suffixes and CIDR ranges', () => {
    expect(shouldProxy('https://api.internal.test/x', '.internal.test')).toBe(false);
    expect(shouldProxy('https://internal.test/x', 'internal.test')).toBe(false);
    expect(shouldProxy('http://10.1.2.3/x', '10.0.0.0/8')).toBe(false);
    expect(shouldProxy('http://11.1.2.3/x', '10.0.0.0/8')).toBe(true);
  });

  it('proxies ordinary public hosts', () => {
    expect(shouldProxy('https://www.pimco.com/insights', 'localhost,10.0.0.0/8')).toBe(true);
  });
});
