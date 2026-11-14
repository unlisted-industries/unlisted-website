import migration from '../../migrations/0013_independent_workspace.sql?raw';
import { initializeTables } from './db.js';
export const ensureWorkspace = initializeTables(migration);
