import migration from '../../migrations/0010_live_visitors.sql?raw';
import { all, initializeTables, isToken, makeToken, unixNow } from './db.js';
import { getSettings } from './catalog.js';
import { setCookie } from './http.js';

export const activeWindow = 5 * 60;
export const ensureLiveVisitors = initializeTables(migration);

export function analyticsAllowed(request) {
  return request.headers.get('DNT') !== '1' && request.headers.get('Sec-GPC') !== '1' &&
    !/bot|crawler|spider|preview/i.test(request.headers.get('User-Agent') ?? '');
}

export async function recordVisitor(context, env, allowNew = true) {
  if (!analyticsAllowed(context.request)) return null;
  const settings = await getSettings(context, env.DB);
  if (!settings.analytics_enabled) return null;
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Cairo' }).format(new Date());
  const [lastDay, storedId] = (context.cookies.get('unlisted_visit')?.value ?? '').split('.');
  if (!allowNew && (!isToken(storedId) || !await env.DB.prepare('SELECT 1 FROM visits WHERE day=? AND visitor_id=?').bind(lastDay ?? '', storedId).first())) return null;
  const id = isToken(storedId) ? storedId : makeToken();
  if (lastDay !== day || !isToken(storedId)) {
    await env.DB.prepare('INSERT OR IGNORE INTO visits (visitor_id, day) VALUES (?, ?)').bind(id, day).run();
    setCookie(context, 'unlisted_visit', day + '.' + id, 365 * 86400);
  }
  await ensureLiveVisitors(env.DB);
  const suppliedCountry = context.request.cf?.country;
  const country = typeof suppliedCountry === 'string' && /^[A-Z]{2}$/.test(suppliedCountry) && suppliedCountry !== 'XX' ? suppliedCountry : null;
  await env.DB.prepare(`INSERT INTO visitor_activity (visitor_id,last_seen_at,country) VALUES (?,?,?)
    ON CONFLICT(visitor_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
      country=coalesce(excluded.country,visitor_activity.country)
    WHERE visitor_activity.last_seen_at <= excluded.last_seen_at - 45`).bind(id, unixNow(), country).run();
  return { id, day };
}

export async function liveVisitors(db, enabled = true) {
  const now = unixNow();
  const base = { enabled: Boolean(enabled), available: true, visitors: 0, countries: [], unknown: 0, windowSeconds: activeWindow, asOf: new Date(now * 1000).toISOString() };
  if (!enabled) return base;
  await ensureLiveVisitors(db);
  const rows = await all(db.prepare(`SELECT country,count(*) AS visitors FROM visitor_activity
    WHERE last_seen_at >= ? AND last_seen_at <= ? GROUP BY country ORDER BY visitors DESC,country`).bind(now - activeWindow, now));
  return { ...base, visitors: rows.reduce((total, row) => total + row.visitors, 0),
    countries: rows.filter((row) => row.country), unknown: rows.find((row) => !row.country)?.visitors ?? 0 };
}
