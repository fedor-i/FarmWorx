import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { openDb } from './open-db.js';
import { seedIfEmpty } from './seed.js';

const dataDir = join(import.meta.dirname, '..', 'data');
if (process.argv.includes('--reset')) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
seedIfEmpty(openDb(join(dataDir, 'farmworx.db')));
console.log('Seeded demo data');
