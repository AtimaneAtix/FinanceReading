import { pathToFileURL } from 'node:url';
import { loadSources, loadTaxonomy, validateStaticTags } from '../config.ts';
import { openDb, syncSources, dueSources, allSources } from '../db/index.ts';
import { Tagger } from './tagger.ts';
import { ingestSource, type SourceOutcome } from './pipeline.ts';

const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 4);
const TICK_MS = Number(process.env.INGEST_TICK_MS ?? 60_000);

export function describeOutcome(o: SourceOutcome): string {
  const label = `${o.institution} — ${o.name}`.padEnd(46).slice(0, 46);
  switch (o.status) {
    case 'ok':
      return `  ok    ${label} +${o.stats.inserted} new (${o.fetched} fetched, ` +
        `${o.stats.duplicateUrl + o.stats.duplicateTitle} dup)`;
    case 'not-modified':
      return `  same  ${label} unchanged since last fetch`;
    case 'empty':
      return `  EMPTY ${label} ${o.error ?? ''}`;
    case 'error':
      return `  FAIL  ${label} ${o.error ?? ''}`;
  }
}

/** Runs the given async task over the list, at most `limit` at a time. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runOnce(force = false): Promise<SourceOutcome[]> {
  const sourcesFile = loadSources();
  const taxonomy = loadTaxonomy();

  const problems = validateStaticTags(sourcesFile, taxonomy);
  if (problems.length > 0) {
    throw new Error(`Config problems:\n  - ${problems.join('\n  - ')}`);
  }

  const db = openDb();
  try {
    syncSources(db, sourcesFile.sources, sourcesFile.defaults.poll_minutes);
    const tagger = new Tagger(taxonomy);
    const due = force
      ? allSources(db).filter((s) => s.enabled === 1 && s.in_config === 1)
      : dueSources(db, Date.now());

    if (due.length === 0) return [];
    return await mapLimit(due, CONCURRENCY, (row) => ingestSource(db, row, tagger));
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const force = process.argv.includes('--force') || once;

  if (once) {
    const outcomes = await runOnce(force);
    if (outcomes.length === 0) {
      console.log('No sources were due.');
    } else {
      for (const o of outcomes) console.log(describeOutcome(o));
      const inserted = outcomes.reduce((n, o) => n + o.stats.inserted, 0);
      const broken = outcomes.filter((o) => o.status === 'error' || o.status === 'empty').length;
      console.log(`\n${inserted} new article(s); ${broken} source(s) need attention.`);
      if (broken > 0) process.exitCode = 1;
    }
    return;
  }

  console.log(`Worker started. Checking for due sources every ${TICK_MS / 1000}s.`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n${signal} received, finishing the current pass…`);
      stopping = true;
    });
  }

  while (!stopping) {
    try {
      const outcomes = await runOnce(false);
      for (const o of outcomes) {
        if (o.status !== 'not-modified') console.log(describeOutcome(o));
      }
    } catch (err) {
      // A bad config must not kill the worker; it is usually fixed within seconds.
      console.error(`Pass failed: ${(err as Error).message}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  console.log('Worker stopped.');
}

// Only run the loop when this file is the process entry point, so tests and
// scripts can import runOnce() without starting a worker.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
