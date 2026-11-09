import { env } from 'cloudflare:workers';
import { sessionPost } from '../../lib/session-route.js';

export function POST(context) {
  return sessionPost(env, context, 'account');
}
