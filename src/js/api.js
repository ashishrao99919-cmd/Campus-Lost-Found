export const BASE_URL =
  (typeof window !== 'undefined' && window.__API_BASE__) || '/api';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const STATUS_MESSAGES = {
  400: 'The submitted data was invalid. Please review the form and try again.',
  401: 'You need to be logged in to do that.',
  404: 'That item could not be found on the server.',
  500: 'The server ran into a problem. Please try again shortly.',
};

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE_URL + path, { credentials: 'include', ...options });
  } catch {
    throw new ApiError(
      'Unable to connect to the server. Please make sure the backend is running.',
      0
    );
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok || (body && body.success === false)) {
    const message =
      (body && body.message) ||
      STATUS_MESSAGES[res.status] ||
      'Something went wrong while talking to the server.';
    throw new ApiError(message, res.status);
  }
  return body || {};
}

function splitDetails(value) {
  if (!value) return [];
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    name: row.item_name,
    type: row.type,
    status: row.status,
    category: row.category,
    location: row.location,
    date: row.date,
    description: row.description,
    details: splitDetails(row.additional_details),
    university: row.university || 'other',
    reporter: {
      name: 'Campus Member',
      phone: row.contact_number || '',
      email: row.email || '',
    },
    image: row.image_url || null,
    createdAt: row.created_at || '',
    isOwner: row.is_owner === true,
    reportCount: row.report_count || 0,
    pendingReportCount: row.pending_report_count || 0,
    claimCount: row.claim_count || 0,
    pendingClaimCount: row.pending_claim_count || 0,
    _source: 'api',
  };
}

function queryString(params = {}) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') usp.set(key, value);
  });
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

export function dataURLToBlob(dataURL) {
  const [meta, base64] = String(dataURL).split(',');
  const mime = (meta.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export const api = {
  async listItems(params = {}) {
    const data = await request(`/items${queryString(params)}`);
    return (data.items || []).map(mapItem);
  },

  async getItem(id) {
    const data = await request(`/items/${encodeURIComponent(id)}`);
    return mapItem(data.item);
  },

  async createItem(payload) {
    const data = await request('/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return mapItem(data.item);
  },

  async uploadImage(itemId, dataURL) {
    const blob = dataURLToBlob(dataURL);
    const form = new FormData();
    form.append('image', blob, 'photo.jpg');
    const data = await request(`/items/${encodeURIComponent(itemId)}/image`, {
      method: 'POST',
      body: form,
    });
    return mapItem(data.item);
  },

  async markReturned(itemId) {
    const data = await request(`/items/${encodeURIComponent(itemId)}/returned`, {
      method: 'PUT',
    });
    return mapItem(data.item);
  },

  async validateCategory(payload) {
    return request('/categories/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async checkListing(payload) {
    return request('/listings/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async updateItem(itemId, payload) {
    const data = await request(`/items/${encodeURIComponent(itemId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return mapItem(data.item);
  },

  async deleteItem(itemId) {
    return request(`/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  },

  async register(name, email, password) {
    const data = await request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    return data;
  },

  async login(email, password) {
    const data = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return data;
  },

  async logout() {
    return request('/auth/logout', { method: 'POST' });
  },

  async getCurrentUser() {
    try {
      const data = await request('/auth/me');
      return data.user || null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },

  async adminStats() {
    return request('/admin/stats');
  },

  async adminListUsers() {
    return request('/admin/users');
  },

  async adminUpdateUser(userId, payload) {
    return request(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  async adminListItems(params = {}) {
    return request(`/admin/items${queryString(params)}`);
  },

  async adminDeleteItem(itemId) {
    return request(`/admin/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  },

  async adminLogs() {
    return request('/admin/logs');
  },

  async createItemReport(itemId, reason, details) {
    return request(`/items/${encodeURIComponent(itemId)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, details }),
    });
  },

  async adminListReports(params = {}) {
    return request(`/admin/reports${queryString(params)}`);
  },

  async adminResolveReport(reportId) {
    return request(`/admin/reports/${encodeURIComponent(reportId)}/resolve`, {
      method: 'PUT',
    });
  },

  async adminDismissReport(reportId) {
    return request(`/admin/reports/${encodeURIComponent(reportId)}/dismiss`, {
      method: 'PUT',
    });
  },

  async getItemMatches(itemId) {
    return request(`/items/${encodeURIComponent(itemId)}/matches`);
  },

  async getNotifications() {
    return request('/notifications');
  },

  async markNotificationRead(notifId) {
    return request(`/notifications/${encodeURIComponent(notifId)}/read`, {
      method: 'PUT',
    });
  },

  async markAllNotificationsRead() {
    return request('/notifications/read-all', {
      method: 'PUT',
    });
  },

  async dismissMatch(matchId) {
    return request(`/matches/${encodeURIComponent(matchId)}/dismiss`, {
      method: 'PUT',
    });
  },

  async createClaim(itemId, proofDetails) {
    return request(`/items/${encodeURIComponent(itemId)}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof_details: proofDetails }),
    });
  },

  async getItemClaims(itemId) {
    return request(`/items/${encodeURIComponent(itemId)}/claims`);
  },

  async getMyClaims() {
    return request('/my-claims');
  },

  async acceptClaim(claimId) {
    return request(`/claims/${encodeURIComponent(claimId)}/accept`, {
      method: 'PUT',
    });
  },

  async rejectClaim(claimId) {
    return request(`/claims/${encodeURIComponent(claimId)}/reject`, {
      method: 'PUT',
    });
  },
};
