-- Sources mirror config/sources.yaml, plus the health columns the config
-- cannot carry (what happened on the last fetch).
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  institution     TEXT NOT NULL,
  name            TEXT NOT NULL,
  homepage        TEXT NOT NULL,
  adapter_kind    TEXT NOT NULL,
  config_json     TEXT NOT NULL,
  static_tags     TEXT NOT NULL DEFAULT '[]',
  poll_minutes    INTEGER NOT NULL DEFAULT 30,
  enabled         INTEGER NOT NULL DEFAULT 1,
  in_config       INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,
  last_modified   TEXT,
  last_fetch_at   INTEGER,
  last_status     TEXT,
  last_error      TEXT,
  last_item_count INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- Denormalised so filtering and facet counts never need a join.
  institution    TEXT NOT NULL,
  url            TEXT NOT NULL,
  canonical_hash TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  -- Normalised title, used to collapse the same article published under
  -- several regional paths (/us/en/... and /eu/en/... of one PIMCO piece).
  title_key      TEXT NOT NULL,
  summary        TEXT,
  published_at   INTEGER NOT NULL,
  -- 1 when the source gave no date and published_at is really "first seen",
  -- so undated items cannot masquerade as breaking news.
  date_estimated INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER NOT NULL,
  -- The publisher's own categories, verbatim, for native_map tagging.
  native_categories TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS items_published_idx ON items(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_titlekey_idx  ON items(institution, title_key, published_at);
CREATE INDEX IF NOT EXISTS items_source_idx    ON items(source_id);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS item_tags_tag_idx ON item_tags(tag, item_id);

-- Sitemap adapters remember which URLs they have already considered, so a
-- second run does not re-fetch every article page just to discard it.
CREATE TABLE IF NOT EXISTS seen_urls (
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  canonical_hash TEXT NOT NULL,
  seen_at        INTEGER NOT NULL,
  PRIMARY KEY (source_id, canonical_hash)
) WITHOUT ROWID;
