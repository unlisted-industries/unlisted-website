// Meta Pixel standard events. Pages describe the event in a hidden [data-pixel-event] element;
// this file fires it (the store CSP blocks inline scripts). Purchases fire once per order.
// PageView is sent from the browser and from the server (/api/px) with the same event ID,
// so Meta counts it once and the Conversions API covers it even when the pixel is blocked.
(() => {
  const pageViewId = 'pv-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pageView = () => {
    if (typeof fbq === 'function') fbq('track', 'PageView', {}, { eventID: pageViewId });
    // Give fbevents.js a moment to set the _fbp/_fbc cookies, then tell the server.
    setTimeout(() => {
      const body = JSON.stringify({ id: pageViewId, url: location.href });
      try {
        if (!navigator.sendBeacon || !navigator.sendBeacon('/api/px', new Blob([body], { type: 'application/json' }))) {
          fetch('/api/px', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true }).catch(() => {});
        }
      } catch { /* Tracking never interrupts shopping. */ }
    }, 1500);
  };
  const fire = () => {
    if (typeof fbq !== 'function') return false;
    document.querySelectorAll('[data-pixel-event]').forEach((el) => {
      const name = el.dataset.pixelEvent, id = el.dataset.eventId || '';
      if (name === 'Purchase' && id) {
        try { if (localStorage.getItem('px-' + id)) return; localStorage.setItem('px-' + id, '1'); } catch { /* storage blocked */ }
      }
      const data = { currency: el.dataset.currency || 'EGP' };
      if (el.dataset.value) data.value = Number(el.dataset.value);
      if (el.dataset.contentIds) { data.content_ids = el.dataset.contentIds.split(','); data.content_type = 'product'; }
      if (el.dataset.numItems) data.num_items = Number(el.dataset.numItems);
      fbq('track', name, data, id ? { eventID: id } : undefined);
    });
    return true;
  };
  pageView();
  if (!fire()) addEventListener('load', fire, { once: true });
})();
