/**
 * Hunts down how a listing page actually delivers its articles.
 *
 * The insight hubs of most large institutions are JavaScript search
 * applications: PIMCO's `#sort=@publishz32xdate descending&f:category=[...]`
 * fragment is a Coveo interface, and the fragment never even reaches the
 * server. Fetching such a page returns an empty shell, so this command opens
 * it in a real browser, watches the network, and reports the JSON endpoint
 * behind it — plus any feed, sitemap or server-rendered structure it finds.
 *
 *   npm run discover -- https://www.pimco.com/eu/en/insights
 *   npm run discover -- <url> --no-browser     # skip Playwright
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.ts';
import { discover, type DiscoveryReport } from '../src/discover/index.ts';

const BOLD = '\x1b[1m', DIM = '\x1b[2m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, text: string) => (colour ? `${code}${text}${RESET}` : text);

function heading(text: string): void {
  console.log(`\n${c(BOLD, text)}`);
}

function printReport(report: DiscoveryReport): void {
  console.log(`\nTarget:   ${report.requestedUrl}`);
  if (report.finalUrl !== report.requestedUrl) console.log(`Resolved: ${report.finalUrl}`);
  console.log(
    `Method:   ${report.renderedWithBrowser ? 'rendered in Chromium with network capture' : 'plain HTTP fetch'}`,
  );

  for (const warning of report.warnings) console.log(c(YELLOW, `\n! ${warning}`));

  heading('1. JSON endpoints behind the page');
  if (report.network.length === 0) {
    console.log(
      report.renderedWithBrowser
        ? '  none found — the page may render server-side, or load articles in a format we did not recognise'
        : '  not checked (needs a browser; re-run without --no-browser)',
    );
  } else {
    for (const [i, n] of report.network.entries()) {
      console.log(
        `  ${i === 0 ? c(GREEN, '>') : ' '} ${n.method} ${n.url.slice(0, 110)}`,
      );
      console.log(`      items_path: "${n.itemsPath || '(root)'}"  records: ${n.recordCount}  score: ${n.score.toFixed(1)}`);
      console.log(`      fields: ${JSON.stringify(n.fields)}`);
      for (const title of n.sampleTitles) console.log(c(DIM, `      · ${title.slice(0, 90)}`));
      if (n.sampleCategories.length > 0) {
        console.log(c(DIM, `      categories seen: ${n.sampleCategories.join(', ').slice(0, 160)}`));
      }
    }
  }

  heading('2. Feeds');
  if (report.feeds.length === 0) console.log('  none');
  for (const f of report.feeds) {
    console.log(`  ${f.url}  (${f.itemCount} items, ${f.source})${f.title ? ` — ${f.title}` : ''}`);
  }

  heading('3. Sitemaps');
  if (report.sitemaps.length === 0) console.log('  none');
  for (const s of report.sitemaps) {
    console.log(`  ${s.url}  (${s.urlCount} URLs, ${s.matchingCount} matching this section)`);
    for (const sample of s.sampleUrls.slice(0, 3)) console.log(c(DIM, `      · ${sample}`));
  }

  heading('4. Server-rendered structure');
  if (report.html.length === 0) console.log('  no repeated article structure found in the HTML');
  for (const h of report.html) {
    console.log(`  ${h.itemSelector}  (${h.matches} matches)`);
    for (const title of h.sampleTitles) console.log(c(DIM, `      · ${title}`));
  }

  heading('Suggested config/sources.yaml block');
  if (!report.suggestion) {
    console.log(
      '  Nothing usable found. If you can open the page in your own browser, check the\n' +
        '  Network tab (filter: Fetch/XHR), copy the article request as cURL, and paste it\n' +
        '  in — a json adapter can be written from that exactly.',
    );
  } else {
    console.log(c(DIM, `  best available adapter: ${report.suggestion.adapter}\n`));
    console.log(
      report.suggestion.yaml
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    console.log(
      c(DIM, '  Review it, paste the entry under `sources:` in config/sources.yaml,\n' +
        '  then run `npm run doctor` to confirm it works.'),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const target = args.find((a) => !a.startsWith('-'));
  const useBrowser = !args.includes('--no-browser');

  if (!target) {
    console.error(
      'Usage: npm run discover -- <listing-page-url> [--no-browser]\n\n' +
        'Example:\n  npm run discover -- https://www.pimco.com/eu/en/insights',
    );
    process.exit(1);
  }

  console.log(`Hunting for the article source behind ${target}…`);
  const report = await discover(target, { useBrowser });
  printReport(report);

  const dir = resolve(ROOT, 'config/discovered');
  mkdirSync(dir, { recursive: true });
  const name = target.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const path = resolve(dir, `${name.slice(0, 80)}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${path.replace(`${ROOT}/`, '')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
