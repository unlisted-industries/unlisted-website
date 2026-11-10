import { confirmLogin, logout, requestLogin } from './auth.js';
import { passwordsReady, saveOwnerPassword, signInWithPassword } from './admin-password.js';
import { emailValue, formData, formError, seeOther, StoreError, textValue } from './http.js';

export async function sessionPost(env, context, purpose) {
  const login = purpose === 'admin' ? '/admin/login' : '/account';
  let destination = login;
  try {
    const form = await formData(context.request);
    if (purpose === 'admin' && form.get('action') === 'password') {
      await signInWithPassword(env, context, form);
      return seeOther('/admin');
    }
    if (purpose === 'admin' && form.get('action') === 'save-password') {
      destination = '/admin/password';
      await saveOwnerPassword(env, context, form);
      return seeOther('/admin?saved=1');
    }
    switch (form.get('action')) {
      case 'confirm': {
        if (purpose === 'admin' && !passwordsReady(env, context.url)) {
          throw new StoreError('Owner password setup is unavailable on this address.', 503);
        }
        const signedIn = await confirmLogin(env, context, purpose, textValue(form, 'token', 64));
        return seeOther(purpose === 'admin' ? '/admin/password' : signedIn);
      }
      case 'logout':
        return seeOther(await logout(env, context, purpose));
      default:
        await requestLogin(env, context, purpose, emailValue(form));
        return seeOther(login + '?sent=1');
    }
  } catch (error) {
    return formError(error, destination);
  }
}
