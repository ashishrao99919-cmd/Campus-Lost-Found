import { CATEGORIES, categoryLabel, universityLabel } from './data.js';
import { statusOf } from './store.js';
import { ICONS, esc, icon, timeAgo, formatDate, parseDate } from './ui.js';

const catIcon = (id) => (CATEGORIES.find((c) => c.id === id) || {}).icon || 'dots';

export function itemImage(item) {
  if (item.image) return item.image;
  const hue = [...String(item.id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  const gid = `grad_${String(item.id).replace(/[^a-z0-9_-]/gi, '')}`;
  const inner = ICONS[catIcon(item.category)] || ICONS.dots;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'>` +
    `<defs><linearGradient id='${gid}' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue},55%,90%)'/>` +
    `<stop offset='1' stop-color='hsl(${(hue + 40) % 360},48%,81%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='400' height='300' fill='url(#${gid})'/>` +
    `<circle cx='330' cy='42' r='92' fill='hsla(${hue},50%,45%,0.13)'/>` +
    `<circle cx='58' cy='262' r='110' fill='hsla(${hue},50%,45%,0.10)'/>` +
    `<g transform='translate(152,102) scale(4)' fill='none' stroke='hsl(${hue},30%,40%)' stroke-width='1' stroke-linecap='round' stroke-linejoin='round'>${inner}</g>` +
    `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function statusBadge(status) {
  if (status === 'returned') {
    return `<span class="badge badge--returned">${icon('check')}Returned</span>`;
  }
  return `<span class="badge badge--${status === 'lost' ? 'lost' : 'found'}">${status === 'lost' ? 'Lost' : 'Found'}</span>`;
}

export function itemCard(item, opts = {}) {
  const st = statusOf(item);
  const href = `#/item/${encodeURIComponent(item.id)}`;
  const tel = String((item.reporter && item.reporter.phone) || '').replace(/[^\d+]/g, '');
  return `
    <article class="item-card${st === 'returned' ? ' is-returned' : ''}">
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
          ${item.university && item.university !== 'other' ? `<li>${icon('school')}${esc(universityLabel(item.university))}</li>` : ''}
          <li>${icon('calendar')}${timeAgo(item.date)}</li>
        </ul>
        <div class="card-actions">
          <a class="btn btn-secondary btn-sm" href="${href}">${icon('eye')}View Details</a>
          ${opts.showContact && tel ? `<a class="btn btn-primary btn-sm" href="tel:${tel}">${icon('message')}Contact</a>` : ''}
        </div>
      </div>
    </article>`;
}

export function skeletonCardsHTML(count = 6) {
  return Array.from({ length: count })
    .map(
      () => `
      <div class="item-card card-skeleton" aria-hidden="true">
        <div class="sk sk-media"></div>
        <div class="card-body">
          <div class="sk sk-line w-70"></div>
          <div class="sk sk-line"></div>
          <div class="sk sk-line w-90"></div>
          <div class="sk sk-line w-50"></div>
        </div>
      </div>`
    )
    .join('');
}

export function errorStateHTML(message, { retry = true } = {}) {
  return `
    <div class="error-banner" role="alert">
      <span class="error-icon">${icon('alert')}</span>
      <div class="error-text">
        <strong>Connection problem</strong>
        <p>${esc(message)}</p>
      </div>
      ${retry ? `<button type="button" class="btn btn-secondary btn-sm" data-retry>${icon('arrowRight')}Try again</button>` : ''}
    </div>`;
}

export function emptyStateHTML({ iconName = 'search', title, text, actionsHTML = '' }) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon(iconName)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${actionsHTML ? `<div class="empty-actions">${actionsHTML}</div>` : ''}
    </div>`;
}

export function renderNotFound(root, message = "We couldn't find the page or item you were looking for.") {
  root.innerHTML = `
    <div class="container page">
      <section class="not-found">
        <div class="empty-icon">${icon('alert')}</div>
        <h2>Nothing here</h2>
        <p>${esc(message)}</p>
        <div class="empty-actions">
          <a class="btn btn-primary" href="#/">Back to Home</a>
          <a class="btn btn-secondary" href="#/lost-items">Browse Listings</a>
        </div>
      </section>
    </div>`;
}

export { formatDate, parseDate };
