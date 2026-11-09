import { confirmLogin, logout, requestLogin } from './auth.js';
import { emailValue, formData, formError, seeOther, textValue } from './http.js';

export async function sessionPost(env, context, purpose) {
  const login = purpose === 'admin' ? '/admin/login' : '/account';
  try {
    const form = await formData(context.request);
    switch (form.get('action')) {
      case 'confirm':
        return seeOther(await confirmLogin(env, context, purpose, textValue(form, 'token', 64)));
      case 'logout':
        return seeOther(await logout(env, context, purpose));
      default:
        await requestLogin(env, context, purpose, emailValue(form));
        return seeOther(login + '?sent=1');
    }
  } catch (error) {
    return formError(error, login);
  }
}
