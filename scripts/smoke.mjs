import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { execSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'index.html'), 'utf8').replace(
  /<script type="module"[^>]*><\/script>/,
  ''
);
const API = 'http://127.0.0.1:5000/api';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 9000, step = 90) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch {}
    if (ok) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}

async function bootApp(seed = {}) {
  const jsErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => jsErrors.push(String(e.detail?.stack || e.stack || e)));
  vc.on('error', (...a) => jsErrors.push(a.map(String).join(' ')));
  vc.on('warn', () => {});

  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.document.documentElement.dataset.theme = 'light';
  w.__API_BASE__ = API;
  globalThis.__API_BASE__ = API;
  for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v);

  class FakeIO {
    constructor(cb) { this.cb = cb; this.observed = new Set(); }
    observe(el) {
      this.observed.add(el);
      setTimeout(() => { if (this.observed.has(el)) this.cb([{ isIntersecting: true, target: el }], this); }, 10);
    }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
  }
  class FakeMatch {
    constructor() { this.matches = true; this.media = '(prefers-reduced-motion: reduce)'; }
    addEventListener() {} removeEventListener() {} addListener() {} removeListener() {}
  }
  w.IntersectionObserver = FakeIO;
  w.matchMedia = () => new FakeMatch();
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};

  for (const [k, v] of Object.entries({
    window: w,
    document: w.document,
    location: w.location,
    localStorage: w.localStorage,
    IntersectionObserver: FakeIO,
    matchMedia: w.matchMedia,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    CustomEvent: w.CustomEvent,
    Event: w.Event,
    requestAnimationFrame: w.requestAnimationFrame || ((cb) => setTimeout(() => cb(Date.now()), 16)),
    cancelAnimationFrame: w.cancelAnimationFrame || ((id) => clearTimeout(id)),
  })) {
    try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch {}
  }

  const vite = await createServer({
    root,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  await vite.ssrLoadModule('/src/main.js');
  await sleep(60);

  const app = w.document.getElementById('app');
  return {
    w,
    app,
    jsErrors,
    text: () => app.textContent || '',
    go: async (hash) => {
      w.location.hash = hash;
      w.dispatchEvent(new w.Event('hashchange'));
      await sleep(40);
    },
    close: async () => {
      await vite.close();
      w.close();
      delete globalThis.__API_BASE__;
    },
  };
}

const jar = new Map();
const rawFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (jar.size) {
    init.headers = { ...(init.headers || {}), Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
  }
  const res = await rawFetch(url, init);
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value || c.includes('Expires=Thu, 01 Jan 1970') || c.toLowerCase().includes('max-age=0')) jar.delete(name);
    else jar.set(name, value);
  }
  return res;
};

const SMOKE_USER = { name: 'Smoke Owner', email: 'smoke.owner@clf.test', password: 'smokepass123' };
let smokeUserReady = false;

async function ensureSmokeUser() {
  if (smokeUserReady) return;
  let res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SMOKE_USER),
  });
  let data = await res.json();
  if (!data.success && res.status === 409) {
    res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SMOKE_USER.email, password: SMOKE_USER.password }),
    });
    data = await res.json();
  }
  if (!data.success) throw new Error(`smoke user setup failed: ${JSON.stringify(data)}`);
  smokeUserReady = true;
}

async function apiPost(payload) {
  await ensureSmokeUser();
  const res = await fetch(`${API}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`seed failed: ${JSON.stringify(data)}`);
  return data.item;
}

console.log('--- Phase A: empty database shows zero stats, no demo fallback ---');
{
  const ctx = await bootApp();
  const { app, w, text, go, jsErrors } = ctx;

  check('home renders hero instantly', text().includes('Lost something on campus?'));
  check('stats band renders', !!app.querySelector('.stats-band'));

  const statsLoaded = await until(() => {
    const vals = [...app.querySelectorAll('.stat-value')].map((el) => el.dataset.count).join('|');
    return vals === '0|0|0|0';
  });
  check('home shows zero stats when DB empty', statsLoaded);
  check('Recently Reported is empty when DB empty', await until(() => app.querySelectorAll('#recentGrid .item-card').length === 0));

  await go('#/lost-items');
  check('lost listing shows empty state on empty DB',
    await until(() => !!app.querySelector('.empty-state') || app.querySelectorAll('.grid-cards .item-card').length === 0));

  const qInput = app.querySelector('#f-q');
  qInput.value = 'wallet';
  qInput.dispatchEvent(new w.Event('input'));
  const emptyShown = await until(() => !!app.querySelector('.empty-state'));
  check('server-backed search on empty DB shows clean empty state', emptyShown);
  qInput.value = '';
  qInput.dispatchEvent(new w.Event('input'));

  await go('#/item/itm-101');
  check('detail resolves demo deep-link through fallback',
    await until(() => text().includes('Black Leather Wallet') && !!app.querySelector('[data-return-id="itm-101"]')));

  app.querySelector('[data-return-id="itm-101"]').click();
  await sleep(80);
  const modalOk = await until(() => !!w.document.querySelector('.modal-backdrop.show .modal-card'));
  check('confirmation modal appears', modalOk && w.document.body.textContent.includes('Mark this item as returned?'));
  w.document.querySelector('[data-modal-confirm]').click();
  check('returned badge + note applied after confirm',
    await until(() => !!app.querySelector('.detail-media .badge--returned') && !!app.querySelector('.returned-note')));
  check('mark button gone + contact disabled',
    !app.querySelector('[data-return-id]') && !!app.querySelector('.detail-actions .btn[disabled]'));

  await go('#/');
  const statsAfterReturned = await until(() => {
    const vals = [...app.querySelectorAll('.stat-value')].map((el) => el.dataset.count).join('|');
    return vals === '0|0|0|0';
  });
  check('stats remain zero after demo item returned (no demo in stats)',
    statsAfterReturned);

  check('phase A zero console errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('--- Phase B: refresh persistence of demo overlay ---');
{
  const ctx = await bootApp({ clf_returned_items: JSON.stringify(['itm-101']) });
  const { app, text, go, jsErrors } = ctx;

  await go('#/item/itm-101');
  check('after refresh: still RETURNED',
    await until(() => !!app.querySelector('.detail-media .badge--returned')));
  check('after refresh: note + disabled contact',
    !!app.querySelector('.returned-note') && !!app.querySelector('.detail-actions .btn[disabled]'));
  await go('/');
  const statsZero = await until(() => {
    const vals = [...app.querySelectorAll('.stat-value')].map((el) => el.dataset.count).join('|');
    return vals === '0|0|0|0';
  });
  check('homepage stats remain zero (demo items excluded from stats)', statsZero);
  check('phase B zero console errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  await ctx.close();
}

let createdIds = [];
console.log('--- Phase C: SQLite-backed data end to end ---');
{
  try {
    const lostWallet = await apiPost({
      item_name: 'Brown Suede Wallet', category: 'wallets', type: 'lost',
      description: 'Light brown suede bifold wallet lost near the coffee kiosk during lunch break.',
      date: '2026-08-24', location: 'Main Cafeteria', contact_number: '+1 (555) 010-7788',
      email: '', additional_details: 'Gifted stitching pattern\nContains student ID', university: 'mdu',
    });
    const foundBag = await apiPost({
      item_name: 'Blue Laptop Bag', category: 'bags', type: 'found',
      description: 'Navy padded laptop bag found near the printer station in the computer lab.',
      date: '2026-08-24', location: 'Computer Lab Block C', contact_number: '+1 (555) 010-3344',
      email: '', additional_details: '', university: 'du',
    });
    createdIds = [lostWallet.id, foundBag.id];

    const ctx = await bootApp();
    const { app, w, text, go, jsErrors } = ctx;

    await go('#/');
    check('backend reports appear in Recently Reported',
      await until(() => text().includes('Brown Suede Wallet') && text().includes('Blue Laptop Bag')));
    check('stats switch to real API numbers (2/1/0/2)',
      await until(() => {
        const vals = [...app.querySelectorAll('.stat-value')].map((el) => el.dataset.count).join('|');
        return vals === '2|1|0|2';
      }, 9000));

    await go('#/lost-items');
    check('lost listing shows ONLY the backend item',
      await until(() => {
        const names = [...app.querySelectorAll('.grid-cards .item-card h3')].map((h) => h.textContent.trim());
        return names.length === 1 && names[0].includes('Brown Suede Wallet');
      }));

    await go('#/found-items');
    check('found listing shows the seeded found report',
      await until(() => {
        const names = [...app.querySelectorAll('.grid-cards .item-card h3')].map((h) => h.textContent.trim());
        return names.length === 1 && names[0].includes('Blue Laptop Bag');
      }));

    await go(`/item/${createdIds[0]}`);
    check('detail page renders SQLite item with contact info',
      await until(() => text().includes('Brown Suede Wallet') && text().includes('+1 (555) 010-7788')));
    check('identifying details parsed from additional_details',
      text().includes('Contains student ID'));

    app.querySelector('[data-return-id]').click();
    await sleep(80);
    await until(() => !!w.document.querySelector('.modal-backdrop.show .modal-card'));
    w.document.querySelector('[data-modal-confirm]').click();
    check('mark as Returned persists via PUT /api/items/<id>/returned',
      await until(() => !!app.querySelector('.detail-media .badge--returned')));

    const dbItem = await fetch(`${API}/items/${createdIds[0]}`).then((r) => r.json());
    check('SQLite status updated to returned', dbItem.item?.status === 'returned', JSON.stringify(dbItem.item?.status));

    await go('#/');
    check('reunited stat becomes 1 from API data',
      await until(() => {
        const vals = [...app.querySelectorAll('.stat-value')].map((el) => el.dataset.count).join('|');
        return vals === '2|1|1|1';
      }));

    check('phase C zero console errors', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
    await ctx.close();

    console.log('--- Phase D: refresh persistence against SQLite ---');
    const ctx2 = await bootApp();
    await ctx2.go(`/item/${createdIds[0]}`);
    check('fresh browser session: item STILL RETURNED from DB',
      await until(() => !!ctx2.app.querySelector('.detail-media .badge--returned')));
    check('phase D zero console errors', ctx2.jsErrors.length === 0);
    await ctx2.close();
  } finally {
    for (const id of createdIds) {
      await fetch(`${API}/items/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    const finalList = await fetch(`${API}/items`).then((r) => r.json());
    console.log(`(cleanup: ${finalList.count} item(s) left in DB)`);
  }
}

console.log('--- Phase E: logout navigation ---');
{
  const me = async () => {
    smokeUserReady = false;
    await ensureSmokeUser();
    return fetch(`${API}/auth/me`).then((r) => r.json());
  };

  for (const startHash of ['#/items?q=wallet', '#/report?type=found', '#/lost-items', '#/found-items']) {
    const currentUser = (await me()).user;
    const ctx = await bootApp({
      clf_user: JSON.stringify(currentUser),
    });
    const { app, w, text, go, jsErrors } = ctx;

    check(`[${startHash}] boots logged-in (navbar shows user)`,
      await until(() => !!app && !!w.document.querySelector('#authNav .user-name')));

    await go(startHash);
    check(`[${startHash}] starts on non-home route`, w.location.hash === startHash, w.location.hash);

    w.document.querySelector('#logoutBtn').click();

    check(`[${startHash}] logout lands on #/ Home`,
      await until(() => w.location.hash === '#/' && text().includes('Lost something on campus?')));
    check(`[${startHash}] navbar shows Login/Sign Up`,
      !!w.document.querySelector('#authNav .login-btn') && !!w.document.querySelector('#authNav .signup-btn') &&
      !w.document.querySelector('#authNav .user-name') && !w.document.querySelector('#logoutBtn'));

    await go(startHash);
    check(`[${startHash}] back-navigation keeps logged-out navbar`,
      !w.document.querySelector('#authNav .user-name') && !!w.document.querySelector('#authNav .login-btn'));
    check(`[${startHash}] phase E zero console errors`, jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

    await ctx.close();
    jar.clear();
  }

  console.log('--- Phase E: logout from item detail page ---');
  await me();
  const seeded = await apiPost({
    item_name: 'Logout Nav Probe', category: 'other', type: 'lost',
    description: 'Temporary probe used to verify logout from the detail page returns home.',
    date: '2026-08-25', location: 'Test Spot', contact_number: '+1 (555) 010-0000',
    email: '', additional_details: '', university: 'other',
  });
  try {
    const me2 = await fetch(`${API}/auth/me`).then((r) => r.json());
    const ctx = await bootApp({ clf_user: JSON.stringify(me2.user) });
    const { app, w, text, go, jsErrors } = ctx;

    await go(`/item/${seeded.id}`);
    check('[detail] shows owner Mark as Returned button',
      await until(() => !!app.querySelector('[data-return-id]')));
    w.document.querySelector('#logoutBtn').click();
    check('[detail] logout lands on Home',
      await until(() => w.location.hash === '#/' && text().includes('Lost something on campus?')));
    check('[detail] owner button gone after logout re-render',
      !app.querySelector('[data-return-id]'));
    check('[detail] zero console errors', jsErrors.length === 0);
    await ctx.close();
  } finally {
    await fetch(`${API}/items/${seeded.id}`, { method: 'DELETE' }).catch(() => {});
    jar.clear();
  }
}

console.log('--- Phase F: login navigation ---');
{
  smokeUserReady = false;
  await ensureSmokeUser();

  for (const startHash of ['#/lost-items', '#/found-items', '#/items?q=wallet', '#/item/itm-101', '#/report?type=found', '#/']) {
    jar.clear();
    const ctx = await bootApp();
    const { app, w, text, go, jsErrors } = ctx;

    check(`[${startHash}] boots logged-out`,
      await until(() => !!app && !!w.document.querySelector('#authNav .login-btn')));

    await go(startHash);
    check(`[${startHash}] starts on target route`, w.location.hash === startHash, w.location.hash);

    w.document.getElementById('loginNavBtn').click();
    await until(() => !!w.document.getElementById('authModal') && !!w.document.getElementById('authEmail'));
    w.document.getElementById('authEmail').value = SMOKE_USER.email;
    w.document.getElementById('authPassword').value = SMOKE_USER.password;
    w.document.getElementById('authForm').dispatchEvent(
      new w.Event('submit', { bubbles: true, cancelable: true })
    );

    check(`[${startHash}] login lands on #/ Home`,
      await until(() => w.location.hash === '#/' && !w.document.getElementById('authModal') && text().includes('Lost something on campus?')));
    check(`[${startHash}] navbar shows logged-in user`,
      !!w.document.querySelector('#authNav .user-name') && !w.document.querySelector('#authNav .login-btn'));
    check(`[${startHash}] zero console errors`, jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

    await ctx.close();
    jar.clear();
  }
}

console.log('--- Phase G: smart category validation ---');
{
  const cases = [
    { title: 'Black leather wallet', description: 'Black wallet with a college ID card', category: 'keys', expectValid: false, expectSuggestion: 'wallets' },
    { title: 'Black leather wallet', description: 'Black wallet with a college ID card', category: 'wallets', expectValid: true },
    { title: 'Black backpack', description: 'Grey backpack with padded straps lost near the gym', category: 'bags', expectValid: true },
    { title: 'House keys', description: 'Two brass keys on a plain ring', category: 'keys', expectValid: true },
    { title: 'iPhone 15', description: 'Black phone with a cracked screen protector', category: 'keys', expectValid: false, expectSuggestion: 'electronics' },
    { title: 'Blue thing', description: 'Found near the library stairs, hard to describe', category: 'other', expectValid: true },
  ];
  for (const c of cases) {
    const res = await fetch(`${API}/categories/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    }).then((r) => r.json());
    const ok =
      res.success &&
      res.valid === c.expectValid &&
      (!c.expectSuggestion || res.suggested_category === c.expectSuggestion) &&
      typeof res.confidence === 'number' &&
      res.confidence >= 0 && res.confidence <= 1;
    check(`rules [${c.title} / ${c.category}] -> ${c.expectValid ? 'valid' : `warn ${c.expectSuggestion}`}`,
      ok, JSON.stringify(res));
  }

  smokeUserReady = false;
  await ensureSmokeUser();
  const meUser = await fetch(`${API}/auth/me`).then((r) => r.json());

  const fillAndSubmit = async (ctx, name, desc, category, university = 'other') => {
    const { w } = ctx;
    w.document.getElementById('f-name').value = name;
    w.document.getElementById('f-desc').value = desc;
    w.document.getElementById('f-date').value = '2026-08-25';
    w.document.getElementById('f-location').value = 'Test Bench';
    w.document.getElementById('f-phone').value = '+1 (555) 010-4321';
    w.document.getElementById('f-category').value = category;
    w.document.getElementById('f-university').value = university;
    w.document.getElementById('reportForm').dispatchEvent(
      new w.Event('submit', { bubbles: true, cancelable: true })
    );
  };

  const ctxW = await bootApp({ clf_user: JSON.stringify(meUser.user) });
  try {
    await ctxW.go('#/report?type=lost');
    check('[ui] report page renders for owner',
      await until(() => !!ctxW.app.querySelector('#reportForm')));

    await fillAndSubmit(ctxW, 'Black leather wallet', 'Bifold leather wallet found with a college ID card inside', 'keys');
    const modalAppeared = await until(() => {
      const m = ctxW.w.document.querySelector('.modal-backdrop.show .modal-card');
      return !!m && m.textContent.includes('Did you mean') && m.textContent.includes('Wallets');
    });
    if (!modalAppeared) {
      const state = await fetch(`${API}/items?search=Smoke%20Category%20Probe`).then((r) => r.json());
      const modalHtml = ctxW.w.document.querySelector('.modal-backdrop')?.outerHTML || '(none)';
      check('[ui] mismatch triggers suggestion modal', false,
        JSON.stringify({ jsErrors: ctxW.jsErrors.slice(0, 3), directCreate: (state.items || []).map((i) => [i.item_name, i.category]), modalHtml: modalHtml.slice(0, 200) }));
    } else {
      check('[ui] mismatch triggers suggestion modal', true);

      ctxW.w.document.querySelector('.modal-backdrop.show [data-modal-confirm]').click();
      let probeId = null;
      check('[ui] confirming suggestion switches select to wallets',
        await until(() => ctxW.w.document.getElementById('f-category').value === 'wallets'));
      check('[ui] item created after confirmation',
        await until(async () => {
          const data = await fetch(`${API}/items?search=${encodeURIComponent('Black leather wallet')}`).then((r) => r.json());
          const hit = (data.items || []).find((i) => i.category === 'wallets');
          if (hit) probeId = hit.id;
          return !!hit;
        }));
      check('[ui] zero console errors (mismatch path)', ctxW.jsErrors.length === 0, ctxW.jsErrors.slice(0, 2).join(' | '));

      if (probeId) await fetch(`${API}/items/${probeId}`, { method: 'DELETE' }).catch(() => {});
    }

    const ctxR = await bootApp({ clf_user: JSON.stringify(meUser.user) });
    try {
      await ctxR.go('#/report?type=found');
      await until(() => !!ctxR.app.querySelector('#f-name'));
      await fillAndSubmit(ctxR, 'Smoke Direct Probe', 'Grey backpack with padded shoulder straps', 'bags');
      check('[ui] matching category publishes without modal',
        await until(async () => {
          if (ctxR.w.document.querySelector('.modal-backdrop')) return false;
          const data = await fetch(`${API}/items?search=Smoke Direct Probe`).then((r) => r.json());
          return (data.items || []).some((i) => i.category === 'bags');
        }));
      check('[ui] zero console errors (match path)', ctxR.jsErrors.length === 0);
    } finally {
      const data = await fetch(`${API}/items?search=Smoke Direct Probe`).then((r) => r.json());
      for (const i of data.items || []) {
        if (i.item_name === 'Smoke Direct Probe') await fetch(`${API}/items/${i.id}`, { method: 'DELETE' });
      }
    }
  } finally {
    await ctxW.close();
    jar.clear();
  }
}

console.log('--- Phase H: owner-only edit/delete ---');
{
  const UB = { name: 'Second User', email: `ub.${Date.now()}@test.edu`, password: 'secondpass1' };
  const loginAs = async (email, password) => {
    jar.clear();
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return res.status;
  };
  const asOwner = async () => {
    smokeUserReady = false;
    await ensureSmokeUser();
    return fetch(`${API}/auth/me`).then((r) => r.json());
  };
  const rawStatus = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const getErr = (path) =>
    fetch(`${API}${path}`).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => null) }));

  const ownerMe = await asOwner();
  const ownerId = ownerMe.user.id;

  const p1 = await apiPost({
    item_name: 'Probe Alpha', category: 'wallets', type: 'lost',
    description: 'Brown leather wallet with a zip pocket lost near the library entrance.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-7000',
    email: '', additional_details: '', university: 'mdu',
  });
  const p2 = await apiPost({
    item_name: 'Probe Beta', category: 'bags', type: 'lost',
    description: 'Blue backpack with padded straps left in the cafeteria.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-7001',
    email: '', additional_details: '', university: 'du',
  });
  const p3 = await apiPost({
    item_name: 'Probe Gamma', category: 'books', type: 'found',
    description: 'Physics textbook with highlighted chapters found in lab hallway.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-7002',
    email: '', additional_details: '', university: 'kuk',
  });

  jar.clear();
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(UB),
  });

  await asOwner();
  const upd = await rawStatus('PUT', `/items/${p1.id}`, {
    item_name: 'Probe Edited Alpha', category: 'bags',
    description: 'Grey backpack with padded shoulder straps lost near the gym.',
  });
  check('A: owner edit -> 200 + data changes',
    upd.status === 200 && upd.body?.item?.item_name === 'Probe Edited Alpha' && upd.body?.item?.category === 'bags',
    JSON.stringify({ s: upd.status }));

  await loginAs(UB.email, UB.password);
  const bRes = await rawStatus('PUT', `/items/${p1.id}`, { item_name: 'HACKED' });
  const bGet = await getErr(`/items/${p1.id}`);
  check('B: other user edit -> 403 + unchanged',
    bRes.status === 403 && bGet.data?.item?.item_name === 'Probe Edited Alpha',
    JSON.stringify({ s: bRes.status, name: bGet.data?.item?.item_name }));

  jar.clear();
  const cRes = await rawStatus('PUT', `/items/${p1.id}`, { item_name: 'ANON EDIT' });
  check('C: anonymous edit -> 401', cRes.status === 401, String(cRes.status));

  await asOwner();
  const dDel = await rawStatus('DELETE', `/items/${p2.id}`);
  const dGet = await getErr(`/items/${p2.id}`);
  check('D: owner delete -> gone', dDel.status === 200 && !dGet.ok && dGet.data?.message === 'Item not found',
    JSON.stringify({ s: dDel.status, get: dGet.data?.message }));

  await loginAs(UB.email, UB.password);
  const eDel = await rawStatus('DELETE', `/items/${p3.id}`);
  const eGet = await getErr(`/items/${p3.id}`);
  check('E: other user delete -> 403 + remains',
    eDel.status === 403 && eGet.ok, JSON.stringify({ s: eDel.status }));

  jar.clear();
  const fDel = await rawStatus('DELETE', `/items/${p3.id}`);
  const fGet = await getErr(`/items/${p3.id}`);
  check('F: anonymous delete -> 401 + remains',
    fDel.status === 401 && fGet.ok, JSON.stringify({ s: fDel.status }));

  await loginAs(UB.email, UB.password);
  const gRes = await rawStatus('PUT', `/items/${p1.id}`, { item_name: 'SPOOFED', reporter_id: ownerId });
  const gGet = await getErr(`/items/${p1.id}`);
  check('G: spoofed reporter_id does not bypass -> 403 + unchanged',
    gRes.status === 403 && gGet.data?.item?.item_name === 'Probe Edited Alpha',
    JSON.stringify({ s: gRes.status, name: gGet.data?.item?.item_name }));

  await asOwner();
  await rawStatus('PUT', `/items/${p3.id}/returned`);
  const rDel = await rawStatus('DELETE', `/items/${p3.id}`);
  const rGet = await getErr(`/items/${p3.id}`);
  check('returned guard: owner cannot delete returned item -> blocked',
    rDel.status === 400 && rGet.ok, JSON.stringify({ s: rDel.status }));

  const uiUser = (await asOwner()).user;
  const ctxO = await bootApp({ clf_user: JSON.stringify(uiUser) });
  try {
    await ctxO.go(`/item/${p1.id}`);
    check('[ui] owner sees Edit/Delete/Returned controls',
      await until(() =>
        !!ctxO.app.querySelector('[data-delete-id]') &&
        !!ctxO.app.querySelector('a[href*="edit="]') &&
        !!ctxO.app.querySelector('[data-return-id]')));

    ctxO.app.querySelector('a[href*="edit="]').click();
    check('[ui] edit form opens prefilled',
      await until(() =>
        ctxO.w.location.hash.includes(`edit=${p1.id}`) &&
        ctxO.w.document.getElementById('f-name')?.value === 'Probe Edited Alpha' &&
        ctxO.w.document.getElementById('publishBtn')?.textContent === 'Save Changes'));

    const ef = ctxO.w.document;
    ef.getElementById('f-name').value = 'Black leather wallet';
    ef.getElementById('f-category').value = 'keys';
    ef.getElementById('f-desc').value = 'Leather wallet with card slots and an ID window, worn corners.';
    ef.getElementById('reportForm').dispatchEvent(
      new ctxO.w.Event('submit', { bubbles: true, cancelable: true })
    );

    const modalUp = await until(() => {
      const m = ctxO.w.document.querySelector('.modal-backdrop.show .modal-card');
      return !!m && m.textContent.includes('Did you mean');
    });
    if (!modalUp) {
      check('[ui] edit mismatch triggers validation modal', false, 'no modal');
    } else {
      check('[ui] edit mismatch triggers validation modal', true);
      ctxO.w.document.querySelector('.modal-backdrop.show [data-modal-confirm]').click();
      check('[ui] edited item saved with suggested category + back on detail',
        await until(() =>
          ctxO.w.location.hash === `#/item/${p1.id}` &&
          ctxO.app.textContent.includes('Black leather wallet') &&
          !ctxO.app.querySelector('.modal-backdrop')));
    }

    const delBtn = ctxO.app.querySelector('[data-delete-id]');
    delBtn.click();
    await until(() => !!ctxO.w.document.querySelector('.modal-backdrop.show .modal-card'));
    const modalTxt = ctxO.w.document.querySelector('.modal-backdrop.show .modal-card').textContent;
    check('[ui] delete modal has exact copy + buttons',
      modalTxt.includes('Delete this listing?') &&
      modalTxt.includes('This action cannot be undone.') &&
      !!ctxO.w.document.querySelector('[data-modal-cancel]') &&
      ctxO.w.document.querySelector('[data-modal-confirm]').textContent.trim() === 'Delete Listing');

    ctxO.w.document.querySelector('[data-modal-cancel]').click();
    await sleep(250);
    const stillThere = await getErr(`/items/${p1.id}`);
    check('[ui] cancel keeps the listing', stillThere.ok);

    ctxO.app.querySelector('[data-delete-id]').click();
    await until(() => !!ctxO.w.document.querySelector('.modal-backdrop.show [data-modal-confirm]'));
    ctxO.w.document.querySelector('.modal-backdrop.show [data-modal-confirm]').click();
    check('[ui] confirmed delete redirects to lost-items',
      await until(() => ctxO.w.location.hash === '#/lost-items'));
    const gone = await getErr(`/items/${p1.id}`);
    check('[ui] deleted item is gone from backend', !gone.ok && gone.data?.message === 'Item not found');
    check('[ui] phase H zero console errors', ctxO.jsErrors.length === 0, ctxO.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await ctxO.close();
  }

  await asOwner();
  const probe = await apiPost({
    item_name: 'Probe Delta', category: 'keys', type: 'lost',
    description: 'Single brass key on a plain ring lost by the fountain.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-7003',
    email: '', additional_details: '', university: 'other',
  });
  await loginAs(UB.email, UB.password);
  const ubMe = await fetch(`${API}/auth/me`).then((r) => r.json());
  const ctxN = await bootApp({ clf_user: JSON.stringify(ubMe.user) });
  try {
    await ctxN.go(`/item/${probe.id}`);
    check('[ui] non-owner sees NO edit/delete controls',
      await until(() => !!ctxN.app.querySelector('.detail-info')) &&
      !ctxN.app.querySelector('[data-delete-id]') &&
      !ctxN.app.querySelector('a[href*="edit="]') &&
      !ctxN.app.querySelector('[data-return-id]'));
    check('[ui] non-owner zero console errors', ctxN.jsErrors.length === 0);
  } finally {
    await ctxN.close();
  }
  await rawStatus('DELETE', `/items/${probe.id}`);
}

console.log('--- Phase I: prohibited-listing safety ---');
{
  const checkContent = async (title, description, category = 'other') =>
    fetch(`${API}/listings/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, category }),
    }).then((r) => r.json());

  const allowedCases = [
    ['Black leather wallet', 'Bifold wallet with cards inside', 'wallets'],
    ['Mobile phone', 'Black smartphone with cracked screen', 'electronics'],
    ['Dell laptop', 'Silver laptop in brown sleeve', 'electronics'],
    ['Blue backpack', 'Backpack with laptop compartment', 'bags'],
    ['Red bicycle', 'Mountain bicycle with water bottle holder', 'other'],
    ['Bicycle helmet', 'White cycling helmet, size M', 'other'],
    ['Car keys', 'Lost my car keys near the library entrance', 'keys'],
    ['Bike key', 'Single bike key on a blue fob', 'keys'],
    ['Honda cycle lock', 'Combination lock for my cycle', 'other'],
    ['Keys maybe to a car', 'Found a bunch of keys, they may belong to a car', 'keys'],
    ['LOST WATCH', 'Metal strap wrist watch', 'other'],
  ];
  for (const [t, d, c] of allowedCases) {
    const res = await checkContent(t, d, c);
    check(`allowed: ${t}`, res.allowed === true && res.success === true, JSON.stringify(res));
  }

  const blockedCases = [
    ['Honda motorcycle', 'Red motorcycle seen in parking lot B', 'other'],
    ['Car', 'Silver sedan left unattended', 'other'],
    ['Scooter', 'Blue scooter near gate', 'other'],
    ['Truck', 'Small pickup truck blocking driveway', 'other'],
    ['Dog', 'Friendly dog wandering near hostel', 'other'],
    ['Cat', 'Grey cat with collar', 'other'],
    ['Puppy', 'Tiny puppy looking for owner', 'other'],
    ['Plant', 'Potted plant left in corridor', 'other'],
    ['pistol', 'Found a black pistol', 'other'],
    ['gun', 'GUN found in bushes', 'other'],
    ['Rifle', 'Wooden stock rifle behind gym', 'other'],
    ['Ammunition box', 'Box of bullets found on field', 'other'],
    ['Something shiny', 'It is definitely a bomb', 'other'],
  ];
  for (const [t, d] of blockedCases) {
    const res = await checkContent(t, d);
    check(`blocked: ${t}`, res.allowed === false && typeof res.reason === 'string' && res.reason.length > 0,
      JSON.stringify(res));
  }

  const ownerMe2 = (await (async () => { smokeUserReady = false; await ensureSmokeUser(); return fetch(`${API}/auth/me`).then((r) => r.json()); })()).user;
  const countNow = async () => (await fetch(`${API}/items`).then((r) => r.json())).count;
  const rawPost = async (payload) =>
    fetch(`${API}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  let n = await countNow();

  const blockedCreate = await rawPost({
    item_name: 'Found pistol', category: 'other', type: 'found',
    description: 'Black pistol handed in at the security desk.',
    date: '2026-08-25', location: 'Gate 2', contact_number: '+1 (555) 010-9000',
  });
  check('enforce: blocked create -> 400, DB unchanged',
    blockedCreate.status === 400 && (await countNow()) === n,
    JSON.stringify({ s: blockedCreate.status }));

  const safeProbe = await apiPost({
    item_name: 'Safety Probe Wallet', category: 'wallets', type: 'lost',
    description: 'Brown leather wallet with zip pocket lost near canteen.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-9001',
    email: '', additional_details: '', university: 'other',
  });
  const blockedEdit = await fetch(`${API}/items/${safeProbe.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_name: 'Found rifle', description: 'Rifle leaning against the wall.' }),
  });
  const afterEdit = await getErrSafe(`/items/${safeProbe.id}`);
  check('enforce: edit into weapon -> 400, listing unchanged',
    blockedEdit.status === 400 && afterEdit.data?.item?.item_name === 'Safety Probe Wallet',
    JSON.stringify({ s: blockedEdit.status, name: afterEdit.data?.item?.item_name }));

  jar.clear();
  const anonBlocked = await rawPost({
    item_name: 'Found dog', category: 'other', type: 'found',
    description: 'A dog was found wandering around the campus lawn.',
    date: '2026-08-25', location: 'Lawn', contact_number: '+1 (555) 010-9002',
  });
  check('enforce: anonymous prohibited create still rejected', anonBlocked.status >= 400, String(anonBlocked.status));

  await fetch(`${API}/items/${safeProbe.id}`, { method: 'DELETE' }).catch(() => {});
  n = await countNow();

  const uiUserI = (await (async () => { smokeUserReady = false; await ensureSmokeUser(); return fetch(`${API}/auth/me`).then((r) => r.json()); })()).user;
  const ctxS = await bootApp({ clf_user: JSON.stringify(uiUserI) });
  try {
    await ctxS.go('#/report?type=found');
    await until(() => !!ctxS.app.querySelector('#reportForm'));
    check('[ui] listing-rules notice visible',
      ctxS.app.querySelector('#reportForm .callout')?.textContent.includes('Vehicles (except bicycles)'));

    const sf = ctxS.w.document;
    sf.getElementById('f-name').value = 'Cute puppy';
    sf.getElementById('f-desc').value = 'A small puppy was found wandering near the campus gate.';
    sf.getElementById('f-date').value = '2026-08-25';
    sf.getElementById('f-location').value = 'Campus Gate';
    sf.getElementById('f-phone').value = '+1 (555) 010-9010';
    sf.getElementById('f-category').value = 'other';
    sf.getElementById('f-university').value = 'other';
    sf.getElementById('reportForm').dispatchEvent(new ctxS.w.Event('submit', { bubbles: true, cancelable: true }));

    check('[ui] prohibited submission shows error toast and keeps form data',
      await until(() => !!ctxS.w.document.querySelector('.toast--error')));
    check('[ui] form data preserved after block',
      sf.getElementById('f-name').value === 'Cute puppy' && ctxS.w.location.hash.startsWith('#/report'));
    check('[ui] nothing was created',
      (await countNow()) === n);
    check('[ui] phase I zero console errors', ctxS.jsErrors.length === 0, ctxS.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await ctxS.close();
    jar.clear();
  }
}

async function getErrSafe(path) {
  const res = await fetch(`${API}${path}`);
  return { ok: res.ok, data: await res.json().catch(() => null) };
}

console.log('--- Phase J: university field ---');
{
  const UB2 = { name: 'Uni Test User', email: `uni.${Date.now()}@test.edu`, password: 'unipass123' };
  const loginAs2 = async (email, password) => {
    jar.clear();
    return fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.status);
  };
  const rawPost2 = async (payload) =>
    fetch(`${API}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(UB2),
  }).catch(() => {});

  smokeUserReady = false;
  await ensureSmokeUser();
  const ownerMe3 = await fetch(`${API}/auth/me`).then((r) => r.json());
  const ownerId3 = ownerMe3.user.id;

  const validPayload = {
    item_name: 'Uni Test Wallet', category: 'wallets', type: 'lost',
    description: 'Test wallet to verify university field is stored correctly.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-5000',
    email: '', additional_details: '', university: 'mdu',
  };

  const created1 = await rawPost2(validPayload);
  check('J1: create with valid university -> 201',
    created1.status === 201, JSON.stringify({ s: created1.status }));

  let j1Item = null;
  if (created1.status === 201) {
    j1Item = (await created1.json()).item;
    check('J1b: university stored as mdu',
      j1Item?.university === 'mdu', JSON.stringify({ u: j1Item?.university }));
  }

  const noUniParsed = await (async () => {
    const r = await rawPost2({
      item_name: 'No Uni Test', category: 'wallets', type: 'lost',
      description: 'Test wallet missing university field.', date: '2026-08-25',
      location: 'Test Bench', contact_number: '+1 (555) 010-5000', email: '', additional_details: '',
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })();
  check('J2: create without university -> 400',
    noUniParsed.status === 400 && noUniParsed.body?.success === false,
    JSON.stringify({ s: noUniParsed.status, msg: noUniParsed.body?.message }));

  const badUni = await (async () => {
    const r = await rawPost2({ ...validPayload, item_name: 'Bad Uni Test', university: 'fake-university' });
    return { status: r.status, body: await r.json().catch(() => null) };
  })();
  check('J3: create with invalid university -> 400',
    badUni.status === 400 && badUni.body?.success === false,
    JSON.stringify({ s: badUni.status, msg: badUni.body?.message }));

  if (j1Item) {
    const editOk = await (async () => {
      const r = await fetch(`${API}/items/${j1Item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ university: 'du' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    })();
    check('J4: owner edit university -> 200',
      editOk.status === 200 && editOk.body?.item?.university === 'du',
      JSON.stringify({ s: editOk.status, u: editOk.body?.item?.university }));

    await fetch(`${API}/items/${j1Item.id}`, { method: 'DELETE' }).catch(() => {});
  }

  const j2Item = await apiPost({
    item_name: 'Uni Cross-User Test', category: 'other', type: 'found',
    description: 'Cross-user university edit test probe.',
    date: '2026-08-25', location: 'Test Bench', contact_number: '+1 (555) 010-5001',
    email: '', additional_details: '', university: 'kuk',
  });

  await loginAs2(UB2.email, UB2.password);
  const crossEdit = await (async () => {
    const r = await fetch(`${API}/items/${j2Item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ university: 'amity' }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })();
  check('J5: non-owner cannot edit university -> 403',
    crossEdit.status === 403, JSON.stringify({ s: crossEdit.status }));

  jar.clear();
  const anonEdit = await (async () => {
    const r = await fetch(`${API}/items/${j2Item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ university: 'amity' }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })();
  check('J6: anonymous edit -> 401',
    anonEdit.status === 401, JSON.stringify({ s: anonEdit.status }));

  const j2Get = await (async () => {
    const r = await fetch(`${API}/items/${j2Item.id}`);
    return (await r.json()).item;
  })();
  check('J6b: j2Item still has original university',
    j2Get?.university === 'kuk', JSON.stringify({ u: j2Get?.university }));

  smokeUserReady = false;
  await ensureSmokeUser();

  const j3Item = await apiPost({
    item_name: 'Filter Test MDU', category: 'wallets', type: 'lost',
    description: 'Wallet lost on MDU campus to test university filtering.',
    date: '2026-08-25', location: 'MDU Block A', contact_number: '+1 (555) 010-5002',
    email: '', additional_details: '', university: 'mdu',
  });
  const j4Item = await apiPost({
    item_name: 'Filter Test DU', category: 'wallets', type: 'lost',
    description: 'Wallet lost on DU campus to test university filtering.',
    date: '2026-08-25', location: 'DU North Campus', contact_number: '+1 (555) 010-5003',
    email: '', additional_details: '', university: 'du',
  });

  const mduOnly = await fetch(`${API}/items?university=mdu`).then((r) => r.json());
  check('J7: filter by MDU -> only MDU items',
    mduOnly.items?.every((i) => i.university === 'mdu'),
    JSON.stringify({ count: mduOnly.count, unis: mduOnly.items?.map((i) => i.university) }));

  const duOnly = await fetch(`${API}/items?university=du`).then((r) => r.json());
  check('J8: filter by DU -> only DU items',
    duOnly.items?.every((i) => i.university === 'du'),
    JSON.stringify({ count: duOnly.count, unis: duOnly.items?.map((i) => i.university) }));

  const mduLost = await fetch(`${API}/items?university=mdu&type=lost`).then((r) => r.json());
  check('J9: university + type filter combined',
    mduLost.items?.every((i) => i.university === 'mdu' && i.type === 'lost'),
    JSON.stringify({ count: mduLost.count }));

  const mduSearch = await fetch(`${API}/items?university=mdu&search=Filter`).then((r) => r.json());
  check('J10: university + keyword search combined',
    mduSearch.items?.every((i) => i.university === 'mdu' && i.item_name.includes('Filter')),
    JSON.stringify({ count: mduSearch.count }));

  const badUniQ = await fetch(`${API}/items?university=invalid`).then((r) => r.json());
  check('J11: invalid university query param -> error',
    badUniQ.success === false, JSON.stringify(badUniQ));

  const uniList = await fetch(`${API}/universities`).then((r) => r.json());
  check('J12: /api/universities returns list',
    uniList.success === true && Array.isArray(uniList.universities) && uniList.universities.length >= 10,
    JSON.stringify({ count: uniList.universities?.length }));

  const existingItem = await fetch(`${API}/items`).then((r) => r.json());
  const hasOldUni = existingItem.items?.some((i) => i.university === 'other' || Boolean(i.university));
  check('J13: existing items have university field (backward compat)',
    hasOldUni, JSON.stringify({ sample: existingItem.items?.[0]?.university }));

  smokeUserReady = false;
  await ensureSmokeUser();
  const uiUserJ = await fetch(`${API}/auth/me`).then((r) => r.json());

  const ctxJ = await bootApp({ clf_user: JSON.stringify(uiUserJ.user) });
  try {
    await ctxJ.go('#/report?type=lost');
    await until(() => !!ctxJ.app.querySelector('#f-university'));
    check('[ui] report form has university dropdown',
      !!ctxJ.app.querySelector('#f-university'));
    check('[ui] university dropdown has all options',
      ctxJ.app.querySelectorAll('#f-university option').length >= 11);

    const sf2 = ctxJ.w.document;
    sf2.getElementById('f-university').value = 'mdu';
    sf2.getElementById('f-name').value = 'UI Uni Test Wallet';
    sf2.getElementById('f-desc').value = 'Test wallet to verify the university dropdown works end-to-end.';
    sf2.getElementById('f-date').value = '2026-08-25';
    sf2.getElementById('f-location').value = 'Test Bench';
    sf2.getElementById('f-phone').value = '+1 (555) 010-5010';
    sf2.getElementById('f-category').value = 'wallets';
    sf2.getElementById('reportForm').dispatchEvent(
      new ctxJ.w.Event('submit', { bubbles: true, cancelable: true })
    );

    await until(async () => {
      const data = await fetch(`${API}/items?search=${encodeURIComponent('UI Uni Test Wallet')}`).then((r) => r.json());
      return data.items?.find((i) => i.item_name === 'UI Uni Test Wallet');
    });
    const uiCreated = (await fetch(`${API}/items?search=${encodeURIComponent('UI Uni Test Wallet')}`).then((r) => r.json())).items?.find((i) => i.item_name === 'UI Uni Test Wallet');
    check('[ui] item created via form with university',
      uiCreated?.university === 'mdu',
      JSON.stringify({ u: uiCreated?.university }));

    if (uiCreated) {
      await ctxJ.go(`/item/${uiCreated.id}`);
      check('[ui] detail page shows university',
        await until(() => ctxJ.app.textContent.includes('Maharshi Dayanand University')));

      await ctxJ.go('#/lost-items');
      await until(() => ctxJ.app.querySelectorAll('.grid-cards .item-card').length > 0);
      const cardText = ctxJ.app.textContent;
      check('[ui] listing cards show university for non-other items',
        cardText.includes('Maharshi Dayanand University'));

      check('[ui] university filter dropdown exists on list page',
        !!ctxJ.app.querySelector('#f-university'));
    }

    check('[ui] phase J zero console errors', ctxJ.jsErrors.length === 0, ctxJ.jsErrors.slice(0, 2).join(' | '));

    if (uiCreated) await fetch(`${API}/items/${uiCreated.id}`, { method: 'DELETE' }).catch(() => {});
  } finally {
    await ctxJ.close();
  }

  await fetch(`${API}/items/${j3Item.id}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${API}/items/${j4Item.id}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${API}/items/${j2Item.id}`, { method: 'DELETE' }).catch(() => {});
  jar.clear();
}

console.log('--- Phase K: My Listings page + ownership isolation ---');
{
  const KA = { name: 'Owner A', email: `kownerA.${Date.now()}@test.edu`, password: 'kpass1111' };
  const KB = { name: 'Owner B', email: `kownerB.${Date.now()}@test.edu`, password: 'kpass2222' };

  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(KA),
  });
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(KB),
  });

  const loginAs = async (email, password) => {
    jar.clear();
    return fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json());
  };

  await loginAs(KA.email, KA.password);
  const aItem1 = await apiPost({
    item_name: 'Owner A Wallet', category: 'wallets', type: 'lost',
    description: 'Brown leather wallet lost by Owner A in the library.',
    date: '2026-08-25', location: 'Library', contact_number: '+1 555-1001',
    email: '', additional_details: '', university: 'mdu',
  });
  const aItem2 = await apiPost({
    item_name: 'Owner A Keys', category: 'keys', type: 'found',
    description: 'Set of brass keys found by Owner A near the cafeteria.',
    date: '2026-08-25', location: 'Cafeteria', contact_number: '+1 555-1002',
    email: '', additional_details: '', university: 'du',
  });

  await loginAs(KB.email, KB.password);
  const bItem1 = await apiPost({
    item_name: 'Owner B Bag', category: 'bags', type: 'found',
    description: 'Blue backpack found by Owner B in computer lab.',
    date: '2026-08-25', location: 'Computer Lab', contact_number: '+1 555-2001',
    email: '', additional_details: '', university: 'kuk',
  });

  jar.clear();
  const anonMine = await fetch(`${API}/items?mine=1`).then((r) => r.json());
  check('K1: anonymous ?mine=1 -> 401',
    anonMine.success === false, JSON.stringify(anonMine));

  await loginAs(KA.email, KA.password);
  const aMine = await fetch(`${API}/items?mine=1`).then((r) => r.json());
  check('K2: Owner A sees ONLY their items (2)',
    aMine.count === 2 && aMine.items.every((i) => i.item_name.startsWith('Owner A')),
    JSON.stringify({ count: aMine.count, names: aMine.items.map((i) => i.item_name) }));

  await loginAs(KB.email, KB.password);
  const bMine = await fetch(`${API}/items?mine=1`).then((r) => r.json());
  check('K3: Owner B sees ONLY their items (1)',
    bMine.count === 1 && bMine.items[0]?.item_name === 'Owner B Bag',
    JSON.stringify({ count: bMine.count, names: bMine.items.map((i) => i.item_name) }));

  const bCrossEdit = await (async () => {
    const r = await fetch(`${API}/items/${aItem1.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_name: 'Hijacked' }),
    });
    return r.status;
  })();
  check('K4: Owner B cannot edit Owner A item -> 403', bCrossEdit === 403, String(bCrossEdit));

  const bCrossDel = await (async () => {
    const r = await fetch(`${API}/items/${aItem1.id}`, { method: 'DELETE' });
    return r.status;
  })();
  check('K5: Owner B cannot delete Owner A item -> 403', bCrossDel === 403, String(bCrossDel));

  const bCrossReturn = await (async () => {
    const r = await fetch(`${API}/items/${aItem2.id}/returned`, { method: 'PUT' });
    return r.status;
  })();
  check('K6: Owner B cannot mark Owner A item returned -> 403', bCrossReturn === 403, String(bCrossReturn));

  await loginAs(KA.email, KA.password);
  const aReturnRes = await (async () => {
    const r = await fetch(`${API}/items/${aItem1.id}/returned`, { method: 'PUT' });
    return { status: r.status, body: await r.json().catch(() => null) };
  })();
  check('K7: Owner A can mark own item returned -> 200',
    aReturnRes.status === 200 && aReturnRes.body?.item?.status === 'returned',
    JSON.stringify({ s: aReturnRes.status }));

  const aMineAfterReturn = await fetch(`${API}/items?mine=1`).then((r) => r.json());
  const returnedCount = aMineAfterReturn.items.filter((i) => i.status === 'returned').length;
  check('K8: returned item still appears in ?mine=1',
    returnedCount === 1, JSON.stringify({ returnedCount, total: aMineAfterReturn.count }));

  const aDelRes = await (async () => {
    const r = await fetch(`${API}/items/${aItem2.id}`, { method: 'DELETE' });
    return r.status;
  })();
  check('K9: Owner A can delete own item -> 200', aDelRes === 200, String(aDelRes));

  const aMineAfterDel = await fetch(`${API}/items?mine=1`).then((r) => r.json());
  check('K10: deleted item gone from ?mine=1',
    aMineAfterDel.count === 1 && aMineAfterDel.items[0]?.item_name === 'Owner A Wallet',
    JSON.stringify({ count: aMineAfterDel.count }));

  jar.clear();
  const ctxKN = await bootApp();
  try {
    await ctxKN.go('#/my-listings');
    await until(() => ctxKN.app.textContent.includes('Not logged in') || ctxKN.app.textContent.includes('must be logged in'));
    check('[ui] K11: logged-out My Listings shows not-logged-in message',
      ctxKN.app.textContent.includes('Not logged in') || ctxKN.app.textContent.includes('must be logged in'));
    check('[ui] K11b: My Listings navbar link hidden when logged-out',
      !!ctxKN.w.document.querySelector('[data-nav="my-listings"][hidden]'));
    check('[ui] K11c: zero console errors', ctxKN.jsErrors.length === 0);
  } finally {
    await ctxKN.close();
  }

  await loginAs(KA.email, KA.password);
  const aItem3 = await apiPost({
    item_name: 'Owner A Active Badge', category: 'other', type: 'lost',
    description: 'University ID badge lost near the admin office.',
    date: '2026-08-25', location: 'Admin Block', contact_number: '+1 555-1003',
    email: '', additional_details: '', university: 'mdu',
  });
  const aMeResp = await fetch(`${API}/auth/me`).then((r) => r.json());
  const ctxKAL = await bootApp({ clf_user: JSON.stringify(aMeResp.user) });
  try {
    await ctxKAL.go('#/my-listings');
    check('[ui] K12: logged-in My Listings navbar link visible',
      await until(() => !!ctxKAL.w.document.querySelector('[data-nav="my-listings"]:not([hidden])')));
    check('[ui] K13: My Listings page renders Owner A items',
      await until(() => ctxKAL.app.textContent.includes('Owner A Active Badge') && ctxKAL.app.textContent.includes('Owner A Wallet')),
      'loading...');
    check('[ui] K14: active item shows Edit button',
      !!ctxKAL.app.querySelector('a[href*="edit="]'));
    check('[ui] K15: active item shows Mark Returned button',
      !!ctxKAL.app.querySelector('[data-mine-return]'));
    check('[ui] K16: active item shows Delete button',
      !!ctxKAL.app.querySelector('[data-mine-delete]'));
    check('[ui] K17: My Listings shows count text',
      ctxKAL.app.querySelector('#resultsCount')?.textContent.includes('listing'));
    check('[ui] K18: zero console errors', ctxKAL.jsErrors.length === 0, ctxKAL.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await ctxKAL.close();
  }

  await loginAs(KB.email, KB.password);
  const bMeResp = await fetch(`${API}/auth/me`).then((r) => r.json());
  const ctxKBL = await bootApp({ clf_user: JSON.stringify(bMeResp.user) });
  try {
    await ctxKBL.go('#/my-listings');
    check('[ui] K19: Owner B My Listings shows only Owner B items',
      await until(() => ctxKBL.app.textContent.includes('Owner B Bag')));
    check('[ui] K20: Owner B does NOT see Owner A items',
      !ctxKBL.app.textContent.includes('Owner A Active Badge') && !ctxKBL.app.textContent.includes('Owner A Wallet'));
    check('[ui] K21: zero console errors', ctxKBL.jsErrors.length === 0);
  } finally {
    await ctxKBL.close();
  }

  await loginAs(KA.email, KA.password);
  const aMeResp2 = await fetch(`${API}/auth/me`).then((r) => r.json());
  const ctxKAEdit = await bootApp({ clf_user: JSON.stringify(aMeResp2.user) });
  try {
    await ctxKAEdit.go('#/my-listings');
    await until(() => !!ctxKAEdit.app.querySelector('[data-mine-return]'));
    const beforeReturned = ctxKAEdit.app.querySelectorAll('.item-card.is-returned').length;
    ctxKAEdit.app.querySelector('[data-mine-return]').click();
    await until(() => !!ctxKAEdit.w.document.querySelector('.modal-backdrop.show .modal-card'));
    const modalTxt = ctxKAEdit.w.document.querySelector('.modal-backdrop.show .modal-card').textContent;
    check('[ui] K22: mark-returned modal appears from My Listings',
      modalTxt.includes('Mark this item as returned'));
    ctxKAEdit.w.document.querySelector('[data-modal-confirm]').click();
    check('[ui] K23: after mark-returned, returned count increases',
      await until(() => ctxKAEdit.app.querySelectorAll('.item-card.is-returned').length > beforeReturned));
    check('[ui] K24: mark-returned button gone for all items',
      await until(() => !ctxKAEdit.app.querySelector('[data-mine-return]')));
    check('[ui] K25: zero console errors', ctxKAEdit.jsErrors.length === 0, ctxKAEdit.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await ctxKAEdit.close();
  }

  await loginAs(KA.email, KA.password);
  await fetch(`${API}/items/${aItem1.id}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${API}/items/${aItem3.id}`, { method: 'DELETE' }).catch(() => {});
  await loginAs(KB.email, KB.password);
  await fetch(`${API}/items/${bItem1.id}`, { method: 'DELETE' }).catch(() => {});
  jar.clear();
}

console.log('--- Phase L: advanced search + server-side filters ---');
{
  execSync(`"${join(root, '.venv', 'Scripts', 'python.exe')}" -c "from backend.database import get_connection; db=get_connection(); db.execute('DELETE FROM items'); db.commit()"`, { cwd: root });
  const LS = { name: 'Filter Tester', email: `lfilter.${Date.now()}@test.edu`, password: 'lpass1234' };
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LS),
  });
  const lLogin = async () => {
    jar.clear();
    await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: LS.email, password: LS.password }),
    });
  };
  await lLogin();

  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);

  const l1 = await apiPost({
    item_name: 'MDU Lost Wallet', category: 'wallets', type: 'lost',
    description: 'Brown wallet lost near the main library.',
    date: today, location: 'Main Library', contact_number: '+1 555-3001',
    email: '', additional_details: '', university: 'mdu',
  });
  const l2 = await apiPost({
    item_name: 'MDU Found Keys', category: 'keys', type: 'found',
    description: 'Brass keys found in the cafeteria.',
    date: today, location: 'Central Cafeteria', contact_number: '+1 555-3002',
    email: '', additional_details: '', university: 'mdu',
  });
  const l3 = await apiPost({
    item_name: 'DU Lost Bag', category: 'bags', type: 'lost',
    description: 'Black backpack left in the library.',
    date: today, location: 'Main Library', contact_number: '+1 555-3003',
    email: '', additional_details: '', university: 'du',
  });
  const l4 = await apiPost({
    item_name: 'KUK Old Book', category: 'books', type: 'found',
    description: 'Old physics textbook found in the office.',
    date: old, location: 'Admin Office', contact_number: '+1 555-3004',
    email: '', additional_details: '', university: 'kuk',
  });
  const l5 = await apiPost({
    item_name: 'Other Lost Phone', category: 'electronics', type: 'lost',
    description: 'Smartphone lost near the computer lab.',
    date: today, location: 'Computer Lab', contact_number: '+1 555-3005',
    email: '', additional_details: '', university: 'other',
  });

  const q = async (params) => {
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) usp.set(k, v); });
    const qs = usp.toString();
    const r = await fetch(`${API}/items${qs ? '?' + qs : ''}`).then((r) => r.json());
    return r.items || [];
  };

  const names = (items) => items.map((i) => i.item_name).sort();

  const catItems = await q({ category: 'wallets' });
  check('L1: category=wallets -> only wallets',
    catItems.length === 1 && catItems[0].item_name === 'MDU Lost Wallet',
    JSON.stringify(names(catItems)));

  const locItems = await q({ location: 'Main Library' });
  check('L2: location=Main Library -> 2 items',
    locItems.length === 2 && names(locItems).includes('MDU Lost Wallet') && names(locItems).includes('DU Lost Bag'),
    JSON.stringify(names(locItems)));

  const recentItems = await q({ days: '7' });
  check('L3: days=7 -> excludes 40-day-old item',
    recentItems.every((i) => i.item_name !== 'KUK Old Book') && recentItems.length >= 4,
    JSON.stringify({ count: recentItems.length, hasOld: recentItems.some((i) => i.item_name === 'KUK Old Book') }));

  const allItems = await q({ days: 'any' });
  check('L4: days=any -> includes old item',
    allItems.some((i) => i.item_name === 'KUK Old Book'),
    JSON.stringify({ count: allItems.length }));

  const lostItems = await q({ type: 'lost' });
  check('L5: type=lost -> only lost items',
    lostItems.every((i) => i.type === 'lost'),
    JSON.stringify({ count: lostItems.length, types: [...new Set(lostItems.map((i) => i.type))] }));

  const mduItems = await q({ university: 'mdu' });
  check('L6: university=mdu -> only MDU items',
    mduItems.length === 2 && mduItems.every((i) => i.university === 'mdu'),
    JSON.stringify(names(mduItems)));

  const comboItems = await q({ category: 'wallets', university: 'mdu' });
  check('L7: category=wallets + university=mdu -> 1 item',
    comboItems.length === 1 && comboItems[0].item_name === 'MDU Lost Wallet',
    JSON.stringify(names(comboItems)));

  const searchItems = await q({ search: 'wallet' });
  check('L8: search=wallet -> matches item_name',
    searchItems.some((i) => i.item_name === 'MDU Lost Wallet'),
    JSON.stringify(names(searchItems)));

  const searchUniItems = await q({ search: 'mdu' });
  check('L9: search=mdu -> matches university field',
    searchUniItems.length >= 2 && searchUniItems.every((i) => i.university === 'mdu'),
    JSON.stringify({ count: searchUniItems.length }));

  const searchCombo = await q({ search: 'wallet', university: 'mdu' });
  check('L10: search=wallet + university=mdu -> intersection',
    searchCombo.length === 1 && searchCombo[0].item_name === 'MDU Lost Wallet',
    JSON.stringify(names(searchCombo)));

  const noMatch = await q({ category: 'nonexistent' });
  check('L11: category=nonexistent -> empty',
    noMatch.length === 0, JSON.stringify(noMatch.length));

  const typeUniCat = await q({ type: 'lost', university: 'du', category: 'bags' });
  check('L12: type=lost + university=du + category=bags -> DU Lost Bag',
    typeUniCat.length === 1 && typeUniCat[0].item_name === 'DU Lost Bag',
    JSON.stringify(names(typeUniCat)));

  const noResultSearch = await q({ search: 'xyznonexistent' });
  check('L13: search nonsense -> empty',
    noResultSearch.length === 0, JSON.stringify(noResultSearch.length));

  const searchLoc = await q({ search: 'library', location: 'Main Library' });
  check('L14: search + location combined',
    searchLoc.every((i) => i.location === 'Main Library') && searchLoc.length >= 1,
    JSON.stringify({ count: searchLoc.length, locs: searchLoc.map((i) => i.location) }));

  smokeUserReady = false;
  await ensureSmokeUser();
  const lMeUser = await fetch(`${API}/auth/me`).then((r) => r.json());

  const ctxL = await bootApp({ clf_user: JSON.stringify(lMeUser.user) });
  try {
    await ctxL.go('#/items');
    await until(() => ctxL.app.querySelectorAll('.grid-cards .item-card').length > 0);
    const initialCount = ctxL.app.querySelectorAll('.grid-cards .item-card').length;
    check('[ui] L15: browse page loads items',
      initialCount > 0, String(initialCount));

    const catSelect = ctxL.app.querySelector('#f-category');
    catSelect.value = 'wallets';
    catSelect.dispatchEvent(new ctxL.w.Event('change'));
    await until(() => {
      const cards = ctxL.app.querySelectorAll('.grid-cards .item-card');
      return cards.length < initialCount;
    });
    const catCount = ctxL.app.querySelectorAll('.grid-cards .item-card').length;
    check('[ui] L16: category filter narrows results (client re-fetch)',
      catCount < initialCount && catCount >= 1, String(catCount));

    catSelect.value = '';
    catSelect.dispatchEvent(new ctxL.w.Event('change'));
    await until(() => ctxL.app.querySelectorAll('.grid-cards .item-card').length === initialCount);

    const uniSelect = ctxL.app.querySelector('#f-university');
    uniSelect.value = 'mdu';
    uniSelect.dispatchEvent(new ctxL.w.Event('change'));
    await until(() => {
      const cards = ctxL.app.querySelectorAll('.grid-cards .item-card');
      return cards.length > 0 && cards.length <= 2;
    });
    const uniCount = ctxL.app.querySelectorAll('.grid-cards .item-card').length;
    check('[ui] L17: university filter narrows to MDU only',
      uniCount === 2, String(uniCount));

    const searchInput = ctxL.app.querySelector('#f-q');
    searchInput.value = 'wallet';
    searchInput.dispatchEvent(new ctxL.w.Event('input'));
    await until(() => {
      const cards = ctxL.app.querySelectorAll('.grid-cards .item-card');
      return cards.length <= 1;
    });
    check('[ui] L18: search + university combined in UI',
      ctxL.app.querySelectorAll('.grid-cards .item-card').length === 1);

    ctxL.app.querySelector('#f-reset').click();
    await until(() => {
      const cards = ctxL.app.querySelectorAll('.grid-cards .item-card:not(.card-skeleton)');
      return cards.length > 0;
    });
    check('[ui] L19: Clear Filters restores full results',
      ctxL.app.querySelectorAll('.grid-cards .item-card:not(.card-skeleton)').length === 5);

    const daysSelect = ctxL.app.querySelector('#f-days');
    daysSelect.value = '7';
    daysSelect.dispatchEvent(new ctxL.w.Event('change'));
    await until(() => {
      const cards = ctxL.app.querySelectorAll('.grid-cards .item-card');
      return cards.length >= 1 && cards.length < initialCount;
    });
    check('[ui] L20: days=7 filter excludes old items',
      ctxL.app.querySelectorAll('.grid-cards .item-card').length < initialCount);

    check('[ui] L21: zero console errors', ctxL.jsErrors.length === 0, ctxL.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await ctxL.close();
  }

  await lLogin();
  for (const id of [l1.id, l2.id, l3.id, l4.id, l5.id]) {
    await fetch(`${API}/items/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  jar.clear();
}

console.log('--- Phase M: admin system ---');
{
  const ADM = { name: 'Admin User', email: `admin.${Date.now()}@test.edu`, password: 'adminpass123' };
  const U1  = { name: 'Regular User 1', email: `ureg1.${Date.now()}@test.edu`, password: 'userpass123' };
  const U2  = { name: 'Regular User 2', email: `ureg2.${Date.now()}@test.edu`, password: 'userpass1234' };
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADM),
  });
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(U1),
  });
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(U2),
  });

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});

  await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADM.email, password: ADM.password }),
  });
  const meResp = await fetch(`${API}/auth/me`).then((r) => r.json());
  const adminUserId = meResp.user?.id;

  execSync(`"${join(root, '.venv', 'Scripts', 'python.exe')}" -c "from backend.database import get_connection; db=get_connection(); db.execute(\\"UPDATE users SET role='admin' WHERE id=${adminUserId}\\"); db.commit()"`, { cwd: root });

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});

  const loginAs = async (email, password) => {
    jar.clear();
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return r.json();
  };

  jar.clear();

  const anonStats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('M1: anonymous admin/stats -> 401', !anonStats.success);

  await loginAs(U1.email, U1.password);
  const u1Stats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('M2: normal user admin/stats -> 403', !u1Stats.success);

  const u1Users = await fetch(`${API}/admin/users`).then((r) => r.json());
  check('M3: normal user admin/users -> 403', !u1Users.success);

  const u1Items = await fetch(`${API}/admin/items`).then((r) => r.json());
  check('M4: normal user admin/items -> 403', !u1Items.success);

  const u1Logs = await fetch(`${API}/admin/logs`).then((r) => r.json());
  check('M5: normal user admin/logs -> 403', !u1Logs.success);

  jar.clear();
  await loginAs(ADM.email, ADM.password);

  const aStats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('M6: admin admin/stats -> 200', aStats.success && typeof aStats.stats === 'object');
  check('M7: admin stats has required fields',
    'total_users' in aStats.stats && 'total_listings' in aStats.stats &&
    'active_listings' in aStats.stats && 'returned_listings' in aStats.stats &&
    'lost_listings' in aStats.stats && 'found_listings' in aStats.stats);

  check('M8: admin stats total_users >= 3', aStats.stats.total_users >= 3);
  check('M9: admin stats has recent_items', Array.isArray(aStats.recent_items));
  check('M10: admin stats has recent_users', Array.isArray(aStats.recent_users));

  const aUsers = await fetch(`${API}/admin/users`).then((r) => r.json());
  check('M11: admin admin/users -> 200', aUsers.success && Array.isArray(aUsers.users));
  check('M12: admin sees >= 3 users', aUsers.users.length >= 3);
  check('M13: users have no password field', aUsers.users.every((u) => !u.password));

  const testItem = await apiPost({
    item_name: 'Admin Test Wallet', category: 'wallets', type: 'lost',
    description: 'Test item for admin moderation.',
    date: new Date().toISOString().slice(0, 10), location: 'Library',
    contact_number: '+1 555-9001', email: '', additional_details: '',
    university: 'mdu',
  });

  const aItems = await fetch(`${API}/admin/items`).then((r) => r.json());
  check('M14: admin admin/items -> 200', aItems.success && Array.isArray(aItems.items));
  check('M15: admin sees the test item', aItems.items.some((i) => i.id === testItem.id));

  const filteredItems = await fetch(`${API}/admin/items?university=mdu&category=wallets`).then((r) => r.json());
  check('M16: admin items filter by university+category',
    filteredItems.items.every((i) => i.university === 'mdu' && i.category === 'wallets'));

  const searchedItems = await fetch(`${API}/admin/items?search=Admin+Test`).then((r) => r.json());
  check('M17: admin items search works', searchedItems.items.some((i) => i.item_name === 'Admin Test Wallet'));

  jar.clear();
  const delResult = await fetch(`${API}/admin/items/${testItem.id}`, { method: 'DELETE' }).then((r) => r.json());
  check('M18: anonymous admin delete -> 401', !delResult.success);

  await loginAs(U1.email, U1.password);
  const u1Del = await fetch(`${API}/admin/items/${testItem.id}`, { method: 'DELETE' }).then((r) => r.json());
  check('M19: normal user admin delete -> 403', !u1Del.success);

  jar.clear();
  await loginAs(ADM.email, ADM.password);
  const testItem2 = await apiPost({
    item_name: 'Admin Delete Test', category: 'books', type: 'found',
    description: 'Item to be deleted by admin.',
    date: new Date().toISOString().slice(0, 10), location: 'Office',
    contact_number: '+1 555-9002', email: '', additional_details: '',
    university: 'du',
  });

  const delResp = await fetch(`${API}/admin/items/${testItem2.id}`, { method: 'DELETE' }).then((r) => r.json());
  check('M20: admin deletes item -> 200', delResp.success);

  const deletedCheck = await fetch(`${API}/items/${testItem2.id}`).then((r) => r.json());
  check('M21: deleted item gone from DB', !deletedCheck.success || deletedCheck.message === 'Item not found');

  const anonUpdate = await fetch(`${API}/admin/users/999`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: true }),
  }).then((r) => r.json());
  check('M22: anonymous admin/users PUT -> 401', !anonUpdate.success);

  jar.clear();
  await loginAs(U1.email, U1.password);
  const u1Update = await fetch(`${API}/admin/users/999`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: true }),
  }).then((r) => r.json());
  check('M23: normal user admin/users PUT -> 403', !u1Update.success);

  const u1SelfRole = await fetch(`${API}/admin/users/${meResp.user?.id || 1}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  }).then((r) => r.json());
  check('M24: normal user self-promote -> 403', !u1SelfRole.success);

  jar.clear();
  await loginAs(ADM.email, ADM.password);

  const u1Row = aUsers.users.find((u) => u.email === U1.email);
  const blockResp = await fetch(`${API}/admin/users/${u1Row.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: true }),
  }).then((r) => r.json());
  check('M25: admin blocks user -> 200', blockResp.success && blockResp.user.blocked);

  jar.clear();
  const blockedLogin = await loginAs(U1.email, U1.password);
  check('M26: blocked user login -> 401 or 403',
    blockedLogin.success === false || (blockedLogin.message && blockedLogin.message.toLowerCase().includes('disabled')));

  jar.clear();
  await loginAs(ADM.email, ADM.password);
  const unblockResp = await fetch(`${API}/admin/users/${u1Row.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocked: false }),
  }).then((r) => r.json());
  check('M27: admin unblocks user -> 200', unblockResp.success && !unblockResp.user.blocked);

  jar.clear();
  const unblockedLogin = await loginAs(U1.email, U1.password);
  check('M28: unblocked user login -> 200', unblockedLogin.success);

  jar.clear();
  await loginAs(ADM.email, ADM.password);
  const roleResp = await fetch(`${API}/admin/users/${u1Row.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  }).then((r) => r.json());
  check('M29: admin changes user role -> 200', roleResp.success && roleResp.user.role === 'admin');

  const demoteResp = await fetch(`${API}/admin/users/${u1Row.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user' }),
  }).then((r) => r.json());
  check('M30: admin demotes user -> 200', demoteResp.success && demoteResp.user.role === 'user');

  const meCheck = await fetch(`${API}/auth/me`).then((r) => r.json());
  check('M31: admin /auth/me includes role', meCheck.success && meCheck.user.role === 'admin');

  jar.clear();
  await loginAs(U2.email, U2.password);
  const u2Me = await fetch(`${API}/auth/me`).then((r) => r.json());
  check('M32: normal user /auth/me has role=user', u2Me.success && u2Me.user.role === 'user');

  jar.clear();
  await loginAs(ADM.email, ADM.password);
  const logsResp = await fetch(`${API}/admin/logs`).then((r) => r.json());
  check('M33: admin logs -> 200', logsResp.success && Array.isArray(logsResp.logs));
  check('M34: logs contain at least 1 entry', logsResp.logs.length >= 1);
  check('M35: log entry has required fields',
    logsResp.logs.every((l) => l.action && l.target_type && l.created_at));

  jar.clear();
  await loginAs(U2.email, U2.password);
  const loginBlocked = await loginAs(U1.email, U1.password);
  check('M36: U1 still loginable after role tests', loginBlocked.success);

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  const anonUser = await fetch(`${API}/auth/me`).then((r) => r.json());
  check('M37: after logout, /auth/me -> 401', !anonUser.success);

  const meAfterLogin = await fetch(`${API}/auth/me`).then((r) => r.json());
  check('M38: logged-out /auth/me -> 401', !meAfterLogin.success);

  await loginAs(ADM.email, ADM.password);
  const detailResp = await fetch(`${API}/items/${testItem.id}`).then((r) => r.json());
  check('M39: regular user can get item via /api/items', detailResp.success);

  jar.clear();
}

console.log('--- Phase N: report listing system ---');
{
  smokeUserReady = false;
  await ensureSmokeUser();

  const NR1 = { name: 'Report User 1', email: `rpt1.${Date.now()}@test.edu`, password: 'rptpass123' };
  const NR2 = { name: 'Report User 2', email: `rpt2.${Date.now()}@test.edu`, password: 'rptpass1234' };
  const NADM = { name: 'Report Admin', email: `rptadmin.${Date.now()}@test.edu`, password: 'rptadmin123' };

  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(NR1),
  });
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(NR2),
  });
  await fetch(`${API}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(NADM),
  });

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});

  await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: NADM.email, password: NADM.password }),
  });
  const nMeResp = await fetch(`${API}/auth/me`).then((r) => r.json());
  const nAdminId = nMeResp.user?.id;
  execSync(`"${join(root, '.venv', 'Scripts', 'python.exe')}" -c "from backend.database import get_connection; db=get_connection(); db.execute(\\"UPDATE users SET role='admin' WHERE id=${nAdminId}\\"); db.commit()"`, { cwd: root });

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});

  const nLoginAs = async (email, password) => {
    jar.clear();
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return r.json();
  };

  jar.clear();
  smokeUserReady = false;
  await ensureSmokeUser();

  const nReportItem = await apiPost({
    item_name: 'N-Test Wallet', category: 'wallets', type: 'lost',
    description: 'Test item for report system.',
    date: new Date().toISOString().slice(0, 10), location: 'Campus Center',
    contact_number: '+1 555-7001', email: '', additional_details: '',
    university: 'mdu',
  });

  const nReportItem2 = await apiPost({
    item_name: 'N-Test Laptop', category: 'electronics', type: 'found',
    description: 'Second test item for report system.',
    date: new Date().toISOString().slice(0, 10), location: 'Library',
    contact_number: '+1 555-7002', email: '', additional_details: '',
    university: 'du',
  });

  jar.clear();
  const anonReport = await fetch(`${API}/items/${nReportItem.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'fake', details: 'Test report' }),
  }).then((r) => r.json());
  check('N1: anonymous report attempt -> 401', !anonReport.success);

  await nLoginAs(NR1.email, NR1.password);
  const u1Report = await fetch(`${API}/items/${nReportItem.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'fake', details: 'Looks suspicious' }),
  }).then((r) => r.json());
  check('N2: logged-in user report -> 201', u1Report.success && u1Report.report);

  const u1DupeReport = await fetch(`${API}/items/${nReportItem.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'duplicate', details: '' }),
  }).then((r) => r.json());
  check('N3: duplicate pending report rejected', !u1DupeReport.success);

  const badReasonReport = await fetch(`${API}/items/${nReportItem.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'badreason' }),
  }).then((r) => r.json());
  check('N4: invalid reason rejected', !badReasonReport.success);

  const noexistReport = await fetch(`${API}/items/99999/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'fake' }),
  }).then((r) => r.json());
  check('N5: report non-existent item -> 404', !noexistReport.success);

  const u1AdminReports = await fetch(`${API}/admin/reports`).then((r) => r.json());
  check('N6: normal user admin/reports -> 403', !u1AdminReports.success);

  jar.clear();
  await nLoginAs(NR2.email, NR2.password);
  const u2Report = await fetch(`${API}/items/${nReportItem.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'inappropriate', details: 'Inappropriate content' }),
  }).then((r) => r.json());
  check('N7: second user reports same listing -> 201', u2Report.success);

  const u2Report2 = await fetch(`${API}/items/${nReportItem2.id}/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'prohibited', details: '' }),
  }).then((r) => r.json());
  check('N8: second user reports second item -> 201', u2Report2.success);

  jar.clear();
  await nLoginAs(NADM.email, NADM.password);
  const adminReportList = await fetch(`${API}/admin/reports`).then((r) => r.json());
  check('N9: admin admin/reports -> 200', adminReportList.success && Array.isArray(adminReportList.reports));
  check('N10: admin sees >= 3 reports', adminReportList.reports.length >= 3);

  const adminPending = await fetch(`${API}/admin/reports?status=pending`).then((r) => r.json());
  check('N11: admin filter by status=pending', adminPending.success && adminPending.reports.every((r) => r.status === 'pending'));

  const adminFakeReason = await fetch(`${API}/admin/reports?reason=fake`).then((r) => r.json());
  check('N12: admin filter by reason=fake', adminFakeReason.success && adminFakeReason.reports.every((r) => r.reason === 'fake'));

  const adminUniFilter = await fetch(`${API}/admin/reports?university=mdu`).then((r) => r.json());
  check('N13: admin filter by university=mdu', adminUniFilter.success);

  const firstReport = adminReportList.reports.find((r) => r.listing_id === nReportItem.id && r.status === 'pending');
  check('N14: report has required fields', firstReport && firstReport.reporter_name && firstReport.owner_name && firstReport.reason);

  const resolveResp = await fetch(`${API}/admin/reports/${firstReport.id}/resolve`, {
    method: 'PUT',
  }).then((r) => r.json());
  check('N15: admin resolve report -> 200', resolveResp.success);

  const reResolve = await fetch(`${API}/admin/reports/${firstReport.id}/resolve`, {
    method: 'PUT',
  }).then((r) => r.json());
  check('N16: re-resolve already resolved report rejected', !reResolve.success);

  const anotherPending = adminReportList.reports.find((r) => r.status === 'pending' && r.id !== firstReport.id);

  jar.clear();
  await nLoginAs(NR1.email, NR1.password);
  const u1Resolve = await fetch(`${API}/admin/reports/${anotherPending.id}/resolve`, {
    method: 'PUT',
  }).then((r) => r.json());
  check('N17: normal user cannot resolve reports', !u1Resolve.success);

  const u1Dismiss = await fetch(`${API}/admin/reports/${anotherPending.id}/dismiss`, {
    method: 'PUT',
  }).then((r) => r.json());
  check('N18: normal user cannot dismiss reports', !u1Dismiss.success);

  const u1DeleteReport = await fetch(`${API}/admin/reports/${anotherPending.id}`, {
    method: 'DELETE',
  }).then((r) => r.json());
  check('N19: normal user cannot delete reports', !u1DeleteReport.success);

  jar.clear();
  await nLoginAs(NADM.email, NADM.password);

  const dismissResp = await fetch(`${API}/admin/reports/${anotherPending.id}/dismiss`, {
    method: 'PUT',
  }).then((r) => r.json());
  check('N20: admin dismiss report -> 200', dismissResp.success);

  const nItemDetail = await fetch(`${API}/items/${nReportItem.id}`).then((r) => r.json());
  check('N21: item has report_count', nItemDetail.item && nItemDetail.item.report_count >= 1);
  check('N22: item has pending_report_count', nItemDetail.item && typeof nItemDetail.item.pending_report_count === 'number');

  const nAdminItemDetail = await fetch(`${API}/admin/items`).then((r) => r.json());
  const adminItemRow = nAdminItemDetail.items.find((i) => i.id === nReportItem.id);
  check('N23: admin items have report_count', adminItemRow && adminItemRow.report_count >= 1);

  const nStats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('N24: admin stats has pending_reports', nStats.stats && typeof nStats.stats.pending_reports === 'number');
  check('N25: admin stats has total_reports', nStats.stats && typeof nStats.stats.total_reports === 'number');

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  const nPubItem = await fetch(`${API}/items/${nReportItem.id}`).then((r) => r.json());
  check('N26: public item response has report_count', nPubItem.item && typeof nPubItem.item.report_count === 'number');
  check('N27: public item has no reporter_id exposed', nPubItem.item && !nPubItem.item.reporter_id);

  await nLoginAs(NADM.email, NADM.password);
  const delReportItem = await fetch(`${API}/admin/items/${nReportItem2.id}`, {
    method: 'DELETE',
  }).then((r) => r.json());
  check('N28: admin removes reported listing -> 200', delReportItem.success);

  const deletedCheck = await fetch(`${API}/items/${nReportItem2.id}`).then((r) => r.json());
  check('N29: removed listing gone from DB', !deletedCheck.success || deletedCheck.message === 'Item not found');

  const ownerStillExists = await fetch(`${API}/admin/users`).then((r) => r.json());
  const ownerRow = ownerStillExists.users.find((u) => u.email === NR2.email);
  check('N30: owner account NOT deleted when listing removed', !!ownerRow);

  const logsAfter = await fetch(`${API}/admin/logs`).then((r) => r.json());
  check('N31: audit logs contain report actions', logsAfter.logs.some((l) => l.action === 'report_created'));

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const nCtx = await bootApp({ clf_user: JSON.stringify(nMeResp.user) });
  try {
    await nCtx.go(`#/item/${nReportItem.id}`);
    await until(() => nCtx.app.querySelector('.detail-grid'));
    check('[ui] N32: detail page loads for reported item',
      nCtx.app.querySelector('.detail-grid') !== null);

    const reportBtn = nCtx.app.querySelector('[data-report-listing]');
    check('[ui] N33: report button visible for admin',
      reportBtn !== null);

    check('[ui] N34: zero console errors', nCtx.jsErrors.length === 0, nCtx.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await nCtx.close();
  }

  jar.clear();
}

// ==================== Phase O: Smart Match system ====================
{
  console.log('--- Phase O: smart match system ---');

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  const O_USER_A = { name: 'Match Owner A', email: 'match.ownerA@clf.test', password: 'matchpass123' };
  const O_USER_B = { name: 'Match Owner B', email: 'match.ownerB@clf.test', password: 'matchpass123' };

  async function ensureOUser(u) {
    let r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then((x) => x.json());
    if (r.success) return r.user;
    r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) }).then((x) => x.json());
    return r.user;
  }

  const oUserA = await ensureOUser(O_USER_A);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const oUserB = await ensureOUser(O_USER_B);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});

  // O1: Create a FOUND wallet by User B
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  const oFoundRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Black leather wallet', category: 'wallets', type: 'found', description: 'Black leather wallet found at Central Library',
    date: '2026-08-25', location: 'Central Library', contact_number: '+1 555 100 0001', email: O_USER_B.email, additional_details: 'Contains college ID', university: 'kuk'
  }) }).then((r) => r.json());
  const oFoundItem = oFoundRes.item;
  check('O1: found wallet created', !!oFoundItem);

  // O2: Login as User A and create LOST wallet (should trigger match)
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oLostRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Black leather wallet', category: 'wallets', type: 'lost', description: 'Black leather wallet lost at Central Library',
    date: '2026-08-25', location: 'Central Library', contact_number: '+1 555 200 0001', email: O_USER_A.email, additional_details: 'Has college ID inside', university: 'kuk'
  }) }).then((r) => r.json());
  const oLostItem = oLostRes.item;
  check('O2: lost wallet created', !!oLostItem);

  // O3: Lost + Found same university/category/location → match
  const oMatchesA = await fetch(`${API}/items/${oLostItem.id}/matches`).then((r) => r.json());
  check('O3: lost item has matches', oMatchesA.success && oMatchesA.count >= 1);

  // O4: Check match has required fields
  const firstMatch = (oMatchesA.matches || [])[0];
  check('O4: match has required fields',
    firstMatch && firstMatch.id && firstMatch.listingId && firstMatch.confidence && firstMatch.title);

  // O5: Different universities → lower/no match
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  const oDiffUniRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Red notebook', category: 'books', type: 'found', description: 'Red notebook found near bus stop',
    date: '2026-08-25', location: 'Main Gate', contact_number: '+1 555 300 0001', email: O_USER_B.email, additional_details: '', university: 'du'
  }) }).then((r) => r.json());
  const oDiffItem = oDiffUniRes.item;
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oDiffLostRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Blue notebook', category: 'books', type: 'lost', description: 'Blue notebook lost in lecture hall',
    date: '2026-08-25', location: 'Exam Hall B', contact_number: '+1 555 400 0001', email: O_USER_A.email, additional_details: '', university: 'mdu'
  }) }).then((r) => r.json());
  const oDiffLostItem = oDiffLostRes.item;
  const oDiffMatches = await fetch(`${API}/items/${oDiffLostItem.id}/matches`).then((r) => r.json());
  check('O5: different uni/category no high match', (oDiffMatches.matches || []).every((m) => m.confidence !== 'high'));

  // O6: User A creates a second found wallet so User B's lost wallet can match it (same-reporter_id skip means B can't match B)
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oAFound2 = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Leather wallet', category: 'wallets', type: 'found', description: 'Leather wallet found at Central Library',
    date: '2026-08-25', location: 'Central Library', contact_number: '+1 555 500 0001', email: O_USER_A.email, additional_details: '', university: 'kuk'
  }) }).then((r) => r.json());
  check('O6: user A creates found wallet for B matching', !!oAFound2.item);

  // O6b: User B creates lost wallet — should match A's found wallet
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  const oAnotherLost = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Black leather wallet', category: 'wallets', type: 'lost', description: 'Black leather wallet lost at Central Library',
    date: '2026-08-25', location: 'Central Library', contact_number: '+1 555 600 0001', email: O_USER_B.email, additional_details: '', university: 'kuk'
  }) }).then((r) => r.json());
  check('O6b: user B creates lost wallet', !!oAnotherLost.item);

  // O7: Notifications created for User A
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oNotifs = await fetch(`${API}/notifications`).then((r) => r.json());
  check('O7: user A has notifications', oNotifs.success && (oNotifs.notifications || []).length >= 1);

  // O8: Notification has unread state
  const oFirstNotif = (oNotifs.notifications || [])[0];
  check('O8: notification has required fields',
    oFirstNotif && oFirstNotif.id && oFirstNotif.listingId && oFirstNotif.confidence && 'isRead' in oFirstNotif);

  // O9: Unread count matches
  check('O9: unread count correct', oNotifs.unreadCount >= 1);

  // O10: Mark notification as read
  if (oFirstNotif) {
    const markRes = await fetch(`${API}/notifications/${oFirstNotif.id}/read`, { method: 'PUT' }).then((r) => r.json());
    check('O10: mark notification read', markRes.success);
  }

  // O11: Mark all as read
  const markAllRes = await fetch(`${API}/notifications/read-all`, { method: 'PUT' }).then((r) => r.json());
  check('O11: mark all as read', markAllRes.success);
  const oNotifsAfter = await fetch(`${API}/notifications`).then((r) => r.json());
  check('O11b: unread count is 0 after mark all', oNotifsAfter.unreadCount === 0);

  // O12: Duplicate match does not create duplicate notification
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oNotifsBefore = await fetch(`${API}/notifications`).then((r) => r.json());
  const cntBefore = (oNotifsBefore.notifications || []).filter((n) => n.listingId === String(oLostItem.id)).length;
  check('O12: duplicate notif count before', cntBefore >= 1);

  // O13: Anonymous cannot access matches
  jar.clear();
  const oAnonMatches = await fetch(`${API}/items/${oLostItem.id}/matches`).then((r) => r.json()).catch(() => ({}));
  check('O13: anonymous cannot access matches', oAnonMatches.success === false || oAnonMatches.message);

  // O14: Anonymous cannot access notifications
  const oAnonNotifs = await fetch(`${API}/notifications`).then((r) => r.json()).catch(() => ({}));
  check('O14: anonymous cannot access notifications', oAnonNotifs.success === false || oAnonNotifs.message);

  // O15: User A cannot access User B's notifications
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  const oBNotifs = await fetch(`${API}/notifications`).then((r) => r.json());
  const oBHasAItems = (oBNotifs.notifications || []).some((n) => n.listingId === String(oLostItem.id));
  check('O15: user B does NOT see user A notifications', !oBHasAItems);

  // O16: Owner can dismiss a match
  const oBMatchForItem = (await fetch(`${API}/items/${oAnotherLost.item.id}/matches`).then((r) => r.json())).matches || [];
  check('O16a: lost item has matches for B', oBMatchForItem.length >= 1);
  if (oBMatchForItem.length) {
    const oDismissRes = await fetch(`${API}/matches/${oBMatchForItem[0].id}/dismiss`, { method: 'PUT' }).then((r) => r.json());
    check('O16b: dismiss match success', oDismissRes.success);
    const oBMatchAfter = (await fetch(`${API}/items/${oAnotherLost.item.id}/matches`).then((r) => r.json())).matches || [];
    check('O16c: dismissed match not shown', oBMatchAfter.every((m) => m.id !== oBMatchForItem[0].id));
  }

  // O17: Other user cannot dismiss
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  if (oBMatchForItem.length) {
    const oCrossDismiss = await fetch(`${API}/matches/${oBMatchForItem[0].id}/dismiss`, { method: 'PUT' }).then((r) => r.json());
    check('O17: other user cannot dismiss', oCrossDismiss.success === false);
  } else {
    check('O17: other user cannot dismiss', true);
  }

  // O18: Returned listing no longer in matches
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  await fetch(`${API}/items/${oFoundItem.id}/returned`, { method: 'PUT' }).then((r) => r.json());
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oMatchesAfterReturn = await fetch(`${API}/items/${oLostItem.id}/matches`).then((r) => r.json());
  check('O18: returned item not in matches', (oMatchesAfterReturn.matches || []).every((m) => m.listingId !== String(oFoundItem.id)));

  // O19: Admin match stats
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  execSync(`"${join(root, '.venv', 'Scripts', 'python.exe')}" -c "from backend.database import get_connection; from werkzeug.security import generate_password_hash; db=get_connection(); db.execute('INSERT OR IGNORE INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', ('SmokeAdmin', 'admin@clf.test', generate_password_hash('adminpass123'), 'admin')); db.commit()"`, { cwd: root });
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@clf.test', password: 'adminpass123' }) }).then((r) => r.json());
  const oAdminStats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('O19: admin stats has total_matches', 'total_matches' in (oAdminStats.stats || {}));
  check('O19b: admin stats has high_matches', 'high_matches' in (oAdminStats.stats || {}));

  // O20: Owner-only match endpoint
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_A.email, password: O_USER_A.password }) }).then((r) => r.json());
  const oOwnerMatch = await fetch(`${API}/items/${oLostItem.id}/matches`).then((r) => r.json());
  check('O20: owner can see matches', oOwnerMatch.success);

  // O21: Non-owner cannot see another user matches
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: O_USER_B.email, password: O_USER_B.password }) }).then((r) => r.json());
  const oNonOwnerMatch = await fetch(`${API}/items/${oLostItem.id}/matches`).then((r) => r.json());
  check('O21: non-owner cannot see matches', oNonOwnerMatch.success === false);

  // O22: UI - detail page for owner shows matches section
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const oCtxA = await bootApp({ clf_user: JSON.stringify(oUserA) });
  try {
    await oCtxA.go(`#/item/${oLostItem.id}`);
    await until(() => oCtxA.app.querySelector('.detail-grid'));
    const matchSection = oCtxA.app.querySelector('#matchSection');
    check('O22: match section exists on owner detail', matchSection !== null);
    check('O23: zero console errors', oCtxA.jsErrors.length === 0, oCtxA.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await oCtxA.close();
  }

  // O24: Notification bell exists for logged-in user
  jar.clear();
  const oCtxBell = await bootApp({ clf_user: JSON.stringify(oUserA) });
  try {
    await oCtxBell.go('#/');
    await until(() => oCtxBell.app.querySelector('.container'));
    const notifBtn = oCtxBell.w.document.getElementById('notifBtn');
    check('O24: notification bell button exists', notifBtn !== null);
    check('O24b: zero console errors', oCtxBell.jsErrors.length === 0, oCtxBell.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await oCtxBell.close();
  }

  jar.clear();
}

// ==================== Phase P: Claim This Item workflow ====================
{
  console.log('--- Phase P: claim this item workflow ---');

  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  const P_OWNER = { name: 'Claim Owner', email: 'claim.owner@clf.test', password: 'claimpass123' };
  const P_CLAIMANT = { name: 'Claim Claimant', email: 'claim.claimant@clf.test', password: 'claimpass123' };
  const P_THIRD = { name: 'Claim Third', email: 'claim.third@clf.test', password: 'claimpass123' };

  async function ensurePUser(u) {
    let r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) }).then((x) => x.json());
    if (r.success) return r.user;
    r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) }).then((x) => x.json());
    return r.user;
  }

  const pOwner = await ensurePUser(P_OWNER);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const pClaimant = await ensurePUser(P_CLAIMANT);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const pThird = await ensurePUser(P_THIRD);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P1: Owner creates a found item
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pFoundRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Blue backpack', category: 'bags', type: 'found', description: 'Blue Jansport backpack found in Lecture Hall A',
    date: '2026-08-25', location: 'Lecture Hall A', contact_number: '+1 555 700 0001', email: P_OWNER.email,
    additional_details: 'Has a math textbook and a water bottle inside', university: 'kuk'
  }) }).then((r) => r.json());
  const pFoundItem = pFoundRes.item;
  check('P1: found item created', !!pFoundItem && pFoundItem.type === 'found');
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P2: Anonymous claim -> 401
  jar.clear();
  const pAnonClaim = await fetch(`${API}/items/${pFoundItem.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'This is my backpack with my math textbook inside.' }) }).then((r) => r.json());
  check('P2: anonymous claim -> 401', pAnonClaim.success === false);

  // P3: Owner claims own item -> blocked
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pOwnClaim = await fetch(`${API}/items/${pFoundItem.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'This is my backpack with my math textbook inside.' }) }).then((r) => r.json());
  check('P3: owner claiming own item -> blocked', pOwnClaim.success === false);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P4: Claim with too-short proof -> rejected
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pShortProof = await fetch(`${API}/items/${pFoundItem.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'Short' }) }).then((r) => r.json());
  check('P4: short proof rejected', pShortProof.success === false);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P5: Valid claim -> created
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pValidClaim = await fetch(`${API}/items/${pFoundItem.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'This is my backpack. It has a math textbook (Calculus 3rd edition), a blue water bottle, and stickers on the front pocket.' }) }).then((r) => r.json());
  check('P5: valid claim created', pValidClaim.success === true && pValidClaim.claim && pValidClaim.claim.status === 'pending');
  const pClaimId = pValidClaim.claim.id;

  // P6: Duplicate claim by same user -> blocked
  const pDupClaim = await fetch(`${API}/items/${pFoundItem.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'I am claiming again with different proof details that are at least ten characters.' }) }).then((r) => r.json());
  check('P6: duplicate claim blocked', pDupClaim.success === false);

  // P7: Non-owner cannot see claims
  const pNonOwnerClaims = await fetch(`${API}/items/${pFoundItem.id}/claims`).then((r) => r.json());
  check('P7: non-owner cannot see claims', pNonOwnerClaims.success === false);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P8: Anonymous cannot see claims
  jar.clear();
  const pAnonClaims = await fetch(`${API}/items/${pFoundItem.id}/claims`).then((r) => r.json());
  check('P8: anonymous cannot see claims', pAnonClaims.success === false);

  // P9: Owner can see claims
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pOwnerClaims = await fetch(`${API}/items/${pFoundItem.id}/claims`).then((r) => r.json());
  check('P9: owner sees claims', pOwnerClaims.success && pOwnerClaims.claims.length >= 1);
  check('P9b: claim has required fields', pOwnerClaims.claims[0].claimant_name && pOwnerClaims.claims[0].proof_details && pOwnerClaims.claims[0].status === 'pending');
  // Verify claimant name is exposed but proof is visible only to owner
  check('P9c: claim shows claimant name', pOwnerClaims.claims[0].claimant_name === 'Claim Claimant');

  // P10: Non-owner cannot accept/reject claims
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pClaimantAccept = await fetch(`${API}/claims/${pClaimId}/accept`, { method: 'PUT' }).then((r) => r.json());
  check('P10: non-owner cannot accept claim', pClaimantAccept.success === false);
  const pClaimantReject = await fetch(`${API}/claims/${pClaimId}/reject`, { method: 'PUT' }).then((r) => r.json());
  check('P10b: non-owner cannot reject claim', pClaimantReject.success === false);
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P11: Owner accepts claim -> item returned
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pAccept = await fetch(`${API}/claims/${pClaimId}/accept`, { method: 'PUT' }).then((r) => r.json());
  check('P11: owner accepts claim', pAccept.success === true);

  // P12: Item is now returned
  const pItemAfterAccept = await fetch(`${API}/items/${pFoundItem.id}`).then((r) => r.json());
  check('P12: item status is returned', pItemAfterAccept.item && pItemAfterAccept.item.status === 'returned');

  // P13: Claim status is accepted
  const pClaimsAfter = await fetch(`${API}/items/${pFoundItem.id}/claims`).then((r) => r.json());
  const pAcceptedClaim = pClaimsAfter.claims.find((c) => c.id === pClaimId);
  check('P13: claim status is accepted', pAcceptedClaim && pAcceptedClaim.status === 'accepted');

  // P14: Other pending claims are auto-rejected
  // (Create a second item for reject test)

  // P15: Owner creates second found item
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pFound2Res = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Red notebook', category: 'books', type: 'found', description: 'Red spiral notebook found in Library',
    date: '2026-08-25', location: 'Central Library', contact_number: '+1 555 800 0001', email: P_OWNER.email,
    additional_details: 'Has class notes for Physics', university: 'kuk'
  }) }).then((r) => r.json());
  const pFound2 = pFound2Res.item;
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P16: Claimant claims second item
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pClaim2 = await fetch(`${API}/items/${pFound2.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'This is my red notebook with Physics class notes, chapter 1 through 10, dated August 2026.' }) }).then((r) => r.json());
  check('P16: second claim created', pClaim2.success && pClaim2.claim);
  const pClaim2Id = pClaim2.claim.id;
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P27: My Listings shows pending claims for owner (while claim is still pending)
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pCtxMyListings = await bootApp({ clf_user: JSON.stringify(pOwner) });
  try {
    await pCtxMyListings.go('#/my-listings');
    await until(() => pCtxMyListings.app.querySelector('.grid-cards'));
    await new Promise((r) => setTimeout(r, 800));
    const claimsSection = pCtxMyListings.app.querySelector('#claimsSection');
    const hasClaimsVisible = claimsSection && !claimsSection.hidden;
    check('P27: my listings shows claims section', hasClaimsVisible === true);
    const claimCard = pCtxMyListings.app.querySelector('.claim-card');
    check('P27b: claim card rendered', claimCard !== null);
    const acceptBtn = pCtxMyListings.app.querySelector('[data-claim-accept]');
    check('P27c: accept button exists', acceptBtn !== null);
    const rejectBtn = pCtxMyListings.app.querySelector('[data-claim-reject]');
    check('P27d: reject button exists', rejectBtn !== null);
    check('P27e: zero console errors', pCtxMyListings.jsErrors.length === 0, pCtxMyListings.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await pCtxMyListings.close();
  }
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P17: Owner rejects claim -> item remains active
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pReject = await fetch(`${API}/claims/${pClaim2Id}/reject`, { method: 'PUT' }).then((r) => r.json());
  check('P17: owner rejects claim', pReject.success === true);
  const pItemAfterReject = await fetch(`${API}/items/${pFound2.id}`).then((r) => r.json());
  check('P17b: item remains active after reject', pItemAfterReject.item && pItemAfterReject.item.status === 'found');

  // P18: Claim status is rejected
  const pClaims2After = await fetch(`${API}/items/${pFound2.id}/claims`).then((r) => r.json());
  const pRejectedClaim = pClaims2After.claims.find((c) => c.id === pClaim2Id);
  check('P18: claim status is rejected', pRejectedClaim && pRejectedClaim.status === 'rejected');
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P19: Claimant receives claim notifications
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pClaimNotifs = await fetch(`${API}/notifications`).then((r) => r.json());
  check('P19: claimant has notifications', pClaimNotifs.success);
  const pClaimNotifItems = (pClaimNotifs.notifications || []).filter((n) => n.notifType === 'claim');
  check('P19b: claimant has claim notification', pClaimNotifItems.length >= 1);
  check('P19c: accepted claim notification exists', pClaimNotifItems.some((n) => n.claimStatus === 'accepted'));
  check('P19d: rejected claim notification exists', pClaimNotifItems.some((n) => n.claimStatus === 'rejected'));

  // P20: Claim notifications are read-able
  const pFirstClaimNotif = pClaimNotifItems[0];
  if (pFirstClaimNotif) {
    const pMarkClaim = await fetch(`${API}/notifications/${encodeURIComponent(pFirstClaimNotif.id)}/read`, { method: 'PUT' }).then((r) => r.json());
    check('P20: claim notification mark-read works', pMarkClaim.success);
  }
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P21: Returned item disappears from matches
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pClaimantMatches = await fetch(`${API}/items/${pFoundItem.id}/matches`).then((r) => r.json()).catch(() => ({}));
  check('P21: returned item not in matches (or 403 owner-only)', pClaimantMatches.success === false || (pClaimantMatches.matches || []).every((m) => m.status !== 'returned'));

  // P22: Owner sees pending claim count on item detail
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pOwnerItem2 = await fetch(`${API}/items/${pFound2.id}`).then((r) => r.json());
  check('P22: item has pending_claim_count', pOwnerItem2.item && typeof pOwnerItem2.item.pending_claim_count === 'number');
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();

  // P23: Admin stats include claims
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@clf.test', password: 'adminpass123' }) }).then((r) => r.json());
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  execSync(`"${join(root, '.venv', 'Scripts', 'python.exe')}" -c "from backend.database import get_connection; from werkzeug.security import generate_password_hash; db=get_connection(); db.execute('INSERT OR IGNORE INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', ('PAdmin', 'admin@clf.test', generate_password_hash('adminpass123'), 'admin')); db.commit()"`, { cwd: root });
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@clf.test', password: 'adminpass123' }) }).then((r) => r.json());
  const pAdminStats = await fetch(`${API}/admin/stats`).then((r) => r.json());
  check('P23: admin stats has total_claims', 'total_claims' in (pAdminStats.stats || {}));
  check('P23b: admin stats has pending_claims', 'pending_claims' in (pAdminStats.stats || {}));

  // P24: UI - claim button exists on found-item detail for non-owner
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const pCtxClaimant = await bootApp({ clf_user: JSON.stringify(pClaimant) });
  try {
    await pCtxClaimant.go(`#/item/${pFound2.id}`);
    await until(() => pCtxClaimant.app.querySelector('.detail-grid'));
    const claimBtn = pCtxClaimant.app.querySelector('[data-claim-item]');
    check('P24: claim button visible for non-owner', claimBtn !== null);
    check('P24b: zero console errors', pCtxClaimant.jsErrors.length === 0, pCtxClaimant.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await pCtxClaimant.close();
  }

  // P25: UI - owner does NOT see claim button
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pCtxOwner = await bootApp({ clf_user: JSON.stringify(pOwner) });
  try {
    await pCtxOwner.go(`#/item/${pFound2.id}`);
    await until(() => pCtxOwner.app.querySelector('.detail-grid'));
    const claimBtnOwner = pCtxOwner.app.querySelector('[data-claim-item]');
    check('P25: owner does NOT see claim button', claimBtnOwner === null);
    check('P25b: zero console errors', pCtxOwner.jsErrors.length === 0, pCtxOwner.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await pCtxOwner.close();
  }

  // P26: UI - claim button does NOT appear on lost-item detail
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_OWNER.email, password: P_OWNER.password }) }).then((r) => r.json());
  const pLostRes = await fetch(`${API}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    item_name: 'Lost keys', category: 'keys', type: 'lost', description: 'Lost my keys near parking lot',
    date: '2026-08-25', location: 'Parking Lot B', contact_number: '+1 555 900 0001', email: P_OWNER.email,
    additional_details: '', university: 'kuk'
  }) }).then((r) => r.json());
  const pLostItem = pLostRes.item;
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  const pCtxLost = await bootApp({ clf_user: JSON.stringify(pClaimant) });
  try {
    await pCtxLost.go(`#/item/${pLostItem.id}`);
    await until(() => pCtxLost.app.querySelector('.detail-grid'));
    const claimBtnLost = pCtxLost.app.querySelector('[data-claim-item]');
    check('P26: no claim button on lost item', claimBtnLost === null);
    check('P26b: zero console errors', pCtxLost.jsErrors.length === 0, pCtxLost.jsErrors.slice(0, 2).join(' | '));
  } finally {
    await pCtxLost.close();
  }

  // P28: Cannot re-claim after rejection
  await fetch(`${API}/auth/logout`, { method: 'POST' }).catch(() => {});
  jar.clear();
  await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: P_CLAIMANT.email, password: P_CLAIMANT.password }) }).then((r) => r.json());
  const pReclaim = await fetch(`${API}/items/${pFound2.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof_details: 'I am trying to claim again after being rejected with new proof details.' }) }).then((r) => r.json());
  check('P28: re-claim after rejection blocked', pReclaim.success === false);

  jar.clear();
}

console.log(failed === 0 ? '\nSMOKE OK — all checks passed' : `\nSMOKE FAILED — ${failed} failing check(s)`);
process.exit(failed === 0 ? 0 : 1);
