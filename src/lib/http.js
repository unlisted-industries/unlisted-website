export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function textValue(source, key, max = 180, required = true) {
  const value = source.get(key);
  const text = typeof value === 'string' ? value.trim() : '';
  if ((required && !text) || text.length > max) {
    throw new StoreError('Check the ' + key.replaceAll('_', ' ') + ' field.');
  }
  return text;
}

export function emailValue(source, key = 'email') {
  const email = textValue(source, key, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError('Enter a valid email address.');
  return email;
}

export function quantityValue(value, min = 1, max = 25) {
  if (!/^\d{1,12}$/.test(String(value))) throw new StoreError('Enter a whole number.');
  const number = Number(value);
  if (number < min || number > max) throw new StoreError('The number is outside the allowed range.');
  return number;
}

export function priceValue(value) {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(String(value))) {
    throw new StoreError('Enter an amount in EGP with up to two decimals.');
  }
  const [units, fraction = ''] = String(value).split('.');
  const cents = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents > 100000000) throw new StoreError('The amount is too large.');
  return cents;
}

export function slugValue(value) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 80) {
    throw new StoreError('Use lowercase letters, numbers and hyphens in the URL handle.');
  }
  return value;
}

export function checked(form, name) {
  return Number(form.get(name) === 'on');
}

export function assertSameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new StoreError('The form must be submitted from this website.', 403);
  }
}

export async function formData(request, max = 48 * 1024) {
  assertSameOrigin(request);
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)(?:;|$)/i.test(contentType)) {
    throw new StoreError('Send this request as a form.', 415);
  }
  const chunks = await readBody(request, max);
  try {
    return await new Response(new Blob(chunks), { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new StoreError('The form could not be read.');
  }
}

export async function readBody(request, max) {
  if (!request.body) return [];
  if (Number(request.headers.get('Content-Length')) > max) throw new StoreError('The file or form is too large.', 413);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      throw new StoreError('The file or form is too large.', 413);
    }
    chunks.push(value);
  }
  return chunks;
}

export function seeOther(location) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export function withStatus(location, name, value) {
  const url = new URL(location, 'https://local.invalid');
  url.searchParams.set(name, value);
  return url.pathname + url.search + url.hash;
}

export function formError(error, destination) {
  if (error instanceof StoreError) {
    return seeOther(withStatus(destination, 'error', error.message));
  }
  console.error('Store operation failed', { type: error?.name });
  return seeOther(withStatus(destination, 'error', 'Something went wrong. Please try again.'));
}

export function setCookie(context, name, value, maxAge, path = '/') {
  context.cookies.set(name, value, {
    path, maxAge, httpOnly: true, sameSite: 'lax', secure: context.url.protocol === 'https:',
  });
}

export function clearCookie(context, name, path = '/') {
  setCookie(context, name, '', 0, path);
}
