import './style.css';
import { HomePage } from './js/views/home.js';
import { ListPage } from './js/views/list.js';
import { DetailPage } from './js/views/detail.js';
import { ReportPage } from './js/views/report.js';
import { MyListingsPage } from './js/views/my-listings.js';
import { renderNotFound } from './js/components.js';
import { setReturned } from './js/store.js';
import { api } from './js/api.js';
import { $, $$, icon, toast, initReveals, confirmModal, esc } from './js/ui.js';

// ---------------- AUTH ----------------

import { AdminPage } from './js/views/admin.js';

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('clf_user') || 'null');
  } catch {
    return null;
  }
}

function setCurrentUser(user) {
  try {
    if (user) {
      localStorage.setItem('clf_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('clf_user');
    }
  } catch {}
}

function authModal(mode = 'login') {
  const old = document.getElementById('authModal');
  if (old) old.remove();

  const isLogin = mode === 'login';

  const modal = document.createElement('div');
  modal.id = 'authModal';

  modal.innerHTML = `
    <div class="auth-backdrop" data-auth-close></div>

    <div class="auth-box">
      <button class="auth-close" data-auth-close>&times;</button>

      <div class="auth-logo">
        <span>📍</span>
      </div>

      <h2>${isLogin ? 'Welcome Back!' : 'Create Account'}</h2>

      <p class="auth-subtitle">
        ${
          isLogin
            ? 'Login to manage your lost & found reports.'
            : 'Join Campus Lost & Found to report and recover items.'
        }
      </p>

      <form id="authForm">

        ${
          !isLogin
            ? `
              <label>Name</label>
              <input
                type="text"
                id="authName"
                placeholder="Enter your name"
                required
              />
            `
            : ''
        }

        <label>Email</label>
        <input
          type="email"
          id="authEmail"
          placeholder="Enter your email"
          required
        />

        <label>Password</label>
        <input
          type="password"
          id="authPassword"
          placeholder="Enter password"
          minlength="6"
          required
        />

        <button type="submit" class="auth-submit">
          ${isLogin ? 'Login' : 'Create Account'}
        </button>

        <div id="authMessage" class="auth-message"></div>

      </form>

      <div class="auth-switch">
        ${
          isLogin
            ? `
              Don't have an account?
              <button type="button" id="switchSignup">Sign Up</button>
            `
            : `
              Already have an account?
              <button type="button" id="switchLogin">Login</button>
            `
        }
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelectorAll('[data-auth-close]').forEach((el) => {
    el.addEventListener('click', () => modal.remove());
  });

  const switchSignup = document.getElementById('switchSignup');
  if (switchSignup) {
    switchSignup.addEventListener('click', () => authModal('signup'));
  }

  const switchLogin = document.getElementById('switchLogin');
  if (switchLogin) {
    switchLogin.addEventListener('click', () => authModal('login'));
  }

  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const message = document.getElementById('authMessage');
    const submitBtn = document.querySelector('.auth-submit');

    submitBtn.disabled = true;
    submitBtn.textContent = isLogin ? 'Logging in...' : 'Creating account...';
    message.textContent = '';
    message.className = 'auth-message';

    try {
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value;

      if (isLogin) {
        const data = await api.login(email, password);
        setCurrentUser(data.user);
        modal.remove();
        toast('Login successful!', 'success');
        updateAuthUI();

        if (location.hash && location.hash !== '#/') {
          location.hash = '#/';
        } else {
          render();
        }
        window.scrollTo(0, 0);
      } else {
        await api.register(
          document.getElementById('authName').value.trim(),
          email,
          password
        );
        message.textContent = 'Account created successfully! Please login.';
        message.classList.add('success');

        setTimeout(() => {
          authModal('login');
        }, 1000);
      }
    } catch (err) {
      message.textContent =
        err.message || 'Unable to connect to the server.';
      message.classList.add('error');
    } finally {
      if (document.querySelector('.auth-submit')) {
        document.querySelector('.auth-submit').disabled = false;
        document.querySelector('.auth-submit').textContent =
          isLogin ? 'Login' : 'Create Account';
      }
    }
  });
}

function updateAuthUI() {
  const navLinks = document.querySelector('.nav-links');
  if (!navLinks) return;

  const existing = document.getElementById('authNav');

  if (existing) {
    existing.remove();
  }

  const user = getCurrentUser();

  $$('.nav-auth-only').forEach((el) => { el.hidden = !user; });
  $$('.nav-admin-only').forEach((el) => { el.hidden = !(user && user.role === 'admin'); });

  const wrapper = document.createElement('div');
  wrapper.id = 'authNav';
  wrapper.className = 'auth-nav';

  if (user) {
    wrapper.innerHTML = `
      <span class="user-name">
        Hi, ${esc(user.name || 'User')}
      </span>

      <button class="auth-nav-btn logout-btn" id="logoutBtn">
        Logout
      </button>
    `;

    wrapper.querySelector('#logoutBtn').addEventListener('click', async () => {
      try {
        await api.logout();
      } catch (err) {
        toast(err && err.message ? err.message : 'Could not log out. Please try again.', 'error');
        return;
      }

      setCurrentUser(null);
      toast('Logged out successfully', 'success');
      updateAuthUI();

      if (location.hash && location.hash !== '#/') {
        location.hash = '#/';
      } else {
        render();
      }
      window.scrollTo(0, 0);
    });
  } else {
    wrapper.innerHTML = `
      <button class="auth-nav-btn login-btn" id="loginNavBtn">
        Login
      </button>

      <button class="auth-nav-btn signup-btn" id="signupNavBtn">
        Sign Up
      </button>
    `;

    wrapper.querySelector('#loginNavBtn').addEventListener('click', () => {
      authModal('login');
    });

    wrapper.querySelector('#signupNavBtn').addEventListener('click', () => {
      authModal('signup');
    });
  }

  navLinks.appendChild(wrapper);
  loadNotifications();
}

async function verifySession() {
  let serverUser = null;
  try {
    serverUser = await api.getCurrentUser();
  } catch {
    return;
  }
  const localUser = getCurrentUser();
  if (serverUser) {
    if (!localUser || localUser.id !== serverUser.id || localUser.email !== serverUser.email || localUser.name !== serverUser.name) {
      setCurrentUser(serverUser);
      updateAuthUI();
    }
  } else if (localUser) {
    setCurrentUser(null);
    updateAuthUI();
  }
}

const app = document.getElementById('app');
let pendingScrollTarget = null;

function parseHash() {
  let raw = location.hash.replace(/^#/, '');
  if (!raw) raw = '/';
  const [pathPart, qs] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  return { segments, query };
}

function setActiveNav(head) {
  const key =
    head === 'items' || head === 'item' ? 'lost-items' :
    head === 'my-listings' ? 'my-listings' :
    head === 'admin' ? 'admin' :
    head || 'home';
  $$('.nav-links a[data-nav], .mobile-links a[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === key);
  });
}

function closeMobileMenu() {
  const menu = $('#mobileMenu');
  if (!menu) return;
  menu.classList.remove('open');
  $('#menuBtn')?.setAttribute('aria-expanded', 'false');
  setMenuIcon(false);
}

function setMenuIcon(open) {
  const btn = $('#menuBtn');
  if (btn) btn.innerHTML = icon(open ? 'close' : 'menu');
}

function scrollToHowItWorks() {
  const el = document.getElementById('how-it-works');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  const { segments, query } = parseHash();
  const head = segments[0];
  const page = document.createElement('div');

  if (!head) {
    HomePage(page);
    document.title = 'Campus Lost & Found — Help it find its way home';
  } else if (head === 'lost-items') {
    ListPage('lost')(page, query);
    document.title = 'Lost Items — Campus Lost & Found';
  } else if (head === 'found-items') {
    ListPage('found')(page, query);
    document.title = 'Found Items — Campus Lost & Found';
  } else if (head === 'items') {
    ListPage('all')(page, query);
    document.title = 'Browse Items — Campus Lost & Found';
  } else if (head === 'my-listings') {
    MyListingsPage(page, query);
    document.title = 'My Listings — Campus Lost & Found';
  } else if (head === 'item' && segments[1]) {
    DetailPage(page, { ...query, id: decodeURIComponent(segments[1]) });
  } else if (head === 'report') {
    ReportPage(page, query);
  } else if (head === 'admin') {
    AdminPage(page);
    document.title = 'Admin Dashboard — Campus Lost & Found';
  } else {
    renderNotFound(page);
    document.title = 'Not found — Campus Lost & Found';
  }

  app.replaceChildren(page);
  setActiveNav(head);
  closeMobileMenu();
  window.scrollTo(0, 0);
  initPage();
}

function initPage() {
  initReveals(app);
  if (pendingScrollTarget) {
    const target = pendingScrollTarget;
    pendingScrollTarget = null;
    requestAnimationFrame(() => {
      const el = document.getElementById(target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

async function loadNotifications() {
  const user = getCurrentUser();
  const notifWrap = document.querySelector('.notif-wrap');
  const badge = document.getElementById('notifBadge');
  const list = document.getElementById('notifList');
  if (!user) {
    if (notifWrap) notifWrap.hidden = true;
    return;
  }
  if (notifWrap) notifWrap.hidden = false;
  try {
    const data = await api.getNotifications();
    const notifs = data.notifications || [];
    const unread = data.unreadCount || 0;
    if (badge) {
      if (unread > 0) {
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }
    if (!list) return;
    if (!notifs.length) {
      list.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
      return;
    }
    list.innerHTML = notifs.map((n) => {
      const href = `#/item/${encodeURIComponent(n.listingId)}`;
      const time = n.createdAt ? timeAgoShort(n.createdAt) : '';
      let badgeHtml;
      if (n.notifType === 'claim') {
        const claimClass = n.claimStatus === 'accepted' ? 'claim-notif-accepted' : 'claim-notif-rejected';
        const claimLabel = n.claimStatus === 'accepted' ? 'Accepted' : 'Rejected';
        badgeHtml = `<span class="notif-conf ${claimClass}">${claimLabel}</span>`;
      } else {
        const conf = n.confidence || 'low';
        const confClass = conf === 'high' ? 'match-conf-high' : conf === 'medium' ? 'match-conf-medium' : 'match-conf-low';
        const confLabel = conf.charAt(0).toUpperCase() + conf.slice(1);
        badgeHtml = `<span class="notif-conf ${confClass}">${confLabel}</span>`;
      }
      return `<a class="notif-item${n.isRead ? '' : ' unread'}" href="${href}" data-notif-id="${n.id}">
        ${badgeHtml}
        <span class="notif-text">${esc(n.title || 'A possible match was found.')}</span>
        <span class="notif-time">${esc(time)}</span>
      </a>`;
    }).join('');
    list.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const nid = el.dataset.notifId;
        if (nid && el.classList.contains('unread')) {
          try { await api.markNotificationRead(nid); } catch {}
        }
      });
    });
  } catch {
    if (list) list.innerHTML = '<p class="notif-empty">Unable to load notifications.</p>';
  }
}

function timeAgoShort(iso) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff}d ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function openSearch() {
  const overlay = $('#searchOverlay');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#globalSearchInput').focus(), 60);
}

function closeSearch() {
  const overlay = $('#searchOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  $('#globalSearchInput').value = '';
}

function initChrome() {
  updateAuthUI();
  verifySession();
  $('#year').textContent = String(new Date().getFullYear());

  const navSearchBtn = $('#navSearchBtn');
  navSearchBtn.innerHTML = icon('search');
  const menuBtn = $('#menuBtn');
  setMenuIcon(false);

  $$('.search-icon').forEach((el) => (el.innerHTML = icon('search')));
  $$('[data-close-search] .icon-btn, #globalSearchForm .icon-btn').forEach(
    (el) => (el.innerHTML = icon('close'))
  );
  const reportMenuLinks = [
    ['#reportMenu a[href="#/report?type=lost"]', 'edit', 'Report a Lost Item'],
    ['#reportMenu a[href="#/report?type=found"]', 'users', 'Report a Found Item'],
  ];
  reportMenuLinks.forEach(([sel, ic, label]) => {
    const a = $(sel);
    if (a) a.innerHTML = `${icon(ic)}<span>${label}</span>`;
  });
  const mobileReports = [
    ['[data-mobile-report][href="#/report?type=lost"]', 'edit', 'Report Lost Item'],
    ['[data-mobile-report][href="#/report?type=found"]', 'users', 'Report Found Item'],
  ];
  mobileReports.forEach(([sel, ic, label]) => {
    const a = $(sel);
    if (a) a.innerHTML = `${icon(ic)}<span>${label}</span>`;
  });

  const themeToggle = $('#themeToggle');
  function paintTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeToggle.innerHTML = icon(dark ? 'sun' : 'moon');
    themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  paintTheme();
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('clf_theme', next);
    } catch {}
    paintTheme();
  });

  navSearchBtn.addEventListener('click', openSearch);
  $$('[data-close-search]').forEach((el) => el.addEventListener('click', closeSearch));
  $('#globalSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#globalSearchInput').value.trim();
    closeSearch();
    location.hash = q ? `#/items?q=${encodeURIComponent(q)}` : '#/items';
  });

  const notifBtn = $('#notifBtn');
  if (notifBtn) {
    notifBtn.innerHTML = `${icon('bell')}<span class="notif-badge" id="notifBadge" hidden>0</span>`;
    notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = $('#notifPanel');
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      notifBtn.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) loadNotifications();
    });
  }
  const notifPanel = $('#notifPanel');
  if (notifPanel) {
    notifPanel.addEventListener('click', (e) => e.stopPropagation());
  }
  const notifMarkAll = $('#notifMarkAll');
  if (notifMarkAll) {
    notifMarkAll.addEventListener('click', async () => {
      try {
        await api.markAllNotificationsRead();
        loadNotifications();
      } catch {}
    });
  }
  document.addEventListener('click', () => {
    const panel = $('#notifPanel');
    if (panel && !panel.hidden) {
      panel.hidden = true;
      const btn = $('#notifBtn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });

  const reportBtn = $('#reportBtn');
  const reportMenu = $('#reportMenu');
  reportBtn.addEventListener('click', () => {
    const willOpen = reportMenu.hidden;
    reportMenu.hidden = !willOpen;
    reportBtn.setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.report-wrap') && !reportMenu.hidden) {
      reportMenu.hidden = true;
      reportBtn.setAttribute('aria-expanded', 'false');
    }
  });
  reportMenu.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      reportMenu.hidden = true;
      reportBtn.setAttribute('aria-expanded', 'false');
    }
  });

  menuBtn.addEventListener('click', () => {
    const menu = $('#mobileMenu');
    const willOpen = !menu.classList.contains('open');
    menu.classList.toggle('open', willOpen);
    menuBtn.setAttribute('aria-expanded', String(willOpen));
    setMenuIcon(willOpen);
  });
  $('#mobileMenu').addEventListener('click', (e) => {
    if (e.target.closest('a')) closeMobileMenu();
  });

  $$('[data-how]').forEach((link) =>
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const { segments } = parseHash();
      if (!segments[0]) {
        scrollToHowItWorks();
      } else {
        pendingScrollTarget = 'how-it-works';
        location.hash = '#/';
        if (location.hash === '#/') render();
      }
    })
  );

  window.addEventListener('scroll', () => {
    $('#navbar').classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = $('#searchOverlay');
    if (overlay.classList.contains('open')) closeSearch();
    if (!$('#reportMenu').hidden) $('#reportBtn').click();
    closeMobileMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 940) closeMobileMenu();
  });

  document.addEventListener('click', (e) => {
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) {
      render();
      return;
    }
    const returnBtn = e.target.closest('[data-return-id]');
    if (returnBtn) {
      e.preventDefault();
      const id = returnBtn.dataset.returnId;
      confirmModal({
        title: 'Mark this item as returned?',
        message: 'Are you sure this item has been successfully returned to its owner?',
        cancelLabel: 'Cancel',
        confirmLabel: 'Yes, Mark as Returned',
        onConfirm: async () => {
          try {
            await setReturned(id);
            toast('Item marked as returned successfully!', 'success');
          } catch (err) {
            toast(err && err.message ? err.message : 'Could not update the item. Please try again.', 'error');
          }
          render();
        },
      });
      return;
    }
  });
}

initChrome();

window.addEventListener('hashchange', render);
render();
