// Client plumbing shared by the worker, gate and boss screens: offline outbox, state, voice, camera, NFC, GPS.

export const $ = (selector, root = document) => root.querySelector(selector);

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// crypto.randomUUID only exists over HTTPS, and a farm LAN may be plain HTTP.
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// IndexedDB: an ordered outbox of unsent changes and a key-value cache of the last state.
const dbReady = new Promise((resolve, reject) => {
  const open = indexedDB.open('farmworx', 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
    open.result.createObjectStore('kv');
  };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

async function idb(store, mode, run) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const kvGet = (key) => idb('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => idb('kv', 'readwrite', (s) => s.put(value, key));
const outboxAll = () => idb('outbox', 'readonly', (s) => s.getAll());

const BATCH_OPS = 25;
const RETRY_MS = 15_000;

// Mirrors the server for changes still in the outbox, so a phone with no signal shows its own work.
export function applyLocal(state, op) {
  const p = op.payload;
  const person = state.people.find((x) => x.id === op.personId);
  if (op.type === 'punch' && person) {
    const type = p.type === 'toggle' ? (person.status === 'off' ? 'in' : 'out') : p.type;
    person.status = { in: 'on', break_end: 'on', break_start: 'break', out: 'off' }[type];
    person.since = op.ts;
    if (type === 'out') person.zoneId = null;
  } else if (op.type === 'task_update') {
    const task = state.tasks.find((t) => t.id === p.taskId);
    if (task) Object.assign(task, { status: p.status, problem: p.status === 'problem' ? p.reason : null, updatedTs: op.ts }, p.assigneeId !== undefined && { assigneeId: p.assigneeId });
  } else if (op.type === 'task_create' && !state.tasks.some((t) => t.id === op.id)) {
    const status = p.origin === 'worker' ? 'request' : 'todo';
    state.tasks.unshift({ id: op.id, ...p, createdBy: op.personId, status, createdTs: op.ts, updatedTs: op.ts });
  } else if (op.type === 'note' && !state.notes.some((n) => n.id === op.id)) {
    state.notes.unshift({ id: op.id, personId: op.personId, taskId: p.taskId, kind: p.kind, text: p.text, url: p.data, ts: op.ts });
  } else if (op.type === 'asset_checkout') {
    const asset = state.assets.find((a) => a.id === p.assetId);
    if (asset) asset.holderId = p.action === 'take' ? op.personId : null;
  } else if (op.type === 'consent' && person) {
    person.locationConsent = p.location ? 'yes' : 'no';
  }
}

export function createStore({ personId = null, onChange }) {
  const stateUrl = personId ? `/api/state?person=${encodeURIComponent(personId)}` : '/api/state';
  const cacheKey = `state:${personId ?? 'all'}`;
  let state = null;
  let flushing = false;
  let retryTimer = null;
  const store = { pending: 0, online: true };

  const publish = async () => {
    const queued = await outboxAll();
    store.pending = queued.length;
    if (state) {
      const view = structuredClone(state);
      queued.forEach((op) => applyLocal(view, op));
      store.state = view;
      onChange?.(view, store);
    }
  };

  store.refresh = async () => {
    try {
      const response = await fetch(stateUrl);
      if (!response.ok) throw new Error(`state ${response.status}`);
      state = await response.json();
      store.online = true;
      await kvSet(cacheKey, state);
    } catch {
      store.online = false;
      state ??= await kvGet(cacheKey);
    }
    await publish();
  };

  store.flush = async () => {
    if (flushing) return;
    flushing = true;
    clearTimeout(retryTimer);
    try {
      for (;;) {
        const batch = (await outboxAll()).slice(0, BATCH_OPS);
        if (!batch.length) break;
        const response = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ops: batch.map(({ seq, ...op }) => op) }),
        });
        if (!response.ok) throw new Error(`sync ${response.status}`);
        const { applied, rejected } = await response.json();
        const handled = new Set([...applied, ...rejected.map((r) => r.id)]);
        rejected.forEach((r) => console.warn('Rejected op', r));
        await idb('outbox', 'readwrite', (s) => {
          batch.filter((op) => handled.has(op.id)).forEach((op) => s.delete(op.seq));
        });
      }
      store.online = true;
      await store.refresh();
    } catch {
      store.online = false;
      await publish();
      retryTimer = setTimeout(store.flush, RETRY_MS);
    } finally {
      flushing = false;
    }
  };

  // Never waits for the network: the change is safe in the outbox before this returns.
  store.send = async (type, payload = {}, { actor = personId, id = uid() } = {}) => {
    const op = { id, type, personId: actor, ts: Date.now(), payload };
    await idb('outbox', 'readwrite', (s) => s.add(op));
    await publish();
    store.flush();
    return op;
  };

  store.start = async () => {
    await store.refresh();
    store.flush();
    const events = new EventSource('/api/events');
    events.onmessage = () => store.refresh();
    addEventListener('online', store.flush);
    return store;
  };

  return store;
}

export function registerServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(console.warn);
}

// Spoken words. A phone with no voice for this language stays silent, so pictures must carry the meaning.
export function speak(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9;
  speechSynthesis.speak(utterance);
}

export function buzz(pattern = 60) {
  navigator.vibrate?.(pattern);
}

// Location. Foreground only: this is the limit of a web app and the main reason for a native wrapper.
let lastFix = null;
const FIX_MAX_AGE = 60_000;
const FIX_WAIT = 2500;

export function watchLocation(onFix) {
  if (!navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    ({ coords }) => {
      lastFix = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy, at: Date.now() };
      onFix(lastFix);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Clocking in must never hang on a slow GPS, so this gives up quickly and records no position.
export function quickFix() {
  if (lastFix && Date.now() - lastFix.at < FIX_MAX_AGE) return Promise.resolve(lastFix);
  if (!navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy }),
      () => resolve({}),
      { enableHighAccuracy: true, maximumAge: FIX_MAX_AGE, timeout: FIX_WAIT },
    );
  });
}

// Photos are shrunk on the phone, since farm signal is often too weak for full-size pictures.
const PHOTO_MAX_EDGE = 1280;

export function capturePhoto() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const VOICE_MAX_MS = 60_000;

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
    };
  });
  recorder.start();
  const timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), VOICE_MAX_MS);
  return () => {
    clearTimeout(timer);
    if (recorder.state === 'recording') recorder.stop();
    return finished;
  };
}

// NFC. Web NFC exists on Android Chrome only; iPhones reach the app through the URL stored on the tag.
export const NFC_SUPPORTED = 'NDEFReader' in window;

export async function scanNfc(onTag) {
  const reader = new NDEFReader();
  const controller = new AbortController();
  await reader.scan({ signal: controller.signal });
  reader.onreading = ({ serialNumber, message }) => {
    const url = [...message.records]
      .filter((record) => record.recordType === 'url')
      .map((record) => new TextDecoder().decode(record.data))[0];
    const fromUrl = url && decodeURIComponent(new URL(url).pathname.split('/t/')[1] ?? '');
    onTag((fromUrl || serialNumber || '').toUpperCase());
  };
  return () => controller.abort();
}

export function writeNfc(tagUid) {
  return new NDEFReader().write({ records: [{ recordType: 'url', data: `${location.origin}/t/${encodeURIComponent(tagUid)}` }] });
}

export function clockTime(ts, timeZone) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone }).format(ts);
}

export function duration(minutes) {
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, '0')}m`;
}

export function zoneRestricted(zone, now = Date.now()) {
  return Boolean(zone?.restrictedUntil && zone.restrictedUntil > now);
}

// A plain drawing of the farm that needs no map tiles, so it still works with no signal.
export function miniMap(zones, targetId, me) {
  const blocks = zones.filter((z) => z.kind !== 'farm');
  const farm = zones.find((z) => z.kind === 'farm') ?? blocks[0];
  const lats = farm.polygon.map((p) => p[0]);
  const lngs = farm.polygon.map((p) => p[1]);
  const [north, south, west, east] = [Math.max(...lats), Math.min(...lats), Math.min(...lngs), Math.max(...lngs)];
  const width = 120;
  const height = Math.round((width * (north - south) * 1.25) / (east - west));
  const xy = ([lat, lng]) => [((lng - west) / (east - west)) * width, ((north - lat) / (north - south)) * height];
  const shapes = blocks.map((zone) => {
    const points = zone.polygon.map((p) => xy(p).map((n) => n.toFixed(1)).join(',')).join(' ');
    const active = zone.id === targetId;
    return `<polygon points="${points}" fill="${esc(zone.color)}" fill-opacity="${active ? 1 : 0.16}" stroke="${active ? 'var(--ink)' : 'none'}" stroke-width="2"/>`;
  }).join('');
  const dot = me?.lat ? (() => {
    const [x, y] = xy([me.lat, me.lng]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="#fff" stroke="var(--ink)" stroke-width="2.5"/>`;
  })() : '';
  return `<svg class="minimap" viewBox="0 0 ${width} ${height}" aria-hidden="true">${shapes}${dot}</svg>`;
}
