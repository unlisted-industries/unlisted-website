import { env } from 'cloudflare:workers';
import { limitRequest } from '../../lib/auth.js';
import { makeToken } from '../../lib/db.js';
import { emailValue, formData, formError, seeOther, textValue } from '../../lib/http.js';

export async function POST(context) {
  try {
    const form = await formData(context.request);
    const email = emailValue(form);
    await limitRequest(env.DB, context.request, 'contact', { subject: email, limit: 8 });
    if (form.get('website')) return seeOther('/pages/contact?sent=1');
    await env.DB.prepare('INSERT INTO contact_messages (id, name, email, phone, message) VALUES (?, ?, ?, ?, ?)')
      .bind(makeToken(), textValue(form, 'name', 100), email, textValue(form, 'phone', 24, false), textValue(form, 'message', 3000)).run();
    return seeOther('/pages/contact?sent=1');
  } catch (error) {
    return formError(error, '/pages/contact');
  }
}
