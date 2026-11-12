import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { recordVisitor } from './lib/live-visitors.js';

const protectedPaths = /^(?:\/(?:admin|account|orders|api|cart|checkout|payment-test)(?:\/|$))/;
const storefrontPaths = /^\/(?:$|products\/|collections\/|pages\/)/;

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;
  if (request.method === 'GET' && storefrontPaths.test(url.pathname)) {
    try {
      context.locals.visitor = await recordVisitor(context, env);
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
