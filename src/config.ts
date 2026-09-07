import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A CSS selector, optionally suffixed with `@attribute` to read an attribute. */
const Selector = z.string().min(1);

const SelectorSet = z.object({
  item: Selector,
  title: Selector,
  link: Selector,
  date: Selector.optional(),
  summary: Selector.optional(),
});
export type SelectorSet = z.infer<typeof SelectorSet>;

/**
 * How a bearer token is obtained. Search APIs behind insight hubs (Coveo and
 * friends) mint short-lived tokens in the page, so a hardcoded value would go
 * stale within the hour — we re-derive it on every run instead.
 */
const Auth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('env'), var: z.string().min(1) }),
  z.object({
    kind: z.literal('from_page'),
    page_url: z.string().url(),
    // First capture group is the token.
    token_regex: z.string().min(1),
  }),
]);
export type Auth = z.infer<typeof Auth>;

const Pagination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('offset'),
    // Placeholder substituted into url/body: {{offset}} and {{page_size}}.
    page_size: z.number().int().positive().default(50),
    max_pages: z.number().int().positive().max(20).default(2),
  }),
]);

const RssAdapter = z.object({
  kind: z.literal('rss'),
  url: z.string().url(),
});

const JsonAdapter = z.object({
  kind: z.literal('json'),
  request: z.object({
    method: z.enum(['GET', 'POST']).default('GET'),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
    body: z.string().optional(),
  }),
  auth: Auth.default({ kind: 'none' }),
  /** Dot path to the array of records, e.g. "results" or "data.hits". */
  items_path: z.string().default(''),
  /** Dot paths, relative to a record, for each normalised field. */
  fields: z.object({
    title: z.string(),
    url: z.string(),
    summary: z.string().optional(),
    published_at: z.string().optional(),
    categories: z.string().optional(),
  }),
  pagination: Pagination.default({ kind: 'none' }),
});

const SitemapAdapter = z.object({
  kind: z.literal('sitemap'),
  url: z.string().url(),
  /** Regexes an entry URL must match / must not match to count as an article. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  /** Visit each new URL to read og:title and the published date. */
  fetch_metadata: z.boolean().default(true),
  /** Ceiling on per-run article fetches, so a first run cannot hammer a site. */
  max_new_per_run: z.number().int().positive().max(200).default(25),
});

const HtmlAdapter = z.object({
  kind: z.literal('html'),
  url: z.string().url(),
  selectors: SelectorSet,
});

const BrowserAdapter = z.object({
  kind: z.literal('browser'),
  url: z.string().url(),
  selectors: SelectorSet,
  wait_for: z.string().optional(),
  /** Number of "scroll to bottom" passes before reading the DOM. */
  scroll: z.number().int().min(0).max(10).default(0),
});

export const AdapterConfig = z.discriminatedUnion('kind', [
  RssAdapter,
  JsonAdapter,
  SitemapAdapter,
  HtmlAdapter,
  BrowserAdapter,
]);
export type AdapterConfig = z.infer<typeof AdapterConfig>;
export type AdapterKind = AdapterConfig['kind'];

export const SourceConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase, digits and dashes only'),
  institution: z.string().min(1),
  name: z.string().min(1),
  homepage: z.string().url(),
  enabled: z.boolean().default(true),
  poll_minutes: z.number().int().min(5).max(1440).optional(),
  /** Tags every item from this source receives, e.g. ["scope:macro"]. */
  static_tags: z.array(z.string()).default([]),
  adapter: AdapterConfig,
  /** Tried in order when the primary adapter yields nothing or throws. */
  fallback: z.array(AdapterConfig).default([]),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

export const SourcesFile = z.object({
  defaults: z.object({ poll_minutes: z.number().int().min(5).default(30) }).default({ poll_minutes: 30 }),
  sources: z.array(SourceConfig),
});
export type SourcesFile = z.infer<typeof SourcesFile>;

const Facet = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  values: z.array(z.string().min(1)).min(1),
});
export type Facet = z.infer<typeof Facet>;

const Rule = z.object({
  tag: z.string().min(1),
  any: z.array(z.string()).default([]),
  all: z.array(z.string()).default([]),
  none: z.array(z.string()).default([]),
});
export type Rule = z.infer<typeof Rule>;

export const TaxonomyFile = z.object({
  facets: z.array(Facet).min(1),
  /** The publisher's own category value or GUID -> our tags. Best signal there is. */
  native_map: z.record(z.array(z.string())).default({}),
  rules: z.array(Rule).default([]),
});
export type TaxonomyFile = z.infer<typeof TaxonomyFile>;

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
  try {
    return YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse YAML in ${path}: ${(err as Error).message}`);
  }
}

/** Renders a zod failure as something a human can act on without reading a stack trace. */
function explain(path: string, err: z.ZodError): never {
  const lines = err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`Invalid config in ${path}:\n${lines.join('\n')}`);
}

export function loadSources(
  path = process.env.SOURCES_PATH ?? resolve(ROOT, 'config/sources.yaml'),
): SourcesFile {
  const parsed = SourcesFile.safeParse(readYaml(path));
  if (!parsed.success) explain(path, parsed.error);

  const seen = new Set<string>();
  for (const s of parsed.data.sources) {
    if (seen.has(s.id)) throw new Error(`Duplicate source id "${s.id}" in ${path}`);
    seen.add(s.id);
  }
  return parsed.data;
}

export function loadTaxonomy(
  path = process.env.TAXONOMY_PATH ?? resolve(ROOT, 'config/taxonomy.yaml'),
): TaxonomyFile {
  const parsed = TaxonomyFile.safeParse(readYaml(path));
  if (!parsed.success) explain(path, parsed.error);

  const known = new Set(
    parsed.data.facets.flatMap((f) => f.values.map((v) => `${f.id}:${v}`)),
  );
  // A tag that belongs to no declared facet can never be filtered on, so it is a
  // config bug rather than a harmless extra.
  const unknown = new Set<string>();
  for (const r of parsed.data.rules) if (!known.has(r.tag)) unknown.add(r.tag);
  for (const tags of Object.values(parsed.data.native_map)) {
    for (const t of tags) if (!known.has(t)) unknown.add(t);
  }
  if (unknown.size > 0) {
    throw new Error(
      `Unknown tags in ${path} (not declared under any facet): ${[...unknown].join(', ')}`,
    );
  }
  return parsed.data;
}

export function validateStaticTags(sources: SourcesFile, taxonomy: TaxonomyFile): string[] {
  const known = new Set(taxonomy.facets.flatMap((f) => f.values.map((v) => `${f.id}:${v}`)));
  const problems: string[] = [];
  for (const s of sources.sources) {
    for (const t of s.static_tags) {
      if (!known.has(t)) problems.push(`source "${s.id}" declares unknown static tag "${t}"`);
    }
  }
  return problems;
}
