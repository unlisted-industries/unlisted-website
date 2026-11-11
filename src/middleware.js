import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { isToken, makeToken } from './lib/db.js';
import { getSettings } from './lib/catalog.js';
import { setCookie } from './lib/http.js';

const protectedPaths = /^(?:\/(?:admin|account|orders|api|cart|checkout|payment-test)(?:\/|$))/;
const storefrontPaths = /^\/(?:$|products\/|collections\/|pages\/)/;

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  if (request.method === 'GET' && storefrontPaths.test(url.pathname) &&
      request.headers.get('DNT') !== '1' && request.headers.get('Sec-GPC') !== '1' &&
      !/bot|crawler|spider|preview/i.test(request.headers.get('User-Agent') ?? '')) {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Cairo' }).format(new Date());
    const [lastDay, storedId] = (context.cookies.get('unlisted_visit')?.value ?? '').split('.');
    const id = isToken(storedId) ? storedId : makeToken();
    try {
      const settings = await getSettings(context, env.DB);
      if (settings.analytics_enabled) {
        if (lastDay !== day || !isToken(storedId)) {
          await env.DB.prepare('INSERT OR IGNORE INTO visits (visitor_id, day) VALUES (?, ?)').bind(id, day).run();
          setCookie(context, 'unlisted_visit', day + '.' + id, 365 * 86400);
        }
        context.locals.visitor = { id, day };
      }
    } catch {
      // Storefront requests can continue when the analytics write is unavailable.
    }
  }
  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  // Preserve Origin on form submissions while keeping paths and query strings out of Referer.
  headers.set('Referrer-Policy', 'strict-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (headers.get('Content-Type')?.includes('text/html')) {
    headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accept.paymob.com https://eg.checkout.paymob.com; object-src 'none'");
  }
  if (protectedPaths.test(url.pathname)) headers.set('Cache-Control', 'private, no-store');
  if (url.hostname.endsWith('.workers.dev') || protectedPaths.test(url.pathname)) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
