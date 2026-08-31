import { fetchItem, fetchItems, statusOf } from '../store.js';
import { api } from '../api.js';
import { categoryLabel, universityLabel } from '../data.js';
import {
  itemCard,
  itemImage,
  renderNotFound,
  statusBadge,
  errorStateHTML,
} from '../components.js';
import { icon, esc, toast, nav, confirmModal, formatDate, parseDate, timeAgo, initReveals } from '../ui.js';

const REPORT_REASONS = [
  ['fake', 'Fake or misleading listing'],
  ['wrong_category', 'Wrong category'],
  ['prohibited', 'Prohibited item'],
  ['duplicate', 'Duplicate listing'],
  ['inappropriate', 'Inappropriate content'],
  ['incorrect_info', 'Incorrect information'],
  ['other', 'Other'],
];

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('clf_user') || 'null');
  } catch {
    return null;
  }
}

function initialsOf(name) {
  return String(name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function skeletonHTML() {
  return `
  <div class="container page">
    <article class="detail-grid" aria-hidden="true">
      <div class="detail-media sk sk-media-detail"></div>
      <div class="detail-info">
        <div class="sk sk-line w-60"></div>
        <div class="sk sk-line"></div>
        <div class="sk sk-line w-80"></div>
        <div class="sk sk-line w-40"></div>
      </div>
    </article>
  </div>`;
}

export function DetailPage(root, query) {
  document.title = 'Loading… — Campus Lost & Found';
  root.innerHTML = skeletonHTML();
  initReveals(root);
  hydrate(root, query.id);
}

async function hydrate(root, id) {
  let item;
  try {
    item = await fetchItem(String(id), { allowFallback: true });
  } catch (err) {
    root.innerHTML = `
      <div class="container page">
        <a class="back-link" href="#/lost-items">${icon('arrowLeft')}Back to Listings</a>
        ${errorStateHTML(err.message)}
      </div>`;
    initReveals(root);
    return;
  }

  if (!root.isConnected) return;
  if (!item) {
    document.title = 'Item not found — Campus Lost & Found';
    renderNotFound(root, 'That item may have been removed or the link is incorrect.');
    return;
  }

  const rep = item.reporter || {};
  const tel = String(rep.phone || '').replace(/[^\d+]/g, '');
  const st = statusOf(item);
  const returned = st === 'returned';
  const backHref = item.type === 'found' ? '#/found-items' : '#/lost-items';

  document.title = `${item.name} — Campus Lost & Found`;

  const user = getCurrentUser();
  const isAdmin = user && user.role === 'admin';
  const isUnderReview = item.pendingReportCount >= 3;

  root.innerHTML = `
  <div class="container page">
    <a class="back-link" href="${backHref}">${icon('arrowLeft')}Back to Listings</a>

    <article class="detail-grid">
      <div class="detail-media">
        <img src="${itemImage(item)}" alt="${esc(item.name)}">
        ${statusBadge(st)}
      </div>
      <div class="detail-info">
        <h1>${esc(item.name)}</h1>
        ${
          returned
            ? `<div class="returned-note">${icon('check')}<span>This item has been successfully returned to its owner.</span></div>`
            : ''
        }
        ${
          isUnderReview && (isAdmin || item.isOwner)
            ? `<div class="under-review-note">${icon('alert')}<span>This listing is under review (${item.pendingReportCount} pending report${item.pendingReportCount === 1 ? '' : 's'}).</span></div>`
            : ''
        }
        ${
          isAdmin && item.reportCount > 0
            ? `<div class="admin-report-badge">${icon('alert')}<span>${item.reportCount} report${item.reportCount === 1 ? '' : 's'}${item.pendingReportCount > 0 ? ` (${item.pendingReportCount} pending)` : ''}</span></div>`
            : ''
        }
        <div class="meta-grid">
          <div class="meta-item"><span class="meta-icon">${icon('tag')}</span><div><div class="meta-label">Category</div><div class="meta-value">${esc(categoryLabel(item.category))}</div></div></div>
          <div class="meta-item"><span class="meta-icon">${icon('pin')}</span><div><div class="meta-label">Location</div><div class="meta-value">${esc(item.location)}</div></div></div>
          <div class="meta-item"><span class="meta-icon">${icon('calendar')}</span><div><div class="meta-label">Date</div><div class="meta-value">${formatDate(parseDate(item.date))}</div></div></div>
          <div class="meta-item"><span class="meta-icon">${icon('info')}</span><div><div class="meta-label">Reported</div><div class="meta-value">${timeAgo(item.date)}</div></div></div>
          ${item.university && item.university !== 'other' ? `<div class="meta-item"><span class="meta-icon">${icon('school')}</span><div><div class="meta-label">University</div><div class="meta-value">${esc(universityLabel(item.university))}</div></div></div>` : ''}
        </div>
        <p class="detail-desc">${esc(item.description)}</p>
        ${
          Array.isArray(item.details) && item.details.length
            ? `<div class="callout">
                <h3>${icon('shield')}Identifying details</h3>
                <ul>${item.details.map((d) => `<li>${icon('check')}<span>${esc(d)}</span></li>`).join('')}</ul>
              </div>`
            : ''
        }
        <div class="reporter-card">
          <div class="reporter-head">
            <span class="avatar" aria-hidden="true">${esc(initialsOf(rep.name))}</span>
            <div>
              <div class="reporter-name">${esc(rep.name || 'Campus Member')}</div>
              <div class="reporter-role">Listed by · Campus community member</div>
            </div>
          </div>
          <div class="contact-rows">
            ${rep.phone ? `<div class="contact-row">${icon('phone')}<span>${esc(rep.phone)}</span></div>` : ''}
            ${rep.email ? `<div class="contact-row">${icon('mail')}<span>${esc(rep.email)}</span></div>` : ''}
          </div>
        </div>
        <div class="detail-actions">
          ${
            returned
              ? `<button type="button" class="btn btn-primary btn-lg" disabled title="This item has been returned">Contact Reporter</button>`
              : tel
                ? `<a class="btn btn-primary btn-lg" href="tel:${tel}">${icon('message')}Contact Reporter</a>`
                : ''
          }
          ${
            !item.isOwner && !returned && item._source !== 'demo' && item.type === 'found'
              ? `<button type="button" class="btn btn-success btn-lg" data-claim-item="${esc(item.id)}">${icon('eye')}Claim This Item</button>`
              : ''
          }
          ${
            returned || !(item._source === 'demo' || item.isOwner)
              ? ''
              : `<button type="button" class="btn btn-success btn-lg" data-return-id="${esc(item.id)}">${icon('check')}Mark as Returned</button>`
          }
          ${
            item.isOwner && item._source !== 'demo'
              ? `<a class="btn btn-secondary btn-lg" href="#/report?type=${esc(item.type)}&edit=${encodeURIComponent(item.id)}">${icon('edit')}Edit Listing</a>
                 <button type="button" class="btn btn-secondary btn-lg" data-delete-id="${esc(item.id)}">${icon('trash')}Delete Listing</button>`
              : ''
          }
          <a class="btn btn-ghost btn-lg" href="${backHref}">Back to Listings</a>
          ${
            !item.isOwner && !returned && item._source !== 'demo'
              ? `<button type="button" class="btn btn-secondary btn-lg" data-report-listing="${esc(item.id)}">${icon('alert')}Report Listing</button>`
              : ''
          }
        </div>
        ${
          item.isOwner && item.pendingClaimCount > 0
            ? `<div class="claim-count-note">${icon('eye')}<span>${item.pendingClaimCount} pending claim${item.pendingClaimCount === 1 ? '' : 's'} — <a href="#/my-listings">Review in My Listings</a></span></div>`
            : ''
        }
        <p class="detail-note">${icon('info')} Contact details shown here are provided by the reporter of this item.</p>
      </div>
    </article>

    <section class="related-section" id="relatedSection" hidden>
      <div class="section-head"><h2>Similar listings</h2><p class="section-sub" id="relatedSub"></p></div>
      <div class="grid-cards" id="relatedGrid"></div>
    </section>

    <section class="possible-matches-section" id="matchSection" hidden>
      <h2>${icon('sparkle')}Possible Matches</h2>
      <div id="matchGrid"></div>
    </section>
  </div>`;

  initReveals(root);
  loadRelated(root, item);
  loadMatches(root, item);

  const delBtn = root.querySelector('[data-delete-id]');
  if (delBtn) {
    delBtn.addEventListener('click', () => {
      confirmModal({
        title: 'Delete this listing?',
        message: 'This action cannot be undone.',
        confirmLabel: 'Delete Listing',
        cancelLabel: 'Cancel',
        onConfirm: async () => {
          try {
            await api.deleteItem(item.id);
            toast('Listing deleted successfully.', 'success');
            setTimeout(() => nav(item.type === 'found' ? '/found-items' : '/lost-items'), 600);
          } catch (err) {
            toast(err && err.message ? err.message : 'Could not delete the listing. Please try again.', 'error');
          }
        },
      });
    });
  }

  const reportBtn = root.querySelector('[data-report-listing]');
  if (reportBtn) {
    reportBtn.addEventListener('click', () => {
      if (!getCurrentUser()) {
        toast('Please log in to report a listing.', 'info');
        return;
      }
      openReportModal(item);
    });
  }

  const claimBtn = root.querySelector('[data-claim-item]');
  if (claimBtn) {
    claimBtn.addEventListener('click', () => {
      if (!getCurrentUser()) {
        toast('Please log in to claim this item.', 'info');
        return;
      }
      openClaimModal(item);
    });
  }
}

function openReportModal(item) {
  const existing = document.querySelector('.report-modal-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop report-modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card report-modal" role="dialog" aria-modal="true" aria-labelledby="reportModalTitle">
      <h3 id="reportModalTitle">${icon('alert')}Report Listing</h3>
      <p class="report-modal-sub">Why are you reporting "${esc(item.name)}"?</p>
      <div class="report-reasons">
        ${REPORT_REASONS.map(([value, label]) =>
          `<label class="report-reason-option">
            <input type="radio" name="reportReason" value="${value}">
            <span>${esc(label)}</span>
          </label>`
        ).join('')}
      </div>
      <div class="report-details-wrap">
        <label for="reportDetails">Additional details (optional)</label>
        <textarea id="reportDetails" class="input" rows="2" maxlength="500" placeholder="Provide any extra context..."></textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-report-cancel>Cancel</button>
        <button type="button" class="btn btn-danger" data-report-submit disabled>Submit Report</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  const radios = backdrop.querySelectorAll('input[name="reportReason"]');
  const submitBtn = backdrop.querySelector('[data-report-submit]');
  radios.forEach((r) => r.addEventListener('change', () => { submitBtn.disabled = false; }));

  let deciding = false;
  function finish(callback) {
    if (deciding) return;
    deciding = true;
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 200);
    if (typeof callback === 'function') callback();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-report-cancel]')) finish(null);
  });

  submitBtn.addEventListener('click', async () => {
    const selected = backdrop.querySelector('input[name="reportReason"]:checked');
    if (!selected) return;
    const details = backdrop.querySelector('#reportDetails').value.trim();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      await api.createItemReport(item.id, selected.value, details);
      finish(() => toast('Report submitted. Thank you for helping keep the community safe.', 'success'));
    } catch (err) {
      finish(() => toast(err.message || 'Could not submit report. Please try again.', 'error'));
    }
  });
}

function openClaimModal(item) {
  const existing = document.querySelector('.claim-modal-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop claim-modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card claim-modal" role="dialog" aria-modal="true" aria-labelledby="claimModalTitle">
      <h3 id="claimModalTitle">${icon('eye')}Claim This Item</h3>
      <p class="claim-modal-sub">You are claiming "${esc(item.name)}". Please provide details that only the real owner would know to help verify your ownership.</p>
      <div class="claim-proof-wrap">
        <label for="claimProof">Proof of ownership</label>
        <textarea id="claimProof" class="input" rows="4" maxlength="1000" placeholder="Describe unique identifying details: serial numbers, scratches, stickers, where you last had it, contents, etc."></textarea>
        <p class="claim-proof-hint">The item owner will review your claim privately. Your information is not shared publicly.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-claim-cancel>Cancel</button>
        <button type="button" class="btn btn-success" data-claim-submit disabled>Submit Claim</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  const proofInput = backdrop.querySelector('#claimProof');
  const submitBtn = backdrop.querySelector('[data-claim-submit]');
  proofInput.addEventListener('input', () => {
    submitBtn.disabled = proofInput.value.trim().length < 10;
  });

  let deciding = false;
  function finish(callback) {
    if (deciding) return;
    deciding = true;
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 200);
    if (typeof callback === 'function') callback();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-claim-cancel]')) finish(null);
  });

  submitBtn.addEventListener('click', async () => {
    const proof = proofInput.value.trim();
    if (proof.length < 10) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    try {
      await api.createClaim(item.id, proof);
      finish(() => toast('Claim submitted successfully. The item owner will review your request.', 'success'));
    } catch (err) {
      finish(() => toast(err.message || 'Could not submit claim. Please try again.', 'error'));
    }
  });
}

async function loadRelated(root, item) {
  try {
    const { items } = await fetchItems({}, { allowFallback: true });
    if (!root.isConnected) return;
    const related = items.filter((i) => i.id !== item.id && i.category === item.category).slice(0, 3);
    if (!related.length) return;
    const section = root.querySelector('#relatedSection');
    section.hidden = false;
    root.querySelector('#relatedSub').textContent =
      `More ${categoryLabel(item.category).toLowerCase()} reports on campus.`;
    root.querySelector('#relatedGrid').innerHTML = related.map((r) => itemCard(r)).join('');
    initReveals(section);
  } catch {
    /* related items are optional — silently skip */
  }
}

async function loadMatches(root, item) {
  if (!item.isOwner || item._source === 'demo') return;
  try {
    const data = await api.getItemMatches(item.id);
    const matches = data.matches || [];
    if (!matches.length || !root.isConnected) return;
    const section = root.querySelector('#matchSection');
    if (!section) return;
    section.hidden = false;
    const grid = root.querySelector('#matchGrid');
    grid.innerHTML = matches.map((m) => {
      const confClass = m.confidence === 'high' ? 'match-conf-high' : m.confidence === 'medium' ? 'match-conf-medium' : 'match-conf-low';
      const confLabel = m.confidence.charAt(0).toUpperCase() + m.confidence.slice(1);
      const uni = m.university && m.university !== 'other' ? universityLabel(m.university) : '';
      return `<div class="match-card" data-match-id="${m.id}">
        <span class="notif-conf ${confClass}">${confLabel} Match</span>
        <div class="match-card-info">
          <h4><a href="#/item/${encodeURIComponent(m.listingId)}">${esc(m.title)}</a></h4>
          <div class="match-card-meta">
            ${uni ? `<span>${icon('school')}${esc(uni)}</span>` : ''}
            <span>${icon('pin')}${esc(m.location)}</span>
          </div>
        </div>
        <div class="match-card-actions">
          <a class="btn btn-secondary btn-sm" href="#/item/${encodeURIComponent(m.listingId)}">${icon('eye')}View</a>
          <button type="button" class="match-dismiss-btn" data-dismiss-match="${m.id}">Not a Match</button>
        </div>
      </div>`;
    }).join('');
    grid.querySelectorAll('[data-dismiss-match]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const matchId = btn.dataset.dismissMatch;
        try {
          await api.dismissMatch(matchId);
          const card = btn.closest('.match-card');
          if (card) card.remove();
          const remaining = grid.querySelectorAll('.match-card');
          if (!remaining.length) section.hidden = true;
          toast('Match dismissed.', 'success');
        } catch (err) {
          toast(err.message || 'Could not dismiss match.', 'error');
        }
      });
    });
  } catch {
    /* matches are optional — silently skip */
  }
}
