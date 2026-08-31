import { CATEGORIES, categoryLabel, locationsFrom, UNIVERSITIES } from '../data.js';
import { fetchItems } from '../store.js';
import { itemCard, emptyStateHTML, skeletonCardsHTML, errorStateHTML } from '../components.js';
import { icon, esc, initReveals } from '../ui.js';

const TITLES = {
  lost: { t: 'Lost Items', s: 'Browse items reported missing around campus.' },
  found: { t: 'Found Items', s: 'Items recently found by members of the campus community.' },
  all: { t: 'Browse Items', s: 'Every lost and found report across campus, in one place.' },
};

const STATUS_META = {
  all: { t: 'Browse Items', s: 'Every lost and found report across campus, in one place.' },
  lost: { t: 'Lost Items', s: 'Browse items reported missing around campus.' },
  found: { t: 'Found Items', s: 'Items recently found by members of the campus community.' },
  returned: { t: 'Returned Items', s: 'Successfully reunited with their owners. Case closed!' },
};

const STATUS_OPTIONS = {
  lost: [['all', 'All items'], ['lost', 'Lost'], ['returned', 'Returned']],
  found: [['all', 'All items'], ['found', 'Found'], ['returned', 'Returned']],
  all: [['all', 'All items'], ['lost', 'Lost'], ['found', 'Found'], ['returned', 'Returned']],
};

function optionList(values, selected, allLabel) {
  return (
    `<option value="">${esc(allLabel)}</option>` +
    values.map((v) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('')
  );
}

export function ListPage(mode) {
  return function List(root, query) {
    let all = [];

    const defaults = {
      q: '',
      status: mode === 'found' ? 'found' : 'all',
      category: '',
      location: '',
      university: '',
      days: 'any',
      sort: 'newest',
    };
    const allowedStatus = STATUS_OPTIONS[mode].map(([v]) => v);
    const state = {
      q: query.q || defaults.q,
      status: allowedStatus.includes(query.status) ? query.status : defaults.status,
      category: query.category || defaults.category,
      location: query.location || defaults.location,
      university: query.university || defaults.university,
      days: query.days || defaults.days,
      sort: query.sort || defaults.sort,
    };

    root.innerHTML = `
    <div class="container page">
      <section class="page-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/">Home</a><span aria-hidden="true">/</span><span id="crumbCurrent">${TITLES[mode].t}</span>
        </nav>
        <h1 id="listingTitle">${TITLES[mode].t}</h1>
        <p class="lead" id="listingSub">${TITLES[mode].s}</p>
      </section>

      <section class="listing">
        <form class="listing-toolbar" id="toolbar">
          <div class="toolbar-field grow">
            <label for="f-q">Search</label>
            <div class="search-wrap">
              ${icon('search')}
              <input class="input" id="f-q" type="search" autocomplete="off"
                placeholder="Item name, category, location..." value="${esc(state.q)}">
            </div>
          </div>
          <div class="toolbar-field">
            <label for="f-status">Status</label>
            <span class="select"><select class="input" id="f-status">
              ${STATUS_OPTIONS[mode]
                .map(([v, label]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${esc(label)}</option>`)
                .join('')}
            </select></span>
          </div>
          <div class="toolbar-field">
            <label for="f-university">University</label>
            <span class="select"><select class="input" id="f-university">
              <option value="">All universities</option>
              ${UNIVERSITIES.map(
                (u) => `<option value="${u.id}" ${state.university === u.id ? 'selected' : ''}>${esc(u.label)}</option>`
              ).join('')}
            </select></span>
          </div>
          <div class="toolbar-field">
            <label for="f-category">Category</label>
            <span class="select"><select class="input" id="f-category">
              ${CATEGORIES.map(
                (c) => `<option value="${c.id}" ${state.category === c.id ? 'selected' : ''}>${esc(c.label)}</option>`
              ).join('')}
            </select></span>
          </div>
          <div class="toolbar-field">
            <label for="f-location">Location</label>
            <span class="select"><select class="input" id="f-location">${optionList([], state.location, 'All locations')}</select></span>
          </div>
          <div class="toolbar-field">
            <label for="f-days">Date</label>
            <span class="select"><select class="input" id="f-days">
              <option value="any" ${state.days === 'any' ? 'selected' : ''}>Any time</option>
              <option value="7" ${state.days === '7' ? 'selected' : ''}>Last 7 days</option>
              <option value="30" ${state.days === '30' ? 'selected' : ''}>Last 30 days</option>
            </select></span>
          </div>
          <div class="toolbar-field">
            <label for="f-sort">Sort by</label>
            <span class="select"><select class="input" id="f-sort">
              <option value="newest" ${state.sort === 'newest' ? 'selected' : ''}>Newest first</option>
              <option value="oldest" ${state.sort === 'oldest' ? 'selected' : ''}>Oldest first</option>
              <option value="az" ${state.sort === 'az' ? 'selected' : ''}>A – Z</option>
            </select></span>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" id="f-reset">${icon('close')}Reset</button>
        </form>

        <div class="results-meta">
          <p class="results-count" id="resultsCount">Loading items…</p>
        </div>

        <div class="grid-cards" id="resultsGrid">${skeletonCardsHTML(6)}</div>
        <div id="emptyWrap"></div>
      </section>
    </div>`;
    /* __WIRING__ */

    const grid = root.querySelector('#resultsGrid');
    const emptyWrap = root.querySelector('#emptyWrap');
    const countEl = root.querySelector('#resultsCount');
    const titleEl = root.querySelector('#listingTitle');
    const subEl = root.querySelector('#listingSub');
    const crumbEl = root.querySelector('#crumbCurrent');

    function applyClientFilters() {
      let out = [...all];
      if (state.location) out = out.filter((i) => i.location === state.location);
      out.sort((a, b) => {
        if (state.sort === 'az') return a.name.localeCompare(b.name);
        if (state.sort === 'oldest') return a.date.localeCompare(b.date);
        return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.date.localeCompare(a.date);
      });
      return out;
    }

    function renderHeader() {
      const meta = mode === 'all' ? STATUS_META[state.status] || TITLES.all : TITLES[mode];
      titleEl.textContent = meta.t;
      subEl.textContent = meta.s;
      crumbEl.textContent = meta.t;
    }

    let fetchSeq = 0;

    function renderError(message) {
      countEl.textContent = '';
      grid.innerHTML = '';
      emptyWrap.innerHTML = errorStateHTML(message);
    }

    async function load() {
      renderHeader();
      const seq = ++fetchSeq;
      grid.innerHTML = skeletonCardsHTML(6);
      emptyWrap.innerHTML = '';

      const params = {};
      if (mode !== 'all') params.type = mode;
      if (state.status !== 'all') params.status = state.status;
      if (state.university) params.university = state.university;
      if (state.category) params.category = state.category;
      if (state.location) params.location = state.location;
      if (state.days !== 'any') params.days = state.days;
      if (state.q) params.search = state.q;

      try {
        const result = await fetchItems(params, { allowFallback: true });
        if (seq !== fetchSeq) return;
        all = result.items;
        paint();
      } catch (err) {
        if (seq === fetchSeq) {
          countEl.textContent = '';
          grid.innerHTML = '';
          emptyWrap.innerHTML = errorStateHTML(err.message);
        }
      }
    }

    function paint() {
      const locSelect = root.querySelector('#f-location');
      locSelect.innerHTML = optionList(locationsFrom(all), state.location, 'All locations');

      renderHeader();
      const items = applyClientFilters();
      const total = all.length;

      if (!items.length) {
        countEl.textContent = `Showing 0 of ${total} ${total === 1 ? 'item' : 'items'}`;
        grid.innerHTML = '';
        emptyWrap.innerHTML = emptyStateHTML({
          title: 'No matching items found.',
          text: 'Try another search term or report the item yourself so the community can help.',
          actionsHTML: `
            <button type="button" class="btn btn-secondary" id="emptyReset">${icon('close')}Clear filters</button>
            <a class="btn btn-primary" href="#/report?type=${mode === 'found' ? 'found' : 'lost'}">${icon('edit')}${
              mode === 'found' ? 'Report a Found Item' : 'Report a Lost Item'
            }</a>`,
        });
        emptyWrap.querySelector('#emptyReset').addEventListener('click', resetFilters);
        return;
      }

      emptyWrap.innerHTML = '';
      countEl.textContent =
        items.length === total
          ? `Showing ${items.length} ${items.length === 1 ? 'item' : 'items'}`
          : `Showing ${items.length} of ${total} ${total === 1 ? 'item' : 'items'}`;
      grid.innerHTML = items.map((i) => itemCard(i, { showContact: i.status === 'found' })).join('');
    }

    function syncControls() {
      const q = root.querySelector('#f-q');
      if (q.value !== state.q) q.value = state.q;
      const bind = (id, key) => {
        const el = root.querySelector(id);
        if (el && el.value !== String(state[key])) el.value = String(state[key]);
      };
      bind('#f-status', 'status');
      bind('#f-category', 'category');
      bind('#f-location', 'location');
      bind('#f-university', 'university');
      bind('#f-days', 'days');
      bind('#f-sort', 'sort');
    }

    function resetFilters() {
      Object.assign(state, defaults);
      syncControls();
      load();
    }

    const searchInput = root.querySelector('#f-q');
    let debounceTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.q = searchInput.value.trim();
        load();
      }, 260);
    });

    [['#f-status', 'status'], ['#f-category', 'category'], ['#f-location', 'location'], ['#f-university', 'university'], ['#f-days', 'days'], ['#f-sort', 'sort']]
      .forEach(([id, key]) => {
        const el = root.querySelector(id);
        if (!el) return;
        el.addEventListener('change', () => {
          state[key] = el.value;
          if (key === 'sort') paint();
          else load();
        });
      });

    root.querySelector('#f-reset').addEventListener('click', resetFilters);

    load();
    initReveals(root);
  };
}
