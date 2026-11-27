// Meta Pixel standard events. Pages describe the event in a hidden [data-pixel-event] element;
// this file fires it (the store CSP blocks inline scripts). Purchases fire once per order.
(() => {
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
  if (!fire()) addEventListener('load', fire, { once: true });
})();
