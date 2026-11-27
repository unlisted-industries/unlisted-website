const openMenu = document.querySelector('[data-open-menu]');
const closeMenu = document.querySelector('[data-close-menu]');
const overlay = document.getElementById('MenuOverlay');

function setMenu(open) {
  overlay.classList.toggle('is-open', open);
  overlay.setAttribute('aria-hidden', String(!open));
  overlay.inert = !open;
  openMenu.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('store-menu-open', open);
  if (open) closeMenu.focus();
  else openMenu.focus();
}

openMenu?.addEventListener('click', () => setMenu(true));
closeMenu?.addEventListener('click', () => setMenu(false));
overlay?.addEventListener('click', (event) => {
  if (event.target === overlay) setMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (!overlay?.classList.contains('is-open')) return;
  if (event.key === 'Escape') setMenu(false);
  if (event.key === 'Tab') {
    const focusable = [...overlay.querySelectorAll('a[href], button, summary')].filter((element) => element.getClientRects().length);
    const edge = event.shiftKey ? focusable[0] : focusable.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0]).focus();
    }
  }
});

const picker = document.querySelector('[data-variant-picker]');
const variantDiscount = document.querySelector('[data-offer-discount]');
picker?.addEventListener('change', () => {
  const option = picker.selectedOptions[0].dataset, price = document.querySelector('[data-variant-price]');
  price.replaceChildren();
  if (option.was) { const was = document.createElement('del'); was.className = 'unl-price-was'; was.textContent = option.was; price.append(was, ' '); }
  const now = document.createElement('span'); now.className = 'unl-price-now'; now.textContent = option.price; price.append(now);
  if (variantDiscount) {
    variantDiscount.textContent = option.discount;
    variantDiscount.hidden = !option.discount;
  }
});

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelector('.drop-film video')?.pause();
}

const sizeFinder = document.querySelector('[data-cozy-size-finder]');
if (sizeFinder) {
  const heightField = sizeFinder.querySelector('[data-height]');
  const weightField = sizeFinder.querySelector('[data-weight]');
  const result = sizeFinder.querySelector('output');
  // Two relaxed sizes. The model (172 cm, 67 kg) wears S/M.
  const limit = { height: 177, weight: 78 };
  sizeFinder.addEventListener('input', () => { result.textContent = ''; });
  sizeFinder.addEventListener('submit', (event) => {
    event.preventDefault();
    const height = heightField.valueAsNumber, weight = weightField.valueAsNumber;
    const large = height >= limit.height || weight >= limit.weight;
    result.textContent = large
      ? 'Recommended size: L. It gives you the relaxed fit at ' + height + ' cm · ' + weight + ' kg.'
      : 'Recommended size: S/M. It gives you the relaxed fit at ' + height + ' cm · ' + weight + ' kg.';
  });
}
const offerClock = document.querySelector('[data-offer-clock]');
if (offerClock) {
  const digitGroups = offerClock.querySelectorAll('[data-offer-time] .offer-banner-digits');
  const boundary = Number(offerClock.dataset.boundary);
  const serverTime = Number(offerClock.dataset.now);
  const navigation = performance.getEntriesByType('navigation')[0];
  const offset = Date.now() - serverTime - Math.max(0, performance.now() - (navigation?.responseStart || 0));
  let timer;
  function tick() {
    clearTimeout(timer);
    const remaining = Math.ceil((boundary - Date.now() + offset) / 1000);
    if (remaining <= 0) {
      offerClock.hidden = true;
      // Reload only GET pages. A checkout review was rendered by POST; its
      // submitted total will instead be revalidated by the order endpoint.
      if (!document.querySelector('form[action="/api/checkout"]')) location.reload();
      return;
    }
    const values = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60];
    if (remaining < 21600) offerClock.classList.add('is-urgent');
    digitGroups.forEach((group, index) => {
      group.textContent = String(values[index]).padStart(2, '0');
    });
    timer = setTimeout(tick, 250);
  }
  addEventListener('pageshow', tick);
  document.addEventListener('visibilitychange', tick);
  tick();
}

// Slide-in cart: "Add to cart" stays on the page and opens the cart from the right.
const drawer = document.getElementById('CartDrawer');
const drawerOverlay = document.querySelector('.cd-overlay');
if (drawer && drawerOverlay) {
  let lastFocus = null;
  const setDrawer = (open) => {
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    drawer.inert = !open;
    drawerOverlay.hidden = !open;
    document.body.classList.toggle('store-menu-open', open);
    if (open) { lastFocus = document.activeElement; drawer.querySelector('.cd-close')?.focus(); }
    else lastFocus?.focus?.();
  };
  const loadDrawer = async () => {
    const response = await fetch('/cart-drawer', { headers: { Accept: 'text/html' }, cache: 'no-store' });
    if (!response.ok) throw new Error('drawer');
    drawer.innerHTML = await response.text();
    const count = drawer.querySelector('[data-cart-drawer-count]')?.dataset.cartDrawerCount;
    document.querySelectorAll('.cart-count').forEach((el) => { el.textContent = count ?? el.textContent; });
  };
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-cart-close]')) setDrawer(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('is-open')) setDrawer(false);
  });
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.getAttribute('action') !== '/api/cart') return;
    const submitter = event.submitter;
    const action = submitter?.name === 'action' ? submitter.value : new FormData(form).get('action');
    const inDrawer = drawer.contains(form);
    if (!['add', 'add_set'].includes(action) && !inDrawer) return; // Buy now and cart-page edits keep their normal flow.
    event.preventDefault();
    if (submitter) submitter.disabled = true;
    try {
      const response = await fetch('/api/cart', { method: 'POST', body: new FormData(form, submitter), credentials: 'same-origin' });
      if (response.url.includes('error=')) { location.href = response.url; return; }
      await loadDrawer();
      setDrawer(true);
      if (['add', 'add_set'].includes(action) && typeof fbq === 'function') fbq('track', 'AddToCart');
    } catch {
      form.submit();
    } finally {
      if (submitter) submitter.disabled = false;
    }
  });
}
