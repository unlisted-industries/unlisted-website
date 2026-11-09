import { isToken } from '../../lib/db.js';
import { seeOther } from '../../lib/http.js';

export function GET({ url }) {
  const order = url.searchParams.get('order');
  return seeOther(isToken(order, 16) ? '/orders/' + order : '/account');
}
