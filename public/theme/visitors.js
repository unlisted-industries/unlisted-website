(() => {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  let timer;
  const pulse = async () => {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    try { await fetch('/api/visit', { method: 'POST', credentials: 'same-origin', keepalive: true }); } catch { /* Shopping continues offline. */ }
    timer = setTimeout(pulse, 60000);
  };
  timer = setTimeout(pulse, 60000);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (document.visibilityState === 'visible') pulse();
  });
  addEventListener('pagehide', () => clearTimeout(timer));
})();
