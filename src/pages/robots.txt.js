export function GET({ url }) {
  const text = url.hostname.endsWith('.workers.dev') ? 'User-agent: *\nDisallow: /\n'
    : 'User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /orders\nDisallow: /checkout\nDisallow: /cart\nSitemap: ' + url.origin + '/sitemap.xml\n';
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
