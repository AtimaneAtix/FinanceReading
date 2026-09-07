import type { TaxonomyFile } from '../config.ts';

export interface TaggableItem {
  title: string;
  summary?: string | null;
  nativeCategories?: string[];
  staticTags?: string[];
}

interface CompiledRule {
  tag: string;
  any: RegExp[];
  all: RegExp[];
  none: RegExp[];
}

export class Tagger {
  private readonly rules: CompiledRule[];
  private readonly nativeMap: Map<string, string[]>;
  private readonly knownTags: Set<string>;

  constructor(taxonomy: TaxonomyFile) {
    this.knownTags = new Set(
      taxonomy.facets.flatMap((f) => f.values.map((v) => `${f.id}:${v}`)),
    );
    this.rules = taxonomy.rules.map((r) => ({
      tag: r.tag,
      any: r.any.map(compile),
      all: r.all.map(compile),
      none: r.none.map(compile),
    }));
    // Native categories are matched case-insensitively, because publishers are
    // inconsistent about casing between their API and their HTML.
    this.nativeMap = new Map(
      Object.entries(taxonomy.native_map).map(([k, v]) => [k.toLowerCase().trim(), v]),
    );
  }

  tag(item: TaggableItem): string[] {
    const out = new Set<string>();

    // 1. Tags the source always carries.
    for (const t of item.staticTags ?? []) {
      if (this.knownTags.has(t)) out.add(t);
    }

    // 2. The publisher's own taxonomy — the best signal we get, so it runs
    //    before the keyword guesswork.
    for (const cat of item.nativeCategories ?? []) {
      const mapped = this.nativeMap.get(cat.toLowerCase().trim());
      if (mapped) for (const t of mapped) out.add(t);
    }

    // 3. Keyword rules over the text we have.
    const haystack = `${item.title}\n${item.summary ?? ''}`;
    for (const rule of this.rules) {
      if (matches(rule, haystack)) out.add(rule.tag);
    }

    return [...out].sort();
  }

  /** Native category values seen in the wild that nothing maps yet. */
  unmappedCategories(categories: string[]): string[] {
    return categories.filter((c) => !this.nativeMap.has(c.toLowerCase().trim()));
  }
}

function matches(rule: CompiledRule, haystack: string): boolean {
  if (rule.none.some((re) => re.test(haystack))) return false;
  if (rule.all.length > 0 && !rule.all.every((re) => re.test(haystack))) return false;
  if (rule.any.length > 0) return rule.any.some((re) => re.test(haystack));
  // A rule with only `all` (or only `none`) is satisfied by reaching here.
  return rule.all.length > 0 || rule.none.length > 0;
}

/**
 * Rule terms are regexes. A term that is not valid regex is treated as a
 * literal rather than crashing the worker — a typo in the taxonomy should cost
 * one rule, not the whole run.
 */
function compile(term: string): RegExp {
  try {
    return new RegExp(term, 'i');
  } catch {
    return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}
