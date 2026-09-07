import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, canonicalHash, titleKey, parseDate, toExcerpt } from '../src/ingest/canonical.ts';
import { getPath, render } from '../src/ingest/adapters/json.ts';
import { extractArticleMeta } from '../src/ingest/meta.ts';
import { parseRobots, pathMatches, describeFetchFailure } from '../src/ingest/http.ts';
import { Tagger } from '../src/ingest/tagger.ts';
import { loadTaxonomy } from '../src/config.ts';
import { findRecordArrays, guessFields, looksLikeTitle, looksLikeUrl } from '../src/discover/score.ts';

describe('canonicalizeUrl', () => {
  it('drops the fragment that insight hubs keep their filter state in', () => {
    const withFragment =
      'https://www.pimco.com/eu/en/insights#sort=%40publishz32xdate%20descending&f:category=[70341f6d]';
    expect(canonicalizeUrl(withFragment)).toBe('https://pimco.com/eu/en/insights');
  });

  it('treats tracking parameters as noise', () => {
    expect(canonicalizeUrl('https://a.test/x?utm_source=rss&utm_medium=feed&id=7')).toBe(
      'https://a.test/x?id=7',
    );
    expect(canonicalizeUrl('https://a.test/x?gclid=abc')).toBe('https://a.test/x');
  });

  it('normalises host, scheme and trailing slash', () => {
    const variants = [
      'http://www.Example.com/insights/',
      'https://example.com/insights',
      'https://WWW.example.com:443/insights/',
    ];
    const hashes = new Set(variants.map((v) => canonicalHash(canonicalizeUrl(v)!)));
    expect(hashes.size).toBe(1);
  });

  it('keeps meaningful query parameters and their order stable', () => {
    expect(canonicalizeUrl('https://a.test/x?b=2&a=1')).toBe(canonicalizeUrl('https://a.test/x?a=1&b=2'));
    expect(canonicalizeUrl('https://a.test/x?a=1&b=2')).toContain('a=1&b=2');
  });

  it('rejects anything that is not a fetchable document', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('mailto:a@b.test')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('resolves relative links against the source homepage', () => {
    expect(canonicalizeUrl('/insights/piece', 'https://a.test/section/')).toBe(
      'https://a.test/insights/piece',
    );
  });
});

describe('titleKey', () => {
  it('matches the same article published under two regional paths', () => {
    expect(titleKey('Credit Spreads in 2026: Where the Value Is')).toBe(
      titleKey('Credit spreads in 2026 — where the value is'),
    );
  });

  it('ignores a site-name suffix', () => {
    expect(titleKey('The Inflation Path | PIMCO')).toBe(titleKey('The Inflation Path'));
  });

  it('refuses to key on a title too short to be distinctive', () => {
    expect(titleKey('Update')).toBe('');
    expect(titleKey('Q4')).toBe('');
  });

  it('does not collapse genuinely different titles', () => {
    expect(titleKey('Equity Outlook 2026')).not.toBe(titleKey('Equity Outlook 2027'));
  });
});

describe('parseDate', () => {
  const now = Date.UTC(2026, 8, 7);

  it('reads ISO, RFC 822, epoch seconds and epoch milliseconds', () => {
    expect(parseDate('2026-09-05T09:00:00Z', now).ms).toBe(Date.UTC(2026, 8, 5, 9));
    expect(parseDate('Sat, 05 Sep 2026 09:00:00 GMT', now).ms).toBe(Date.UTC(2026, 8, 5, 9));
    expect(parseDate(1757062800, now).ms).toBe(1757062800 * 1000);
    expect(parseDate('1757062800000', now).ms).toBe(1757062800000);
  });

  it('marks unusable values as estimated instead of inventing a date', () => {
    expect(parseDate(null, now).estimated).toBe(true);
    expect(parseDate('', now).estimated).toBe(true);
    expect(parseDate('not a date', now).estimated).toBe(true);
  });

  it('rejects a far-future date rather than pinning it to the top of the list', () => {
    expect(parseDate('2099-01-01T00:00:00Z', now).estimated).toBe(true);
  });

  it('rejects an implausibly old date', () => {
    expect(parseDate('1900-01-01T00:00:00Z', now).estimated).toBe(true);
  });
});

describe('toExcerpt', () => {
  it('strips markup and decodes entities', () => {
    expect(toExcerpt('<p>Rates &amp; <b>credit</b></p>')).toBe('Rates & credit');
  });

  it('truncates long text on a boundary', () => {
    const long = toExcerpt('word '.repeat(200), 50);
    expect(long!.length).toBeLessThanOrEqual(50);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('returns null for nothing useful', () => {
    expect(toExcerpt('<p>  </p>')).toBeNull();
    expect(toExcerpt(null)).toBeNull();
  });
});

describe('json field paths', () => {
  const payload = { data: { hits: [{ raw: { title: 'A' } }, { raw: { title: 'B' } }] } };

  it('reads nested paths and array indices', () => {
    expect(getPath(payload, 'data.hits[1].raw.title')).toBe('B');
    expect(getPath(payload, 'data.hits')).toHaveLength(2);
  });

  it('returns the root for an empty path, so a top-level array works', () => {
    expect(getPath([1, 2], '')).toEqual([1, 2]);
  });

  it('returns undefined instead of throwing on a wrong path', () => {
    expect(getPath(payload, 'data.missing.deep')).toBeUndefined();
  });

  it('substitutes template variables', () => {
    expect(render('{"firstResult":{{offset}},"n":{{page_size}}}', { offset: 50, page_size: 25 })).toBe(
      '{"firstResult":50,"n":25}',
    );
    expect(render('Bearer {{token}}', { token: 'abc' })).toBe('Bearer abc');
  });
});

describe('article metadata', () => {
  it('prefers OpenGraph, then JSON-LD, then the title tag', () => {
    const meta = extractArticleMeta(`<html><head>
      <title>Fallback | Site</title>
      <meta property="og:title" content="Real Headline">
      <meta property="og:description" content="A summary.">
      <meta property="article:published_time" content="2026-09-05T09:00:00Z">
      <meta property="article:section" content="Fixed Income">
    </head><body></body></html>`);
    expect(meta.title).toBe('Real Headline');
    expect(meta.summary).toBe('A summary.');
    expect(meta.publishedAt).toBe('2026-09-05T09:00:00Z');
    expect(meta.categories).toContain('Fixed Income');
  });

  it('falls back to JSON-LD when OpenGraph is missing', () => {
    const meta = extractArticleMeta(`<html><head><script type="application/ld+json">
      {"@type":"NewsArticle","headline":"From JSON-LD","datePublished":"2026-01-02T00:00:00Z",
       "articleSection":["Macro","Rates"]}
    </script></head><body></body></html>`);
    expect(meta.title).toBe('From JSON-LD');
    expect(meta.publishedAt).toBe('2026-01-02T00:00:00Z');
    expect(meta.categories).toEqual(expect.arrayContaining(['Macro', 'Rates']));
  });

  it('survives malformed JSON-LD', () => {
    const meta = extractArticleMeta(
      '<html><head><title>Still Works</title><script type="application/ld+json">{oops</script></head></html>',
    );
    expect(meta.title).toBe('Still Works');
  });
});

describe('robots.txt', () => {
  it('applies the most specific matching rule', () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/public/\n`);
    expect(rules.disallow).toContain('/private/');
    expect(pathMatches('/private/secret', '/private/')).toBe(true);
    expect(pathMatches('/insights/a', '/private/')).toBe(false);
  });

  it('understands wildcards and end anchors', () => {
    expect(pathMatches('/a/b.pdf', '/*.pdf$')).toBe(true);
    expect(pathMatches('/a/b.pdf?x=1', '/*.pdf$')).toBe(false);
  });

  it('prefers a group naming our agent over the wildcard group', () => {
    const rules = parseRobots(
      `User-agent: *\nDisallow: /\n\nUser-agent: financereadingbot\nDisallow: /admin/\n`,
    );
    expect(rules.disallow).toEqual(['/admin/']);
  });
});

describe('Tagger', () => {
  const tagger = new Tagger(loadTaxonomy());

  it('tags from the headline', () => {
    const tags = tagger.tag({ title: 'Credit Spreads and High Yield Defaults in the US' });
    expect(tags).toContain('asset:credit');
    expect(tags).toContain('region:us');
  });

  it('lets the publisher category win where one is mapped', () => {
    const mapped = new Tagger({
      facets: [{ id: 'asset', label: 'Asset', values: ['fixed-income'] }],
      native_map: { 'Fixed Income': ['asset:fixed-income'] },
      rules: [],
    });
    expect(mapped.tag({ title: 'An untagged headline', nativeCategories: ['fixed income'] })).toEqual([
      'asset:fixed-income',
    ]);
  });

  it('keeps a source-level static tag', () => {
    expect(tagger.tag({ title: 'Anything', staticTags: ['type:news'] })).toContain('type:news');
  });

  it('discards a static tag that no facet declares', () => {
    expect(tagger.tag({ title: 'Anything', staticTags: ['nonsense:value'] })).not.toContain(
      'nonsense:value',
    );
  });

  it('honours none: as an exclusion', () => {
    const t = new Tagger({
      facets: [{ id: 'scope', label: 'Scope', values: ['macro'] }],
      native_map: {},
      rules: [{ tag: 'scope:macro', any: ['inflation'], all: [], none: ['podcast'] }],
    });
    expect(t.tag({ title: 'Inflation update' })).toEqual(['scope:macro']);
    expect(t.tag({ title: 'Inflation update podcast' })).toEqual([]);
  });

  it('does not crash on an invalid regex in a rule', () => {
    const t = new Tagger({
      facets: [{ id: 'scope', label: 'Scope', values: ['macro'] }],
      native_map: {},
      rules: [{ tag: 'scope:macro', any: ['('], all: [], none: [] }],
    });
    expect(t.tag({ title: 'a ( b' })).toEqual(['scope:macro']);
  });

  it('reports publisher categories that nothing maps yet', () => {
    expect(tagger.unmappedCategories(['Some New Category'])).toEqual(['Some New Category']);
  });
});

describe('discovery scoring', () => {
  it('finds the article array however deeply it is buried', () => {
    const payload = {
      meta: { took: 3 },
      response: {
        docs: Array.from({ length: 5 }, (_, i) => ({
          headline: `A reasonably long article headline ${i}`,
          permalink: `https://a.test/articles/${i}`,
          published: '2026-09-05T09:00:00Z',
        })),
      },
    };
    const best = findRecordArrays(payload)[0];
    expect(best?.path).toBe('response.docs');

    const fields = guessFields(best!.records);
    expect(fields.title).toBe('headline');
    expect(fields.url).toBe('permalink');
    expect(fields.published_at).toBe('published');
  });

  it('sees through one level of nesting, as search APIs use', () => {
    const records = Array.from({ length: 4 }, (_, i) => ({
      title: `Another sufficiently long headline ${i}`,
      clickUri: `https://a.test/${i}`,
      raw: { publishz32xdate: 1757062800000, category: ['Fixed Income'] },
    }));
    const fields = guessFields(records);
    expect(fields.url).toBe('clickUri');
    expect(fields.published_at).toBe('raw.publishz32xdate');
    expect(fields.categories).toBe('raw.category');
  });

  it('ignores arrays that hold no articles', () => {
    expect(findRecordArrays({ facets: [{ count: 1 }, { count: 2 }] })).toHaveLength(0);
  });

  it('distinguishes titles from URLs and junk', () => {
    expect(looksLikeTitle('The Inflation Path and What It Means')).toBe(true);
    expect(looksLikeTitle('https://a.test/x')).toBe(false);
    expect(looksLikeTitle('short')).toBe(false);
    expect(looksLikeUrl('/insights/piece')).toBe(true);
    expect(looksLikeUrl('not a url')).toBe(false);
  });
});

describe('fetch failure messages', () => {
  it('names a proxy refusal instead of saying "fetch failed"', () => {
    const inner = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), {
      name: 'AbortError',
      code: 'UND_ERR_ABORTED',
    });
    const middle = Object.assign(new Error('Request was cancelled.'), { cause: inner });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: middle });
    expect(describeFetchFailure(outer)).toBe(
      'Blocked by the network proxy (HTTP 403) before reaching the site',
    );
  });

  it('recognises a DNS failure however deeply it is wrapped', () => {
    const inner = Object.assign(new Error('getaddrinfo ENOTFOUND nope.test'), { code: 'ENOTFOUND' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(describeFetchFailure(outer)).toContain('DNS lookup failed');
  });

  it('reports our own timeout as a timeout', () => {
    expect(describeFetchFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(
      'Timed out waiting for a response',
    );
  });

  it('falls back to the deepest message that says something', () => {
    const inner = new Error('The server closed the connection unexpectedly');
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });
    expect(describeFetchFailure(outer)).toBe('The server closed the connection unexpectedly');
  });
});
