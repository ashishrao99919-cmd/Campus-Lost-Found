import { api } from '../api.js';
import { CATEGORIES, categoryLabel, universityLabel, UNIVERSITIES } from '../data.js';
import { icon, esc, toast, confirmModal, timeAgo } from '../ui.js';
import { skeletonCardsHTML, emptyStateHTML } from '../components.js';

let activeTab = 'dashboard';

const REPORT_REASONS = {
  fake: 'Fake or misleading',
  wrong_category: 'Wrong category',
  prohibited: 'Prohibited item',
  duplicate: 'Duplicate listing',
  inappropriate: 'Inappropriate content',
  incorrect_info: 'Incorrect info',
  other: 'Other',
};

const REPORT_STATUSES = {
  pending: 'Pending',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('clf_user') || 'null');
  } catch {
    return null;
  }
}

function requireAdmin() {
  const user = getCurrentUser();
  if (!user || user.role !== 'admin') return false;
  return true;
}

function statCard(label, value, iconName) {
  return `
    <div class="stat-card">
      <div class="stat-icon">${icon(iconName)}</div>
      <div class="stat-body">
        <span class="stat-value">${esc(String(value))}</span>
        <span class="stat-label">${esc(label)}</span>
      </div>
    </div>`;
}

export function AdminPage(root) {
  if (!requireAdmin()) {
    root.innerHTML = `
      <div class="container page">
        <section class="page-head">
          <h1>Access Denied</h1>
          <p class="lead">You do not have permission to view this page.</p>
          <a class="btn btn-primary" href="#/">${icon('arrowLeft')}Back to Home</a>
        </section>
      </div>`;
    return;
  }

  const tabs = [
    ['dashboard', 'Dashboard', 'sparkle'],
    ['listings', 'Listings', 'box'],
    ['users', 'Users', 'users'],
    ['reports', 'Reports', 'alert'],
    ['logs', 'Activity Log', 'clock'],
  ];

  root.innerHTML = `
    <div class="container page">
      <section class="page-head">
        <nav class="crumbs" aria-label="Breadcrumb">
          <a href="#/">Home</a><span aria-hidden="true">/</span><span>Admin</span>
        </nav>
        <h1>${icon('shield')} Admin Dashboard</h1>
        <p class="lead">Manage listings, users, and review activity.</p>
      </section>
      <nav class="admin-tabs" role="tablist">
        ${tabs.map(([id, label, ic]) =>
          `<button class="admin-tab${id === activeTab ? ' active' : ''}" role="tab" data-admin-tab="${id}" aria-selected="${id === activeTab}">${icon(ic)}${label}</button>`
        ).join('')}
      </nav>
      <div id="adminContent" class="admin-content">
        ${skeletonCardsHTML(3)}
      </div>
    </div>`;

  const content = root.querySelector('#adminContent');

  root.querySelectorAll('[data-admin-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.adminTab;
      root.querySelectorAll('[data-admin-tab]').forEach((b) => {
        b.classList.toggle('active', b.dataset.adminTab === activeTab);
        b.setAttribute('aria-selected', b.dataset.adminTab === activeTab ? 'true' : 'false');
      });
      renderTab(content);
    });
  });

  renderTab(content);
}

async function renderTab(content) {
  content.innerHTML = skeletonCardsHTML(3);
  try {
    if (activeTab === 'dashboard') await renderDashboard(content);
    else if (activeTab === 'listings') await renderListings(content);
    else if (activeTab === 'users') await renderUsers(content);
    else if (activeTab === 'reports') await renderReports(content);
    else if (activeTab === 'logs') await renderLogs(content);
  } catch (err) {
    content.innerHTML = `
      <div class="admin-error">
        <p>${esc(err.message || 'Failed to load data.')}</p>
        <button class="btn btn-secondary btn-sm" data-retry-admin>${icon('arrowRight')}Retry</button>
      </div>`;
    content.querySelector('[data-retry-admin]')?.addEventListener('click', () => renderTab(content));
  }
}

async function renderDashboard(content) {
  const data = await api.adminStats();
  const s = data.stats;
  content.innerHTML = `
    <div class="admin-stats-grid">
      ${statCard('Total Users', s.total_users, 'users')}
      ${statCard('Total Listings', s.total_listings, 'box')}
      ${statCard('Active Listings', s.active_listings, 'eye')}
      ${statCard('Returned', s.returned_listings, 'check')}
      ${statCard('Lost', s.lost_listings, 'search')}
      ${statCard('Found', s.found_listings, 'pin')}
      ${statCard('Pending Reports', s.pending_reports || 0, 'alert')}
      ${statCard('Total Reports', s.total_reports || 0, 'alert')}
      ${statCard('Total Matches', s.total_matches || 0, 'sparkle')}
      ${statCard('High Matches', s.high_matches || 0, 'sparkle')}
    </div>

    <div class="admin-section">
      <h2>Recent Listings</h2>
      ${data.recent_items.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Item</th><th>Type</th><th>Status</th><th>Category</th><th>University</th><th>Reporter</th><th>Date</th></tr></thead>
            <tbody>
              ${data.recent_items.map((i) => `
                <tr>
                  <td><a href="#/item/${i.id}" class="admin-link">${esc(i.item_name)}</a></td>
                  <td><span class="badge badge--${i.type === 'lost' ? 'lost' : 'found'}">${esc(i.type)}</span></td>
                  <td><span class="badge badge--${i.status === 'returned' ? 'returned' : i.status === 'lost' ? 'lost' : 'found'}">${esc(i.status)}</span></td>
                  <td>${esc(categoryLabel(i.category))}</td>
                  <td>${esc(universityLabel(i.university))}</td>
                  <td>${esc(i.reporter_name || '—')}</td>
                  <td>${esc(timeAgo(i.created_at ? i.created_at.split(' ')[0] : new Date().toISOString().slice(0, 10)))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="admin-empty">No listings yet.</p>'}
    </div>

    <div class="admin-section">
      <h2>Recent Users</h2>
      ${data.recent_users.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
            <tbody>
              ${data.recent_users.map((u) => `
                <tr>
                  <td>${esc(u.name)}</td>
                  <td>${esc(u.email)}</td>
                  <td><span class="badge badge--${u.role === 'admin' ? 'found' : 'lost'}">${esc(u.role)}</span></td>
                  <td>${u.blocked ? '<span class="badge badge--lost">Blocked</span>' : '<span class="badge badge--returned">Active</span>'}</td>
                  <td>${esc(timeAgo(u.created_at ? u.created_at.split(' ')[0] : new Date().toISOString().slice(0, 10)))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="admin-empty">No users yet.</p>'}
    </div>`;
}

async function renderListings(content) {
  const filtersHTML = `
    <div class="admin-toolbar">
      <div class="toolbar-field grow">
        <label for="admin-search">Search</label>
        <div class="search-wrap">
          ${icon('search')}
          <input class="input" id="admin-search" type="search" autocomplete="off" placeholder="Search listings...">
        </div>
      </div>
      <div class="toolbar-field">
        <label for="admin-filter-type">Type</label>
        <span class="select"><select class="input" id="admin-filter-type">
          <option value="">All types</option>
          <option value="lost">Lost</option>
          <option value="found">Found</option>
        </select></span>
      </div>
      <div class="toolbar-field">
        <label for="admin-filter-status">Status</label>
        <span class="select"><select class="input" id="admin-filter-status">
          <option value="">All statuses</option>
          <option value="lost">Lost</option>
          <option value="found">Found</option>
          <option value="returned">Returned</option>
        </select></span>
      </div>
      <div class="toolbar-field">
        <label for="admin-filter-uni">University</label>
        <span class="select"><select class="input" id="admin-filter-uni">
          <option value="">All universities</option>
          ${UNIVERSITIES.map((u) => `<option value="${u.id}">${esc(u.label)}</option>`).join('')}
        </select></span>
      </div>
      <div class="toolbar-field">
        <label for="admin-filter-cat">Category</label>
        <span class="select"><select class="input" id="admin-filter-cat">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}
        </select></span>
      </div>
    </div>
    <div id="adminListingsTable">${skeletonCardsHTML(3)}</div>`;

  content.innerHTML = filtersHTML;

  const tableWrap = content.querySelector('#adminListingsTable');
  let debounceTimer;

  async function loadListings() {
    const params = {};
    const q = content.querySelector('#admin-search')?.value?.trim();
    const type = content.querySelector('#admin-filter-type')?.value;
    const status = content.querySelector('#admin-filter-status')?.value;
    const uni = content.querySelector('#admin-filter-uni')?.value;
    const cat = content.querySelector('#admin-filter-cat')?.value;
    if (q) params.search = q;
    if (type) params.type = type;
    if (status) params.status = status;
    if (uni) params.university = uni;
    if (cat) params.category = cat;

    tableWrap.innerHTML = skeletonCardsHTML(3);
    try {
      const data = await api.adminListItems(params);
      const items = data.items || [];
      if (!items.length) {
        tableWrap.innerHTML = emptyStateHTML({
          title: 'No listings found.',
          text: 'Try adjusting your filters.',
        });
        return;
      }
      tableWrap.innerHTML = `
        <p class="results-count">Showing ${items.length} listing${items.length === 1 ? '' : 's'}</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Item</th><th>Type</th><th>Status</th><th>Category</th><th>Location</th><th>University</th><th>Reporter</th><th>Reports</th><th>Actions</th></tr></thead>
            <tbody>
              ${items.map((i) => `
                <tr data-item-id="${i.id}">
                  <td><a href="#/item/${i.id}" class="admin-link">${esc(i.item_name)}</a></td>
                  <td><span class="badge badge--${i.type === 'lost' ? 'lost' : 'found'}">${esc(i.type)}</span></td>
                  <td><span class="badge badge--${i.status === 'returned' ? 'returned' : i.status === 'lost' ? 'lost' : 'found'}">${esc(i.status)}</span></td>
                  <td>${esc(categoryLabel(i.category))}</td>
                  <td>${esc(i.location)}</td>
                  <td>${esc(universityLabel(i.university))}</td>
                  <td>${esc(i.reporter_name || '—')}</td>
                  <td>${i.report_count > 0 ? `<span class="badge badge--lost">${i.report_count} (${i.pending_report_count} pending)</span>` : '—'}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" data-admin-delete="${i.id}" data-admin-delete-name="${esc(i.item_name)}">
                      ${icon('trash')}Delete
                    </button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      tableWrap.querySelectorAll('[data-admin-delete]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.adminDelete;
          const name = btn.dataset.adminDeleteName;
          confirmModal({
            title: 'Delete Listing',
            message: `Are you sure you want to permanently delete "${name}"? This action cannot be undone.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            onConfirm: async () => {
              try {
                await api.adminDeleteItem(id);
                toast('Listing deleted successfully.', 'success');
                await loadListings();
              } catch (err) {
                toast(err.message || 'Failed to delete listing.', 'error');
              }
            },
          });
        });
      });
    } catch (err) {
      tableWrap.innerHTML = `<div class="admin-error"><p>${esc(err.message)}</p></div>`;
    }
  }

  content.querySelector('#admin-search')?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadListings, 300);
  });
  ['admin-filter-type', 'admin-filter-status', 'admin-filter-uni', 'admin-filter-cat'].forEach((id) => {
    content.querySelector(`#${id}`)?.addEventListener('change', loadListings);
  });

  await loadListings();
}

async function renderUsers(content) {
  const data = await api.adminListUsers();
  const users = data.users || [];
  if (!users.length) {
    content.innerHTML = emptyStateHTML({ title: 'No users found.', text: 'No accounts registered yet.' });
    return;
  }
  content.innerHTML = `
    <p class="results-count">${users.length} user${users.length === 1 ? '' : 's'}</p>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr data-user-id="${u.id}">
              <td>${esc(u.name)}</td>
              <td>${esc(u.email)}</td>
              <td>
                <select class="input input-sm" data-role-select="${u.id}" ${u.id === getCurrentUser()?.id ? 'disabled title="Cannot change own role"' : ''}>
                  <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
              </td>
              <td>${u.blocked ? '<span class="badge badge--lost">Blocked</span>' : '<span class="badge badge--returned">Active</span>'}</td>
              <td>${esc(timeAgo(u.created_at ? u.created_at.split(' ')[0] : new Date().toISOString().slice(0, 10)))}</td>
              <td>
                <button class="btn btn-sm ${u.blocked ? 'btn-primary' : 'btn-secondary'}"
                  data-toggle-block="${u.id}"
                  ${u.id === getCurrentUser()?.id ? 'disabled title="Cannot block yourself"' : ''}>
                  ${u.blocked ? icon('check') + 'Unblock' : icon('alert') + 'Block'}
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  content.querySelectorAll('[data-toggle-block]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.toggleBlock;
      const user = users.find((u) => String(u.id) === String(uid));
      if (!user) return;
      const action = user.blocked ? 'unblock' : 'block';
      confirmModal({
        title: `${action === 'block' ? 'Block' : 'Unblock'} User`,
        message: `Are you sure you want to ${action} "${user.name}" (${user.email})?`,
        confirmLabel: action === 'block' ? 'Block' : 'Unblock',
        cancelLabel: 'Cancel',
        onConfirm: async () => {
          try {
            await api.adminUpdateUser(uid, { blocked: !user.blocked });
            toast(`User ${action}ed successfully.`, 'success');
            await renderUsers(content);
          } catch (err) {
            toast(err.message || 'Failed to update user.', 'error');
          }
        },
      });
    });
  });

  content.querySelectorAll('[data-role-select]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const uid = sel.dataset.roleSelect;
      try {
        await api.adminUpdateUser(uid, { role: sel.value });
        toast('User role updated.', 'success');
        await renderUsers(content);
      } catch (err) {
        toast(err.message || 'Failed to update role.', 'error');
      }
    });
  });
}

async function renderReports(content) {
  const filtersHTML = `
    <div class="admin-toolbar">
      <div class="toolbar-field">
        <label for="admin-report-status">Status</label>
        <span class="select"><select class="input" id="admin-report-status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </select></span>
      </div>
      <div class="toolbar-field">
        <label for="admin-report-reason">Reason</label>
        <span class="select"><select class="input" id="admin-report-reason">
          <option value="">All reasons</option>
          ${Object.entries(REPORT_REASONS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
        </select></span>
      </div>
      <div class="toolbar-field">
        <label for="admin-report-uni">University</label>
        <span class="select"><select class="input" id="admin-report-uni">
          <option value="">All universities</option>
          ${UNIVERSITIES.map((u) => `<option value="${u.id}">${esc(u.label)}</option>`).join('')}
        </select></span>
      </div>
    </div>
    <div id="adminReportsTable">${skeletonCardsHTML(3)}</div>`;

  content.innerHTML = filtersHTML;

  const tableWrap = content.querySelector('#adminReportsTable');

  async function loadReports() {
    const params = {};
    const status = content.querySelector('#admin-report-status')?.value;
    const reason = content.querySelector('#admin-report-reason')?.value;
    const uni = content.querySelector('#admin-report-uni')?.value;
    if (status) params.status = status;
    if (reason) params.reason = reason;
    if (uni) params.university = uni;

    tableWrap.innerHTML = skeletonCardsHTML(3);
    try {
      const data = await api.adminListReports(params);
      const reports = data.reports || [];
      if (!reports.length) {
        tableWrap.innerHTML = emptyStateHTML({
          title: 'No reports found.',
          text: 'Try adjusting your filters.',
        });
        return;
      }
      const pendingCount = reports.filter((r) => r.status === 'pending').length;
      const resolvedCount = reports.filter((r) => r.status === 'resolved').length;
      const dismissedCount = reports.filter((r) => r.status === 'dismissed').length;

      tableWrap.innerHTML = `
        <div class="admin-report-summary">
          <span class="badge badge--lost">${pendingCount} Pending</span>
          <span class="badge badge--returned">${resolvedCount} Resolved</span>
          <span class="badge badge--found">${dismissedCount} Dismissed</span>
          <span class="results-count">${reports.length} total</span>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Listing</th><th>Reporter</th><th>Owner</th><th>Reason</th><th>Details</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
              ${reports.map((r) => `
                <tr data-report-id="${r.id}">
                  <td><a href="#/item/${r.listing_id}" class="admin-link">${esc(r.item_name)}</a></td>
                  <td>${esc(r.reporter_name || '—')}</td>
                  <td>${esc(r.owner_name || '—')}</td>
                  <td><span class="badge badge--found">${esc(REPORT_REASONS[r.reason] || r.reason)}</span></td>
                  <td>${esc(r.details || '—')}</td>
                  <td><span class="badge badge--${r.status === 'pending' ? 'lost' : r.status === 'resolved' ? 'returned' : 'found'}">${esc(REPORT_STATUSES[r.status])}</span></td>
                  <td>${esc(timeAgo(r.created_at ? r.created_at.split(' ')[0] : new Date().toISOString().slice(0, 10)))}</td>
                  <td>
                    ${r.status === 'pending' ? `
                      <button class="btn btn-secondary btn-sm" data-report-resolve="${r.id}">${icon('check')}Resolve</button>
                      <button class="btn btn-secondary btn-sm" data-report-dismiss="${r.id}">${icon('close')}Dismiss</button>
                    ` : ''}
                    <button class="btn btn-secondary btn-sm" data-report-view="${r.listing_id}">${icon('eye')}View</button>
                    <button class="btn btn-secondary btn-sm" data-report-remove="${r.listing_id}" data-report-remove-name="${esc(r.item_name)}">${icon('trash')}Remove</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      tableWrap.querySelectorAll('[data-report-resolve]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.adminResolveReport(btn.dataset.reportResolve);
            toast('Report resolved.', 'success');
            await loadReports();
          } catch (err) {
            toast(err.message || 'Failed to resolve report.', 'error');
          }
        });
      });

      tableWrap.querySelectorAll('[data-report-dismiss]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.adminDismissReport(btn.dataset.reportDismiss);
            toast('Report dismissed.', 'success');
            await loadReports();
          } catch (err) {
            toast(err.message || 'Failed to dismiss report.', 'error');
          }
        });
      });

      tableWrap.querySelectorAll('[data-report-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
          window.location.hash = `#/item/${btn.dataset.reportView}`;
        });
      });

      tableWrap.querySelectorAll('[data-report-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.reportRemove;
          const name = btn.dataset.reportRemoveName;
          confirmModal({
            title: 'Remove Listing',
            message: `Are you sure you want to permanently remove "${name}"? This action cannot be undone and will not delete the owner's account.`,
            confirmLabel: 'Remove Listing',
            cancelLabel: 'Cancel',
            onConfirm: async () => {
              try {
                await api.adminDeleteItem(id);
                toast('Listing removed successfully.', 'success');
                await loadReports();
              } catch (err) {
                toast(err.message || 'Failed to remove listing.', 'error');
              }
            },
          });
        });
      });
    } catch (err) {
      tableWrap.innerHTML = `<div class="admin-error"><p>${esc(err.message)}</p></div>`;
    }
  }

  ['admin-report-status', 'admin-report-reason', 'admin-report-uni'].forEach((id) => {
    content.querySelector(`#${id}`)?.addEventListener('change', loadReports);
  });

  await loadReports();
}

async function renderLogs(content) {
  const data = await api.adminLogs();
  const logs = data.logs || [];
  if (!logs.length) {
    content.innerHTML = emptyStateHTML({ title: 'No activity yet.', text: 'Admin actions will appear here.' });
    return;
  }
  content.innerHTML = `
    <p class="results-count">${logs.length} log entr${logs.length === 1 ? 'y' : 'ies'}</p>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td>${esc(l.admin_name || '—')}</td>
              <td><span class="badge badge--found">${esc(l.action)}</span></td>
              <td>${esc(l.target_type)}${l.target_id ? ` #${l.target_id}` : ''}</td>
              <td>${esc(l.details || '—')}</td>
              <td>${esc(timeAgo(l.created_at ? l.created_at.split(' ')[0] : new Date().toISOString().slice(0, 10)))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
