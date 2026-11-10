import migration from '../../migrations/0006_owner_passwords.sql?raw';
import { initializeTables } from './db.js';

export const ensureOwnerPasswordSchema = initializeTables(migration);
