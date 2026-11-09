const openMenu = document.querySelector('[data-open-menu]');
const closeMenu = document.querySelector('[data-close-menu]');
const overlay = document.getElementById('MenuOverlay');
const guide = document.getElementById('SizeGuide');

function setMenu(open, restoreFocus = true) {
  overlay.classList.toggle('is-open', open);
  overlay.setAttribute('aria-hidden', String(!open));
  overlay.inert = !open;
  openMenu.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('store-menu-open', open);
  if (open) closeMenu.focus();
  else if (restoreFocus) openMenu.focus();
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
let guideTrigger;
for (const element of document.querySelectorAll('[data-open-size-guide]')) {
  element.addEventListener('click', (event) => {
    event.preventDefault();
    const fromMenu = overlay.contains(element);
    if (fromMenu) setMenu(false, false);
    guideTrigger = fromMenu ? openMenu : element;
    guide.showModal();
  });
}
for (const element of document.querySelectorAll('[data-close-size-guide]')) {
  element.addEventListener('click', () => guide.close());
}
guide?.addEventListener('close', () => guideTrigger?.focus());

const picker = document.querySelector('[data-variant-picker]');
picker?.addEventListener('change', () => {
  document.querySelector('[data-variant-price]').textContent = picker.selectedOptions[0].dataset.price;
});

if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelector('.drop-film video')?.pause();
}
