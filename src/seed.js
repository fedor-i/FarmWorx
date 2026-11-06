import { tx } from './db.js';
import { applyOps } from './ops.js';
import { localDate } from './timesheet.js';

const TIMEZONE = 'America/Los_Angeles';
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

// A made-up ranch laid out on farmland in the Salinas Valley, used only to give the map real coordinates.
const ORIGIN = [36.6195, -121.5985];
const STEP_LAT = 0.0034;
const STEP_LNG = 0.0042;

function block(row, col, heightSteps = 1, widthSteps = 1) {
  const gap = 0.00012;
  const north = ORIGIN[0] - row * STEP_LAT - gap;
  const south = north - heightSteps * STEP_LAT + 2 * gap;
  const west = ORIGIN[1] + col * STEP_LNG + gap;
  const east = west + widthSteps * STEP_LNG - 2 * gap;
  return [[north, west], [north, east], [south, east], [south, west]];
}

const ZONES = [
  { id: 'farm', kind: 'farm', names: { en: 'Demo Ranch', es: 'Rancho Demo' }, color: '#8a9a90', symbol: '', crop: null, polygon: block(-0.1, -0.1, 2.3, 3.2) },
  { id: 'yard', kind: 'yard', names: { en: 'Shop yard', es: 'Patio del taller' }, color: '#6b7280', symbol: '◆', crop: null, polygon: block(0, 0, 0.55, 0.8) },
  { id: 'red', kind: 'block', names: { en: 'Red field', es: 'Campo rojo' }, color: '#d1432f', symbol: '●', crop: 'strawberry', polygon: block(0, 1) },
  { id: 'blue', kind: 'block', names: { en: 'Blue field', es: 'Campo azul' }, color: '#2467c9', symbol: '▲', crop: 'lettuce', polygon: block(0, 2) },
  { id: 'yellow', kind: 'block', names: { en: 'Yellow field', es: 'Campo amarillo' }, color: '#d39b00', symbol: '★', crop: 'tomato', polygon: block(1, 1) },
  { id: 'green', kind: 'block', names: { en: 'Green field', es: 'Campo verde' }, color: '#2f8a4e', symbol: '■', crop: 'broccoli', polygon: block(1, 2) },
];

const PEOPLE = [
  { id: 'ana', name: 'Ana Reyes', lang: 'es', avatar: '👩🏽‍🌾', color: '#f4b8a0' },
  { id: 'luis', name: 'Luis Ortega', lang: 'es', avatar: '👨🏽‍🌾', color: '#a9cfa4' },
  { id: 'marco', name: 'Marco Díaz', lang: 'es', avatar: '👨🏾‍🦱', color: '#a7c6ec' },
  { id: 'elena', name: 'Elena Cruz', lang: 'es', avatar: '👵🏽', color: '#e8cf7f' },
  { id: 'tom', name: 'Tom Becker', lang: 'en', avatar: '🧔🏼', color: '#cdb5e6' },
  { id: 'sam', name: 'Sam Porter', lang: 'en', avatar: '🧑🏻‍💼', color: '#b9c6c0', role: 'supervisor' },
];

const ASSETS = [
  { id: 'tractor', name: 'Tractor 1', icon: '🚜', fence: 'farm', at: [36.6150, -121.5962] },
  { id: 'pickup', name: 'Crew pickup', icon: '🛻', fence: 'farm', at: [36.6188, -121.5978] },
  { id: 'pump', name: 'Water pump', icon: '⛽', fence: 'farm', at: [36.6186, -121.5868] },
  { id: 'generator', name: 'Generator', icon: '🔌', fence: 'yard', at: [36.6190, -121.5958] },
  { id: 'sprayer', name: 'Backpack sprayer', icon: '🎒', fence: 'yard', at: [36.6182, -121.5966] },
];

const TAGS = [
  ['04:A1:7E:12:55:01', 'nfc', 'person', 'ana'],
  ['04:A1:7E:12:55:02', 'nfc', 'person', 'luis'],
  ['04:A1:7E:12:55:03', 'nfc', 'person', 'marco'],
  ['04:A1:7E:12:55:04', 'nfc', 'person', 'elena'],
  ['04:A1:7E:12:55:05', 'nfc', 'person', 'tom'],
  ['04:B2:10:00:00:01', 'nfc', 'asset', 'tractor'],
  ['04:B2:10:00:00:02', 'nfc', 'asset', 'pickup'],
  ['04:B2:10:00:00:03', 'nfc', 'asset', 'sprayer'],
  ['04:C3:20:00:00:01', 'nfc', 'zone', 'red'],
  ['04:C3:20:00:00:02', 'nfc', 'zone', 'blue'],
  ['04:C3:20:00:00:03', 'nfc', 'zone', 'yellow'],
  ['04:C3:20:00:00:04', 'nfc', 'zone', 'green'],
  ['E280-1170-0000-GEN', 'uhf', 'asset', 'generator'],
  ['BLE-AC23-PUMP', 'ble', 'asset', 'pump'],
  ['GPS-TRACTOR-1', 'gps', 'asset', 'tractor'],
];

function farmTime(dateText, hour, minute) {
  const guess = Date.parse(`${dateText}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'longOffset' }).formatToParts(guess);
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.find((p) => p.type === 'timeZoneName').value);
  const offset = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * HOUR + Number(match[3]) * MINUTE);
  return guess - offset;
}

function seedHistory(ops, now) {
  const workers = PEOPLE.filter((p) => !p.role);
  let counter = 0;
  const add = (type, personId, ts, payload) => ops.push({ id: `seed-${++counter}`, type, personId, ts, payload });

  for (let daysAgo = 1; daysAgo <= 7; daysAgo++) {
    const date = localDate(now - daysAgo * DAY, TIMEZONE);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) continue;
    workers.forEach((person, index) => {
      const start = farmTime(date, 7, 2 + index * 4 + (daysAgo % 3));
      add('punch', person.id, start, { type: 'in', method: index % 2 ? 'badge' : 'button' });
      const skipBreak = person.id === 'elena' && daysAgo === 1;
      if (!skipBreak) {
        add('punch', person.id, start + 5 * HOUR - 10 * MINUTE, { type: 'break_start', method: 'button' });
        add('punch', person.id, start + 5 * HOUR + 22 * MINUTE, { type: 'break_end', method: 'button' });
      }
      const forgotToClockOut = person.id === 'marco' && daysAgo === 1;
      if (!forgotToClockOut) add('punch', person.id, start + 8.5 * HOUR + (index % 3) * 6 * MINUTE, { type: 'out', method: index % 2 ? 'badge' : 'button' });
    });
  }

  const shiftStart = now - 3 * HOUR;
  const onShift = { ana: [36.6172, -121.5915], luis: [36.6168, -121.5932], marco: [36.6172, -121.5880], elena: [36.6142, -121.5880] };
  Object.entries(onShift).forEach(([personId, [lat, lng]], index) => {
    add('punch', personId, shiftStart + index * 3 * MINUTE, { type: 'in', method: index % 2 ? 'badge' : 'button' });
    add('sighting', personId, now - (index + 1) * MINUTE, { lat, lng, accuracy: 8 });
  });

  for (const asset of ASSETS) {
    add('sighting', null, now - 5 * MINUTE, { ownerType: 'asset', ownerId: asset.id, lat: asset.at[0], lng: asset.at[1], source: 'seed' });
  }

  add('zone_restrict', 'sam', now - 2 * HOUR, { zoneId: 'yellow', hours: 12, reason: 'Pesticide applied' });

  const task = (id, ts, payload, personId = 'sam') => ops.push({ id, type: 'task_create', personId, ts, payload });
  task('task-harvest', now - 170 * MINUTE, { action: 'harvest', thing: 'strawberry', zoneId: 'red', qty: 40, assigneeId: 'ana' });
  task('task-weed', now - 165 * MINUTE, { action: 'weed', thing: 'strawberry', zoneId: 'red', assigneeId: 'luis' });
  task('task-water', now - 160 * MINUTE, { action: 'water', thing: 'lettuce', zoneId: 'blue', assigneeId: 'marco' });
  task('task-fix', now - 150 * MINUTE, { action: 'load', thing: 'bins', zoneId: 'yard', qty: 12, assigneeId: 'ana' });
  task('task-plant', now - 120 * MINUTE, { action: 'plant', thing: 'broccoli', zoneId: 'green', assigneeId: 'elena' });
  ops.push({ id: 'seed-doing', type: 'task_update', personId: 'ana', ts: now - 140 * MINUTE, payload: { taskId: 'task-harvest', status: 'doing' } });
  ops.push({ id: 'seed-problem', type: 'task_update', personId: 'marco', ts: now - 40 * MINUTE, payload: { taskId: 'task-water', status: 'problem', reason: 'broken' } });
  task('task-request', now - 25 * MINUTE, { action: 'need_water', zoneId: 'green', origin: 'worker' }, 'elena');
}

export function seed(db, now = Date.now()) {
  tx(db, () => {
    const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    setting.run('farm_name', 'Demo Ranch');
    setting.run('timezone', TIMEZONE);
    for (const z of ZONES) {
      db.prepare('INSERT INTO zones (id, kind, names, color, symbol, crop, polygon) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(z.id, z.kind, JSON.stringify(z.names), z.color, z.symbol, z.crop, JSON.stringify(z.polygon));
    }
    for (const p of PEOPLE) {
      db.prepare('INSERT INTO people (id, name, lang, avatar, color, role) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.name, p.lang, p.avatar, p.color, p.role ?? 'worker');
    }
    for (const a of ASSETS) {
      db.prepare('INSERT INTO assets (id, name, icon, fence_zone_id) VALUES (?, ?, ?, ?)').run(a.id, a.name, a.icon, a.fence);
    }
    for (const [uid, kind, ownerType, ownerId] of TAGS) {
      db.prepare('INSERT INTO tags (uid, kind, owner_type, owner_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(uid, kind, ownerType, ownerId, now - 30 * DAY, now - 30 * DAY);
    }
    db.prepare('INSERT INTO readers (id, name, kind, lat, lng) VALUES (?, ?, ?, ?, ?)').run('gate-uhf', 'Shop gate UHF reader', 'uhf', 36.6180, -121.5955);
  });

  const ops = [];
  seedHistory(ops, now);
  const { rejected } = applyOps({ db, now }, ops);
  if (rejected.length) throw new Error(`seed failed: ${JSON.stringify(rejected[0])}`);
}

export function seedIfEmpty(db) {
  if (!db.prepare('SELECT 1 FROM people LIMIT 1').get()) seed(db);
}
