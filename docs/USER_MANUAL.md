# FinanceReader — User Manual

A plain-language guide to running FinanceReader. The [README](../README.md) is the
technical reference; this is for using it. New here? Do **Download and install** in
the README first.

All commands below assume your terminal is already open in the project folder.

## Start here

The system is two halves sharing one database: a **worker** that fetches articles, and a **panel** that displays them. Both run forever and hold the terminal — that is normal, not stuck. **Ctrl+C** stops whichever one is running.

The order does not matter. The panel works with an empty database and fills in as the worker fetches.

---

## The three ways to run it

### Option A — Just read what's out there now

Best for a first try. Fetches every source once, then serves the panel.

```bash
npm run ingest:once && npm start
```

Open <http://localhost:3000>

Nothing refreshes while you read. Press **Ctrl+C** and run the same line again for fresh articles.

### Option B — Keep it updating (two terminal tabs)

Tab 1 — the panel:

```bash
npm start
```

Tab 2 — the worker. Fetches every source on a schedule (30 minutes by default):

```bash
npm run worker
```

Both tabs stay occupied while running.

### Option C — Run it in the background (Docker)

Both halves as background services. Gives your prompt straight back and restarts after a reboot.

```bash
docker compose up -d --build
```

Open <http://localhost:3000>

To stop:

```bash
docker compose down
```

---

## Checking on your sources

### Is everything still working?

Fetches every source right now and prints a green/red table.

```bash
npm run doctor
```

> **IMPORTANT** — Trust this over your browser. Some of these sites — Invesco especially — answer **406 to Chrome** and **200 to this project**. A source can look dead in a browser tab and be perfectly fine to the worker.

### Re-apply the tag rules

Run this after editing `config/taxonomy.yaml`. It re-tags everything already stored, and prints the publisher categories that nothing maps yet.

```bash
npm run retag
```

---

## Adding a new source

Adding an institution is a block in `config/sources.yaml` — never a code change.

**If the site has an RSS or Atom feed:** copy an existing `kind: rss` block and change the URL. (Blogger blogs such as Damodaran's serve Atom at `/feeds/posts/default`; that works the same way.)

**If it's a JavaScript page with no feed:** hunt the real endpoint behind it first. This opens the page in a real browser, watches the network, and prints a ready-to-paste config block.

```bash
npm run discover -- https://www.example.com/insights
```

Then confirm it works:

```bash
npm run doctor
```

---

## Updating from GitHub

```bash
git pull && npm install
```

---

## Keeping the database tidy

One file grows as you use this: `data/feeds.db`. Nothing else does — the app writes no logs.

It grows slowly. The panel takes in around **ten dated articles a day**, which works out to roughly **4 MB a year**. Space is not something you will need to think about this decade.

What you might eventually want is to age the reading list — past a point, an article isn't something you're going to get to. The default cut is **one year**, and "older than a year" is decided per article:

- **If the publisher stated a date**, that date is used. Over a year old, it goes.
- **If the date was estimated** — the panel marks these — it goes a year after it *reached your list*, not a year after the guessed date. Those dates come from a sitemap's rebuild stamp or from the moment we first saw the page, and neither is worth deleting on.

About two in five stored articles have an estimated date, so this matters. It leans towards keeping things.

This shows what a cut would remove, and deletes nothing:

```bash
npm run prune
```

Add `--apply` once the list looks right, and `--older-than` to move the line:

```bash
npm run prune -- --older-than=180d --apply
```

> **WARNING** — Pruning cannot be undone. The removed URLs are remembered on purpose, so the sources will not offer them again. Without that they would come straight back: a feed's window reaches much further back than its length suggests — CBRT still lists items from 2023 — so a deleted article that is still listed would return on the next fetch and be deleted again on the next prune, forever. Anything under 30 days needs `--force`.

---

## Extras

### See the panel with no internet

Runs everything against a local fixture. Useful on a plane or a locked-down network.

```bash
npm run demo
```

### Confirm nothing broke after an edit

```bash
npm test && npm run typecheck
```

---

## If something goes wrong

**`npm error code ENOENT ... could not read package.json`**
Your terminal isn't in the project folder. `pwd` shows where you are.

**One red row in `doctor`**
Usually the site, not you. `bofa-institute` has spent hours returning 400 before recovering on its own. The worker backs off and retries, and the health strip in the panel shows it. Every awkward source has a comment in `config/sources.yaml` saying what was tried and what would revive it.

**The panel is empty but the worker says it stored articles**
You're probably looking at a filter. Facets **OR** within a category and **AND** across them, so `region:turkey + asset:crypto` will legitimately show nothing.

---

## Command reference

| Command | What it does | Exits on its own? |
|---|---|---|
| `npm run ingest:once` | Fetch every source one time | Yes |
| `npm start` | Serve the panel on port 3000 | No |
| `npm run worker` | Fetch on a schedule, forever | No |
| `npm run doctor` | Test every source, print a table | Yes |
| `npm run retag` | Re-apply tag rules to stored articles | Yes |
| `npm run prune` | Preview an age cut; `--apply` carries it out | Yes |
| `npm run discover -- <url>` | Find the feed behind a JS page | Yes |
| `npm run demo` | Run against a local fixture, offline | No |
| `npm test` | Run the test suite | Yes |
| `docker compose up -d --build` | Run both halves in the background | Yes |
| `docker compose down` | Stop the background services | Yes |
