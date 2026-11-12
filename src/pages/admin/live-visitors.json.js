import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { getSettings } from '../../lib/catalog.js';
import { liveVisitors } from '../../lib/live-visitors.js';

export async function GET(context) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!await currentUser(env, context, 'admin')) return Response.json({ error: 'Sign in to your workspace.' }, { status: 401, headers });
  try {
    const settings = await getSettings(context, env.DB);
    return Response.json(await liveVisitors(env.DB, settings.analytics_enabled), { headers });
  } catch {
    return Response.json({ error: 'Live activity is temporarily unavailable.' }, { status: 503, headers });
  }
}
