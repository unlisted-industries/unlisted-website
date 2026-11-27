// Overview sales chart: filters and hover tooltip. External file because the admin CSP blocks inline scripts.
document.querySelectorAll('.sc-controls').forEach((form) => {
  const custom = form.querySelector('.sc-custom');
  form.querySelector('[data-sc-range]')?.addEventListener('change', (event) => {
    const isCustom = event.target.value === 'custom';
    if (custom) custom.hidden = !isCustom;
    if (!isCustom) form.requestSubmit();
  });
  form.querySelectorAll('[data-sc-auto]').forEach((select) => select.addEventListener('change', () => form.requestSubmit()));
});
document.querySelectorAll('.sc-wrap').forEach((wrap) => {
  const data = JSON.parse(wrap.dataset.sc), svg = wrap.querySelector('svg'), tip = wrap.querySelector('.sc-tip');
  const cursor = svg.querySelector('.sc-cursor'), dot = svg.querySelector('.sc-dot');
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el; };
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) * svg.viewBox.baseVal.width / r.width;
    let best = data[0]; for (const d of data) if (Math.abs(d.x - vx) < Math.abs(best.x - vx)) best = d;
    cursor.setAttribute('x1', best.x); cursor.setAttribute('x2', best.x); dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y);
    tip.hidden = false;
    tip.replaceChildren(text('small', best.label), text('strong', best.v), ...(best.p ? [text('small', 'Previous: ' + best.p)] : []));
    const px = best.x / svg.viewBox.baseVal.width * r.width; tip.style.left = Math.min(Math.max(px, 70), r.width - 70) + 'px';
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; dot.setAttribute('cx', -10); cursor.setAttribute('x1', -10); cursor.setAttribute('x2', -10); });
});
