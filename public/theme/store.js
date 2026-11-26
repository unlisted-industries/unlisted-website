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
picker?.addEventListener('change', () => {
  document.querySelector('[data-variant-price]').textContent = picker.selectedOptions[0].dataset.price;
});

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelector('.drop-film video')?.pause();
}

const offerClock = document.querySelector('[data-offer-clock]');
if (offerClock) {
  const time = offerClock.querySelector('[data-offer-time]');
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
    time.textContent = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60]
      .map(value => String(value).padStart(2,'0')).join(':');
    timer = setTimeout(tick, 250);
  }
  addEventListener('pageshow', tick);
  document.addEventListener('visibilitychange', tick);
  tick();
}
