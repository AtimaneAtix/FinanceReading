# FinanceReading

One panel for the insights, outlooks and market commentary published by
financial institutions. Headlines from every source in one dense, filterable
list; clicking a headline opens the original article on the publisher's own
site.

```
docker compose up -d --build
open http://localhost:3000
```

- **Tags and filters.** Every article is tagged by type, scope (macro/micro),
  asset class, region and theme. The sidebar filters on them: OR within a
  group, AND across groups. Filters live in the URL, so any view is
  bookmarkable.
- **Links out, always.** The panel is an index, not a reader. Titles link
  straight to the publisher.
- **Five ways to fetch.** Most insight hubs are JavaScript search applications
  with no feed, so an RSS reader alone will not do.

---

## The problem this solves

The pages worth reading are not homepages. They look like this:

```
https://www.pimco.com/eu/en/insights#sort=%40publishz32xdate%20descending&f:category=[70341f6d…]
```

Two things are true about that URL, and they shape the whole design:

1. `@publishz32xdate` is **Coveo** field-name encoding (`z32x` is how Coveo
   escapes characters in field names). The page is a search application, and
   the articles arrive by JSON after the HTML does. Fetch that URL over plain
   HTTP and you get an empty shell — a CSS scraper finds nothing.
2. Everything after `#` is a **fragment**, which browsers never send to the
   server. Those category GUIDs are facet values the page posts to its own
   search API.

So the job is not "write a scraper". It is **find the JSON endpoint behind each
page and replay it** — which gives cleaner data than the rendered HTML, and
keeps working when the site is redesigned.

`npm run discover` does that hunting for you.

---

## Getting started

### 1. Look at it before configuring anything

```bash
npm install
npm run demo          # http://localhost:3000
```

Runs the whole system against a built-in fixture — a feed, a token-protected
search API, and a sitemap, plus one deliberately broken source so the health
strip has something to show. No internet needed.

### 2. Find out which real sources work

```bash
docker compose up -d --build
docker compose exec web npm run doctor
```

`doctor` fetches every source in `config/sources.yaml` right now and prints a
table of what worked. **Expect red on the first run.** The seed list was
written without the ability to reach these domains, so it is a starting grid,
not a verified list. Prune what is dead, then hunt replacements.

### 3. Hunt the sources that failed

```bash
docker compose --profile hunter run --rm hunter https://www.pimco.com/eu/en/insights
```

The hunter opens the page in a real browser and runs five probes:

| Probe | What it looks for |
|---|---|
| Network capture | Every XHR/fetch the page makes, scored on whether the JSON holds article-shaped records. This finds the search API. |
| Framework data | `__NEXT_DATA__`, Nuxt payloads, AEM model endpoints. |
| Feeds | `<link rel="alternate">`, plus the conventional `/rss`, `/feed`, `/atom.xml` paths. |
| Sitemaps | `robots.txt` → `sitemap.xml`, including news sitemaps. |
| HTML structure | Repeated article containers, as a last resort. |

It prints a ranked report and **a config block you can paste into
`config/sources.yaml`**, then writes the full report to `config/discovered/`.

Captured bearer tokens are never written into the suggestion — they are
replaced with `{{token}}` plus a rule for re-minting them, because these tokens
expire within the hour.

**Faster path:** open the listing page yourself, DevTools → Network → Fetch/XHR,
copy the article request as cURL, and write the `json` adapter from that
directly. The hunter automates that loop; it does not replace your judgement.

---

## Adapters

Declared per source. Always take the highest one that works.

| Kind | Use when | Notes |
|---|---|---|
| `json` | The site has a search or content API | **Preferred.** Structured, paginated, survives redesigns. |
| `rss` | A real feed exists | Cheapest. Handles RSS 2.0, Atom, RDF. |
| `sitemap` | No feed, no reachable API | Finds new URLs, then reads each article's own OpenGraph/JSON-LD. Works on JavaScript sites. |
| `html` | Server-rendered listing page | Brittle. Verified by `doctor`. |
| `browser` | Nothing else works | Renders in Chromium. Slow; use sparingly. |

A source may declare `fallback:` adapters, tried in order when the primary
fails or returns nothing — so an API change degrades to fewer fields rather
than to silence.

### Examples

```yaml
# A plain feed.
- id: fed-press
  institution: Federal Reserve
  name: Press releases
  homepage: https://www.federalreserve.gov
  static_tags: [type:news, scope:macro, region:us]
  adapter:
    kind: rss
    url: https://www.federalreserve.gov/feeds/press_all.xml

# A search API behind a JavaScript page, with a token minted by that page.
- id: example-insights
  institution: Example Asset Management
  name: Insights
  homepage: https://www.example.com
  static_tags: [type:insight]
  adapter:
    kind: json
    request:
      method: POST
      url: https://exampleprod.org.coveo.com/rest/search/v2
      headers: { content-type: application/json, authorization: "Bearer {{token}}" }
      body: '{"aq":"@objecttype==Insight","firstResult":{{offset}},"numberOfResults":{{page_size}}}'
    auth:
      kind: from_page                       # or `env` with a var name, or `none`
      page_url: https://www.example.com/insights
      token_regex: '"accessToken"\s*:\s*"([^"]+)"'
    items_path: results                     # dot path to the array
    fields:                                 # dot paths within one record
      title: title
      url: clickUri
      summary: excerpt
      published_at: raw.publishdate
      categories: raw.category
    pagination: { kind: offset, page_size: 50, max_pages: 2 }
  fallback:
    - kind: sitemap
      url: https://www.example.com/sitemap.xml
      include: ['/insights/']
```

Templates `{{token}}`, `{{offset}}`, `{{page}}` and `{{page_size}}` are
substituted into the URL, headers and body.

---

## Tags

`config/taxonomy.yaml` defines the facets and how tags are assigned. Two
mechanisms, in order of quality:

```yaml
# 1. The publisher's own categories, mapped straight through. Best signal
#    available — better than any keyword rule. `npm run retag` prints the
#    categories your sources emit that nothing maps yet.
native_map:
  "Economic and Market Commentary": [scope:macro, type:commentary]
  "70341f6de3a142ee89144df0ec44e3b8": [asset:fixed-income]

# 2. Case-insensitive regex over the title and summary.
rules:
  - tag: asset:credit
    any: ['\bcredit\b', 'high yield', 'investment grade', '\bspread']
    none: ['credit card']          # optional
    all: []                        # optional; every term must match
```

A source can also declare `static_tags`, applied to everything it produces.

After editing, re-apply to everything already stored — nothing is re-fetched:

```bash
docker compose exec web npm run retag
```

Expect to tune this in the first week. That command makes tuning free.

---

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | The whole system against a local fixture. No internet. |
| `npm run doctor` | Fetch every source now; print what worked and why the rest did not. |
| `npm run discover -- <url>` | Hunt the article source behind a listing page. |
| `npm run retag` | Re-apply the taxonomy to stored articles. |
| `npm run ingest:once` | One ingestion pass, then exit. |
| `npm test` | Unit and integration tests, including a fixture of each adapter. |
| `npm run typecheck` | TypeScript, no emit. |

---

## How it works

```
config/sources.yaml ──▶ worker ──▶ adapter ──▶ normalise ──▶ dedupe ──▶ tag ──▶ SQLite
                                                                                  │
                          config/taxonomy.yaml ───────────────────────────────────┘
                                                                                  │
                                                        web (Fastify) ◀───────────┘
                                                              │
                                                        the panel
```

Two services share one SQLite file in WAL mode: the worker writes, the web
server reads. That is why there is no database server to run.

**Deduplication happens twice**, because both kinds occur:

- *Exact*: the canonical URL — host lowercased, fragment dropped, `utm_*` and
  click IDs stripped, trailing slash removed — hashed and uniquely indexed.
- *Near*: a normalised title from the same institution within seven days. This
  is what collapses the `/us/en/` and `/eu/en/` copies of one article.

**Zero items is treated as broken, not quiet.** A scraper that silently stops
returning anything is the most common failure in a system like this, so a
source that returns nothing unexpectedly is marked `EMPTY` and named in the
health strip at the bottom of the panel. Failing sources back off
exponentially, up to sixteen times their normal interval.

**Politeness.** One request per source per interval, serialised per host with a
minimum gap, `robots.txt` respected and cached for twelve hours, identifying
User-Agent, conditional requests (`If-None-Match` / `If-Modified-Since`) so an
unchanged feed costs nothing.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port. |
| `DB_PATH` | `data/feeds.db` | SQLite file. |
| `SOURCES_PATH` / `TAXONOMY_PATH` | `config/…` | Config locations. |
| `INGEST_CONCURRENCY` | `4` | Sources fetched in parallel. |
| `INGEST_TICK_MS` | `60000` | How often the worker looks for due sources. |
| `HOST_MIN_GAP_MS` | `1000` | Minimum gap between requests to one host. |
| `USER_AGENT` | identifying default | Sent on every request. |
| `CHROMIUM_PATH` | — | Browser for the `browser` adapter and the hunter. |
| `HTTPS_PROXY` / `NO_PROXY` | — | Honoured, including CIDR ranges in `NO_PROXY`. |
| `IGNORE_ROBOTS` | — | Set to `1` to skip robots.txt. Off by default, deliberately. |

---

## Adding a source, end to end

1. `npm run discover -- <the listing page URL>`
2. Review the suggested block; paste it under `sources:` in `config/sources.yaml`.
3. `npm run doctor` — confirm it comes back green.
4. `npm run retag` — read the list of unmapped publisher categories it prints,
   and map the useful ones into `native_map`.

---

## Known limits

- The seed source list in `config/sources.yaml` is **unverified**. Run
  `doctor` first.
- Full article text, AI summaries, PDF outlooks, read/unread state and saved
  articles are not in this version. The schema takes them without a rewrite.
- Sites behind a login or a hard paywall are out of scope.
