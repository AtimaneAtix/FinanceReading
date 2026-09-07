/**
 * Runs the whole system against a local fixture, with no internet access.
 *
 * Useful for seeing the panel work before any real source is configured, and
 * for checking a change end to end when the institutions' sites are
 * unreachable (a locked-down network, a plane, a sandbox).
 *
 *   npm run demo   ->   http://localhost:3000
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { startFixtureServer } from '../tests/fixture-server.ts';

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'finance-reading-demo-'));
  const sourcesPath = join(dir, 'sources.yaml');

  writeFileSync(
    sourcesPath,
    YAML.stringify({
      defaults: { poll_minutes: 30 },
      sources: [
        {
          id: 'demo-rss',
          institution: 'Fixture Asset Management',
          name: 'Insights feed',
          homepage: fixture.base,
          static_tags: ['type:insight'],
          adapter: { kind: 'rss', url: `${fixture.base}/rss.xml` },
        },
        {
          id: 'demo-search-api',
          institution: 'Fixture Asset Management',
          name: 'Search API',
          homepage: fixture.base,
          static_tags: ['type:research'],
          adapter: {
            kind: 'json',
            request: {
              method: 'POST',
              url: `${fixture.base}/api/search`,
              headers: { 'content-type': 'application/json' },
              body: '{"firstResult":{{offset}},"numberOfResults":{{page_size}}}',
            },
            auth: {
              kind: 'from_page',
              page_url: `${fixture.base}/insights`,
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
          },
        },
        {
          id: 'demo-sitemap',
          institution: 'Fixture Asset Management',
          name: 'Sitemap crawl',
          homepage: fixture.base,
          static_tags: ['type:commentary'],
          adapter: {
            kind: 'sitemap',
            url: `${fixture.base}/sitemap.xml`,
            include: ['/articles/'],
            max_new_per_run: 25,
          },
        },
        {
          id: 'demo-broken',
          institution: 'Fixture Securities',
          name: 'Feed that is down',
          homepage: fixture.base,
          adapter: { kind: 'rss', url: `${fixture.base}/gone.xml` },
        },
      ],
    }),
  );

  process.env.SOURCES_PATH = sourcesPath;
  process.env.DB_PATH = join(dir, 'demo.db');
  process.env.HOST_MIN_GAP_MS = '0';

  const { runOnce } = await import('../src/ingest/run.ts');
  const { describeOutcome } = await import('../src/ingest/run.ts');
  console.log('Ingesting from the local fixture…\n');
  for (const outcome of await runOnce(true)) console.log(describeOutcome(outcome));

  const { openDb } = await import('../src/db/index.ts');
  const { loadTaxonomy } = await import('../src/config.ts');
  const { buildServer } = await import('../src/server/index.ts');

  const db = openDb();
  const app = buildServer(db, loadTaxonomy());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });

  console.log(`\nDemo panel on http://localhost:${port}`);
  console.log(
    'The fixture publishes one set of articles through a feed, a search API and a sitemap.\n' +
      'You see each article once because deduplication collapses the three copies.\n' +
      'One source is deliberately broken, so the health strip has something to show.',
  );
  console.log('Press Ctrl+C to stop.');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        db.close();
        await fixture.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
