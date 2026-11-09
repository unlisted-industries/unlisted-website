import sanitizeHtml from 'sanitize-html';

export function safeHtml(value) {
  return sanitizeHtml(String(value ?? ''), {
    allowedTags: ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'b', 'i', 'br', 'blockquote', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowProtocolRelative: false,
    transformTags: {
      a(tagName, attributes) {
        let href = attributes.href;
        if (href?.startsWith('https://unlisted-shop.com/')) href = href.slice('https://unlisted-shop.com'.length);
        return { tagName, attribs: href ? { href } : {} };
      },
    },
  });
}

export function safeLink(value) {
  if (typeof value !== 'string') return false;
  if (/^\/(?!\/)[^\u0000-\u0020\\]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function money(amount, compact = false) {
  if (amount == null) return '';
  if (compact) return (amount / 100).toLocaleString('en-EG', { maximumFractionDigits: 2 }) + ' EGP';
  return 'LE ' + (amount / 100).toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function mediaUrl(key) {
  return key ? '/media/' + key.split('/').map(encodeURIComponent).join('/') : null;
}

export function displayDate(seconds) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Cairo' }).format(seconds * 1000);
}

const cairoFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function cairoDateTime(seconds) {
  return seconds == null ? '' : cairoFormatter.format(new Date(seconds * 1000)).replace(' ', 'T');
}

export function parseCairoDateTime(value) {
  const target = Date.parse(value + ':00Z') / 1000;
  if (!Number.isFinite(target)) return null;
  let seconds = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const displayed = cairoDateTime(seconds);
    if (displayed === value) return seconds;
    seconds += target - Date.parse(displayed + ':00Z') / 1000;
  }
  return null;
}
