import { env } from 'cloudflare:workers';
import { all } from '../lib/db.js';

export async function GET({ url }) {
  const rows = await all(env.DB.prepare(`SELECT '/products/' || handle AS path FROM products WHERE status = 'active'
    UNION ALL SELECT '/collections/' || handle FROM collections WHERE active = 1
    UNION ALL SELECT '/pages/' || handle FROM pages WHERE active = 1`));
  const paths = ['/', ...rows.map((row) => row.path)];
  return new Response('<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    paths.map((path) => '<url><loc>' + url.origin + path + '</loc></url>').join('') + '</urlset>',
  { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
