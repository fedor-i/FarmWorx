import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySchema } from '../src/db.js';
import { applyOps, ingestReadings } from '../src/ops.js';
import { seed } from '../src/seed.js';
import { buildState } from '../src/state.js';
import { timesheet } from '../src/timesheet.js';
import { wrapSqlJs } from '../src/demo/sqlite-adapter.js';

const NOW = Date.parse('2026-11-05T20:00:00Z');
const MINUTE = 60_000;

const { default: initSqlJs } = await import('sql.js').catch(() => ({ default: null }));
const skip = initSqlJs ? false : 'sql.js is only installed for building the demo';

async function browserDb(saved) {
  const SQL = await initSqlJs();
  const raw = new SQL.Database(saved);
  const db = wrapSqlJs(raw);
  applySchema(db);
  return { raw, db };
}

test('the app logic gives the same state on the browser database', { skip }, async () => {
  const { db } = await browserDb();
  seed(db, NOW);
  const state = buildState(db, { now: NOW });
  assert.equal(state.people.length, 6);
  assert.deepEqual(['ana', 'luis', 'marco', 'elena'].map((id) => state.people.find((p) => p.id === id).zoneId), ['red', 'red', 'blue', 'green']);
  assert.equal(state.zones.find((z) => z.id === 'yellow').restrictedUntil, NOW - 2 * 3_600_000 + 12 * 3_600_000);
  assert.ok(timesheet(db, '2026-11-01', '2026-11-05', NOW).rows.length > 10);
});

test('resending an op is ignored on the browser database', { skip }, async () => {
  const { db } = await browserDb();
  seed(db, NOW);
  const ctx = { db, now: NOW };
  const op = { id: 'twice', type: 'punch', personId: 'tom', ts: NOW, payload: { type: 'in' } };
  applyOps(ctx, [op]);
  applyOps(ctx, [op]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM punches WHERE id = 'twice'").get().n, 1);
});

test('geofence alerts work on the browser database', { skip }, async () => {
  const { db } = await browserDb();
  seed(db, NOW);
  const ctx = { db, now: NOW + 5 * MINUTE };
  applyOps(ctx, [{ id: 'walk', type: 'sighting', personId: 'ana', ts: NOW + MINUTE, payload: { lat: 36.6145, lng: -121.592 } }]);
  ingestReadings(ctx, { reads: [{ uid: 'GPS-TRACTOR-1', lat: 36.63, lng: -121.62, ts: NOW + MINUTE }] });
  const kinds = buildState(db, { now: NOW }).alerts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['asset_left_fence', 'restricted_entry']);
});

test('saved demo data survives a restart, and rejected ops roll back cleanly', { skip }, async () => {
  const first = await browserDb();
  seed(first.db, NOW);
  const ctx = { db: first.db, now: NOW };
  const { rejected } = applyOps(ctx, [
    { id: 'kept', type: 'task_create', personId: 'sam', ts: NOW, payload: { action: 'water', assigneeId: 'tom' } },
    { id: 'bad', type: 'task_update', personId: 'tom', ts: NOW, payload: { taskId: 'missing', status: 'done' } },
  ]);
  assert.equal(rejected[0].id, 'bad');

  const second = await browserDb(first.raw.export());
  assert.ok(buildState(second.db, { personId: 'tom', now: NOW }).tasks.some((t) => t.id === 'kept'));
  assert.equal(second.db.prepare("SELECT COUNT(*) n FROM ops WHERE id = 'bad'").get().n, 0);
});

test('foreign keys are enforced on the browser database', { skip }, async () => {
  const { db } = await browserDb();
  seed(db, NOW);
  assert.throws(() => db.prepare("INSERT INTO punches (id, person_id, type, ts, received_at, method) VALUES ('x', 'nobody', 'in', 1, 1, 'button')").run());
});
