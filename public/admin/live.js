(() => {
  const panels = [...document.querySelectorAll('[data-live-visitors]')];
  if (!panels.length) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  const world = fetch('/admin/world.json').then((response) => {
    if (!response.ok) throw new Error('World view unavailable');
    return response.json();
  });
  const vertex = ([longitude, latitude]) => {
    const lon = longitude * Math.PI / 180;
    const lat = latitude * Math.PI / 180;
    return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  };
  for (const panel of panels) {
    const canvas = panel.querySelector('[data-live-globe]');
    const context = canvas.getContext('2d');
    const count = panel.querySelector('[data-live-count]');
    const badge = panel.querySelector('[data-live-status]');
    const countries = panel.querySelector('[data-live-countries]');
    const empty = panel.querySelector('[data-live-empty]');
    const updated = panel.querySelector('[data-live-updated]');
    let state = JSON.parse(panel.dataset.liveInitial);
    let points = [], centers = {}, frame, timer, lastPaint = 0, inView = true;
    let width = 300, height = 220, rotation = -.45;
    const countryName = (code) => { try { return regions.of(code) || code; } catch { return code; } };

    function status(text, active) {
      badge.textContent = text;
      const dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      badge.prepend(dot);
      badge.classList.toggle('is-paused', !active);
    }
    function show(data) {
      state = data;
      const ready = data.enabled && data.available !== false;
      count.textContent = ready ? Number(data.visitors).toLocaleString('en-GB') : '—';
      status(ready ? 'Live' : data.enabled ? 'Unavailable' : 'Paused', ready);
      countries.replaceChildren();
      const rows = ready ? data.countries.slice(0, 3).map((row) => [countryName(row.country), row.visitors]) : [];
      if (ready && data.countries.length > 3) rows.push(['More countries', data.countries.slice(3).reduce((sum, row) => sum + row.visitors, 0)]);
      if (ready && data.unknown) rows.push(['Location unavailable', data.unknown]);
      for (const [name, amount] of rows) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        const value = document.createElement('strong');
        label.textContent = name;
        value.textContent = Number(amount).toLocaleString('en-GB');
        row.append(label, value);
        countries.append(row);
      }
      empty.hidden = ready && data.visitors > 0;
      empty.textContent = !data.enabled ? 'Visitor analytics are paused' : ready ? 'Waiting for storefront activity' : 'Live activity is temporarily unavailable';
      updated.textContent = ready ? 'Updated just now · every 15 seconds' : 'Live activity is not being reported';
      paint(performance.now());
    }

    function paint(time) {
      if (!context) return;
      const radius = Math.min(width / 2 - 12, height / 2 - 5);
      const cx = width / 2, cy = height / 2;
      const cosine = Math.cos(rotation), sine = Math.sin(rotation);
      const tilt = .16, ct = Math.cos(tilt), st = Math.sin(tilt);
      const project = (point) => {
        const x = point[0] * cosine + point[2] * sine;
        const z = point[2] * cosine - point[0] * sine;
        const y = point[1] * ct - z * st;
        return [cx + radius * x, cy - radius * y, z * ct + point[1] * st];
      };
      context.clearRect(0, 0, width, height);
      const sphere = context.createRadialGradient(cx - radius * .35, cy - radius * .45, 5, cx, cy, radius);
      sphere.addColorStop(0, '#f6faf7');
      sphere.addColorStop(.75, '#edf4ef');
      sphere.addColorStop(1, '#e5eee8');
      context.fillStyle = sphere;
      context.beginPath();context.arc(cx, cy, radius, 0, Math.PI * 2);context.fill();
      context.strokeStyle = '#b6cbbd50';context.lineWidth = .6;
      for (let latitude = -60; latitude <= 60; latitude += 30) {
        context.beginPath();
        let line = false;
        for (let longitude = -180; longitude <= 180; longitude += 4) {
          const [x, y, z] = project(vertex([longitude, latitude]));
          if (z < 0) { line = false; continue; }
          if (line) context.lineTo(x, y); else context.moveTo(x, y);
          line = true;
        }
        context.stroke();
      }
      for (const point of points) {
        const [x, y, z] = project(point);
        if (z < 0) continue;
        context.fillStyle = 'rgba(49,88,65,' + (.24 + .56 * z).toFixed(2) + ')';
        context.beginPath();context.arc(x, y, .65 + .35 * z, 0, Math.PI * 2);context.fill();
      }
      if (state.enabled && state.available !== false) for (const place of state.countries) {
        if (!centers[place.country]) continue;
        const [x, y, z] = project(centers[place.country]);
        if (z < .03) continue;
        const pulse = reducedMotion.matches ? 0 : (time % 2400) / 2400;
        context.beginPath();context.arc(x, y, 3.5 + pulse * 9, 0, Math.PI * 2);
        context.strokeStyle = 'rgba(24,143,84,' + ((1 - pulse) * .45).toFixed(2) + ')';context.lineWidth = 1.3;context.stroke();
        context.beginPath();context.arc(x, y, 3, 0, Math.PI * 2);context.fillStyle = '#168c53';context.fill();
        context.strokeStyle = '#fff';context.lineWidth = 1.2;context.stroke();
      }
    }
    function animate(time) {
      frame = undefined;
      if (document.visibilityState !== 'visible' || !inView) return;
      if (time - lastPaint >= 33) {
        if (!reducedMotion.matches) rotation += Math.min(time - (lastPaint || time), 60) * .00009;
        lastPaint = time;
        paint(time);
      }
      if (!reducedMotion.matches) frame = requestAnimationFrame(animate);
    }
    function startAnimation() { if (!frame) frame = requestAnimationFrame(animate); }
    function resize() {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);height = Math.max(1, bounds.height);
      const density = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * density);canvas.height = Math.round(height * density);
      context?.setTransform(density, 0, 0, density, 0, 0);
      paint(performance.now());startAnimation();
    }
    async function refresh() {
      clearTimeout(timer);
      if (document.visibilityState !== 'visible' || !inView) return;
      try {
        const response = await fetch('/admin/live-visitors.json', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (response.status === 401) {
          show({ ...state, available: false });
          status('Sign in again', false);empty.textContent = 'Sign in to view live activity';
          updated.textContent = 'Your workspace session has expired';return;
        }
        if (!response.ok) throw new Error('Live activity unavailable');
        show(await response.json());
      } catch {
        show({ ...state, available: false });
        status('Reconnecting', false);updated.textContent = 'Last update unavailable · retrying';
      }
      timer = setTimeout(refresh, 15000);
    }
    show(state);
    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) { startAnimation();refresh(); } else clearTimeout(timer);
    }).observe(panel);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { lastPaint = 0;startAnimation();refresh(); } else clearTimeout(timer);
    });
    reducedMotion.addEventListener('change', () => { paint(performance.now());startAnimation(); });
    world.then((data) => {
      points = data.dots.map(vertex);
      centers = Object.fromEntries(Object.entries(data.countries).map(([code, position]) => [code, vertex(position)]));
      paint(performance.now());startAnimation();
    }).catch(() => { /* Counts remain usable without the decorative globe data. */ });
    addEventListener('pagehide', () => { clearTimeout(timer);cancelAnimationFrame(frame); });
  }
})();
