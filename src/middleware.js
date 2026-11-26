import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { ensureWorkspace } from './lib/workspace-schema.js';
import { saleEndsAt } from './lib/offers.js';
import { recordVisitor } from './lib/live-visitors.js';

const protectedPaths = /^(?:\/(?:returns|admin|account|orders|api|cart|checkout|payment-test)(?:\/|$))/;
const storefrontPaths = /^\/(?:$|offers$|products\/|collections\/|pages\/)/;

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  await ensureWorkspace(env.DB);
  if (request.method === 'GET' && storefrontPaths.test(url.pathname)) {
    try {
      context.locals.visitor = await recordVisitor(context, env);
      const campaign=url.searchParams.get('utm_id')||url.searchParams.get('campaign_id');
      if(context.locals.visitor&&/^\d{1,30}$/.test(campaign||'')) context.cookies.set('unlisted_campaign',campaign,{path:'/',maxAge:7*86400,httpOnly:true,sameSite:'lax',secure:url.protocol==='https:'});
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
  headers.set('Permissions-Policy', `camera=(), microphone=${url.pathname === '/admin/finance' ? '(self)' : '()'}, geolocation=()`);
  if (headers.get('Content-Type')?.includes('text/html')) {
    if (Date.now() < saleEndsAt && !protectedPaths.test(url.pathname)) headers.set('Cache-Control','no-store');
    const basePolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accept.paymob.com https://eg.checkout.paymob.com; object-src 'none'";
    // Permit the exact Meta bootstrap in Store.astro and Meta's pixel endpoints.
    // Admin and API responses retain the original policy.
    const pixelPolicy = basePolicy
      .replace("script-src 'self'", "script-src 'self' 'sha256-BGrr6sjeOj1e2ZfLeuJsLM/kDy1d/Xoh9/l0M1Ajatw=' https://connect.facebook.net")
      .replace("img-src 'self' data:", "img-src 'self' data: https://www.facebook.com")
      + "; connect-src 'self' https://www.facebook.com https://connect.facebook.net";
    headers.set('Content-Security-Policy', /^\/(?:admin|api)(?:\/|$)/.test(url.pathname) ? basePolicy : pixelPolicy);
  }
  if (protectedPaths.test(url.pathname)) headers.set('Cache-Control', 'private, no-store');
  if (url.hostname.endsWith('.workers.dev') || protectedPaths.test(url.pathname)) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
