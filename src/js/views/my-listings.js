import { CATEGORIES, categoryLabel, universityLabel } from '../data.js';
import { api } from '../api.js';
import { setReturned, statusOf } from '../store.js';
import { itemImage, emptyStateHTML, skeletonCardsHTML, errorStateHTML, statusBadge } from '../components.js';
import { icon, esc, initReveals, toast, confirmModal } from '../ui.js';

const STATUS_TABS = [
  ['all', 'All Listings'],
  ['active', 'Active'],
  ['returned', 'Returned'],
];

const TYPE_TABS = [
  ['all', 'All Types'],
  ['lost', 'Lost'],
  ['found', 'Found'],
];

export function MyListingsPage(root, query) {
  let all = [];

  const defaults = { status: 'all', type: 'all', category: '', sort: 'newest' };
  const state = {
    status: ['all', 'active', 'returned'].includes(query.status) ? query.status : defaults.status,
    type: ['all', 'lost', 'found'].includes(query.type) ? query.type : defaults.type,
    category: query.category || defaults.category,
    sort: query.sort || defaults.sort,
  };

  const user = (() => {
    try { return JSON.parse(localStorage.getItem('clf_user') || 'null'); }
    catch { return null; }
  })();

  if (!user) {
    root.innerHTML = `
    <div class="container page">
      <section class="page-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/">Home</a><span aria-hidden="true">/</span><span>My Listings</span>
        </nav>
        <h1>My Listings</h1>
        <p class="lead">You must be logged in to view your listings.</p>
      </section>
      <div class="empty-state">
        <div class="empty-icon">${icon('alert')}</div>
        <h3>Not logged in</h3>
        <p>Please log in to see and manage your reported items.</p>
        <div class="empty-actions">
          <a class="btn btn-primary" href="#/">Back to Home</a>
        </div>
      </div>
    </div>`;
    return;
  }

  root.innerHTML = `
  <div class="container page">
    <section class="page-head">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Home</a><span aria-hidden="true">/</span><span>My Listings</span>
      </nav>
      <h1>My Listings</h1>
      <p class="lead">All items you have reported on Campus Lost &amp; Found.</p>
    </section>

    <section class="claims-section" id="claimsSection" hidden>
      <h2>${icon('eye')}Pending Claims</h2>
      <p class="claims-sub" id="claimsSub">Review claim requests from other users for your found items.</p>
      <div id="claimsList" class="claims-list"></div>
    </section>

    <section class="listing">
      <form class="listing-toolbar" id="toolbar">
        <div class="toolbar-field">
          <label for="f-status">Status</label>
          <span class="select"><select class="input" id="f-status">
            ${STATUS_TABS.map(([v, label]) => `<option value="${v}" ${state.status === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></span>
        </div>
        <div class="toolbar-field">
          <label for="f-type">Type</label>
          <span class="select"><select class="input" id="f-type">
            ${TYPE_TABS.map(([v, label]) => `<option value="${v}" ${state.type === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></span>
        </div>
        <div class="toolbar-field">
          <label for="f-category">Category</label>
          <span class="select"><select class="input" id="f-category">
            <option value="">All categories</option>
            ${CATEGORIES.map(
              (c) => `<option value="${c.id}" ${state.category === c.id ? 'selected' : ''}>${esc(c.label)}</option>`
            ).join('')}
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
        <p class="results-count" id="resultsCount">Loading your listings…</p>
      </div>

      <div class="grid-cards" id="resultsGrid">${skeletonCardsHTML(6)}</div>
      <div id="emptyWrap"></div>
    </section>
  </div>`;

  const grid = root.querySelector('#resultsGrid');
  const emptyWrap = root.querySelector('#emptyWrap');
  const countEl = root.querySelector('#resultsCount');

  function applyClientFilters() {
    let out = [...all];
    if (state.type !== 'all') out = out.filter((i) => i.type === state.type);
    if (state.status === 'active') out = out.filter((i) => statusOf(i) !== 'returned');
    if (state.status === 'returned') out = out.filter((i) => statusOf(i) === 'returned');
    if (state.category) out = out.filter((i) => i.category === state.category);
    out.sort((a, b) => {
      if (state.sort === 'az') return a.name.localeCompare(b.name);
      if (state.sort === 'oldest') return a.date.localeCompare(b.date);
      return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.date.localeCompare(a.date);
    });
    return out;
  }

  function renderCard(item) {
    const st = statusOf(item);
    const href = `#/item/${encodeURIComponent(item.id)}`;
    const editHref = `#/report?type=${esc(item.type)}&edit=${encodeURIComponent(item.id)}`;
    const isReturned = st === 'returned';
    const uniLabel = item.university && item.university !== 'other' ? universityLabel(item.university) : '';
    return `
    <article class="item-card${isReturned ? ' is-returned' : ''}">
      <a class="card-media" href="${href}" aria-label="View details of ${esc(item.name)}">
        <img src="${itemImage(item)}" alt="${esc(item.name)}" loading="lazy">
        ${statusBadge(st)}
      </a>
      <div class="card-body">
        <h3><a href="${href}">${esc(item.name)}</a></h3>
        <p class="card-desc">${esc(item.description)}</p>
        <ul class="card-meta">
          <li>${icon('tag')}${esc(categoryLabel(item.category))}</li>
          <li>${icon('pin')}${esc(item.location)}</li>
          ${uniLabel ? `<li>${icon('school')}${esc(uniLabel)}</li>` : ''}
          <li>${icon('calendar')}${esc(item.date)}</li>
        </ul>
        <div class="card-actions">
          <a class="btn btn-secondary btn-sm" href="${href}">${icon('eye')}View</a>
          ${!isReturned ? `<a class="btn btn-secondary btn-sm" href="${editHref}">${icon('edit')}Edit</a>` : ''}
          ${!isReturned ? `<button type="button" class="btn btn-success btn-sm" data-mine-return="${esc(item.id)}">${icon('check')}Mark Returned</button>` : ''}
          <button type="button" class="btn btn-ghost btn-sm" data-mine-delete="${esc(item.id)}">${icon('trash')}Delete</button>
        </div>
      </div>
    </article>`;
  }

  function paint() {
    const items = applyClientFilters();
    const total = all.length;

    if (!total) {
      grid.innerHTML = '';
      emptyWrap.innerHTML = emptyStateHTML({
        iconName: 'box',
        title: 'You haven\u2019t listed any items yet.',
        text: 'Start by reporting a lost or found item so the campus community can help.',
        actionsHTML: `
          <a class="btn btn-primary" href="#/report?type=lost">${icon('edit')}Report a Lost Item</a>
          <a class="btn btn-secondary" href="#/report?type=found">${icon('search')}Report a Found Item</a>`,
      });
      countEl.textContent = '';
      return;
    }

    if (!items.length) {
      countEl.textContent = `Showing 0 of ${total} listing${total === 1 ? '' : 's'}`;
      grid.innerHTML = '';
      emptyWrap.innerHTML = emptyStateHTML({
        title: 'No matching listings found.',
        text: 'Try adjusting your filters.',
        actionsHTML: `<button type="button" class="btn btn-secondary" id="emptyReset">${icon('close')}Clear filters</button>`,
      });
      emptyWrap.querySelector('#emptyReset').addEventListener('click', resetFilters);
      return;
    }

    emptyWrap.innerHTML = '';
    countEl.textContent =
      items.length === total
        ? `Showing ${items.length} listing${items.length === 1 ? '' : 's'}`
        : `Showing ${items.length} of ${total} listing${total === 1 ? '' : 's'}`;
    grid.innerHTML = items.map((i) => renderCard(i)).join('');
    wireCardActions();
  }

  function wireCardActions() {
    grid.querySelectorAll('[data-mine-return]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.mineReturn;
        const item = all.find((i) => String(i.id) === String(id));
        confirmModal({
          title: 'Mark this item as returned?',
          message: `Are you sure you want to mark "${item ? item.name : 'this item'}" as returned? This action cannot be undone.`,
          confirmLabel: 'Mark as Returned',
          cancelLabel: 'Cancel',
          onConfirm: async () => {
            try {
              await setReturned(id);
              toast('Item marked as returned.', 'success');
              load();
            } catch (err) {
              toast(err.message || 'Could not mark as returned.', 'error');
            }
          },
        });
      });
    });

    grid.querySelectorAll('[data-mine-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.mineDelete;
        const item = all.find((i) => String(i.id) === String(id));
        confirmModal({
          title: 'Delete this listing?',
          message: `Are you sure you want to delete "${item ? item.name : 'this item'}"? This action cannot be undone.`,
          confirmLabel: 'Delete Listing',
          cancelLabel: 'Cancel',
          onConfirm: async () => {
            try {
              await api.deleteItem(id);
              toast('Listing deleted successfully.', 'success');
              load();
            } catch (err) {
              toast(err.message || 'Could not delete listing.', 'error');
            }
          },
        });
      });
    });
  }

  let fetchSeq = 0;

  async function loadClaims() {
    const claimsSection = root.querySelector('#claimsSection');
    const claimsList = root.querySelector('#claimsList');
    if (!claimsSection || !claimsList) return;
    try {
      const foundItems = all.filter((i) => i.type === 'found' && statusOf(i) !== 'returned');
      let allClaims = [];
      for (const item of foundItems) {
        try {
          const data = await api.getItemClaims(item.id);
          const claims = (data.claims || []).filter((c) => c.status === 'pending');
          for (const c of claims) {
            allClaims.push({ ...c, item_name: item.name, item_location: item.location, item_category: item.category });
          }
        } catch {}
      }
      if (!root.querySelector('#claimsSection')) return;
      if (!allClaims.length) {
        claimsSection.hidden = true;
        return;
      }
      claimsSection.hidden = false;
      claimsList.innerHTML = allClaims.map((c) => `
        <div class="claim-card" data-claim-id="${c.id}">
          <div class="claim-card-head">
            <span class="claim-card-item">${icon('tag')}${esc(c.item_name)}</span>
            <span class="claim-card-status badge badge--found">Pending</span>
          </div>
          <div class="claim-card-body">
            <div class="claim-card-from"><strong>From:</strong> ${esc(c.claimant_name)}</div>
            <div class="claim-card-proof"><strong>Proof:</strong> ${esc(c.proof_details)}</div>
            <div class="claim-card-date">${icon('calendar')}${esc(c.created_at ? c.created_at.split(' ')[0] : '')}</div>
          </div>
          <div class="claim-card-actions">
            <button type="button" class="btn btn-success btn-sm" data-claim-accept="${c.id}">${icon('check')}Accept</button>
            <button type="button" class="btn btn-secondary btn-sm" data-claim-reject="${c.id}">${icon('close')}Reject</button>
          </div>
        </div>
      `).join('');
      claimsList.querySelectorAll('[data-claim-accept]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const claimId = btn.dataset.claimAccept;
          confirmModal({
            title: 'Accept this claim?',
            message: 'The item will be marked as returned and the claimant will be notified.',
            confirmLabel: 'Accept Claim',
            cancelLabel: 'Cancel',
            onConfirm: async () => {
              try {
                await api.acceptClaim(claimId);
                toast('Claim accepted. Item marked as returned.', 'success');
                load();
              } catch (err) {
                toast(err.message || 'Could not accept claim.', 'error');
              }
            },
          });
        });
      });
      claimsList.querySelectorAll('[data-claim-reject]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const claimId = btn.dataset.claimReject;
          confirmModal({
            title: 'Reject this claim?',
            message: 'The claimant will be notified. The item will remain active.',
            confirmLabel: 'Reject Claim',
            cancelLabel: 'Cancel',
            onConfirm: async () => {
              try {
                await api.rejectClaim(claimId);
                toast('Claim rejected.', 'success');
                load();
              } catch (err) {
                toast(err.message || 'Could not reject claim.', 'error');
              }
            },
          });
        });
      });
    } catch {}
  }

  async function load() {
    const seq = ++fetchSeq;
    grid.innerHTML = skeletonCardsHTML(6);
    emptyWrap.innerHTML = '';
    countEl.textContent = 'Loading your listings…';

    try {
      const data = await api.listItems({ mine: '1' });
      if (seq !== fetchSeq) return;
      all = data;
      paint();
      loadClaims();
    } catch (err) {
      if (seq !== fetchSeq) return;
      countEl.textContent = '';
      grid.innerHTML = '';
      emptyWrap.innerHTML = errorStateHTML(err.message);
    }
  }

  function resetFilters() {
    Object.assign(state, defaults);
    root.querySelector('#f-status').value = state.status;
    root.querySelector('#f-type').value = state.type;
    root.querySelector('#f-category').value = state.category;
    root.querySelector('#f-sort').value = state.sort;
    load();
  }

  [['#f-status', 'status'], ['#f-type', 'type'], ['#f-category', 'category'], ['#f-sort', 'sort']]
    .forEach(([id, key]) => {
      const el = root.querySelector(id);
      if (el) el.addEventListener('change', () => { state[key] = el.value; load(); });
    });

  root.querySelector('#f-reset').addEventListener('click', resetFilters);

  load();
  initReveals(root);
}
