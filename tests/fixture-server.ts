/**
 * A stand-in for the real institutions, so the whole pipeline can be exercised
 * without touching the internet.
 *
 * It deliberately reproduces the awkward parts of the real thing: a listing
 * page whose articles exist only in JavaScript, a search API that wants a
 * bearer token minted by that page, a sitemap index one level deep, and the
 * same article published under two regional paths.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SEARCH_TOKEN = 'tok_live_9f3c2a';

/** Tests assert against this rather than a hardcoded number. */
export const ARTICLE_COUNT = 6;

const ARTICLES = [
  {
    slug: 'credit-spreads-2026',
    title: 'Credit Spreads in 2026: Where the Value Is',
    summary: 'High yield spreads have compressed, but dispersion across issuers is widening.',
    date: '2026-09-05T09:00:00Z',
    categories: ['Fixed Income', 'a1b2c3d4e5f6'],
  },
  {
    slug: 'inflation-path',
    title: 'The Inflation Path and What It Means for Rates',
    summary: 'Core inflation is cooling, and the central bank has room to cut before year end.',
    date: '2026-09-04T14:30:00Z',
    categories: ['Economic and Market Commentary'],
  },
  {
    slug: 'equity-outlook-q4',
    title: 'Q4 2026 Equity Outlook: Earnings Do the Heavy Lifting',
    summary: 'Valuations are stretched, so returns from here depend on earnings delivery.',
    date: '2026-09-03T08:15:00Z',
    categories: ['Equities'],
  },
  {
    slug: 'em-debt-carry',
    title: 'Emerging Market Debt: Carry Without the Currency Risk',
    summary: 'Local currency yields look attractive once the dollar stops appreciating.',
    date: '2026-09-02T11:00:00Z',
    categories: ['Emerging Markets', 'Fixed Income'],
  },
  {
    slug: 'private-credit-cycle',
    title: 'Private Credit Enters a Less Forgiving Part of the Cycle',
    summary: 'Default rates are normalising as the vintage of 2021 loans reaches maturity.',
    date: '2026-09-01T16:45:00Z',
    categories: ['Private Markets'],
  },
  {
    slug: 'energy-transition-capex',
    title: 'Energy Transition Capex and the Commodities It Consumes',
    summary: 'Grid investment is lifting structural demand for copper well past this cycle.',
    date: '2026-08-31T07:30:00Z',
    categories: ['Commodities', 'Sustainability'],
  },
];

function articleHtml(base: string, slug: string): string | null {
  const article = ARTICLES.find((a) => a.slug === slug);
  if (!article) return null;
  return `<!doctype html><html><head>
<title>${article.title} | Fixture Asset Management</title>
<meta property="og:title" content="${article.title}">
<meta property="og:description" content="${article.summary}">
<meta property="article:published_time" content="${article.date}">
<meta property="article:section" content="${article.categories[0]}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"NewsArticle","headline":"${article.title}",
 "datePublished":"${article.date}","articleSection":"${article.categories[0]}"}
</script>
</head><body><h1>${article.title}</h1><p>${article.summary}</p>
<p>See also <a href="${base}/insights">all insights</a>.</p></body></html>`;
}

/** The Coveo-style listing page: no articles in the HTML, only a token. */
function listingHtml(base: string): string {
  return `<!doctype html><html><head>
<title>Insights | Fixture Asset Management</title>
<link rel="alternate" type="application/rss+xml" title="Fixture Insights" href="${base}/rss.xml">
<script>
  window.__SEARCH__ = {"accessToken":"${SEARCH_TOKEN}","organizationId":"fixtureprod"};
</script>
</head><body>
<div id="coveo-results" data-sort="@publishz32xdate descending"></div>
<noscript>This listing requires JavaScript.</noscript>
<script>
  // The articles exist only after this call, which is the whole difficulty:
  // a plain HTTP fetch of this page sees an empty shell.
  fetch('${base}/api/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + window.__SEARCH__.accessToken,
    },
    body: JSON.stringify({ firstResult: 0, numberOfResults: 50 }),
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var host = document.getElementById('coveo-results');
      data.results.forEach(function (result) {
        var card = document.createElement('div');
        card.className = 'coveo-result';
        var link = document.createElement('a');
        link.href = result.clickUri;
        link.textContent = result.title;
        card.appendChild(link);
        host.appendChild(card);
      });
    });
</script>
</body></html>`;
}

/** A second listing page that really is server-rendered, for the html adapter. */
function staticListingHtml(base: string): string {
  const cards = ARTICLES.map(
    (a) => `<li class="insight-card">
      <a class="insight-card__link" href="${base}/articles/${a.slug}">${a.title}</a>
      <time datetime="${a.date}">${a.date.slice(0, 10)}</time>
      <p class="insight-card__excerpt">${a.summary}</p>
    </li>`,
  ).join('\n');
  return `<!doctype html><html><head><title>Static insights</title></head>
<body><ul class="insight-list">${cards}</ul></body></html>`;
}

function rssXml(base: string): string {
  const items = ARTICLES.map(
    (a) => `  <item>
    <title>${a.title}</title>
    <link>${base}/articles/${a.slug}?utm_source=rss&amp;utm_medium=feed</link>
    <description>${a.summary}</description>
    <pubDate>${new Date(a.date).toUTCString()}</pubDate>
    <category>${a.categories[0]}</category>
  </item>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Fixture Insights</title>
  <link>${base}/insights</link>
  <description>Fixture feed</description>
${items}
</channel></rss>`;
}

function searchJson(offset: number, pageSize: number): string {
  // Shaped like a real search API: results wrapped, real fields under `raw`.
  const slice = ARTICLES.slice(offset, offset + pageSize);
  return JSON.stringify({
    totalCount: ARTICLES.length,
    results: slice.map((a) => ({
      title: a.title,
      clickUri: `https://fixture.test/articles/${a.slug}`,
      excerpt: a.summary,
      raw: {
        publishz32xdate: new Date(a.date).getTime(),
        category: a.categories,
        objecttype: 'Insight',
      },
    })),
  });
}

/**
 * The whole corpus in one response, oldest first and with a relative path
 * instead of a URL -- the shape Goldman's insights feed actually has, and the
 * one that catches a cap that slices before it ranks.
 */
function corpusJson(): string {
  return JSON.stringify(
    [...ARTICLES].reverse().map((a) => ({
      title: a.title,
      slug: `/articles/${a.slug}`,
      props: { publishDate: a.date, topics: a.categories.map((title) => ({ title })) },
    })),
  );
}

/** The CMS rebuild timestamp on the undated fixture page. */
export const UNDATED_LASTMOD = '2026-09-07T13:19:18Z';

/** How many undated pages the undated sitemap lists. */
export const UNDATED_COUNT = 4;

function sitemapUndatedMany(base: string): string {
  // All four share one lastmod, as a section re-stamped in a single rebuild
  // does, so document order is the only ordering left.
  const entries = Array.from(
    { length: UNDATED_COUNT },
    (_, i) =>
      `  <url><loc>${base}/undated/note-${i + 1}</loc><lastmod>${UNDATED_LASTMOD}</lastmod></url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

function sitemapIndex(base: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-articles.xml</loc><lastmod>2026-09-05</lastmod></sitemap>
  <sitemap><loc>${base}/sitemap-legal.xml</loc><lastmod>2020-01-01</lastmod></sitemap>
</sitemapindex>`;
}

function sitemapArticles(base: string): string {
  // The last entry is the same article under a second regional path — exactly
  // the /us/en vs /eu/en duplication the near-duplicate check exists for.
  const entries = ARTICLES.map(
    (a) => `  <url><loc>${base}/articles/${a.slug}</loc><lastmod>${a.date}</lastmod></url>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
  <url><loc>${base}/eu/articles/credit-spreads-2026</loc><lastmod>2026-09-05T10:00:00Z</lastmod></url>
</urlset>`;
}

export interface Fixture {
  base: string;
  close: () => Promise<void>;
  requests: string[];
}

export async function startFixtureServer(): Promise<Fixture> {
  const requests: string[] = [];
  let base = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);

    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/robots.txt') {
      return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\nSitemap: ${base}/sitemap.xml\n`);
    }
    if (url.pathname === '/insights') return send(200, 'text/html', listingHtml(base));
    if (url.pathname === '/static-insights') return send(200, 'text/html', staticListingHtml(base));
    if (url.pathname === '/rss.xml') return send(200, 'application/rss+xml', rssXml(base));
    if (url.pathname === '/feeds/corpus.json') return send(200, 'application/json', corpusJson());
    if (url.pathname === '/sitemap-undated-many.xml') {
      return send(200, 'application/xml', sitemapUndatedMany(base));
    }
    if (url.pathname === '/sitemap-undated.xml') {
      // A page the CMS re-stamped today; the article behind it is years old
      // and states no date anywhere.
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
          `<url><loc>${base}/undated/stale-note</loc>` +
          `<lastmod>${UNDATED_LASTMOD}</lastmod></url></urlset>`,
      );
    }

    if (url.pathname.startsWith('/undated/')) {
      // Distinct titles, or the near-duplicate check would fold these into one
      // and the test would be measuring deduplication rather than the cap.
      const slug = url.pathname.split('/').pop() ?? '';
      const title = `A Note From Years Ago (${slug})`;
      return send(
        200,
        'text/html',
        `<!doctype html><html><head><title>${title} | Fixture Asset Management</title>` +
          `<meta property="og:title" content="${title}">` +
          `<meta property="og:description" content="No date is published anywhere on this page.">` +
          `</head><body><h1>${title}</h1></body></html>`,
      );
    }

    if (url.pathname === '/sitemap.xml') return send(200, 'application/xml', sitemapIndex(base));
    if (url.pathname === '/sitemap-articles.xml') return send(200, 'application/xml', sitemapArticles(base));
    if (url.pathname === '/sitemap-legal.xml') {
      return send(200, 'application/xml', `<?xml version="1.0"?><urlset><url><loc>${base}/legal/terms</loc></url></urlset>`);
    }

    if (url.pathname === '/api/search') {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${SEARCH_TOKEN}`) {
        return send(401, 'application/json', JSON.stringify({ error: 'invalid token' }));
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let offset = 0;
        let pageSize = 50;
        try {
          const parsed = JSON.parse(body || '{}') as { firstResult?: number; numberOfResults?: number };
          offset = parsed.firstResult ?? 0;
          pageSize = parsed.numberOfResults ?? 50;
        } catch {
          // Defaults are fine.
        }
        send(200, 'application/json', searchJson(offset, pageSize));
      });
      return;
    }

    const articleMatch = /^(?:\/eu)?\/articles\/([a-z0-9-]+)$/.exec(url.pathname);
    if (articleMatch?.[1]) {
      const html = articleHtml(base, articleMatch[1]);
      if (html) return send(200, 'text/html', html);
    }

    send(404, 'text/plain', 'not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    base,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
