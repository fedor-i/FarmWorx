import { getSetting } from './db.js';
import { buildShifts, localDate } from './timesheet.js';

const DAY = 86_400_000;
const STATUS_BY_PUNCH = { in: 'on', break_end: 'on', break_start: 'break', out: 'off' };

function presenceMap(db, ownerType) {
  const rows = db.prepare('SELECT * FROM presence WHERE owner_type = ?').all(ownerType);
  return new Map(rows.map((row) => [row.owner_id, row]));
}

function personView(db, person, presence, tz, now) {
  const punches = db.prepare('SELECT type, ts FROM punches WHERE person_id = ? AND ts > ? ORDER BY ts').all(person.id, now - 2 * DAY);
  const last = punches.at(-1);
  const today = localDate(now, tz);
  const shifts = buildShifts(punches, now);
  const todayMin = shifts
    .filter((shift) => shift.start && localDate(shift.start, tz) === today)
    .reduce((sum, shift) => sum + (shift.workedMin ?? 0), 0);
  const here = presence.get(person.id);
  return {
    id: person.id,
    name: person.name,
    lang: person.lang,
    avatar: person.avatar,
    color: person.color,
    role: person.role,
    locationConsent: person.location_consent,
    status: STATUS_BY_PUNCH[last?.type] ?? 'off',
    since: last?.ts ?? null,
    todayMin,
    zoneId: here?.zone_id ?? null,
    lat: here?.lat ?? null,
    lng: here?.lng ?? null,
    seenAt: here?.ts ?? null,
    seenBy: here?.source ?? null,
  };
}

function taskView(row) {
  return {
    id: row.id,
    action: row.action,
    thing: row.thing,
    zoneId: row.zone_id,
    qty: row.qty,
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    origin: row.origin,
    status: row.status,
    problem: row.problem,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function noteView(row) {
  return {
    id: row.id,
    personId: row.person_id,
    taskId: row.task_id,
    kind: row.kind,
    text: row.text,
    url: row.media ? `media/${row.media}` : null,
    zoneId: row.zone_id,
    ts: row.ts,
  };
}

// With personId set this is a worker's view: only their own work and position, never the crew's.
export function buildState(db, { personId = null, now = Date.now() } = {}) {
  const tz = getSetting(db, 'timezone', 'UTC');
  const peoplePresence = presenceMap(db, 'person');
  const assetPresence = presenceMap(db, 'asset');

  let people = db.prepare('SELECT * FROM people ORDER BY name').all().map((p) => personView(db, p, peoplePresence, tz, now));
  if (personId) {
    people = people.map((p) => (p.id === personId ? p : { ...p, zoneId: null, lat: null, lng: null, seenAt: null, seenBy: null, todayMin: 0 }));
  }

  const zones = db.prepare('SELECT * FROM zones').all().map((z) => ({
    id: z.id,
    kind: z.kind,
    names: JSON.parse(z.names),
    color: z.color,
    symbol: z.symbol,
    crop: z.crop,
    polygon: JSON.parse(z.polygon),
    restrictedUntil: z.restricted_until,
    restrictedReason: z.restricted_reason,
  }));

  const assets = db.prepare('SELECT * FROM assets ORDER BY name').all().map((a) => {
    const here = assetPresence.get(a.id);
    return {
      id: a.id,
      name: a.name,
      icon: a.icon,
      fenceZoneId: a.fence_zone_id,
      holderId: a.holder_id,
      zoneId: here?.zone_id ?? null,
      lat: here?.lat ?? null,
      lng: here?.lng ?? null,
      seenAt: here?.ts ?? null,
      seenBy: here?.source ?? null,
      outsideFence: Boolean(here?.outside_fence),
    };
  });

  const tags = db.prepare('SELECT * FROM tags ORDER BY last_seen DESC').all().map((t) => ({
    uid: t.uid,
    kind: t.kind,
    ownerType: t.owner_type,
    ownerId: t.owner_id,
    lastSeen: t.last_seen,
  }));

  const taskRows = personId
    ? db.prepare(`SELECT * FROM tasks WHERE (assignee_id = ? OR created_by = ?) AND (status != 'done' OR updated_ts > ?) ORDER BY created_ts DESC`).all(personId, personId, now - DAY)
    : db.prepare(`SELECT * FROM tasks WHERE status != 'done' OR updated_ts > ? ORDER BY created_ts DESC`).all(now - 2 * DAY);
  const tasks = taskRows.map(taskView);

  const taskIds = tasks.map((t) => t.id);
  const notes = db.prepare('SELECT * FROM notes ORDER BY ts DESC LIMIT 200').all()
    .filter((n) => !personId || n.person_id === personId || taskIds.includes(n.task_id))
    .map(noteView);

  const alerts = personId
    ? []
    : db.prepare('SELECT * FROM alerts WHERE acked_at IS NULL ORDER BY ts DESC LIMIT 50').all().map((a) => ({
        id: a.id,
        kind: a.kind,
        ownerType: a.owner_type,
        ownerId: a.owner_id,
        zoneId: a.zone_id,
        ts: a.ts,
        resolvedAt: a.resolved_at,
      }));

  return {
    farm: { name: getSetting(db, 'farm_name', 'Farm'), timezone: tz },
    serverTime: now,
    people,
    zones,
    assets,
    tags,
    tasks,
    notes,
    alerts,
    readers: db.prepare('SELECT * FROM readers').all(),
  };
}
