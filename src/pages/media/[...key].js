import { env } from 'cloudflare:workers';

async function readMedia({ request, params }) {
  const key = params.key;
  if (!key || !/^(?:shop|upload)\/[a-z0-9_.-]{1,180}$/i.test(key)) return new Response(null, { status: 404 });
  const object = await env.MEDIA.head(key);
  if (!object) return new Response(null, { status: 404 });
  const headers = new Headers({
    'Cache-Control': key.startsWith('upload/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
  });
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  const range = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  let bounds;
  if (range && (!ifRange || ifRange === object.httpEtag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const offset = match[1] ? Number(match[1]) : Math.max(object.size - Number(match[2]), 0);
      const end = match[1] && match[2] ? Math.min(Number(match[2]), object.size - 1) : object.size - 1;
      if (Number.isSafeInteger(offset) && offset >= 0 && offset <= end) bounds = { offset, length: end - offset + 1 };
    }
    if (!bounds) {
      headers.set('Content-Range', 'bytes */' + object.size);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${bounds.offset}-${bounds.offset + bounds.length - 1}/${object.size}`);
  }
  headers.set('Content-Length', String(bounds?.length ?? object.size));
  if (request.method === 'HEAD') return new Response(null, { status: bounds ? 206 : 200, headers });
  const body = await env.MEDIA.get(key, bounds ? { range: bounds } : undefined);
  return body ? new Response(body.body, { status: bounds ? 206 : 200, headers }) : new Response(null, { status: 404 });
}

export const GET = readMedia;
export const HEAD = readMedia;
