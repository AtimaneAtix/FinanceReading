/**
 * Drops articles that have aged out of the reading panel.
 *
 * Size is not the reason to run this. The panel takes on the order of ten
 * dated articles a day, which is about 4 MB of database a year, so the corpus
 * would need a decade or two to become inconvenient. The reason is that this
 * is a reading list: past a point an article is not something you are going to
 * get to, and carrying it makes "All time" less useful rather than more.
 *
 * Nothing is deleted unless you pass --apply.
 *
 *   npm run prune                         # what a 365-day cut would remove
 *   npm run prune -- --older-than=180d    # try a tighter one
 *   npm run prune -- --older-than=180d --apply
 */
import { openDb, pruneOlderThan, prunePreview } from '../src/db/index.ts';

const DEFAULT_DAYS = 365;

/**
 * Below this, a cut is more likely a slip than an intention, and pruning is
 * not reversible: the URLs are remembered so the sources cannot re-offer them,
 * which is what stops a pruned article bouncing back in on the next run. A
 * deliberate short window still works, with --force.
 */
const MIN_SAFE_DAYS = 30;

function parseDays(argv: string[]): number | null {
  const arg = argv.find((a) => a.startsWith('--older-than'));
  if (!arg) return DEFAULT_DAYS;
  const raw = arg.split('=')[1];
  if (raw === undefined || raw === '') return null;
  const match = /^(\d+)\s*d?$/i.exec(raw.trim());
  if (!match) return null;
  const days = Number(match[1]);
  return days > 0 ? days : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const days = parseDays(argv);

  if (days === null) {
    console.error('Usage: npm run prune -- [--older-than=365d] [--apply] [--force]');
    process.exit(1);
  }
  if (days < MIN_SAFE_DAYS && !force) {
    console.error(
      `Refusing to prune everything older than ${days} day(s). Pruning cannot be undone -- ` +
        'the URLs are remembered so the sources will not offer them again -- and anything ' +
        `under ${MIN_SAFE_DAYS} days is usually a typo. Add --force if you meant it.`,
    );
    process.exit(1);
  }

  const cutoff = Date.now() - days * 86_400_000;
  const db = openDb();

  try {
    const preview = prunePreview(db, cutoff);
    const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);

    if (preview.total === 0) {
      console.log(`Nothing published before ${cutoffDate}; ${preview.keeping} article(s) kept.`);
      // Orphaned tags are still worth clearing on a run that prunes nothing.
      if (preview.orphanTags === 0) return;
    } else {
      console.log(
        `${apply ? 'Removing' : 'Would remove'} ${preview.total} article(s) published before ` +
          `${cutoffDate}, keeping ${preview.keeping}.\n`,
      );
      const width = Math.max(...preview.byInstitution.map((r) => r.institution.length));
      for (const row of preview.byInstitution) {
        console.log(`  ${row.institution.padEnd(width)}  ${String(row.count).padStart(5)}`);
      }
    }
    if (preview.orphanTags > 0) {
      console.log(
        `\n${preview.orphanTags} tag row(s) belong to articles that are already gone, ` +
          'left behind by a deletion that ran without the cascade.',
      );
    }

    if (!apply) {
      console.log('\nNothing was deleted. Re-run with --apply to go ahead.');
      return;
    }

    const result = pruneOlderThan(db, cutoff);
    const swept = result.orphanTags > 0 ? `, and swept ${result.orphanTags} orphaned tag(s)` : '';
    console.log(
      `\nRemoved ${result.deleted} article(s) and ${result.tags} tag(s)${swept}; ` +
        `reclaimed ${(result.bytesFreed / 1_048_576).toFixed(1)} MB.`,
    );
    if (result.deleted > 0) {
      console.log(
        'Their URLs are remembered, so the sources will not re-offer them on the next run.',
      );
    }
  } finally {
    db.close();
  }
}

main();
