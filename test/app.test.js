import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { applyOps, ingestReadings } from '../src/ops.js';
import { seed } from '../src/seed.js';
import { buildState } from '../src/state.js';
import { buildShifts, timesheet, timesheetCsv, localDate } from '../src/timesheet.js';
import { pointInPolygon, distanceToPolygonM, resolveZone } from '../public/js/geo.js';
import { createApp } from '../server.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-11-05T20:00:00Z');
const SQUARE = [[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0]];
const INSIDE_RED = [36.6172, -121.5915];
const INSIDE_YELLOW = [36.6145, -121.592];
const INSIDE_GREEN = [36.6142, -121.588];
const OFF_FARM = [36.63, -121.62];

let opSerial = 0;

function fixture() {
  const mediaDir = mkdtempSync(join(tmpdir(), 'farmworx-'));
  const db = openDb();
  seed(db, NOW);
  const ctx = { db, mediaDir, now: NOW };
  const run = (type, personId, payload, ts = NOW) => {
    const result = applyOps(ctx, [{ id: `t-${++opSerial}`, type, personId, ts, payload }]);
    assert.deepEqual(result.rejected, [], JSON.stringify(result.rejected));
    return result;
  };
  const position = (kind, id) => db.prepare('SELECT * FROM presence WHERE owner_type = ? AND owner_id = ?').get(kind, id);
  const openAlerts = (kind) => db.prepare('SELECT * FROM alerts WHERE kind = ? AND resolved_at IS NULL').all(kind);
  return { db, ctx, run, position, openAlerts, cleanup: () => rmSync(mediaDir, { recursive: true, force: true }) };
}

test('pointInPolygon and distance', () => {
  assert.equal(pointInPolygon([0.005, 0.005], SQUARE), true);
  assert.equal(pointInPolygon([0.02, 0.005], SQUARE), false);
  assert.equal(distanceToPolygonM([0.005, 0.005], SQUARE), 0);
  const metres = distanceToPolygonM([0.011, 0.005], SQUARE);
  assert.ok(metres > 105 && metres < 118, `got ${metres}`);
});

test('GPS drift at a fence does not change zone, a clear exit does', () => {
  const zones = [{ id: 'a', kind: 'block', polygon: SQUARE }];
  const justOutside = [0.0101, 0.005];
  const farOutside = [0.012, 0.005];
  assert.equal(resolveZone(justOutside, zones, 'a'), 'a');
  assert.equal(resolveZone(farOutside, zones, 'a'), null);
  assert.equal(resolveZone(justOutside, zones, null), null);
});

test('a poor GPS fix widens the drift allowance', () => {
  const zones = [{ id: 'a', kind: 'block', polygon: SQUARE }];
  const point = [0.0106, 0.005];
  assert.equal(resolveZone(point, zones, 'a', 5), null);
  assert.equal(resolveZone(point, zones, 'a', 90), 'a');
});

test('shift hours subtract breaks', () => {
  const [shift] = buildShifts([
    { type: 'in', ts: 0 },
    { type: 'break_start', ts: 4 * HOUR },
    { type: 'break_end', ts: 4.5 * HOUR },
    { type: 'out', ts: 8.5 * HOUR },
  ], 9 * HOUR);
  assert.equal(shift.workedMin, 480);
  assert.equal(shift.breakMin, 30);
  assert.deepEqual(shift.flags, []);
});

test('a forgotten clock-out gives no hours and a flag, rather than a guess', () => {
  const shifts = buildShifts([{ type: 'in', ts: 0 }, { type: 'in', ts: 24 * HOUR }, { type: 'out', ts: 32 * HOUR }], 33 * HOUR);
  assert.equal(shifts[0].workedMin, null);
  assert.deepEqual(shifts[0].flags, ['missing_out']);
  assert.equal(shifts[1].workedMin, 480);
});

test('a clock-out with no clock-in is flagged', () => {
  const [shift] = buildShifts([{ type: 'out', ts: HOUR }], 2 * HOUR);
  assert.equal(shift.workedMin, null);
  assert.deepEqual(shift.flags, ['missing_in']);
});

test('over five hours without a 30 minute break is flagged', () => {
  const [shift] = buildShifts([{ type: 'in', ts: 0 }, { type: 'out', ts: 6 * HOUR }], 7 * HOUR);
  assert.ok(shift.flags.includes('short_break'));
});

test('an open shift counts up to now and stays open', () => {
  const [shift] = buildShifts([{ type: 'in', ts: 0 }], 2 * HOUR);
  assert.equal(shift.workedMin, 120);
  assert.deepEqual(shift.flags, ['open']);
});

test('a night shift belongs to the farm-local day it started', () => {
  const { db, cleanup } = fixture();
  const lateEvening = Date.parse('2026-10-20T06:30:00Z');
  assert.equal(localDate(lateEvening, 'America/Los_Angeles'), '2026-10-19');
  db.prepare("INSERT INTO punches (id, person_id, type, ts, received_at, method) VALUES ('n1', 'tom', 'in', ?, ?, 'button'), ('n2', 'tom', 'out', ?, ?, 'button')")
    .run(lateEvening, lateEvening, lateEvening + 4 * HOUR, lateEvening);
  const sheet = timesheet(db, '2026-10-19', '2026-10-19', NOW);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0].workedMin, 240);
  cleanup();
});

test('CSV neutralises spreadsheet formulas in names', () => {
  const csv = timesheetCsv({
    timezone: 'UTC',
    rows: [{ name: '=HYPERLINK("x")', date: '2026-11-05', start: 0, end: HOUR, breakMin: 0, workedMin: 60, flags: [] }],
  });
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), csv);
});

test('resending the same op changes nothing', () => {
  const { db, ctx, cleanup } = fixture();
  const op = { id: 'repeat-1', type: 'punch', personId: 'tom', ts: NOW, payload: { type: 'in' } };
  applyOps(ctx, [op]);
  const again = applyOps(ctx, [op]);
  assert.deepEqual(again.applied, ['repeat-1']);
  const { n } = db.prepare("SELECT COUNT(*) n FROM punches WHERE id = 'repeat-1'").get();
  assert.equal(n, 1);
  cleanup();
});

test('a bad op is rejected without blocking the rest of the batch', () => {
  const { ctx, cleanup } = fixture();
  const result = applyOps(ctx, [
    { id: 'bad', type: 'launch_rocket', ts: NOW },
    { id: 'good', type: 'punch', personId: 'tom', ts: NOW, payload: { type: 'in' } },
  ]);
  assert.deepEqual(result.applied, ['good']);
  assert.equal(result.rejected[0].id, 'bad');
  cleanup();
});

test('a phone with its clock set ahead cannot record future times', () => {
  const { db, ctx, cleanup } = fixture();
  applyOps(ctx, [{ id: 'future', type: 'punch', personId: 'tom', ts: NOW + 10 * HOUR, payload: { type: 'in' } }]);
  const { ts } = db.prepare("SELECT ts FROM punches WHERE id = 'future'").get();
  assert.ok(ts <= NOW + 5 * MINUTE);
  cleanup();
});

test('gate badge toggles in, then out', () => {
  const { db, run, cleanup } = fixture();
  run('punch', 'tom', { type: 'toggle', method: 'badge' }, NOW);
  run('punch', 'tom', { type: 'toggle', method: 'badge' }, NOW + HOUR);
  const types = db.prepare("SELECT type FROM punches WHERE person_id = 'tom' ORDER BY ts DESC LIMIT 2").all().map((p) => p.type);
  assert.deepEqual(types, ['out', 'in']);
  cleanup();
});

test('people are never located while off shift, even by a reader', () => {
  const { ctx, position, cleanup } = fixture();
  ingestReadings(ctx, { readerId: 'gate-uhf', reads: [{ uid: '04:A1:7E:12:55:05', ts: NOW }] });
  assert.equal(position('person', 'tom'), undefined);
  cleanup();
});

test('clocking out removes a worker from the live map', () => {
  const { run, position, cleanup } = fixture();
  assert.ok(position('person', 'ana'));
  run('punch', 'ana', { type: 'out' }, NOW + MINUTE);
  assert.equal(position('person', 'ana'), undefined);
  cleanup();
});

test('walking into a no-entry field raises one alert, leaving clears it', () => {
  const { run, openAlerts, cleanup } = fixture();
  run('sighting', 'ana', { lat: INSIDE_YELLOW[0], lng: INSIDE_YELLOW[1], accuracy: 5 }, NOW + MINUTE);
  run('sighting', 'ana', { lat: INSIDE_YELLOW[0], lng: INSIDE_YELLOW[1], accuracy: 5 }, NOW + 2 * MINUTE);
  assert.equal(openAlerts('restricted_entry').length, 1);
  run('sighting', 'ana', { lat: INSIDE_GREEN[0], lng: INSIDE_GREEN[1], accuracy: 5 }, NOW + 3 * MINUTE);
  assert.equal(openAlerts('restricted_entry').length, 0);
  cleanup();
});

test('closing a field alerts on people already inside it', () => {
  const { run, openAlerts, cleanup } = fixture();
  run('zone_restrict', 'sam', { zoneId: 'red', hours: 4 }, NOW);
  assert.ok(openAlerts('restricted_entry').some((a) => a.owner_id === 'ana'));
  cleanup();
});

test('a restriction expires on its own', () => {
  const { ctx, run, openAlerts, cleanup } = fixture();
  ctx.now = NOW + 13 * HOUR;
  run('sighting', 'ana', { lat: INSIDE_YELLOW[0], lng: INSIDE_YELLOW[1] }, ctx.now);
  assert.equal(openAlerts('restricted_entry').length, 0);
  cleanup();
});

test('leaving the farm on shift alerts once, not on every position', () => {
  const { run, openAlerts, cleanup } = fixture();
  run('sighting', 'luis', { lat: OFF_FARM[0], lng: OFF_FARM[1] }, NOW + MINUTE);
  run('sighting', 'luis', { lat: OFF_FARM[0], lng: OFF_FARM[1] }, NOW + 2 * MINUTE);
  assert.equal(openAlerts('person_off_farm').length, 1);
  run('sighting', 'luis', { lat: INSIDE_RED[0], lng: INSIDE_RED[1] }, NOW + 3 * MINUTE);
  assert.equal(openAlerts('person_off_farm').length, 0);
  cleanup();
});

test('equipment fence: GPS tracker exit alerts, return clears', () => {
  const { ctx, openAlerts, position, cleanup } = fixture();
  ingestReadings(ctx, { reads: [{ uid: 'GPS-TRACTOR-1', lat: OFF_FARM[0], lng: OFF_FARM[1], ts: NOW + MINUTE }] });
  assert.equal(openAlerts('asset_left_fence').length, 1);
  assert.equal(position('asset', 'tractor').outside_fence, 1);
  ingestReadings(ctx, { reads: [{ uid: 'GPS-TRACTOR-1', lat: 36.615, lng: -121.5962, ts: NOW + 2 * MINUTE }] });
  assert.equal(openAlerts('asset_left_fence').length, 0);
  cleanup();
});

test('a late upload from a phone stays in history but does not move the live marker', () => {
  const { db, run, position, cleanup } = fixture();
  const current = position('person', 'ana');
  run('sighting', 'ana', { lat: OFF_FARM[0], lng: OFF_FARM[1] }, current.ts - 30 * MINUTE);
  assert.equal(position('person', 'ana').lat, current.lat);
  const { n } = db.prepare("SELECT COUNT(*) n FROM sightings WHERE owner_id = 'ana' AND lat = ?").get(OFF_FARM[0]);
  assert.equal(n, 1);
  cleanup();
});

test('an unknown tag is kept for the supervisor to register', () => {
  const { db, ctx, run, position, cleanup } = fixture();
  ingestReadings(ctx, { readerId: 'gate-uhf', reads: [{ uid: 'e280-new', ts: NOW }] });
  assert.equal(db.prepare("SELECT owner_type FROM tags WHERE uid = 'E280-NEW'").get().owner_type, null);
  run('tag_register', 'sam', { uid: 'e280-new', kind: 'uhf', ownerType: 'asset', ownerId: 'pump' });
  ingestReadings(ctx, { readerId: 'gate-uhf', reads: [{ uid: 'E280-NEW', ts: NOW + MINUTE }] });
  assert.equal(position('asset', 'pump').source, 'reader:gate-uhf');
  cleanup();
});

test('tapping a field sign places the worker in that field', () => {
  const { run, position, cleanup } = fixture();
  run('tag_read', 'ana', { uid: '04:C3:20:00:00:04' }, NOW + MINUTE);
  assert.equal(position('person', 'ana').zone_id, 'green');
  cleanup();
});

test('checking out a tool records holder and position', () => {
  const { db, run, position, cleanup } = fixture();
  run('asset_checkout', 'ana', { assetId: 'sprayer', action: 'take', lat: INSIDE_RED[0], lng: INSIDE_RED[1] }, NOW + MINUTE);
  assert.equal(db.prepare("SELECT holder_id FROM assets WHERE id = 'sprayer'").get().holder_id, 'ana');
  assert.equal(position('asset', 'sprayer').zone_id, 'red');
  run('asset_checkout', 'ana', { assetId: 'sprayer', action: 'return' }, NOW + 2 * MINUTE);
  assert.equal(db.prepare("SELECT holder_id FROM assets WHERE id = 'sprayer'").get().holder_id, null);
  cleanup();
});

test('task travels from supervisor to worker and problems come back', () => {
  const { db, run, cleanup } = fixture();
  run('task_create', 'sam', { action: 'water', thing: 'tomato', zoneId: 'green', assigneeId: 'tom' }, NOW);
  const id = `t-${opSerial}`;
  assert.ok(buildState(db, { personId: 'tom', now: NOW }).tasks.some((x) => x.id === id));
  run('task_update', 'tom', { taskId: id, status: 'problem', reason: 'broken' }, NOW + MINUTE);
  const task = buildState(db, { now: NOW }).tasks.find((x) => x.id === id);
  assert.equal(task.status, 'problem');
  assert.equal(task.problem, 'broken');
  cleanup();
});

test('a worker request reaches the supervisor and can be reassigned', () => {
  const { db, run, cleanup } = fixture();
  run('task_create', 'tom', { action: 'leak', zoneId: 'blue', origin: 'worker' }, NOW);
  const id = `t-${opSerial}`;
  assert.equal(buildState(db, { now: NOW }).tasks.find((x) => x.id === id).status, 'request');
  run('task_update', 'sam', { taskId: id, status: 'todo', assigneeId: 'luis' }, NOW + MINUTE);
  assert.ok(buildState(db, { personId: 'luis', now: NOW }).tasks.some((x) => x.id === id));
  cleanup();
});

test('an older offline task update never overwrites a newer one', () => {
  const { db, run, cleanup } = fixture();
  run('task_update', 'ana', { taskId: 'task-fix', status: 'done' }, NOW);
  run('task_update', 'ana', { taskId: 'task-fix', status: 'doing' }, NOW - HOUR);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-fix'").get().status, 'done');
  const events = db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id = 'task-fix'").get();
  assert.equal(events.n, 3);
  cleanup();
});

test('photos are stored, and non-media uploads are refused', () => {
  const { ctx, run, cleanup } = fixture();
  run('note', 'ana', { kind: 'photo', data: 'data:image/jpeg;base64,/9j/2Q==' });
  assert.equal(readdirSync(ctx.mediaDir).length, 1);
  const bad = applyOps(ctx, [{ id: 'evil', type: 'note', personId: 'ana', ts: NOW, payload: { kind: 'photo', data: 'data:text/html;base64,PHNjcmlwdD4=' } }]);
  assert.equal(bad.rejected[0].error, 'unsupported media');
  assert.equal(readdirSync(ctx.mediaDir).length, 1);
  cleanup();
});

test('voice clips keep their codec suffix', () => {
  const { ctx, run, cleanup } = fixture();
  run('note', 'ana', { kind: 'voice', data: 'data:audio/webm;codecs=opus;base64,GkXfow==' });
  assert.ok(readdirSync(ctx.mediaDir)[0].endsWith('.webm'));
  cleanup();
});

test("a worker's view hides everyone else's location", () => {
  const { db, cleanup } = fixture();
  const state = buildState(db, { personId: 'ana', now: NOW });
  assert.ok(state.people.find((p) => p.id === 'ana').lat !== null);
  assert.equal(state.people.find((p) => p.id === 'luis').lat, null);
  assert.deepEqual(state.alerts, []);
  cleanup();
});

test('seed data puts every worker and machine where intended', () => {
  const { db, cleanup } = fixture();
  const state = buildState(db, { now: NOW });
  const zone = (id) => state.people.find((p) => p.id === id).zoneId;
  assert.deepEqual([zone('ana'), zone('luis'), zone('marco'), zone('elena')], ['red', 'red', 'blue', 'green']);
  assert.deepEqual(state.assets.filter((a) => a.outsideFence), []);
  assert.deepEqual(state.alerts, []);
  cleanup();
});

test('HTTP: sync, tag URL, static safety, media', async (t) => {
  const { db, ctx, cleanup } = fixture();
  const server = createApp({ db, mediaDir: ctx.mediaDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    cleanup();
  });

  const sync = await fetch(`${base}/api/sync`, {
    method: 'POST',
    body: JSON.stringify({ ops: [{ id: 'http-1', type: 'punch', personId: 'tom', ts: Date.now(), payload: { type: 'in' } }] }),
  });
  assert.deepEqual((await sync.json()).applied, ['http-1']);

  const tag = await fetch(`${base}/t/04%3AB2%3A10%3A00%3A00%3A01`, { redirect: 'manual' });
  assert.equal(tag.status, 302);
  assert.equal(tag.headers.get('location'), '/worker.html?tag=04%3AB2%3A10%3A00%3A00%3A01');

  assert.equal((await fetch(`${base}/worker.html`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/media/..%2f..%2fserver.js`)).status, 404);

  assert.equal((await fetch(`${base}/api/timesheet?from=x&to=y`)).status, 400);
  const csv = await fetch(`${base}/api/timesheet.csv?from=2026-10-29&to=2026-11-05`);
  assert.match(await csv.text(), /^Name,Date,In,Out/);

  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST', body: '{oops' })).status, 400);
});
