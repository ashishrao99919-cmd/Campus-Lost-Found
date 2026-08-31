import { CATEGORIES, categoryLabel, locationsFrom, DEMO_ITEMS, UNIVERSITIES } from '../data.js';
import { createReport } from '../store.js';
import { BASE_URL, api } from '../api.js';
import { icon, esc, toast, nav, confirmModal } from '../ui.js';

const COPY = {
  lost: {
    h1: 'Report a Lost Item',
    sub: 'Give the campus community enough information to help you find it.',
    dateLabel: 'Date Lost',
    locationLabel: 'Location Lost',
    button: 'Publish Lost Item',
    success: 'Lost item reported successfully.',
    back: '#/lost-items',
  },
  found: {
    h1: 'Report a Found Item',
    sub: "Describe what you found so its owner can recognize it. It's someone's favorite thing.",
    dateLabel: 'Date Found',
    locationLabel: 'Location Found',
    button: 'Publish Found Item',
    success: 'Found item reported successfully.',
    back: '#/found-items',
  },
};

export async function ReportPage(root, query) {
  const type = query.type === 'found' ? 'found' : 'lost';
  let copy = { ...COPY[type] };
  const isLost = type === 'lost';

  const editId = query.edit && /^\d+$/.test(String(query.edit)) ? String(query.edit) : null;
  let editItem = null;
  if (editId) {
    try {
      const res = await fetch(`${BASE_URL}/items/${encodeURIComponent(editId)}`).then((r) => r.json());
      if (res.success && res.item && res.item.is_owner) editItem = res.item;
    } catch {
      editItem = null;
    }
  }

  if (editItem) {
    copy = {
      ...copy,
      h1: 'Edit Listing',
      sub: 'Update the details of your report.',
      button: 'Save Changes',
      success: 'Listing updated successfully.',
      back: `#/item/${editItem.id}`,
    };
  }

  document.title = `${copy.h1} — Campus Lost & Found`;

  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const locations = locationsFrom(DEMO_ITEMS);

  root.innerHTML = `
  <div class="container page">
    <section class="page-head">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Home</a><span aria-hidden="true">/</span><a href="${copy.back}">${isLost ? 'Lost Items' : 'Found Items'}</a><span aria-hidden="true">/</span><span>${copy.h1}</span>
      </nav>
      <h1>${copy.h1}</h1>
      <p class="lead">${copy.sub}</p>
    </section>

    <div class="form-layout">
      ${
        localStorage.getItem('clf_user')
          ? ''
          : `<div class="callout" style="margin-bottom:1.25rem">
              <h3>${icon('info')}Login required</h3>
              <ul><li>${icon('check')}<span>You need to be logged in to publish a report — this is how ownership of the item is recorded so only you can mark it returned later.</span></li></ul>
            </div>`
      }
      <form class="form-card" id="reportForm" novalidate>
        <div class="callout" style="margin-bottom:1rem;">
          <h3>${icon('shield')}Listing rules</h3>
          <p>Please list only ordinary lost &amp; found personal belongings. Vehicles (except bicycles), living things, and weapons are not allowed.</p>
        </div>
        <div class="form-tabs">
          <a class="tab ${isLost ? 'active' : ''}" href="#/report?type=lost">${icon('edit')}Lost Item</a>
          <a class="tab ${!isLost ? 'active' : ''}" href="#/report?type=found">${icon('users')}Found Item</a>
        </div>

        <p class="form-section-title">Item details</p>
        <div class="form-grid">
          <div class="field span-2">
            <label for="f-university">University <span class="req">*</span></label>
            <span class="select"><select class="input" id="f-university">
              <option value="">Select your university…</option>
              ${UNIVERSITIES.map((u) => `<option value="${u.id}">${esc(u.label)}</option>`).join('')}
            </select></span>
            <p class="field-error">Please select your university.</p>
          </div>
          <div class="field span-2">
            <label for="f-name">Item Name <span class="req">*</span></label>
            <input class="input" id="f-name" type="text" maxlength="80" placeholder="e.g. Black leather wallet">
            <p class="field-error">Please enter the item name (at least 3 characters).</p>
          </div>
          <div class="field">
            <label for="f-category">Category <span class="req">*</span></label>
            <span class="select"><select class="input" id="f-category">
              <option value="">Select a category…</option>
              ${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}
            </select></span>
            <p class="field-error">Please choose a category.</p>
          </div>
          <div class="field">
            <label for="f-date">${copy.dateLabel} <span class="req">*</span></label>
            <input class="input" id="f-date" type="date" max="${todayISO}">
            <p class="field-error">Please pick a valid date (not in the future).</p>
          </div>
          <div class="field span-2">
            <label for="f-desc">Description <span class="req">*</span></label>
            <textarea class="input" id="f-desc" rows="4" maxlength="600"
              placeholder="Describe the color, brand, size, contents and anything distinctive…"></textarea>
            <p class="field-error">Description should be at least 20 characters long.</p>
          </div>
        </div>

        <p class="form-section-title">Where &amp; when</p>
        <div class="form-grid">
          <div class="field">
            <label for="f-location">${copy.locationLabel} <span class="req">*</span></label>
            <input class="input" id="f-location" list="locationList" placeholder="e.g. Central Library" maxlength="60">
            <datalist id="locationList">
              ${locations.map((l) => `<option value="${esc(l)}"></option>`).join('')}
            </datalist>
            <p class="field-error">Please enter the location.</p>
          </div>
          <div class="field">
            <label for="f-phone">Contact Number <span class="req">*</span></label>
            <input class="input" id="f-phone" type="tel" placeholder="+1 555 010 1234">
            <p class="field-error">Enter a valid phone number (at least 7 digits).</p>
          </div>
          <div class="field span-2">
            <label for="f-email">Email (optional)</label>
            <input class="input" id="f-email" type="email" placeholder="you@campus.edu">
            <p class="field-error">That email address doesn't look right.</p>
          </div>
        </div>

        <p class="form-section-title">Extra information</p>
        <div class="form-grid">
          <div class="field span-2">
            <label for="f-photo">Upload Photo (optional)</label>
            <label class="upload-zone" for="f-photo" id="uploadZone">
              ${icon('upload')}
              <strong>Click to upload a photo</strong>
              <span class="upload-hint">PNG or JPG · resized automatically for you</span>
              <input class="visually-hidden" id="f-photo" type="file" accept="image/*">
            </label>
            <div class="preview-box" id="previewBox" hidden>
              <img id="previewImg" alt="Selected photo preview">
              <button type="button" class="icon-btn preview-remove" id="removePhoto" aria-label="Remove photo">${icon('close')}</button>
            </div>
          </div>
        </div>

        <div class="form-actions">
          <p class="form-disclaimer">By publishing you agree that this information will be visible to other students on campus. Never share sensitive personal details. All demo data stays in your browser.</p>
          <button class="btn btn-primary btn-lg" type="submit" id="publishBtn">${copy.button}</button>
        </div>
      </form>

      <aside class="side-stack">
        <div class="side-card">
          <h3>${icon('sparkle')}Tips for a good report</h3>
          <ul class="tips-list">
            <li>${icon('check')}<span>Mention color, brand and size — the small things help owners recognize their items.</span></li>
            <li>${icon('check')}<span>List contents only you would know (a specific card, a sticker, an engraving).</span></li>
            <li>${icon('check')}<span>Use the exact building or room name where it was lost or found.</span></li>
            <li>${icon('check')}<span>A clear photo dramatically increases the chance of a reunion.</span></li>
          </ul>
        </div>
        <div class="side-card">
          <h3>${icon('shield')}Privacy first</h3>
          <p>This is a frontend demo: reports are stored in your browser's localStorage and never leave your device. Sample contact numbers are fictional.</p>
        </div>
      </aside>
    </div>
  </div>`;

  const form = root.querySelector('#reportForm');
  const fields = {
    university: root.querySelector('#f-university'),
    name: root.querySelector('#f-name'),
    category: root.querySelector('#f-category'),
    date: root.querySelector('#f-date'),
    desc: root.querySelector('#f-desc'),
    location: root.querySelector('#f-location'),
    phone: root.querySelector('#f-phone'),
    email: root.querySelector('#f-email'),
  };

  if (editItem) {
    fields.university.value = editItem.university || 'other';
    fields.name.value = editItem.item_name || '';
    fields.category.value = editItem.category || '';
    fields.date.value = editItem.date || '';
    fields.desc.value = editItem.description || '';
    fields.location.value = editItem.location || '';
    fields.phone.value = editItem.contact_number || '';
    fields.email.value = editItem.email || '';
  }

  let photoData = null;

  function setFieldError(input, hasError) {
    input.closest('.field').classList.toggle('has-error', hasError);
    input.classList.toggle('invalid', hasError);
  }

  Object.values(fields).forEach((input) => {
    if (!input) return;
    input.addEventListener('input', () => setFieldError(input, false));
    input.addEventListener('change', () => setFieldError(input, false));
  });

  async function handlePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please choose an image file.', 'error');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      toast('That image is too large. Please pick one under 6 MB.', 'error');
      return;
    }
    try {
      photoData = await compressImage(file);
    } catch {
      toast('Could not read that image. Try another file.', 'error');
      return;
    }
    root.querySelector('#previewImg').src = photoData;
    root.querySelector('#previewBox').hidden = false;
    toast('Photo selected successfully.');
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read-failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode-failed'));
        img.onload = () => {
          try {
            const maxSide = 1000;
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.82));
          } catch (err) {
            reject(err);
          }
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  const photoInput = root.querySelector('#f-photo');
  photoInput.addEventListener('change', () => handlePhoto(photoInput.files[0]));

  const zone = root.querySelector('#uploadZone');
  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, () => zone.classList.remove('dragover'))
  );
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) {
      photoInput.files = e.dataTransfer.files;
      handlePhoto(e.dataTransfer.files[0]);
    }
  });

  root.querySelector('#removePhoto').addEventListener('click', () => {
    photoData = null;
    photoInput.value = '';
    root.querySelector('#previewBox').hidden = true;
    toast('Photo removed.', 'info');
  });

  function validate() {
    let firstBad = null;
    const check = (input, ok) => {
      setFieldError(input, !ok);
      if (!ok && !firstBad) firstBad = input;
      return ok;
    };
    check(fields.university, Boolean(fields.university.value));
    check(fields.name, fields.name.value.trim().length >= 3);
    check(fields.category, Boolean(fields.category.value));
    const d = fields.date.value;
    check(fields.date, Boolean(d) && d <= todayISO);
    check(fields.desc, fields.desc.value.trim().length >= 20);
    check(fields.location, Boolean(fields.location.value.trim()));
    const digits = (fields.phone.value.match(/\d/g) || []).length;
    check(fields.phone, /^\+?[0-9 ()\-.]{7,18}$/.test(fields.phone.value.trim()) && digits >= 7);
    const email = fields.email.value.trim();
    check(fields.email, email === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email));

    if (firstBad) {
      firstBad.focus();
      toast('Please fill all required fields.', 'error');
      return false;
    }
    return true;
  }

  const runPublish = async (finalCategory) => {
    const btn = root.querySelector('#publishBtn');
    btn.disabled = true;
    btn.textContent = editItem ? 'Saving…' : 'Publishing…';

    const payload = {
      item_name: fields.name.value.trim(),
      category: finalCategory,
      type,
      university: fields.university.value,
      description: fields.desc.value.trim(),
      date: fields.date.value,
      location: fields.location.value.trim(),
      contact_number: fields.phone.value.trim(),
      email: fields.email.value.trim(),
    };

    try {
      if (editItem) {
        await api.updateItem(editItem.id, payload);
        if (photoData) {
          try {
            await api.uploadImage(editItem.id, photoData);
          } catch {
            /* listing is saved; image replacement failed non-fatally */
          }
        }
      } else {
        await createReport(payload, photoData);
      }
      toast(copy.success);
      const target = editItem ? `/item/${editItem.id}` : (isLost ? '/lost-items' : '/found-items');
      setTimeout(() => nav(target), 900);
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not save the report. Please try again.', 'error');
      btn.disabled = false;
      btn.textContent = copy.button;
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) return;

    let safety = null;
    try {
      safety = await api.checkListing({
        title: fields.name.value.trim(),
        description: fields.desc.value.trim(),
        category: fields.category.value,
      });
    } catch {
      safety = { allowed: true };
    }
    if (safety && safety.allowed === false) {
      toast(safety.reason || 'This listing cannot be submitted. Vehicles other than bicycles, living things, and weapons are not allowed.', 'error');
      return;
    }

    let check = null;
    try {
      check = await api.validateCategory({
        title: fields.name.value.trim(),
        description: fields.desc.value.trim(),
        category: fields.category.value,
      });
    } catch {
      check = null;
    }

    if (check && !check.valid && check.suggested_category && check.suggested_category !== 'other') {
      const suggestedLabel = categoryLabel(check.suggested_category);
      const selectedLabel = categoryLabel(fields.category.value);
      confirmModal({
        title: 'Category may not match',
        message: `${check.message} Continue with ${suggestedLabel}, or keep ${selectedLabel}.`,
        confirmLabel: `Use ${suggestedLabel}`,
        cancelLabel: `Keep ${selectedLabel}`,
        onConfirm: () => {
          fields.category.value = check.suggested_category;
          runPublish(check.suggested_category);
        },
        onCancel: () => runPublish(fields.category.value),
      });
      return;
    }

    runPublish(fields.category.value);
  });

  refreshLocationList(root);
}

async function refreshLocationList(root) {
  const datalist = root.querySelector('#locationList');
  if (!datalist) return;
  try {
    const data = await fetch(`${BASE_URL}/items`).then((r) => r.json());
    if (!data.success || !Array.isArray(data.items)) return;
    if (!root.isConnected || !datalist.isConnected) return;
    const seen = new Set();
    const options = [];
    data.items.forEach((row) => {
      const loc = String(row.location || '').trim();
      if (loc && !seen.has(loc.toLowerCase())) {
        seen.add(loc.toLowerCase());
        options.push(`<option value="${esc(loc)}"></option>`);
      }
    });
    if (options.length) datalist.innerHTML = options.join('');
  } catch {
    /* keep demo suggestions when backend is unavailable */
  }
}
