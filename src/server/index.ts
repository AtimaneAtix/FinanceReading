import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadTaxonomy, type TaxonomyFile } from '../config.ts';
import { openDb, type DB } from '../db/index.ts';
import { queryItems, sourceHealth, type ItemQuery, type Since, type Sort } from './query.ts';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function asArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter((v) => v !== '');
  }
  if (Array.isArray(value)) return value.flatMap(asArray);
  return [];
}

export function parseQuery(raw: Record<string, unknown>): ItemQuery {
  const since = raw['since'];
  const sort = raw['sort'];
  const limit = Number(raw['limit']);
  return {
    tags: asArray(raw['tags']),
    institutions: asArray(raw['institution']),
    q: typeof raw['q'] === 'string' && raw['q'].trim() !== '' ? raw['q'].trim() : null,
    since: (['24h', '7d', '30d', 'all'] as Since[]).includes(since as Since)
      ? (since as Since)
      : '7d',
    sort: sort === 'oldest' ? ('oldest' as Sort) : ('newest' as Sort),
    cursor: typeof raw['cursor'] === 'string' && raw['cursor'] !== '' ? raw['cursor'] : null,
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

export function buildServer(db: DB, taxonomy: TaxonomyFile) {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: resolve(ROOT, 'public'), prefix: '/' });

  app.get('/api/taxonomy', async () => ({
    facets: taxonomy.facets,
  }));

  app.get('/api/items', async (request) => {
    const query = parseQuery(request.query as Record<string, unknown>);
    return queryItems(db, query, taxonomy);
  });

  app.get('/api/health', async () => {
    const sources = sourceHealth(db);
    const totals = db
      .prepare('SELECT COUNT(*) AS items, MAX(first_seen_at) AS lastIngest FROM items')
      .get() as { items: number; lastIngest: number | null };
    return {
      sources,
      totalItems: totals.items,
      lastIngestAt: totals.lastIngest,
      broken: sources.filter((s) => s.status === 'error' || s.status === 'empty').length,
    };
  });

  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const db = openDb();
  const app = buildServer(db, loadTaxonomy());

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => {
        db.close();
        process.exit(0);
      });
    });
  }

  await app.listen({ port, host });
  console.log(`Reading panel on http://localhost:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
