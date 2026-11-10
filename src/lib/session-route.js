import { confirmLogin, logout, requestLogin } from './auth.js';
import { passwordsReady, saveOwnerPassword, setupOwnerPassword, signInWithPassword } from './admin-password.js';
import { isToken } from './db.js';
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
    if (purpose === 'admin' && form.get('action') === 'setup-password') {
      const token = form.get('token');
      destination = isToken(token, 32) ? '/admin/verify#token=' + token : '/admin/verify';
      await setupOwnerPassword(env, context, form, token);
      return seeOther('/admin/login?password-set=1');
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
