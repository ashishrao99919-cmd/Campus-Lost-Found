import { CATEGORIES } from '../data.js';
import { fetchItems, statusOf } from '../store.js';
import { itemCard, itemImage, skeletonCardsHTML, errorStateHTML } from '../components.js';
import { icon, esc, initReveals, toast } from '../ui.js';

function animateCount(el) {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix || '';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = target + suffix;
    return;
  }
  const dur = 1300;
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function statsFor(items) {
  const foundCount = items.filter((i) => i.type === 'found').length;
  const returnedCount = items.filter((i) => statusOf(i) === 'returned').length;
  return [
    { iconName: 'box', value: items.length, suffix: '', label: 'Reported Items' },
    { iconName: 'search', value: foundCount, suffix: '', label: 'Found Items' },
    { iconName: 'heart', value: returnedCount, suffix: '', label: 'Reunited' },
    { iconName: 'tag', value: Math.max(0, items.length - returnedCount), suffix: '', label: 'Active Listings' },
  ];
}

function step(iconName, num, title, text) {
  return `
    <div class="step reveal">
      <span class="step-num">${num}</span>
      <div class="step-icon">${icon(iconName)}</div>
      <h3>${title}</h3>
      <p>${text}</p>
    </div>`;
}

export function HomePage(root) {
  root.innerHTML = `
  <div class="page">

    <section class="hero">
      <div class="container hero-inner">
        <div class="hero-copy">
          <span class="eyebrow">${icon('sparkle')}Campus Community Platform</span>
          <h1 class="hero-title">Lost something on campus?<br><span class="title-accent">Let's help you find it.</span></h1>
          <p class="lead">Campus Lost &amp; Found makes it easy for students to report missing belongings, share found items, and reconnect with what matters.</p>
          <div class="hero-ctas">
            <a class="btn btn-primary btn-lg" href="#/report?type=lost">${icon('edit')}Report Lost Item</a>
            <a class="btn btn-secondary btn-lg" href="#/report?type=found">${icon('users')}I Found Something</a>
          </div>
          <form class="hero-search" id="heroSearchForm" role="search">
            <span class="search-icon">${icon('search')}</span>
            <input id="heroSearchInput" type="search" autocomplete="off"
              placeholder="Search for wallets, laptops, ID cards, books..." aria-label="Search campus reports">
            <button class="btn btn-primary" type="submit">Search</button>
          </form>
          <p class="hero-hint">${icon('search')}Search campus reports</p>
        </div>

        <div class="hero-visual" aria-hidden="true" id="heroVisual">
          <div class="float-card fc-1 hero-card-1"></div>
          <div class="float-card fc-2 hero-card-2"></div>
          <div class="float-chip ch-1">${icon('pin')}Real-time campus reports</div>
          <div class="float-chip ch-2" id="heroReunitedChip">${icon('heart')}0 reunions</div>
          <div class="float-card fc-3 hero-card-3">
            <span class="reunion-icon">${icon('check')}</span>
            <div><strong>Item reunited</strong><em>Awaiting first reunion</em></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" style="padding-top:0">
      <div class="container">
        <div class="stats-band" id="statsBand">
          ${[
            { iconName: 'box', label: 'Reported Items' },
            { iconName: 'search', label: 'Found Items' },
            { iconName: 'heart', label: 'Reunited' },
            { iconName: 'tag', label: 'Active Listings' },
          ].map(
            (s, i) => `
          <div class="stat-card reveal" style="--d:${i * 0.07}s" data-stat="${s.label}">
            <div class="stat-icon">${icon(s.iconName)}</div>
            <div class="stat-value is-loading">···</div>
            <div class="stat-label">${s.label}</div>
          </div>`
          ).join('')}
        </div>
      </div>
    </section>

    <section class="section" id="recent">
      <div class="container">
        <div class="head-row reveal">
          <div class="section-head" style="margin-bottom:0">
            <span class="eyebrow">${icon('box')}Live feed</span>
            <h2>Recently Reported</h2>
            <p class="section-sub">See what students have recently lost or found around campus.</p>
          </div>
          <a class="btn btn-secondary btn-sm" href="#/items">View All ${icon('arrowRight')}</a>
        </div>
        <div class="grid-cards" id="recentGrid">${skeletonCardsHTML(6)}</div>
        <div id="recentState"></div>
      </div>
    </section>

    <section class="section section-alt" id="categories">
      <div class="container">
        <div class="section-head center reveal">
          <span class="eyebrow">${icon('tag')}Browse by type</span>
          <h2>Item Categories</h2>
          <p class="section-sub">Jump straight to the kind of item you're looking for.</p>
        </div>
        <div class="cat-grid">
          ${CATEGORIES.map((c) => `
            <a class="cat-tile reveal" href="#/items?category=${c.id}">
              <span class="cat-icon">${icon(c.icon)}</span>
              <span>
                <span class="cat-name">${esc(c.label)}</span>
                <span class="cat-count" data-cat-count="${c.id}">…</span>
              </span>
            </a>`).join('')}
        </div>
      </div>
    </section>

    <section class="section" id="how-it-works">
      <div class="container">
        <div class="section-head center reveal">
          <span class="eyebrow">${icon('info')}Simple process</span>
          <h2>How It Works</h2>
          <p class="section-sub">Three steps between "I lost it" and "I got it back."</p>
        </div>
        <div class="steps">
          ${step('edit', 'STEP 01', 'Report', 'Tell the campus community what you lost or found.')}
          ${step('search', 'STEP 02', 'Search', 'Browse listings and search for matching items.')}
          ${step('users', 'STEP 03', 'Reconnect', 'Contact the person who reported the item and arrange its return.')}
        </div>
      </div>
    </section>

    <section class="section" style="padding-top:0">
      <div class="container">
        <div class="cta-banner reveal">
          <div class="cta-content">
            <h2>Something waiting to be found?</h2>
            <p>Post a report in under a minute. The sooner it's listed, the sooner it's home.</p>
            <div class="cta-actions">
              <a class="btn btn-light btn-lg" href="#/report?type=lost">I Lost Something</a>
              <a class="btn btn-outline-light btn-lg" href="#/report?type=found">I Found Something</a>
            </div>
          </div>
        </div>
      </div>
    </section>

  </div>`;

  const heroForm = root.querySelector('#heroSearchForm');
  heroForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = root.querySelector('#heroSearchInput').value.trim();
    location.hash = q ? `#/items?q=${encodeURIComponent(q)}` : '#/items';
  });

  initReveals(root);

  if (!localStorage.getItem('clf_visited')) {
    localStorage.setItem('clf_visited', '1');
    toast('Welcome to Campus Lost & Found!', 'info');
  }

  hydrate(root);
}

async function hydrate(root) {
  let result;
  try {
    result = await fetchItems({}, { allowFallback: true });
  } catch (err) {
    root.querySelector('#recentGrid').innerHTML = '';
    root.querySelector('#recentState').innerHTML = errorStateHTML(err.message);
    return;
  }

  if (!root.isConnected) return;

  if (result.offline) {
    root.querySelector('#recentGrid').innerHTML = '';
    root.querySelector('#recentState').innerHTML = errorStateHTML('Unable to connect to the server. Please make sure the backend is running.');
    return;
  }

  const items = [...result.items].sort(
    (a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
      b.date.localeCompare(a.date)
  );

  statsFor(result.items).forEach((s) => {
    const card = root.querySelector(`[data-stat="${s.label}"]`);
    if (!card) return;
    card.querySelector('.stat-value').outerHTML =
      `<div class="stat-value" data-count="${s.value}" data-suffix="${s.suffix}">0${s.suffix}</div>`;
  });

  const statEls = [...root.querySelectorAll('.stat-value')];
  const statIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          animateCount(en.target);
          statIO.unobserve(en.target);
        }
      });
    },
    { threshold: 0.4 }
  );
  statEls.forEach((el) => statIO.observe(el));

  const catCounts = {};
  result.items.forEach((i) => {
    catCounts[i.category] = (catCounts[i.category] || 0) + 1;
  });
  Object.entries(catCounts).forEach(([catId, count]) => {
    const el = root.querySelector(`[data-cat-count="${catId}"]`);
    if (el) el.textContent = `${count} listing${count === 1 ? '' : 's'}`;
  });

  const grid = root.querySelector('#recentGrid');
  grid.innerHTML = items
    .slice(0, 6)
    .map((item, i) => `<div class="reveal in-view"${i ? ` style="--d:${i * 0.05}s"` : ''}>${itemCard(item)}</div>`)
    .join('');

  const returnedCount = items.filter((i) => statusOf(i) === 'returned').length;
  const chip = root.querySelector('#heroReunitedChip');
  if (chip) chip.innerHTML = `${icon('heart')}${returnedCount} reunion${returnedCount === 1 ? '' : 's'}`;

  const heroItems = items.slice(0, 2);
  const card1 = root.querySelector('.hero-card-1');
  const card2 = root.querySelector('.hero-card-2');
  const card3 = root.querySelector('.hero-card-3');
  if (heroItems[0] && card1) {
    card1.innerHTML = `<img src="${itemImage(heroItems[0])}" alt=""><div class="mini-body"><strong>${esc(heroItems[0].name)}</strong><span>${icon('pin')}${esc(heroItems[0].location)}</span></div>`;
  } else if (card1) card1.style.display = 'none';
  if (heroItems[1] && card2) {
    card2.innerHTML = `<img src="${itemImage(heroItems[1])}" alt=""><div class="mini-body"><strong>${esc(heroItems[1].name)}</strong><span>${icon('pin')}${esc(heroItems[1].location)}</span></div>`;
  } else if (card2) card2.style.display = 'none';
  const returnedItem = items.find((i) => statusOf(i) === 'returned');
  if (returnedItem && card3) {
    card3.innerHTML = `<span class="reunion-icon">${icon('check')}</span><div><strong>Item reunited</strong><em>${esc(returnedItem.name)} returned</em></div>`;
  } else if (card3) {
    card3.innerHTML = `<span class="reunion-icon">${icon('check')}</span><div><strong>Item reunited</strong><em>Awaiting first reunion</em></div>`;
  }
}
