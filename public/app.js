// Reading panel. All filter state lives in the URL, so any view can be
// bookmarked and the back button behaves the way people expect.

const el = {
  facets: document.getElementById('facets'),
  items: document.getElementById('items'),
  count: document.getElementById('count'),
  activeFilters: document.getElementById('active-filters'),
  search: document.getElementById('search'),
  since: document.getElementById('since'),
  sort: document.getElementById('sort'),
  clear: document.getElementById('clear'),
  empty: document.getElementById('empty'),
  sentinel: document.getElementById('sentinel'),
  health: document.getElementById('health'),
  sidebar: document.getElementById('sidebar'),
  menuToggle: document.getElementById('menu-toggle'),
};

const state = {
  facets: [],
  tags: new Set(),
  institutions: new Set(),
  q: '',
  since: '7d',
  sort: 'newest',
  cursor: null,
  loading: false,
  exhausted: false,
  collapsed: new Set(),
};

// --- URL state --------------------------------------------------------

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.tags = new Set(splitParam(p.get('tags')));
  state.institutions = new Set(splitParam(p.get('institution')));
  state.q = p.get('q') ?? '';
  state.since = ['24h', '7d', '30d', 'all'].includes(p.get('since')) ? p.get('since') : '7d';
  state.sort = p.get('sort') === 'oldest' ? 'oldest' : 'newest';
}

function splitParam(value) {
  return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

function writeUrl({ replace = false } = {}) {
  const p = new URLSearchParams();
  if (state.tags.size) p.set('tags', [...state.tags].join(','));
  if (state.institutions.size) p.set('institution', [...state.institutions].join(','));
  if (state.q) p.set('q', state.q);
  if (state.since !== '7d') p.set('since', state.since);
  if (state.sort !== 'newest') p.set('sort', state.sort);
  const url = p.toString() ? `?${p}` : location.pathname;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function queryString(cursor) {
  const p = new URLSearchParams();
  if (state.tags.size) p.set('tags', [...state.tags].join(','));
  if (state.institutions.size) p.set('institution', [...state.institutions].join(','));
  if (state.q) p.set('q', state.q);
  p.set('since', state.since);
  p.set('sort', state.sort);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

// --- data -------------------------------------------------------------

async function loadPage({ reset = false } = {}) {
  if (state.loading) return;
  if (!reset && state.exhausted) return;
  state.loading = true;

  if (reset) {
    state.cursor = null;
    state.exhausted = false;
    el.items.replaceChildren();
    el.empty.hidden = true;
  }

  const loader = document.createElement('li');
  loader.className = 'loading';
  loader.textContent = 'Loading…';
  el.items.append(loader);

  try {
    const res = await fetch(`/api/items?${queryString(state.cursor)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    loader.remove();

    for (const item of data.items) el.items.append(renderItem(item));
    state.cursor = data.nextCursor;
    state.exhausted = data.nextCursor === null;

    renderFacets(data.facets);
    renderSummary(data.total);
    if (data.total === 0) showEmpty();
  } catch (err) {
    loader.className = 'loading';
    loader.textContent = `Could not load articles: ${err.message}`;
  } finally {
    state.loading = false;
  }
}

// --- rendering --------------------------------------------------------

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item';

  const source = document.createElement('div');
  source.className = 'item-source';
  source.innerHTML =
    `<span class="item-institution"></span><span class="item-feed"></span>`;
  source.querySelector('.item-institution').textContent = item.institution;
  source.querySelector('.item-feed').textContent = item.sourceName;

  const body = document.createElement('div');
  body.className = 'item-body';

  const link = document.createElement('a');
  link.className = 'item-title';
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = item.title;
  const ext = document.createElement('span');
  ext.className = 'ext';
  ext.textContent = '↗';
  link.append(ext);
  body.append(link);

  if (item.summary) {
    const p = document.createElement('p');
    p.className = 'item-summary';
    p.textContent = item.summary;
    body.append(p);
  }

  if (item.tags.length) {
    const tags = document.createElement('div');
    tags.className = 'item-tags';
    for (const tag of item.tags) tags.append(renderTagChip(tag));
    body.append(tags);
  }

  const time = document.createElement('time');
  time.className = `item-time${item.dateEstimated ? ' estimated' : ''}`;
  time.dateTime = new Date(item.publishedAt).toISOString();
  time.textContent = relativeTime(item.publishedAt);
  time.title = item.dateEstimated
    ? `${new Date(item.publishedAt).toLocaleString()} (estimated — the source gave no date)`
    : new Date(item.publishedAt).toLocaleString();

  li.append(source, body, time);
  return li;
}

function renderTagChip(tag) {
  const [facet, ...rest] = tag.split(':');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tag${state.tags.has(tag) ? ' on' : ''}`;
  const name = document.createElement('span');
  name.className = 'facet-name';
  name.textContent = `${facet}:`;
  button.append(name, document.createTextNode(rest.join(':')));
  button.addEventListener('click', () => {
    toggle(state.tags, tag);
    apply();
  });
  return button;
}

function renderFacets(counts) {
  el.facets.replaceChildren();
  const groups = [
    { id: 'institution', label: 'Institution', selection: state.institutions },
    ...state.facets.map((f) => ({ id: f.id, label: f.label, selection: state.tags })),
  ];

  for (const group of groups) {
    const values = counts[group.id] ?? [];
    if (values.length === 0) continue;

    const section = document.createElement('section');
    section.className = `facet${state.collapsed.has(group.id) ? ' collapsed' : ''}`;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'facet-head';
    head.innerHTML = '<span class="chevron">▼</span>';
    head.append(document.createTextNode(group.label));
    head.addEventListener('click', () => {
      toggle(state.collapsed, group.id);
      section.classList.toggle('collapsed');
    });

    const body = document.createElement('div');
    body.className = 'facet-body';
    for (const { value, count } of values) {
      const checked = group.selection.has(value);
      if (count === 0 && !checked) {
        // Keep the row, but make it clearly unavailable rather than removing it,
        // so the sidebar does not jump around as filters change.
      }
      const label = document.createElement('label');
      label.className = `facet-option${count === 0 && !checked ? ' zero' : ''}`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => {
        toggle(group.selection, value);
        apply();
      });

      const text = document.createElement('span');
      text.className = 'label';
      text.textContent = group.id === 'institution' ? value : value.split(':').slice(1).join(':');
      text.title = text.textContent;

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = count;

      label.append(input, text, n);
      body.append(label);
    }

    section.append(head, body);
    el.facets.append(section);
  }
}

function renderSummary(total) {
  el.count.textContent = `${total.toLocaleString()} article${total === 1 ? '' : 's'}`;

  el.activeFilters.replaceChildren();
  const active = [
    ...[...state.institutions].map((v) => ({ value: v, set: state.institutions, text: v })),
    ...[...state.tags].map((v) => ({ value: v, set: state.tags, text: v })),
  ];
  for (const { value, set, text } of active) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.append(document.createTextNode(text));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${text}`;
    remove.addEventListener('click', () => {
      set.delete(value);
      apply();
    });
    pill.append(remove);
    el.activeFilters.append(pill);
  }
  el.clear.hidden = active.length === 0 && state.q === '';
}

function showEmpty() {
  const filtered = state.tags.size > 0 || state.institutions.size > 0 || state.q !== '';
  el.empty.hidden = false;
  el.empty.innerHTML = filtered
    ? '<h2>Nothing matches these filters</h2><p>Try widening the date range, or removing a filter.</p>'
    : '<h2>No articles yet</h2><p>Run <code>npm run ingest:once</code> to fetch, then <code>npm run doctor</code> to see which sources are working.</p>';
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < 0) return 'just now';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// --- health -----------------------------------------------------------

async function loadHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const data = await res.json();
    const broken = data.sources.filter((s) => s.status === 'error' || s.status === 'empty');
    if (broken.length === 0) {
      el.health.hidden = true;
      return;
    }
    el.health.hidden = false;
    el.health.replaceChildren();

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent =
      `${broken.length} source${broken.length === 1 ? '' : 's'} not delivering — ` +
      'a quiet feed here means a broken fetch, not a quiet day';
    const list = document.createElement('ul');
    for (const s of broken) {
      const li = document.createElement('li');
      li.textContent = `${s.institution} — ${s.name} (${s.adapter}): `;
      const code = document.createElement('code');
      code.textContent = s.error ?? s.status ?? 'unknown';
      li.append(code);
      list.append(li);
    }
    details.append(summary, list);
    el.health.append(details);
  } catch {
    // The health strip is a nicety; never let it break the reading list.
  }
}

// --- wiring -----------------------------------------------------------

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function apply({ replace = false } = {}) {
  writeUrl({ replace });
  void loadPage({ reset: true });
}

function syncControls() {
  el.search.value = state.q;
  el.since.value = state.since;
  el.sort.value = state.sort;
}

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = el.search.value.trim();
    apply({ replace: true });
  }, 250);
});

el.since.addEventListener('change', () => {
  state.since = el.since.value;
  apply();
});

el.sort.addEventListener('change', () => {
  state.sort = el.sort.value;
  apply();
});

el.clear.addEventListener('click', () => {
  state.tags.clear();
  state.institutions.clear();
  state.q = '';
  syncControls();
  apply();
});

el.menuToggle.addEventListener('click', () => el.sidebar.classList.toggle('open'));

window.addEventListener('popstate', () => {
  readUrl();
  syncControls();
  void loadPage({ reset: true });
});

new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadPage();
  },
  { rootMargin: '400px' },
).observe(el.sentinel);

async function start() {
  readUrl();
  syncControls();
  try {
    const res = await fetch('/api/taxonomy');
    if (res.ok) state.facets = (await res.json()).facets;
  } catch {
    // Without the taxonomy the sidebar loses its labels, but the list still works.
  }
  await loadPage({ reset: true });
  await loadHealth();
  setInterval(loadHealth, 300_000);
}

void start();
