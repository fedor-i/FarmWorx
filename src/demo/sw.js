// The website demo's backend. GitHub Pages can't run server.js, so this service worker answers the same
// routes in the visitor's browser, using the same app logic. Each visitor gets their own private copy.
import initSqlJs from 'sql.js';
import { applySchema, getSetting } from '../db.js';
import { applyOps, ingestReadings } from '../ops.js';
import { seed } from '../seed.js';
import { buildState } from '../state.js';
import { timesheet, timesheetCsv } from '../timesheet.js';
import { wrapSqlJs } from './sqlite-adapter.js';
import '../../public/sw.js';

const SAVED_DB_KEY = 'database';
const RESEED_AFTER = 12 * 3_600_000;
const MEDIA_MIME = { jpg: 'image/jpeg', png: 'image/png', webm: 'audio/webm', m4a: 'audio/mp4', ogg: 'audio/ogg' };

const listeners = new Set();
const encoder = new TextEncoder();
let engine = null;
let backend = null;
let saving = Promise.resolve();

function savedStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('farmworx-demo', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const request = run(tx.objectStore('files'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(request.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function newBackend(raw) {
  const db = wrapSqlJs(raw);
  applySchema(db);
  db.exec('CREATE TABLE IF NOT EXISTS demo_media (file TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const saveFile = (file, base64) => db.prepare('INSERT INTO demo_media (file, data) VALUES (?, ?)').run(file, base64);
  return { raw, db, ctx: () => ({ db, saveFile, now: Date.now() }) };
}

function seedFresh(SQL) {
  const fresh = newBackend(new SQL.Database());
  seed(fresh.db, Date.now());
  fresh.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('seeded_at', String(Date.now()));
  return fresh;
}

// A demo farm left for days would show everyone on a stale shift, so it starts a new day instead.
async function load() {
  engine ??= await initSqlJs({ locateFile: () => new URL('sql-wasm.wasm', self.registration.scope).href });
  const saved = await savedStore('readonly', (store) => store.get(SAVED_DB_KEY));
  if (saved) {
    const restored = newBackend(new engine.Database(saved));
    if (Date.now() - Number(getSetting(restored.db, 'seeded_at', 0)) < RESEED_AFTER) return restored;
  }
  const fresh = seedFresh(engine);
  await persist(fresh);
  return fresh;
}

const ready = () => (backend ??= load());

// The browser can stop a service worker at any time, so every change is written out straight away.
function persist(target) {
  const bytes = target.raw.export();
  // Exporting closes and reopens the database, which turns this setting back off.
  target.db.exec('PRAGMA foreign_keys = ON;');
  saving = saving.then(() => savedStore('readwrite', (store) => store.put(bytes, SAVED_DB_KEY)));
  return saving;
}

function broadcast() {
  for (const controller of listeners) controller.enqueue(encoder.encode('data: changed\n\n'));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function eventStream() {
  let current;
  const stream = new ReadableStream({
    start(controller) {
      current = controller;
      listeners.add(controller);
      controller.enqueue(encoder.encode(': connected\n\n'));
    },
    cancel() {
      listeners.delete(current);
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

function mediaResponse(active, file) {
  const row = active.db.prepare('SELECT data FROM demo_media WHERE file = ?').get(file);
  if (!row) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': MEDIA_MIME[file.split('.').pop()] ?? 'application/octet-stream' } });
}

async function route(request, path, url) {
  if (path === 'api/events') return eventStream();

  const active = await ready();
  if (request.method === 'GET') {
    if (path === 'api/state') return json(buildState(active.db, { personId: url.searchParams.get('person') }));
    if (path === 'api/timesheet' || path === 'api/timesheet.csv') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) return json({ error: 'from and to must be YYYY-MM-DD' }, 400);
      const sheet = timesheet(active.db, from, to);
      if (path === 'api/timesheet') return json(sheet);
      return new Response(timesheetCsv(sheet), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="timesheet-${from}-to-${to}.csv"` },
      });
    }
    if (path.startsWith('media/')) return mediaResponse(active, decodeURIComponent(path.slice('media/'.length)));
  }

  if (request.method === 'POST') {
    if (path === 'api/demo-reset') {
      await savedStore('readwrite', (store) => store.delete(SAVED_DB_KEY));
      backend = null;
      await ready();
      broadcast();
      return json({ ok: true });
    }
    let result = null;
    if (path === 'api/sync') result = applyOps(active.ctx(), (await request.json()).ops);
    if (path === 'api/readings') result = ingestReadings(active.ctx(), await request.json());
    if (result) {
      await persist(active);
      broadcast();
      return json(result);
    }
  }
  return json({ error: 'not found' }, 404);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (path.startsWith('api/') || path.startsWith('media/')) {
    event.respondWith(route(event.request, path, url).catch((error) => {
      console.error(error);
      return json({ error: 'demo backend error' }, 500);
    }));
  }
});
