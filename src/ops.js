import { tx } from './db.js';
import { driftBuffer, distanceToPolygonM, polygonCentre, resolveZone } from '../public/js/geo.js';

const CLOCK_SKEW_LIMIT = 5 * 60_000;
const HOUR = 3_600_000;
const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};
const TASK_STATUSES = new Set(['request', 'todo', 'doing', 'problem', 'done']);
const PUNCH_TYPES = new Set(['in', 'out', 'break_start', 'break_end']);

function require_(condition, message) {
  if (!condition) throw new Error(message);
}

function loadZones(db) {
  return db.prepare('SELECT * FROM zones').all().map((z) => ({ ...z, polygon: JSON.parse(z.polygon) }));
}

function lastPunchType(db, personId, ts) {
  return db.prepare('SELECT type FROM punches WHERE person_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(personId, ts)?.type;
}

function raiseAlert(db, kind, ownerType, ownerId, zoneId, ts) {
  db.prepare('INSERT INTO alerts (kind, owner_type, owner_id, zone_id, ts) VALUES (?, ?, ?, ?, ?)').run(kind, ownerType, ownerId, zoneId, ts);
}

function resolveAlerts(db, kind, ownerType, ownerId, ts) {
  db.prepare('UPDATE alerts SET resolved_at = ? WHERE kind = ? AND owner_type = ? AND owner_id = ? AND resolved_at IS NULL').run(ts, kind, ownerType, ownerId);
}

function checkPersonRules(db, zones, personId, zoneId, previousZoneId, ts) {
  const zone = zones.find((z) => z.id === zoneId);
  if (zoneId !== previousZoneId && zone?.restricted_until > ts) raiseAlert(db, 'restricted_entry', 'person', personId, zoneId, ts);
  if (!(zone?.restricted_until > ts)) resolveAlerts(db, 'restricted_entry', 'person', personId, ts);

  if (zoneId === null && previousZoneId !== null) raiseAlert(db, 'person_off_farm', 'person', personId, null, ts);
  if (zoneId !== null) resolveAlerts(db, 'person_off_farm', 'person', personId, ts);
}

function checkAssetRules(db, zones, assetId, point, accuracy, wasOutside, ts) {
  const asset = db.prepare('SELECT fence_zone_id FROM assets WHERE id = ?').get(assetId);
  const fence = zones.find((z) => z.id === asset?.fence_zone_id);
  if (!fence) return false;
  const outside = distanceToPolygonM(point, fence.polygon) > driftBuffer(accuracy);
  if (outside && !wasOutside) raiseAlert(db, 'asset_left_fence', 'asset', assetId, fence.id, ts);
  if (!outside && wasOutside) resolveAlerts(db, 'asset_left_fence', 'asset', assetId, ts);
  return outside;
}

// The single path for every position: phone GPS, NFC tap, gate reader or vehicle tracker.
export function recordSighting(db, { ownerType, ownerId, lat, lng, accuracy = null, source, ts, tagUid = null }) {
  require_(Number.isFinite(lat) && Number.isFinite(lng), 'sighting needs a position');
  // People are only located during a shift, whatever hardware reports them.
  if (ownerType === 'person' && !['in', 'break_start', 'break_end'].includes(lastPunchType(db, ownerId, ts))) return;

  const zones = loadZones(db);
  const previous = db.prepare('SELECT * FROM presence WHERE owner_type = ? AND owner_id = ?').get(ownerType, ownerId);
  const zoneId = resolveZone([lat, lng], zones, previous?.zone_id, accuracy);
  db.prepare('INSERT INTO sightings (owner_type, owner_id, tag_uid, lat, lng, accuracy, zone_id, source, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ownerType, ownerId, tagUid, lat, lng, accuracy, zoneId, source, ts);

  // A phone back from a dead zone uploads old points; they belong in history, not on the live map.
  if (previous && ts < previous.ts) return;

  let outsideFence = 0;
  if (ownerType === 'person') checkPersonRules(db, zones, ownerId, zoneId, previous ? previous.zone_id : undefined, ts);
  else outsideFence = checkAssetRules(db, zones, ownerId, [lat, lng], accuracy, Boolean(previous?.outside_fence), ts) ? 1 : 0;

  db.prepare(`INSERT INTO presence (owner_type, owner_id, lat, lng, accuracy, zone_id, source, ts, outside_fence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_type, owner_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy,
      zone_id = excluded.zone_id, source = excluded.source, ts = excluded.ts, outside_fence = excluded.outside_fence`)
    .run(ownerType, ownerId, lat, lng, accuracy, zoneId, source, ts, outsideFence);
}

function saveMedia(ctx, dataUrl) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[^;,]+)*;base64,(.+)$/s.exec(dataUrl ?? '');
  require_(match && MEDIA_TYPES[match[1]], 'unsupported media');
  const file = `${crypto.randomUUID()}.${MEDIA_TYPES[match[1]]}`;
  ctx.saveFile(file, match[2]);
  return file;
}

function currentZone(db, personId) {
  return db.prepare("SELECT zone_id FROM presence WHERE owner_type = 'person' AND owner_id = ?").get(personId)?.zone_id ?? null;
}

const handlers = {
  punch(ctx, op) {
    const { db } = ctx;
    const { lat = null, lng = null, accuracy = null, method = 'button', enteredBy = null, note = null } = op.payload;
    let { type } = op.payload;
    if (type === 'toggle') type = ['in', 'break_start', 'break_end'].includes(lastPunchType(db, op.personId, op.ts)) ? 'out' : 'in';
    require_(PUNCH_TYPES.has(type), 'bad punch type');

    db.prepare(`INSERT INTO punches (id, person_id, type, ts, received_at, lat, lng, accuracy, zone_id, method, entered_by, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(op.id, op.personId, type, op.ts, ctx.now, lat, lng, accuracy, currentZone(db, op.personId), method, enteredBy, note);

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      recordSighting(db, { ownerType: 'person', ownerId: op.personId, lat, lng, accuracy, source: `punch:${method}`, ts: op.ts });
      db.prepare('UPDATE punches SET zone_id = ? WHERE id = ?').run(currentZone(db, op.personId), op.id);
    }
    if (type === 'out') {
      db.prepare("DELETE FROM presence WHERE owner_type = 'person' AND owner_id = ?").run(op.personId);
      resolveAlerts(db, 'person_off_farm', 'person', op.personId, op.ts);
      resolveAlerts(db, 'restricted_entry', 'person', op.personId, op.ts);
    }
  },

  task_create(ctx, op) {
    const { action, thing = null, zoneId = null, qty = null, assigneeId = null, origin = 'boss' } = op.payload;
    require_(action, 'task needs an action');
    const status = origin === 'worker' ? 'request' : 'todo';
    ctx.db.prepare(`INSERT INTO tasks (id, action, thing, zone_id, qty, assignee_id, created_by, origin, status, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(op.id, action, thing, zoneId, qty, assigneeId, op.personId, origin, status, op.ts, op.ts);
    ctx.db.prepare('INSERT INTO task_events (task_id, status, person_id, ts) VALUES (?, ?, ?, ?)').run(op.id, status, op.personId, op.ts);
  },

  task_update(ctx, op) {
    const { db } = ctx;
    const { taskId, status, reason = null, assigneeId } = op.payload;
    require_(TASK_STATUSES.has(status), 'bad task status');
    const task = db.prepare('SELECT updated_ts, assignee_id FROM tasks WHERE id = ?').get(taskId);
    require_(task, 'unknown task');
    db.prepare('INSERT INTO task_events (task_id, status, person_id, reason, ts) VALUES (?, ?, ?, ?, ?)').run(taskId, status, op.personId, reason, op.ts);
    // Offline phones can report late. The full history is kept, but the card shows the newest change.
    if (op.ts < task.updated_ts) return;
    db.prepare('UPDATE tasks SET status = ?, problem = ?, assignee_id = ?, updated_ts = ? WHERE id = ?')
      .run(status, status === 'problem' ? reason : null, assigneeId === undefined ? task.assignee_id : assigneeId, op.ts, taskId);
  },

  note(ctx, op) {
    const { taskId = null, kind, text = null, data = null, lat = null, lng = null } = op.payload;
    require_(['text', 'photo', 'voice'].includes(kind), 'bad note kind');
    require_(kind !== 'text' || text?.trim(), 'empty note');
    const media = kind === 'text' ? null : saveMedia(ctx, data);
    ctx.db.prepare('INSERT INTO notes (id, person_id, task_id, kind, text, media, lat, lng, zone_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(op.id, op.personId, taskId, kind, text, media, lat, lng, currentZone(ctx.db, op.personId), op.ts);
  },

  sighting(ctx, op) {
    const { ownerType = 'person', ownerId = op.personId, lat, lng, accuracy = null, source = 'phone-gps' } = op.payload;
    recordSighting(ctx.db, { ownerType, ownerId, lat, lng, accuracy, source, ts: op.ts });
  },

  tag_read(ctx, op) {
    const { db } = ctx;
    const { kind = 'nfc', lat, lng, accuracy = null, source = 'phone-nfc' } = op.payload;
    const uid = String(op.payload.uid ?? '').toUpperCase();
    require_(uid, 'tag read needs a uid');

    const tag = db.prepare('SELECT * FROM tags WHERE uid = ?').get(uid);
    if (tag) db.prepare('UPDATE tags SET last_seen = ? WHERE uid = ?').run(op.ts, uid);
    else db.prepare('INSERT INTO tags (uid, kind, first_seen, last_seen) VALUES (?, ?, ?, ?)').run(uid, kind, op.ts, op.ts);
    if (!tag?.owner_type) return;

    if (tag.owner_type === 'zone') {
      // A field sign is a known place, so a tap fixes the worker's position where GPS is poor.
      const zone = loadZones(db).find((z) => z.id === tag.owner_id);
      const [zoneLat, zoneLng] = polygonCentre(zone.polygon);
      if (op.personId) recordSighting(db, { ownerType: 'person', ownerId: op.personId, lat: zoneLat, lng: zoneLng, source: 'zone-tag', ts: op.ts, tagUid: uid });
    } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
      recordSighting(db, { ownerType: tag.owner_type, ownerId: tag.owner_id, lat, lng, accuracy, source, ts: op.ts, tagUid: uid });
    }
  },

  asset_checkout(ctx, op) {
    const { assetId, action, lat, lng, accuracy = null } = op.payload;
    require_(['take', 'return'].includes(action), 'bad checkout action');
    ctx.db.prepare('UPDATE assets SET holder_id = ? WHERE id = ?').run(action === 'take' ? op.personId : null, assetId);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      recordSighting(ctx.db, { ownerType: 'asset', ownerId: assetId, lat, lng, accuracy, source: `checkout:${action}`, ts: op.ts });
    }
  },

  consent(ctx, op) {
    const choice = op.payload.location ? 'yes' : 'no';
    ctx.db.prepare('UPDATE people SET location_consent = ?, location_consent_ts = ? WHERE id = ?').run(choice, op.ts, op.personId);
  },

  zone_restrict(ctx, op) {
    const { db } = ctx;
    const { zoneId, hours, reason = null } = op.payload;
    const until = hours > 0 ? op.ts + hours * HOUR : null;
    db.prepare('UPDATE zones SET restricted_until = ?, restricted_reason = ? WHERE id = ?').run(until, until ? reason : null, zoneId);
    const here = db.prepare("SELECT owner_id FROM presence WHERE owner_type = 'person' AND zone_id = ?").all(zoneId);
    for (const { owner_id: personId } of here) {
      if (until) raiseAlert(db, 'restricted_entry', 'person', personId, zoneId, op.ts);
      else resolveAlerts(db, 'restricted_entry', 'person', personId, op.ts);
    }
  },

  tag_register(ctx, op) {
    const { kind, ownerType, ownerId } = op.payload;
    const uid = String(op.payload.uid ?? '').toUpperCase();
    require_(uid && ['person', 'asset', 'zone'].includes(ownerType) && ownerId, 'tag needs a uid and an owner');
    ctx.db.prepare(`INSERT INTO tags (uid, kind, owner_type, owner_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (uid) DO UPDATE SET kind = excluded.kind, owner_type = excluded.owner_type, owner_id = excluded.owner_id`)
      .run(uid, kind ?? 'nfc', ownerType, ownerId, op.ts, op.ts);
  },

  alert_ack(ctx, op) {
    ctx.db.prepare('UPDATE alerts SET acked_at = ? WHERE id = ?').run(op.ts, op.payload.alertId);
  },
};

export function applyOps(ctx, ops) {
  const applied = [];
  const rejected = [];
  for (const raw of ops) {
    try {
      require_(typeof raw.id === 'string' && raw.id, 'op needs an id');
      require_(handlers[raw.type], `unknown op ${raw.type}`);
      const ts = Number.isFinite(raw.ts) ? raw.ts : ctx.now;
      const op = { ...raw, payload: raw.payload ?? {}, ts: Math.min(ts, ctx.now + CLOCK_SKEW_LIMIT) };
      const { data, ...logged } = op.payload;
      tx(ctx.db, () => {
        const inserted = ctx.db.prepare('INSERT OR IGNORE INTO ops (id, type, person_id, ts, received_at, payload) VALUES (?, ?, ?, ?, ?, ?)')
          .run(op.id, op.type, op.personId ?? null, op.ts, ctx.now, JSON.stringify(logged));
        if (inserted.changes) handlers[op.type](ctx, op);
      });
      applied.push(op.id);
    } catch (error) {
      rejected.push({ id: raw?.id, error: error.message });
    }
  }
  return { applied, rejected };
}

export function ingestReadings(ctx, { readerId, reads }) {
  const reader = readerId ? ctx.db.prepare('SELECT * FROM readers WHERE id = ?').get(readerId) : null;
  const ops = (reads ?? []).map((read) => {
    const ts = read.ts ?? ctx.now;
    return {
      id: `${readerId ?? 'tracker'}:${read.uid}:${ts}`,
      type: 'tag_read',
      ts,
      payload: {
        uid: read.uid,
        kind: read.kind ?? reader?.kind ?? 'gps',
        lat: read.lat ?? reader?.lat,
        lng: read.lng ?? reader?.lng,
        accuracy: read.accuracy ?? null,
        source: readerId ? `reader:${readerId}` : 'tracker',
      },
    };
  });
  return applyOps(ctx, ops);
}
