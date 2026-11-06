import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './db.js';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  applySchema(db);
  return db;
}
