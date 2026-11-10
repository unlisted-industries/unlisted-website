import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { scryptSync } from 'node:crypto';

export class OwnerPasswordHasher extends DurableObject {
  derive(password, salt) {
    // The object has a separate CPU budget for password hashing.
    return scryptSync(password, Buffer.from(salt, 'hex'), 32, {
      N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024,
    }).toString('hex');
  }
}
