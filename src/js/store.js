import { DEMO_ITEMS } from './data.js';
import { api, ApiError } from './api.js';

const KEYS = {
  returned: 'clf_returned_items',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

let demoReturnedIds = read(KEYS.returned, []);

/* --------------------------------------------- local returned overlay (demo) */

function tagDemo(items) {
  return items.map((i) => ({ ...i, _source: 'demo' }));
}

function statusOf(item) {
  if (!item) return 'lost';
  if (item._source === 'demo' && demoReturnedIds.includes(item.id)) return 'returned';
  return item.status;
}

function markDemoReturned(id) {
  if (demoReturnedIds.includes(id)) return;
  demoReturnedIds = [id, ...demoReturnedIds];
  write(KEYS.returned, demoReturnedIds);
}

/* ------------------------------------------------------------ data facade */

const NETWORK_ERROR = 0;

function demoSubset(params = {}) {
  let items = tagDemo(DEMO_ITEMS);
  if (params.type) items = items.filter((i) => i.status === params.type);
  if (params.status) items = items.filter((i) => statusOf(i) === params.status);
  return items;
}

async function fetchItems(params = {}, { allowFallback = true } = {}) {
  const narrowedByUser = Boolean(params.search);

  try {
    const items = await api.listItems(params);
    return { items, source: 'api' };
  } catch (err) {
    const recoverable =
      err instanceof ApiError && (err.status === NETWORK_ERROR || err.status === 404);
    if (allowFallback && recoverable && !narrowedByUser) {
      return { items: demoSubset(params), source: 'demo', offline: err.status === NETWORK_ERROR };
    }
    throw err;
  }
}

async function fetchItem(id, { allowFallback = true } = {}) {
  try {
    const item = await api.getItem(id);
    return item || fallbackItem(id, allowFallback);
  } catch (err) {
    const notFound = err instanceof ApiError && err.status === 404;
    if ((notFound || err.status === NETWORK_ERROR) && allowFallback) {
      return fallbackItem(id, true);
    }
    throw err;
  }
}

function fallbackItem(id, tag = false) {
  const demo = DEMO_ITEMS.find((i) => i.id === id);
  if (!demo) return null;
  return tag ? { ...demo, _source: 'demo' } : demo;
}

async function createReport(payload, photoData) {
  const item = await api.createItem(payload);
  if (photoData && item) {
    try {
      return await api.uploadImage(item.id, photoData);
    } catch {
      return item;
    }
  }
  return item;
}

async function setReturned(id, knownDemo = false) {
  if (!knownDemo) {
    try {
      return await api.markReturned(id);
    } catch (err) {
      const retryLocally =
        (err instanceof ApiError && (err.status === NETWORK_ERROR || err.status === 404));
      if (!retryLocally) throw err;
    }
  }
  markDemoReturned(id);
  return null;
}

export {
  statusOf,
  fetchItems,
  fetchItem,
  createReport,
  setReturned,
};
