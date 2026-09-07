/**
 * Re-applies config/taxonomy.yaml to every article already stored.
 *
 * Tag rules are meant to be edited often; this makes that free. Nothing is
 * re-fetched, so it runs in seconds even on a large database.
 */
import { loadSources, loadTaxonomy, validateStaticTags } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { Tagger } from '../src/ingest/tagger.ts';

interface Row {
  id: number;
  source_id: string;
  title: string;
  summary: string | null;
  native_categories: string;
}

function main(): void {
  const taxonomy = loadTaxonomy();
  const sourcesFile = loadSources();
  const problems = validateStaticTags(sourcesFile, taxonomy);
  if (problems.length > 0) {
    console.error(`Config problems:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  const tagger = new Tagger(taxonomy);
  const staticBySource = new Map(sourcesFile.sources.map((s) => [s.id, s.static_tags]));
  const db = openDb();

  try {
    const rows = db
      .prepare('SELECT id, source_id, title, summary, native_categories FROM items')
      .all() as Row[];

    if (rows.length === 0) {
      console.log('No articles stored yet — nothing to retag.');
      return;
    }

    const clear = db.prepare('DELETE FROM item_tags WHERE item_id = ?');
    const insert = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)');
    const unmapped = new Map<string, number>();
    let tagCount = 0;

    db.transaction(() => {
      for (const row of rows) {
        const categories = JSON.parse(row.native_categories) as string[];
        const tags = tagger.tag({
          title: row.title,
          summary: row.summary,
          nativeCategories: categories,
          staticTags: staticBySource.get(row.source_id) ?? [],
        });
        clear.run(row.id);
        for (const tag of tags) insert.run(row.id, tag);
        tagCount += tags.length;

        for (const cat of tagger.unmappedCategories(categories)) {
          unmapped.set(cat, (unmapped.get(cat) ?? 0) + 1);
        }
      }
    })();

    const untagged = db
      .prepare('SELECT COUNT(*) AS n FROM items WHERE id NOT IN (SELECT item_id FROM item_tags)')
      .get() as { n: number };

    console.log(
      `Retagged ${rows.length} article(s): ${tagCount} tag(s), ${untagged.n} left untagged.`,
    );

    if (unmapped.size > 0) {
      // These are the publisher's own categories — mapping them beats writing
      // more keyword rules, so they are worth surfacing every run.
      const top = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
      console.log('\nPublisher categories not yet in native_map (best tagging signal available):');
      for (const [cat, n] of top) console.log(`  ${String(n).padStart(5)}  ${cat}`);
      console.log('\nAdd the useful ones to native_map in config/taxonomy.yaml, then run this again.');
    }
  } finally {
    db.close();
  }
}

main();
