const paymobStart = document.querySelector('[data-paymob-start]');
if (paymobStart) {
  const button = paymobStart.querySelector('button');
  const progress = paymobStart.querySelector('[data-paymob-progress]');
  window.addEventListener('pageshow', () => {
    button.disabled = false;
    button.textContent = 'Open sandbox checkout';
    progress.hidden = true;
  });
  paymobStart.addEventListener('submit', () => {
    button.disabled = true;
    button.textContent = 'Preparing checkout…';
    progress.hidden = false;
  });
}
const paymobLaunch = document.querySelector('[data-paymob-launch]');
if (paymobLaunch) window.location.assign(paymobLaunch.href);
