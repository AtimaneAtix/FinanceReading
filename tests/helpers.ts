import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { ROOT } from '../src/config.ts';

export interface TempWorkspace {
  dir: string;
  dbPath: string;
  sourcesPath: string;
  cleanup: () => void;
}

/**
 * A throwaway config + database for one test, wired through the same
 * environment variables the real deployment uses.
 */
export function makeWorkspace(sources: unknown[], defaults = { poll_minutes: 30 }): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), 'finance-reading-'));
  const sourcesPath = join(dir, 'sources.yaml');
  const dbPath = join(dir, 'test.db');
  writeFileSync(sourcesPath, YAML.stringify({ defaults, sources }));

  process.env.SOURCES_PATH = sourcesPath;
  process.env.TAXONOMY_PATH = resolve(ROOT, 'config/taxonomy.yaml');
  process.env.DB_PATH = dbPath;
  // Tests must not wait a second between fixture requests.
  process.env.HOST_MIN_GAP_MS = '0';

  return {
    dir,
    dbPath,
    sourcesPath,
    cleanup: () => {
      delete process.env.SOURCES_PATH;
      delete process.env.DB_PATH;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
