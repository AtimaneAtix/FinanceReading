import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  startFixtureServer,
  SEARCH_TOKEN,
  ARTICLE_COUNT,
  UNDATED_LASTMOD,
  type Fixture,
} from './fixture-server.ts';
import { makeWorkspace, type TempWorkspace } from './helpers.ts';
import { runOnce } from '../src/ingest/run.ts';
import { clearRobotsCache } from '../src/ingest/http.ts';
import { openDb } from '../src/db/index.ts';
import { loadTaxonomy } from '../src/config.ts';
import { buildServer } from '../src/server/index.ts';

let fixture: Fixture;
let workspace: TempWorkspace | null = null;

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.close();
});

afterEach(() => {
  workspace?.cleanup();
  workspace = null;
});

function use(sources: unknown[]): void {
  workspace = makeWorkspace(sources);
}

function rssSource(base: string) {
  return {
    id: 'fixture-rss',
    institution: 'Fixture AM',
    name: 'Insights feed',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: { kind: 'rss', url: `${base}/rss.xml` },
  };
}

function jsonSource(base: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'fixture-json',
    institution: 'Fixture AM',
    name: 'Search API',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'json',
      request: {
        method: 'POST',
        url: `${base}/api/search`,
        headers: { 'content-type': 'application/json' },
        body: '{"firstResult":{{offset}},"numberOfResults":{{page_size}}}',
      },
      auth: {
        kind: 'from_page',
        page_url: `${base}/insights`,
        token_regex: '"accessToken"\\s*:\\s*"([^"]+)"',
      },
      items_path: 'results',
      fields: {
        title: 'title',
        url: 'clickUri',
        summary: 'excerpt',
        published_at: 'raw.publishz32xdate',
        categories: 'raw.category',
      },
      pagination: { kind: 'offset', page_size: 2, max_pages: 3 },
      ...extra,
    },
  };
}

function sitemapSource(base: string) {
  return {
    id: 'fixture-sitemap',
    institution: 'Fixture AM',
    name: 'Sitemap',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'sitemap',
      url: `${base}/sitemap.xml`,
      include: ['/articles/'],
      max_new_per_run: 25,
    },
  };
}

function undatedSitemapSource(base: string) {
  return {
    id: 'fixture-undated',
    institution: 'Fixture AM',
    name: 'Undated sitemap',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'sitemap',
      url: `${base}/sitemap-undated.xml`,
      include: ['/undated/'],
      max_new_per_run: 25,
    },
  };
}

function htmlSource(base: string) {
  return {
    id: 'fixture-html',
    institution: 'Fixture AM',
    name: 'Static listing',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'html',
      url: `${base}/static-insights`,
      selectors: {
        item: '.insight-card',
        title: 'a.insight-card__link',
        link: 'a.insight-card__link@href',
        date: 'time@datetime',
        summary: '.insight-card__excerpt',
      },
    },
  };
}

function storedItems() {
  const db = openDb();
  try {
    return db
      .prepare(
        `SELECT items.*, GROUP_CONCAT(item_tags.tag) AS tags
           FROM items LEFT JOIN item_tags ON item_tags.item_id = items.id
          GROUP BY items.id ORDER BY items.published_at DESC`,
      )
      .all() as (Record<string, unknown> & { tags: string | null })[];
  } finally {
    db.close();
  }
}

describe('rss adapter', () => {
  it('ingests a feed, strips tracking parameters and tags the articles', async () => {
    use([rssSource(fixture.base)]);
    const [outcome] = await runOnce(true);

    expect(outcome?.status).toBe('ok');
    expect(outcome?.adapterUsed).toBe('rss');
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);

    const items = storedItems();
    expect(items).toHaveLength(ARTICLE_COUNT);
    expect(items[0]?.title).toBe('Credit Spreads in 2026: Where the Value Is');
    // The link the user clicks keeps the publisher's own URL.
    expect(String(items[0]?.url)).toContain('utm_source=rss');
    expect(items[0]?.date_estimated).toBe(0);
    expect(String(items[0]?.tags)).toContain('asset:credit');
    expect(String(items[0]?.tags)).toContain('type:insight');
  });

  it('inserts nothing on a second run', async () => {
    use([rssSource(fixture.base)]);
    await runOnce(true);
    const [second] = await runOnce(true);
    expect(second?.status).toBe('ok');
    expect(second?.stats.inserted).toBe(0);
    expect(second?.stats.duplicateUrl).toBe(ARTICLE_COUNT);
    expect(storedItems()).toHaveLength(ARTICLE_COUNT);
  });
});

describe('json adapter', () => {
  it('mints the search token from the page and pages through results', async () => {
    use([jsonSource(fixture.base)]);
    const [outcome] = await runOnce(true);

    expect(outcome?.status).toBe('ok');
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);

    const items = storedItems();
    const categories = JSON.parse(String(items[0]?.native_categories)) as string[];
    // The publisher's own taxonomy is kept verbatim for native_map tagging.
    expect(categories).toContain('Fixed Income');
    // An epoch-millisecond date is a real date, not an estimate.
    expect(items[0]?.date_estimated).toBe(0);
  });

  it('reports a rejected token clearly instead of silently returning nothing', async () => {
    use([
      jsonSource(fixture.base, {
        auth: { kind: 'from_page', page_url: `${fixture.base}/insights`, token_regex: '"nope":"([^"]+)"' },
      }),
    ]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('error');
    expect(outcome?.error).toContain('token_regex did not match');
  });

  it('fails loudly when the field paths are wrong', async () => {
    use([
      {
        ...jsonSource(fixture.base),
        adapter: {
          ...jsonSource(fixture.base).adapter,
          fields: { title: 'nope', url: 'alsoNope' },
        },
      },
    ]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('empty');
    expect(outcome?.notes.join(' ')).toContain('check the field paths');
  });
});

describe('sitemap adapter', () => {
  it('follows the index, reads each article and collapses the regional duplicate', async () => {
    use([sitemapSource(fixture.base)]);
    const [outcome] = await runOnce(true);

    expect(outcome?.status).toBe('ok');
    // Every article, plus one of them again under an /eu/ path.
    expect(outcome?.fetched).toBe(ARTICLE_COUNT + 1);
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);
    expect(outcome?.stats.duplicateTitle).toBe(1);

    const items = storedItems();
    expect(items.map((i) => i.title)).toContain('The Inflation Path and What It Means for Rates');
    expect(items[0]?.summary).toBeTruthy();
  });

  it('marks a lastmod-derived date as estimated, so stale pages cannot pose as fresh', async () => {
    use([undatedSitemapSource(fixture.base)]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('ok');

    const [item] = storedItems();
    // lastmod is still used for ordering...
    expect(item?.published_at).toBe(Date.parse(UNDATED_LASTMOD));
    // ...but it is a CMS rebuild timestamp, not a publication date.
    expect(item?.date_estimated).toBe(1);
  });

  it('keeps a date the article states for itself as certain', async () => {
    use([sitemapSource(fixture.base)]);
    await runOnce(true);
    const dated = storedItems();
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((i) => i.date_estimated === 0)).toBe(true);
  });

  it('treats "nothing new" as healthy rather than broken', async () => {
    use([sitemapSource(fixture.base)]);
    await runOnce(true);
    const [second] = await runOnce(true);
    expect(second?.status).toBe('ok');
    expect(second?.stats.inserted).toBe(0);
    expect(second?.notes).toContain('no new URLs in sitemap');
  });
});

describe('html adapter', () => {
  it('extracts a server-rendered listing with relative links', async () => {
    use([htmlSource(fixture.base)]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('ok');
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);
  });

  it('says plainly when selectors match nothing on a JavaScript page', async () => {
    use([
      {
        ...htmlSource(fixture.base),
        adapter: {
          kind: 'html',
          url: `${fixture.base}/insights`,
          selectors: { item: '.insight-card', title: 'a', link: 'a@href' },
        },
      },
    ]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('empty');
    expect(outcome?.notes.join(' ')).toContain('run `npm run discover`');
  });
});

describe('fallback chain', () => {
  it('falls through to the next adapter when the primary is broken', async () => {
    use([
      {
        id: 'fixture-fallback',
        institution: 'Fixture AM',
        name: 'Primary with fallback',
        homepage: fixture.base,
        static_tags: ['type:insight'],
        adapter: { kind: 'rss', url: `${fixture.base}/does-not-exist.xml` },
        fallback: [{ kind: 'rss', url: `${fixture.base}/rss.xml` }],
      },
    ]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('ok');
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);
  });

  it('records a genuine failure with a usable message', async () => {
    use([
      {
        id: 'fixture-broken',
        institution: 'Fixture AM',
        name: 'Broken feed',
        homepage: fixture.base,
        adapter: { kind: 'rss', url: `${fixture.base}/insights` },
      },
    ]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('error');
    expect(outcome?.error).toContain('HTML page, not a feed');

    const db = openDb();
    const row = db.prepare('SELECT consecutive_failures, last_status FROM sources WHERE id = ?').get('fixture-broken') as
      { consecutive_failures: number; last_status: string };
    db.close();
    expect(row.last_status).toBe('error');
    expect(row.consecutive_failures).toBe(1);
  });
});

describe('cross-source deduplication', () => {
  it('shows one row when two sources carry the same articles', async () => {
    use([rssSource(fixture.base), jsonSource(fixture.base), sitemapSource(fixture.base)]);
    const outcomes = await runOnce(true);
    expect(outcomes.every((o) => o.status === 'ok')).toBe(true);
    // Three sources, one set of real articles.
    expect(storedItems()).toHaveLength(ARTICLE_COUNT);
  });
});

describe('the panel API', () => {
  async function panel() {
    use([rssSource(fixture.base), sitemapSource(fixture.base)]);
    await runOnce(true);
    const db = openDb();
    const app = buildServer(db, loadTaxonomy());
    await app.ready();
    return {
      app,
      db,
      get: async (path: string) => JSON.parse((await app.inject({ method: 'GET', url: path })).body),
      close: async () => {
        await app.close();
        db.close();
      },
    };
  }

  it('returns newest first with tags and a working link', async () => {
    const p = await panel();
    const data = await p.get('/api/items?since=all');
    expect(data.total).toBe(ARTICLE_COUNT);
    expect(data.items[0].title).toBe('Credit Spreads in 2026: Where the Value Is');
    expect(data.items[0].url).toMatch(/^http/);
    expect(data.items[0].publishedAt).toBeGreaterThan(data.items[1].publishedAt);
    await p.close();
  });

  it('narrows on one tag and narrows further on a second facet', async () => {
    const p = await panel();
    const credit = await p.get('/api/items?since=all&tags=asset:credit');
    const creditMacro = await p.get('/api/items?since=all&tags=asset:credit,scope:macro');
    expect(credit.total).toBeGreaterThan(0);
    expect(creditMacro.total).toBeLessThanOrEqual(credit.total);
    await p.close();
  });

  it('widens when two tags share a facet', async () => {
    const p = await panel();
    const one = await p.get('/api/items?since=all&tags=asset:credit');
    const two = await p.get('/api/items?since=all&tags=asset:credit,asset:equities');
    expect(two.total).toBeGreaterThan(one.total);
    await p.close();
  });

  it('counts each facet with its own selection removed', async () => {
    const p = await panel();
    const data = await p.get('/api/items?since=all&tags=asset:credit');
    const equities = data.facets.asset.find((f: { value: string }) => f.value === 'asset:equities');
    // Without this, selecting credit would show equities as zero and the
    // sidebar would become a dead end.
    expect(equities.count).toBeGreaterThan(0);
    await p.close();
  });

  it('searches titles and summaries', async () => {
    const p = await panel();
    const hit = await p.get('/api/items?since=all&q=inflation');
    const miss = await p.get('/api/items?since=all&q=zzzznothing');
    expect(hit.total).toBe(1);
    expect(miss.total).toBe(0);
    await p.close();
  });

  it('treats % in a search as a character, not a wildcard', async () => {
    const p = await panel();
    const data = await p.get('/api/items?since=all&q=%25');
    expect(data.total).toBe(0);
    await p.close();
  });

  it('pages with a stable cursor', async () => {
    const p = await panel();
    const first = await p.get('/api/items?since=all&limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await p.get(`/api/items?since=all&limit=2&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeTruthy();
    const ids = [...first.items, ...second.items].map((i: { id: number }) => i.id);
    expect(new Set(ids).size).toBe(4);
    await p.close();
  });

  it('filters by institution', async () => {
    const p = await panel();
    const mine = await p.get('/api/items?since=all&institution=Fixture%20AM');
    const other = await p.get('/api/items?since=all&institution=Nobody');
    expect(mine.total).toBe(ARTICLE_COUNT);
    expect(other.total).toBe(0);
    await p.close();
  });

  it('reports source health so a broken fetch is visible', async () => {
    const p = await panel();
    const health = await p.get('/api/health');
    expect(health.totalItems).toBe(ARTICLE_COUNT);
    expect(health.broken).toBe(0);
    expect(health.sources).toHaveLength(2);
    await p.close();
  });
});

describe('politeness', () => {
  it('checks robots.txt before crawling article pages', async () => {
    use([sitemapSource(fixture.base)]);
    // robots.txt is cached between fetches, so start this case from cold.
    clearRobotsCache();
    fixture.requests.length = 0;
    await runOnce(true);
    expect(fixture.requests).toContain('GET /robots.txt');
  });

  it('caches robots.txt instead of re-fetching it for every article', async () => {
    use([sitemapSource(fixture.base)]);
    clearRobotsCache();
    fixture.requests.length = 0;
    await runOnce(true);
    const robotsHits = fixture.requests.filter((r) => r === 'GET /robots.txt').length;
    expect(robotsHits).toBe(1);
  });

  it('sends the token only to the search API, never in the config', async () => {
    use([jsonSource(fixture.base)]);
    await runOnce(true);
    const db = openDb();
    const row = db.prepare('SELECT config_json FROM sources WHERE id = ?').get('fixture-json') as
      { config_json: string };
    db.close();
    expect(row.config_json).not.toContain(SEARCH_TOKEN);
  });
});
