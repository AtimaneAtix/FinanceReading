import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  startFixtureServer,
  SEARCH_TOKEN,
  ARTICLE_COUNT,
  UNDATED_LASTMOD,
  UNDATED_COUNT,
  RSS_ETAG,
  type Fixture,
} from './fixture-server.ts';
import { makeWorkspace, type TempWorkspace } from './helpers.ts';
import { runOnce } from '../src/ingest/run.ts';
import { clearRobotsCache } from '../src/ingest/http.ts';
import { openDb, pruneOlderThan, prunePreview, sweepOrphanTags } from '../src/db/index.ts';
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

function useTaking(perRun: number, sources: unknown[]): void {
  workspace = makeWorkspace(sources, { poll_minutes: 30, take_per_run: perRun });
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

function gzippedSitemapSource(base: string) {
  return {
    id: 'fixture-sitemap-gz',
    institution: 'Fixture AM',
    name: 'Gzipped sitemap',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'sitemap',
      url: `${base}/sitemap-articles.xml.gz`,
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

function corpusJsonSource(base: string, maxNew: number) {
  return {
    id: 'fixture-corpus',
    institution: 'Fixture AM',
    name: 'Corpus feed',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'json',
      request: { method: 'GET', url: `${base}/feeds/corpus.json` },
      items_path: '',
      fields: {
        title: 'title',
        url: 'slug',
        published_at: 'props.publishDate',
        categories: ['props.topics[].title'],
      },
      max_new_per_run: maxNew,
    },
  };
}

function manyUndatedSource(base: string, maxUndated: number) {
  return {
    id: 'fixture-undated-many',
    institution: 'Fixture AM',
    name: 'Undated sitemap',
    homepage: base,
    static_tags: ['type:insight'],
    adapter: {
      kind: 'sitemap',
      url: `${base}/sitemap-undated-many.xml`,
      include: ['/undated/'],
      max_new_per_run: 25,
      max_undated_per_run: maxUndated,
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

describe('taking only the newest few per run', () => {
  it('drains the backlog a few at a time instead of re-picking the same ones', async () => {
    // The trap this guards: cap the newest two outright and the same two are
    // chosen on every run, so the third article never arrives.
    useTaking(2, [rssSource(fixture.base)]);

    const [first] = await runOnce(true);
    expect(first?.stats.inserted).toBe(2);
    expect(first?.notes.join(' ')).toContain('waiting for the next run');
    expect(storedItems()).toHaveLength(2);

    for (let run = 0; run < 2; run++) await runOnce(true);
    expect(storedItems()).toHaveLength(ARTICLE_COUNT);
  });

  it('takes the newest, not whichever the feed happened to list first', async () => {
    useTaking(1, [rssSource(fixture.base)]);
    await runOnce(true);
    expect(storedItems()[0]?.title).toBe('Credit Spreads in 2026: Where the Value Is');
  });

  it('calls a source whose every article is already stored quiet, not broken', async () => {
    useTaking(ARTICLE_COUNT, [rssSource(fixture.base)]);
    await runOnce(true);

    const [second] = await runOnce(true);
    // Nothing survives the cap on the second run, but nothing is wrong either.
    expect(second?.status).toBe('ok');
    expect(second?.stats.inserted).toBe(0);
  });

  it('refuses a sitemap that crawls more than the source may keep', async () => {
    // The adapter marks every URL it visits as seen, so the difference would
    // be lost rather than held over. Better to refuse than to lose articles.
    useTaking(5, [sitemapSource(fixture.base)]);
    await expect(runOnce(true)).rejects.toThrow(/marks every URL it visits as seen/);
  });
});

describe('json adapter over a whole-corpus feed', () => {
  it('ranks by date before it caps, and resolves the relative slug', async () => {
    // The fixture hands the records over oldest first, so a cap that slices
    // before it ranks would keep the two oldest articles in the archive.
    use([corpusJsonSource(fixture.base, 2)]);
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('ok');

    const items = storedItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title)).toEqual([
      'Credit Spreads in 2026: Where the Value Is',
      'The Inflation Path and What It Means for Rates',
    ]);
    // A feed that states its dates leaves nothing for the panel to estimate.
    expect(items.every((i) => i.date_estimated === 0)).toBe(true);
    // "/articles/credit-spreads-2026" would otherwise point at the panel.
    expect(items[0]?.url).toBe(`${fixture.base}/articles/credit-spreads-2026`);
    // The taxonomy arrives as objects, reached through the fanned-out path.
    expect(JSON.parse(String(items[0]?.native_categories))).toContain('Fixed Income');
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

  it('takes only its allowance of undated articles, and resumes below them next run', async () => {
    use([manyUndatedSource(fixture.base, 2)]);

    const [first] = await runOnce(true);
    expect(first?.status).toBe('ok');
    expect(storedItems()).toHaveLength(2);

    // The cap is not a filter on the whole sitemap: the run stopped early and
    // marked only what it visited, so the rest arrives next time.
    const [second] = await runOnce(true);
    expect(second?.status).toBe('ok');
    expect(storedItems()).toHaveLength(UNDATED_COUNT);

    // ...and once it is all in, the source is quiet rather than broken.
    const [third] = await runOnce(true);
    expect(third?.status).toBe('ok');
    expect(storedItems()).toHaveLength(UNDATED_COUNT);
  });

  it('does not fetch the articles it stopped short of', async () => {
    use([manyUndatedSource(fixture.base, 1)]);
    fixture.requests.length = 0;
    await runOnce(true);

    const fetched = fixture.requests.filter((r) => r.includes('/undated/'));
    // One article page, not all four: the allowance caps the crawl too.
    expect(fetched).toHaveLength(1);
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

  it('reads a gzipped sitemap', async () => {
    // Decoding the compressed body as text and re-encoding it replaces every
    // byte that is not valid UTF-8, so the stream no longer has a gzip header
    // and every .gz sitemap failed to decompress.
    use([gzippedSitemapSource(fixture.base)]);
    const [outcome] = await runOnce(true);

    expect(outcome?.error).toBeNull();
    expect(outcome?.status).toBe('ok');
    expect(outcome?.stats.inserted).toBe(ARTICLE_COUNT);
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

  it('does not keep a fallback\u2019s ETag, which belongs to a different URL', async () => {
    use([
      {
        id: 'fixture-fallback-etag',
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

    // Stored validators are replayed to the *primary* adapter next run, and
    // recordFetch coalesces rather than clears, so a fallback's ETag would ask
    // one URL whether another had changed -- for every run thereafter.
    const db = openDb();
    const row = db.prepare('SELECT etag, last_modified FROM sources WHERE id = ?')
      .get('fixture-fallback-etag') as { etag: string | null; last_modified: string | null };
    db.close();
    expect(row.etag).toBeNull();
    expect(row.last_modified).toBeNull();
  });

  it('keeps the primary adapter\u2019s own ETag', async () => {
    use([rssSource(fixture.base)]);
    await runOnce(true);

    const db = openDb();
    const row = db.prepare('SELECT etag FROM sources WHERE id = ?').get('fixture-rss') as
      { etag: string | null };
    db.close();
    expect(row.etag).toBe(RSS_ETAG);
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

describe('pruning', () => {
  it('does not let a feed re-offer what was pruned', async () => {
    // The whole reason tombstones exist. A feed's window reaches back much
    // further than its length suggests -- CBRT's publications feed still lists
    // items from 2023 -- and rss sources judge novelty against the items table
    // alone. Without a tombstone the pruned article returns on the very next
    // run and is pruned again on the next pass, for ever.
    use([rssSource(fixture.base)]);
    await runOnce(true);
    const before = storedItems().length;
    expect(before).toBe(ARTICLE_COUNT);

    const db = openDb();
    // Everything, so the fixture feed still lists every one of them.
    const result = pruneOlderThan(db, Date.now());
    db.close();
    expect(result.deleted).toBe(ARTICLE_COUNT);
    expect(storedItems()).toHaveLength(0);

    // The feed has not changed, and offers the same articles again.
    const [outcome] = await runOnce(true);
    expect(outcome?.status).toBe('ok');
    expect(outcome?.stats.inserted).toBe(0);
    expect(storedItems()).toHaveLength(0);
  });

  it('keeps what is inside the window and drops what is outside it', async () => {
    use([rssSource(fixture.base)]);
    await runOnce(true);

    const db = openDb();
    const cutoff = Date.now() - 365 * 86_400_000;
    const preview = prunePreview(db, cutoff);
    const result = pruneOlderThan(db, cutoff);
    db.close();

    // The fixture's articles are all recent, so a year-old cut takes none.
    expect(preview.total).toBe(0);
    expect(result.deleted).toBe(0);
    expect(storedItems()).toHaveLength(ARTICLE_COUNT);
  });

  it('sweeps tag rows whose article was deleted without the cascade', async () => {
    use([rssSource(fixture.base)]);
    await runOnce(true);

    const db = openDb();
    // Exactly what a sqlite3 session does: the pragma is per-connection and
    // the CLI leaves it off, so the tags are left behind.
    db.pragma('foreign_keys = OFF');
    const victim = db.prepare('SELECT id FROM items LIMIT 1').get() as { id: number };
    db.prepare('DELETE FROM items WHERE id = ?').run(victim.id);
    db.pragma('foreign_keys = ON');

    const orphaned = db
      .prepare('SELECT COUNT(*) AS n FROM item_tags WHERE item_id NOT IN (SELECT id FROM items)')
      .get() as { n: number };
    expect(orphaned.n).toBeGreaterThan(0);

    expect(sweepOrphanTags(db)).toBe(orphaned.n);
    const left = db
      .prepare('SELECT COUNT(*) AS n FROM item_tags WHERE item_id NOT IN (SELECT id FROM items)')
      .get() as { n: number };
    db.close();
    expect(left.n).toBe(0);
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

  it('ignores a tag that carries no facet instead of filtering on it', async () => {
    const p = await panel();
    // A tag is "facet:value"; anything else came from a hand-edited URL and
    // cannot match, so it must not narrow the panel to nothing.
    const junk = await p.get('/api/items?since=all&tags=nonsense');
    const real = await p.get('/api/items?since=all&tags=type:insight');
    expect(junk.total).toBe(ARTICLE_COUNT);
    expect(real.total).toBe(ARTICLE_COUNT);
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
