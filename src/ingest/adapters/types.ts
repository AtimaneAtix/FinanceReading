import type { DB } from '../../db/index.ts';

/** One article as a source describes it, before normalisation. */
export interface RawItem {
  url: string;
  title: string;
  summary?: string | null;
  publishedAt?: unknown;
  /** The publisher's own category labels or GUIDs, verbatim. */
  categories?: string[];
}

export interface AdapterResult {
  items: RawItem[];
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  /** Non-fatal problems worth showing in `doctor` output. */
  notes?: string[];
  /**
   * True when zero items is the correct answer rather than a failure — a
   * sitemap whose every URL we have already read, for instance. Without this
   * the worker cannot tell "nothing new" from "the scraper broke".
   */
  healthyEmpty?: boolean;
}

export interface AdapterContext {
  sourceId: string;
  homepage: string;
  etag: string | null;
  lastModified: string | null;
  db: DB;
}

export class AdapterError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'AdapterError';
  }
}
