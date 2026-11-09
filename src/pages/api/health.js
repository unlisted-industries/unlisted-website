import { env } from 'cloudflare:workers';

export async function GET() {
  try {
    const row = await env.DB.prepare("SELECT count(*) AS products FROM products WHERE status = 'active'").first();
    return Response.json({ status: row.products ? 'ok' : 'catalog-empty', products: row.products },
      { status: row.products ? 200 : 503 });
  } catch {
    return Response.json({ status: 'storage-unavailable' }, { status: 503 });
  }
}
