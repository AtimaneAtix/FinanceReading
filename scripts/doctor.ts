/**
 * Fetches every enabled source right now and reports what actually worked.
 *
 * This is the command that turns a list of guessed URLs into a verified one.
 * Run it after any change to config/sources.yaml.
 */
import { runOnce } from '../src/ingest/run.ts';
import type { SourceOutcome } from '../src/ingest/pipeline.ts';

const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, text: string) => (colour ? `${code}${text}${RESET}` : text);

function statusCell(o: SourceOutcome): string {
  switch (o.status) {
    case 'ok': return c(GREEN, 'OK');
    case 'not-modified': return c(DIM, 'SAME');
    case 'empty': return c(YELLOW, 'EMPTY');
    case 'error': return c(RED, 'FAIL');
  }
}

function pad(value: string, width: number): string {
  // Padding must ignore colour escapes, or the columns drift.
  const visible = value.replace(/\x1b\[[0-9;]*m/g, '').length;
  return value + ' '.repeat(Math.max(0, width - visible));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function main(): Promise<void> {
  console.log('Fetching every enabled source. This makes real requests, so give it a minute.\n');
  const outcomes = await runOnce(true);

  if (outcomes.length === 0) {
    console.log('No enabled sources in config/sources.yaml.');
    return;
  }

  const rows = outcomes.map((o) => ({
    outcome: o,
    source: `${o.institution} — ${o.name}`,
    adapter: o.adapterUsed ?? '-',
    items: o.status === 'ok' ? `${o.stats.inserted} new / ${o.fetched}` : '-',
  }));

  const w = {
    source: Math.min(46, Math.max(...rows.map((r) => r.source.length), 6)),
    adapter: Math.max(...rows.map((r) => r.adapter.length), 7),
    items: Math.max(...rows.map((r) => r.items.length), 5),
  };

  console.log(
    `${pad('STATUS', 6)}  ${pad('SOURCE', w.source)}  ${pad('ADAPTER', w.adapter)}  ${pad('ITEMS', w.items)}`,
  );
  console.log('-'.repeat(6 + w.source + w.adapter + w.items + 6));

  for (const r of rows) {
    console.log(
      `${pad(statusCell(r.outcome), 6)}  ${pad(truncate(r.source, w.source), w.source)}  ` +
        `${pad(r.adapter, w.adapter)}  ${pad(r.items, w.items)}`,
    );
  }

  const broken = outcomes.filter((o) => o.status === 'error' || o.status === 'empty');
  if (broken.length > 0) {
    console.log(`\n${c(RED, 'Needs attention')}\n`);
    for (const o of broken) {
      console.log(`  ${o.institution} — ${o.name}  [${o.sourceId}]`);
      if (o.error) console.log(`    ${c(DIM, o.error)}`);
      for (const note of o.notes.slice(0, 4)) console.log(`    ${c(DIM, note)}`);
      console.log(`    ${c(DIM, `try: npm run discover -- <the listing page URL for ${o.institution}>`)}`);
      console.log();
    }
  }

  const notes = outcomes.filter((o) => o.status === 'ok' && o.notes.length > 0);
  if (notes.length > 0) {
    console.log(c(DIM, 'Notes'));
    for (const o of notes) {
      for (const note of o.notes.slice(0, 3)) {
        console.log(c(DIM, `  ${o.sourceId}: ${note}`));
      }
    }
    console.log();
  }

  const inserted = outcomes.reduce((n, o) => n + o.stats.inserted, 0);
  const working = outcomes.length - broken.length;
  console.log(
    `${working}/${outcomes.length} sources working, ${inserted} new article(s) stored.`,
  );
  if (broken.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
