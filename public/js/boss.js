import { ACTIONS, THINGS, REQUESTS, PROBLEMS } from './catalog.js';
import { $, esc, uid, createStore, registerServiceWorker, startRecording, capturePhoto, NFC_SUPPORTED, writeNfc, duration, clockTime, zoneRestricted } from './core.js';

const SUPERVISOR = 'sam';
const TABS = [['live', 'Live map'], ['tasks', 'Tasks'], ['time', 'Time'], ['notes', 'Notes'], ['gear', 'Equipment & tags']];
const FLAG_TEXT = {
  open: 'on shift',
  missing_out: 'no clock-out',
  missing_in: 'no clock-in',
  short_break: 'under 30 min break',
};
const ALERT_TEXT = {
  restricted_entry: (who, zone) => `${who} is inside ${zone}, which is no-entry`,
  person_off_farm: (who) => `${who} left the farm while clocked in`,
  asset_left_fence: (who, zone) => `${who} went outside ${zone}`,
};
const COLUMNS = [['request', 'From crew'], ['todo', 'To do'], ['doing', 'Doing'], ['problem', 'Problem'], ['done', 'Done']];

let tab = 'live';
let simulate = false;
let map = null;
const markers = new Map();
let zoneLayers = [];
let zoneFingerprint = '';
const draft = { action: 'harvest', thing: 'strawberry', zoneId: 'red', qty: '', assignees: new Set(), voice: null };
let stopRecording = null;
let sheetRange = null;

const store = createStore({ onChange: render });
const panel = $('#panel');
const state = () => store.state;
const zoneOf = (id) => state().zones.find((z) => z.id === id);
const zoneName = (id) => zoneOf(id)?.names.en ?? 'Off farm';
const personOf = (id) => state().people.find((p) => p.id === id);
const assetOf = (id) => state().assets.find((a) => a.id === id);
const workers = () => state().people.filter((p) => p.role === 'worker');
const timeAt = (ts) => clockTime(ts, state().farm.timezone);

// Farm-local dates: a supervisor abroad, or a UTC clock, must still see the farm's own day.
function weekRange() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: state().farm.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return { from: date.format(Date.now() - 6 * 86_400_000), to: date.format(Date.now()) };
}

function zoneChip(id) {
  const zone = zoneOf(id);
  if (!zone) return '<span class="zone-chip" style="background:#555">Off farm</span>';
  return `<span class="zone-chip" style="background:${esc(zone.color)}">${esc(zone.symbol)} ${esc(zone.names.en)}</span>`;
}

function face(person) {
  return `<span class="face emoji" style="background:${esc(person.color)}">${person.avatar}</span>`;
}

function ago(ts) {
  if (!ts) return 'never';
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

function alertLine(alert) {
  const who = alert.ownerType === 'person' ? personOf(alert.ownerId)?.name : assetOf(alert.ownerId)?.name;
  return ALERT_TEXT[alert.kind]?.(who ?? 'Unknown', zoneName(alert.zoneId)) ?? alert.kind;
}

// Live map
function ensureMap() {
  const el = $('#map');
  if (map && map.getContainer() === el) return;
  map?.remove();
  markers.clear();
  zoneFingerprint = '';
  map = L.map(el, { zoomControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery © Esri', maxZoom: 19,
  }).addTo(map);
  const farm = state().zones.find((z) => z.kind === 'farm');
  map.fitBounds(farm.polygon);

  // The panel may have no size yet when the map starts, which would fit the farm at maximum zoom.
  let fitted = false;
  const resized = new ResizeObserver(() => {
    if (!el.clientWidth) return;
    map.invalidateSize();
    if (!fitted) map.fitBounds(farm.polygon, { padding: [12, 12] });
    fitted = true;
  });
  resized.observe(el);
  map.on('unload', () => resized.disconnect());
}

function drawZones() {
  const fingerprint = JSON.stringify(state().zones.map((z) => [z.id, zoneRestricted(z)]));
  if (fingerprint === zoneFingerprint) return;
  zoneFingerprint = fingerprint;
  zoneLayers.forEach((layer) => layer.remove());
  zoneLayers = state().zones.map((zone) => {
    const restricted = zoneRestricted(zone);
    const layer = L.polygon(zone.polygon, {
      color: restricted ? '#ff3b24' : zone.color,
      weight: restricted ? 4 : zone.kind === 'farm' ? 3 : 2,
      dashArray: restricted ? '10 7' : zone.kind === 'farm' ? '4 6' : null,
      fillOpacity: zone.kind === 'farm' ? 0 : restricted ? 0.42 : 0.2,
      fillColor: restricted ? '#ff3b24' : zone.color,
      interactive: zone.kind !== 'farm',
    }).addTo(map);
    if (zone.kind !== 'farm') {
      layer.bindTooltip(`${zone.symbol} ${esc(zone.names.en)}${restricted ? ' · NO ENTRY' : ''}`, { permanent: true, direction: 'center', className: 'map-label' });
    }
    return layer;
  });
}

function placeMarker(key, { lat, lng, html, title, onDrag }) {
  const icon = L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] });
  let marker = markers.get(key);
  if (!marker) {
    marker = L.marker([lat, lng], { icon, title, zIndexOffset: 500 }).addTo(map);
    marker.bindTooltip(esc(title), { direction: 'top', offset: [0, -18] });
    marker.on('dragstart', () => { marker.dragging_ = true; });
    markers.set(key, marker);
  } else if (!marker.dragging_) {
    marker.setLatLng([lat, lng]);
    marker.setIcon(icon);
  }
  marker.off('dragend');
  marker.on('dragend', () => {
    marker.dragging_ = false;
    const point = marker.getLatLng();
    onDrag(point.lat, point.lng);
  });
  simulate ? marker.dragging?.enable() : marker.dragging?.disable();
  marker.seen = true;
}

function drawMarkers() {
  markers.forEach((marker) => { marker.seen = false; });
  for (const person of state().people) {
    if (person.status === 'off' || person.lat === null) continue;
    placeMarker(`person:${person.id}`, {
      lat: person.lat,
      lng: person.lng,
      title: `${person.name} (${person.status === 'break' ? 'on break' : 'working'})`,
      html: `<div class="map-marker emoji" style="background:${esc(person.color)}">${person.avatar}</div>`,
      onDrag: (lat, lng) => store.send('sighting', { ownerType: 'person', ownerId: person.id, lat, lng, accuracy: 5, source: 'simulator' }),
    });
  }
  for (const asset of state().assets) {
    if (asset.lat === null) continue;
    placeMarker(`asset:${asset.id}`, {
      lat: asset.lat,
      lng: asset.lng,
      title: asset.name,
      html: `<div class="map-marker asset emoji ${asset.outsideFence ? 'out' : ''}">${asset.icon}</div>`,
      onDrag: (lat, lng) => store.send('sighting', { ownerType: 'asset', ownerId: asset.id, lat, lng, accuracy: 5, source: 'simulator' }),
    });
  }
  markers.forEach((marker, key) => {
    if (!marker.seen) {
      marker.remove();
      markers.delete(key);
    }
  });
}

function liveRail() {
  const { alerts } = state();
  const onShift = workers().filter((p) => p.status !== 'off');
  const offShift = workers().length - onShift.length;
  const blocks = state().zones.filter((z) => z.kind === 'block');
  return `<div class="rail">
    <section class="card"><h2>Alerts</h2>
      ${alerts.map((a) => `<div class="alert ${a.resolvedAt ? 'resolved' : ''}"><div><strong>${esc(alertLine(a))}</strong><span class="small muted">${esc(timeAt(a.ts))}${a.resolvedAt ? ' · cleared' : ''}</span></div><button class="btn" data-act="ack" data-id="${a.id}">OK</button></div>`).join('') || '<span class="muted">No alerts</span>'}
    </section>
    <section class="card"><h2>On shift (${onShift.length})</h2>
      ${onShift.map((p) => `<div class="row">${face(p)}<div class="grow"><div>${esc(p.name)}</div><div class="small muted">${p.status === 'break' ? 'On break' : `Since ${esc(timeAt(p.since))}`} · ${duration(p.todayMin)}</div></div>${p.zoneId ? zoneChip(p.zoneId) : '<span class="small muted">No location</span>'}</div>`).join('') || '<span class="muted">Nobody is clocked in</span>'}
      ${offShift ? `<span class="small muted">${offShift} off shift. Their location is not recorded.</span>` : ''}
    </section>
    <section class="card"><h2>No-entry fields</h2>
      ${blocks.map((z) => {
        const restricted = zoneRestricted(z);
        return `<div class="row"><div class="grow">${zoneChip(z.id)}<div class="small muted">${restricted ? `Until ${esc(timeAt(z.restrictedUntil))}${z.restrictedReason ? ` · ${esc(z.restrictedReason)}` : ''}` : 'Open'}</div></div>
          <button class="btn" data-act="restrict" data-id="${z.id}" data-on="${restricted ? 1 : 0}">${restricted ? 'Reopen' : 'Close 12 h'}</button></div>`;
      }).join('')}
    </section>
  </div>`;
}

function renderLive() {
  const scroll = $('.rail')?.scrollTop;
  if (!$('#map')) {
    panel.className = 'panel live';
    panel.innerHTML = `<div class="map-wrap"><div id="map" aria-label="Farm map"></div>
      <label class="sim-toggle"><input type="checkbox" id="sim" ${simulate ? 'checked' : ''}> Simulate: drag markers</label></div>
      <div id="rail"></div>`;
    $('#sim').onchange = (e) => {
      simulate = e.target.checked;
      drawMarkers();
    };
  }
  $('#rail').innerHTML = liveRail();
  if ($('.rail') && scroll) $('.rail').scrollTop = scroll;
  ensureMap();
  drawZones();
  drawMarkers();
}

// Tasks
function taskIcons(task) {
  const action = ACTIONS[task.action] ?? REQUESTS[task.action];
  const thing = THINGS[task.thing];
  return `<span class="emoji">${action?.icon ?? '❓'}${thing ? ` ${thing.icon}` : ''}</span>${task.qty ? ` <strong>×${esc(task.qty)}</strong>` : ''}`;
}

function miniTask(task) {
  const action = ACTIONS[task.action] ?? REQUESTS[task.action];
  const assignee = personOf(task.assigneeId);
  const creator = personOf(task.createdBy);
  const problem = PROBLEMS[task.problem];
  const notes = state().notes.filter((n) => n.taskId === task.id);
  const attachments = notes.map((n) => (n.kind === 'voice'
    ? `<audio class="clip" controls src="${esc(n.url)}"></audio>`
    : n.kind === 'photo' ? `<img src="${esc(n.url)}" alt="" style="width:100%;border-radius:8px">` : `<div class="small">${esc(n.text)}</div>`)).join('');
  const assignPicker = `<select data-act="assign" data-id="${esc(task.id)}" aria-label="Assign task">
      <option value="">Send to…</option>${workers().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`;
  return `<div class="mini-task">
    <div class="icons">${taskIcons(task)}</div>
    <div class="small"><strong>${esc(action?.en ?? task.action)}</strong>${task.thing ? ` ${esc(THINGS[task.thing]?.en ?? '')}` : ''}</div>
    ${task.zoneId ? `<div>${zoneChip(task.zoneId)}</div>` : ''}
    ${problem ? `<div class="badflag small"><span class="emoji">${problem.icon}</span> ${esc(problem.en)}</div>` : ''}
    ${attachments}
    <div class="row small muted"><span class="grow">${esc(assignee?.name ?? (task.origin === 'worker' ? `From ${creator?.name ?? 'crew'}` : 'Unassigned'))} · ${esc(ago(task.updatedTs))}</span></div>
    ${task.status === 'request' || task.status === 'problem' ? assignPicker : ''}
    ${task.status === 'request' ? `<button class="btn" data-act="close-task" data-id="${esc(task.id)}">Handled</button>` : ''}
    ${task.status === 'problem' ? `<button class="btn" data-act="reopen-task" data-id="${esc(task.id)}">Fixed, back to work</button>` : ''}
  </div>`;
}

function picker(group, items, selected) {
  return `<div class="pick-row">${items.map(([key, icon, text]) => {
    const on = group === 'assignees' ? selected.has(key) : selected === key;
    return `<button class="${on ? 'on' : ''}" data-pick="${group}" data-key="${esc(key)}" aria-pressed="${on}"><span class="emoji">${icon}</span>${esc(text)}</button>`;
  }).join('')}</div>`;
}

function composer() {
  const zones = state().zones.filter((z) => z.kind !== 'farm');
  const canSend = draft.assignees.size > 0;
  return `<section class="card compose">
    <div style="display:grid;gap:10px;min-width:0">
      <h2>New task</h2>
      <div><div class="field-label">Do what</div>${picker('action', Object.entries(ACTIONS).map(([k, v]) => [k, v.icon, v.en]), draft.action)}</div>
      <div><div class="field-label">To what</div>${picker('thing', Object.entries(THINGS).map(([k, v]) => [k, v.icon, v.en]), draft.thing)}</div>
      <div><div class="field-label">Where</div>${picker('zoneId', zones.map((z) => [z.id, `<span style="color:${esc(z.color)}">${esc(z.symbol)}</span>`, z.names.en]), draft.zoneId)}</div>
      <div><div class="field-label">Who</div>${picker('assignees', workers().map((p) => [p.id, p.avatar, p.name.split(' ')[0]]), draft.assignees)}</div>
      <div class="tools">
        <label>How many <input id="qty" type="number" min="1" max="999" value="${esc(draft.qty)}" style="width:90px"></label>
        <button class="btn" data-act="record">${stopRecording ? '⏹ Stop recording' : draft.voice ? '🎙️ Re-record voice' : '🎙️ Add voice message'}</button>
        <button class="btn main" data-act="send-task" ${canSend ? '' : 'disabled'}>Send to ${draft.assignees.size || 'crew'}</button>
      </div>
    </div>
    ${preview()}
  </section>`;
}

function preview() {
  const zone = zoneOf(draft.zoneId);
  const action = ACTIONS[draft.action];
  const thing = THINGS[draft.thing];
  return `<div class="preview">
    <div class="field-label">What the worker sees</div>
    <div class="pics"><span class="pic emoji">${action.icon}</span><span class="pic emoji">${thing.icon}</span>${draft.qty ? `<span class="pic-qty">×${esc(draft.qty)}</span>` : ''}<span class="pic pic-zone" style="background:${esc(zone.color)}">${esc(zone.symbol)}</span></div>
    <div class="small">${esc(action.es)} ${esc(thing.es)} · ${esc(zone.names.es)}</div>
    ${draft.voice ? `<audio class="clip" controls src="${esc(draft.voice)}"></audio>` : ''}
    ${zoneRestricted(zone) ? `<div class="warnbox">⛔ ${esc(zone.names.en)} is no-entry until ${esc(timeAt(zone.restrictedUntil))}. Workers cannot start this until it reopens.</div>` : ''}
  </div>`;
}

function renderTasks() {
  panel.className = 'panel';
  panel.innerHTML = composer() + `<div class="board">${COLUMNS.map(([status, title]) => {
    const tasks = state().tasks.filter((x) => x.status === status);
    return `<section class="column"><h3>${esc(title)} (${tasks.length})</h3>${tasks.map(miniTask).join('')}</section>`;
  }).join('')}</div>`;
}

async function sendTask() {
  for (const assigneeId of draft.assignees) {
    const id = uid();
    await store.send('task_create', { action: draft.action, thing: draft.thing, zoneId: draft.zoneId, qty: Number(draft.qty) || null, assigneeId }, { actor: SUPERVISOR, id });
    if (draft.voice) await store.send('note', { kind: 'voice', data: draft.voice, taskId: id }, { actor: SUPERVISOR });
  }
  draft.assignees.clear();
  draft.voice = null;
  draft.qty = '';
  renderTasks();
}

// Time
async function renderTime() {
  panel.className = 'panel';
  sheetRange ??= weekRange();
  const { from, to } = sheetRange;
  const query = `from=${from}&to=${to}`;
  const response = await fetch(`/api/timesheet?${query}`).catch(() => null);
  const sheet = response?.ok ? await response.json() : null;
  if (tab !== 'time') return;
  if (!sheet) {
    panel.innerHTML = '<div class="card">Timesheets need a connection to the server.</div>';
    return;
  }
  const local = (ts) => (ts ? timeAt(ts) : '<span class="badflag">?</span>');
  const inputTime = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const previous = { person: $('#fix-person')?.value, type: $('#fix-type')?.value, time: $('#fix-time')?.value };
  panel.innerHTML = `<section class="card">
      <div class="tools">
        <label>From <input type="date" id="from" value="${from}"></label>
        <label>To <input type="date" id="to" value="${to}"></label>
        <a class="btn main" style="text-decoration:none" href="/api/timesheet.csv?${query}">Download CSV</a>
      </div>
      <div class="table-scroll"><table><thead><tr><th>Name</th>${sheet.totals.map(() => '').join('')}<th class="num">Total hours</th></tr></thead><tbody>
        ${sheet.totals.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${(x.workedMin / 60).toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="card"><h2>Add a missing punch</h2>
      <div class="tools">
        <label>Person <select id="fix-person">${workers().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>Punch <select id="fix-type"><option value="out">Clock out</option><option value="in">Clock in</option><option value="break_start">Break start</option><option value="break_end">Break end</option></select></label>
        <label>Time <input id="fix-time" type="datetime-local" value="${inputTime}"></label>
        <button class="btn main" data-act="add-punch">Add punch</button>
      </div>
      <span class="small muted">Punches are never edited. This adds a new one marked as entered by ${esc(personOf(SUPERVISOR).name)}.</span>
    </section>
    <section class="card"><h2>Shifts</h2>
      <div class="table-scroll"><table><thead><tr><th>Date</th><th>Name</th><th>In</th><th>Out</th><th class="num">Break</th><th class="num">Worked</th><th>Check</th></tr></thead><tbody>
      ${sheet.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${local(r.start)}</td><td>${r.flags.includes('open') ? '<span class="ok">working</span>' : local(r.end)}</td>
        <td class="num">${r.breakMin} min</td><td class="num">${r.workedMin === null ? '—' : duration(r.workedMin)}</td>
        <td>${r.flags.map((f) => `<span class="${f === 'open' ? 'ok' : f === 'short_break' ? 'warn' : 'badflag'}">${esc(FLAG_TEXT[f] ?? f)}</span>`).join(' ')}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
  if (previous.person) {
    $('#fix-person').value = previous.person;
    $('#fix-type').value = previous.type;
    $('#fix-time').value = previous.time;
  }
}

// Notes
function renderNotes() {
  const draftText = $('#note-text')?.value ?? '';
  panel.className = 'panel';
  panel.innerHTML = `<section class="card"><h2>Add a note</h2>
      <div class="note-box"><input id="note-text" aria-label="Note" placeholder="Type a note for the farm log" value="${esc(draftText)}">
      <button class="btn main" data-act="add-note">Save</button><button class="btn" data-act="add-photo">📷 Photo</button></div></section>
    <div class="feed">${state().notes.map((n) => {
      const person = personOf(n.personId);
      const task = state().tasks.find((x) => x.id === n.taskId);
      return `<article class="card">
        <div class="row">${person ? face(person) : ''}<div class="grow"><div>${esc(person?.name ?? 'Unknown')}</div><div class="small muted">${esc(ago(n.ts))}</div></div>${n.zoneId ? zoneChip(n.zoneId) : ''}</div>
        ${n.kind === 'photo' ? `<img src="${esc(n.url)}" alt="Photo from ${esc(person?.name ?? 'crew')}">` : ''}
        ${n.kind === 'voice' ? `<audio class="clip" controls src="${esc(n.url)}"></audio>` : ''}
        ${n.text ? `<div>${esc(n.text)}</div>` : ''}
        ${task ? `<div class="small muted">On task: ${taskIcons(task)}</div>` : ''}
      </article>`;
    }).join('') || '<div class="card muted">No notes yet. Photos and voice notes from the crew appear here.</div>'}</div>`;
}

// Equipment and tags
function ownerLabel(tag) {
  if (tag.ownerType === 'person') return personOf(tag.ownerId)?.name;
  if (tag.ownerType === 'asset') return assetOf(tag.ownerId)?.name;
  if (tag.ownerType === 'zone') return zoneName(tag.ownerId);
  return null;
}

function renderGear() {
  panel.className = 'panel';
  const unknown = state().tags.filter((tag) => !tag.ownerType);
  const owners = [
    ...workers().map((p) => [`person:${p.id}`, `Person: ${p.name}`]),
    ...state().assets.map((a) => [`asset:${a.id}`, `Equipment: ${a.name}`]),
    ...state().zones.filter((z) => z.kind !== 'farm').map((z) => [`zone:${z.id}`, `Place: ${z.names.en}`]),
  ];
  const ownerOptions = owners.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join('');
  panel.innerHTML = `<section class="card"><h2>Equipment</h2><div class="table-scroll"><table>
      <thead><tr><th>Item</th><th>Where</th><th>Must stay in</th><th>With</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${state().assets.map((a) => `<tr><td><span class="emoji">${a.icon}</span> ${esc(a.name)}</td><td>${a.lat === null ? '—' : zoneChip(a.zoneId)}</td><td>${esc(zoneName(a.fenceZoneId))}${a.outsideFence ? ' <span class="badflag">outside</span>' : ''}</td>
        <td>${esc(personOf(a.holderId)?.name ?? '—')}</td><td class="small">${esc(ago(a.seenAt))}<br><span class="muted">${esc(a.seenBy ?? '')}</span></td>
        <td></td></tr>`).join('')}
      </tbody></table></div></section>
    ${unknown.length ? `<section class="card"><h2>New tags to set up</h2>${unknown.map((tag) => `<div class="row"><span class="tag-kind">${esc(tag.kind)}</span><code class="grow">${esc(tag.uid)}</code>
        <select data-owner="${esc(tag.uid)}" aria-label="Tag owner">${ownerOptions}</select><button class="btn main" data-act="register" data-uid="${esc(tag.uid)}" data-kind="${esc(tag.kind)}">Save</button></div>`).join('')}</section>` : ''}
    <section class="card"><h2>Hardware test</h2>
      <p class="small muted" style="margin:0">Sends a read to the same endpoint a real reader or tracker uses, <code>POST /api/readings</code>.</p>
      <div class="tools">
        <button class="btn" data-act="sim-read" data-uid="E280-1170-0000-GEN">UHF gate reads the generator</button>
        <button class="btn" data-act="sim-read" data-uid="E280-NEW-TAG-${Date.now() % 1000}">UHF gate reads an unknown tag</button>
        <button class="btn" data-act="sim-track">GPS tracker: tractor leaves the farm</button>
        <button class="btn" data-act="sim-back">GPS tracker: tractor returns</button>
      </div></section>
    <section class="card"><h2>Tags</h2><div class="table-scroll"><table>
      <thead><tr><th>Type</th><th>Tag</th><th>Belongs to</th><th>Last read</th><th></th></tr></thead><tbody>
      ${state().tags.map((tag) => `<tr><td><span class="tag-kind">${esc(tag.kind)}</span></td><td><code>${esc(tag.uid)}</code></td><td>${esc(ownerLabel(tag) ?? '—')}</td><td class="small">${esc(ago(tag.lastSeen))}</td>
        <td>${tag.kind === 'nfc' && NFC_SUPPORTED ? `<button class="btn" data-act="write-tag" data-uid="${esc(tag.uid)}">Write to tag</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`;
}

function render() {
  if (!state()) return;
  const open = state().alerts.filter((a) => !a.resolvedAt).length;
  $('#tabs').innerHTML = TABS.map(([id, text]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}">${esc(text)}${id === 'live' && open ? `<span class="count">${open}</span>` : ''}</button>`).join('');
  $('#sync').textContent = store.online ? (store.pending ? `Sending ${store.pending}…` : 'Live') : 'Offline';
  if (tab !== 'live' && map) {
    map.remove();
    map = null;
    markers.clear();
  }
  // Don't redraw a form while someone is typing in it.
  const typing = document.activeElement?.matches('#qty, #fix-time, #from, #to, select, #note-text');
  if (typing && tab !== 'live') return;
  ({ live: renderLive, tasks: renderTasks, time: renderTime, notes: renderNotes, gear: renderGear })[tab]();
}

async function postReadings(body) {
  await fetch('/api/readings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const actions = {
  ack: (b) => store.send('alert_ack', { alertId: Number(b.dataset.id) }, { actor: SUPERVISOR }),
  restrict: (b) => store.send('zone_restrict', { zoneId: b.dataset.id, hours: b.dataset.on === '1' ? 0 : 12, reason: 'Pesticide applied' }, { actor: SUPERVISOR }),
  'send-task': sendTask,
  'close-task': (b) => store.send('task_update', { taskId: b.dataset.id, status: 'done' }, { actor: SUPERVISOR }),
  'reopen-task': (b) => store.send('task_update', { taskId: b.dataset.id, status: 'todo' }, { actor: SUPERVISOR }),
  record: async () => {
    if (stopRecording) {
      draft.voice = await stopRecording();
      stopRecording = null;
    } else {
      try {
        stopRecording = await startRecording();
      } catch {
        alert('Microphone is not available here. It needs HTTPS or localhost, and permission.');
      }
    }
    renderTasks();
  },
  'add-punch': async () => {
    const ts = new Date($('#fix-time').value).getTime();
    if (!Number.isFinite(ts)) return;
    const op = { id: uid(), type: 'punch', personId: $('#fix-person').value, ts, payload: { type: $('#fix-type').value, method: 'supervisor', enteredBy: SUPERVISOR } };
    await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [op] }) });
  },
  'add-note': async () => {
    const text = $('#note-text').value.trim();
    if (!text) return;
    $('#note-text').value = '';
    await store.send('note', { kind: 'text', text }, { actor: SUPERVISOR });
  },
  'add-photo': async () => {
    const data = await capturePhoto();
    if (data) await store.send('note', { kind: 'photo', data }, { actor: SUPERVISOR });
  },
  register: (b) => {
    const [ownerType, ownerId] = document.querySelector(`[data-owner="${CSS.escape(b.dataset.uid)}"]`).value.split(':');
    return store.send('tag_register', { uid: b.dataset.uid, kind: b.dataset.kind, ownerType, ownerId }, { actor: SUPERVISOR });
  },
  'sim-read': (b) => postReadings({ readerId: 'gate-uhf', reads: [{ uid: b.dataset.uid }] }),
  'sim-track': () => postReadings({ reads: [{ uid: 'GPS-TRACTOR-1', lat: 36.6230, lng: -121.6040, accuracy: 6 }] }),
  'sim-back': () => postReadings({ reads: [{ uid: 'GPS-TRACTOR-1', lat: 36.6150, lng: -121.5962, accuracy: 6 }] }),
  'write-tag': async (b) => {
    await writeNfc(b.dataset.uid);
    alert('Tag written. Tapping it now opens the app on any phone.');
  },
};

document.addEventListener('click', (e) => {
  const tabButton = e.target.closest('[data-tab]');
  if (tabButton) {
    tab = tabButton.dataset.tab;
    panel.innerHTML = '';
    render();
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const { pick: group, key } = pick.dataset;
    if (group === 'assignees') draft.assignees.has(key) ? draft.assignees.delete(key) : draft.assignees.add(key);
    else draft[group] = key;
    renderTasks();
    return;
  }
  const button = e.target.closest('[data-act]');
  if (button && button.tagName !== 'SELECT') actions[button.dataset.act]?.(button);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'qty') {
    // Only the preview changes, so the number being typed keeps its cursor.
    draft.qty = e.target.value;
    $('.preview').outerHTML = preview();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset?.act === 'assign' && e.target.value) {
    store.send('task_update', { taskId: e.target.dataset.id, status: 'todo', assigneeId: e.target.value }, { actor: SUPERVISOR });
  }
  if (e.target.id === 'from' || e.target.id === 'to') {
    sheetRange = { from: $('#from').value || sheetRange.from, to: $('#to').value || sheetRange.to };
    e.target.blur();
    renderTime();
  }
});

registerServiceWorker();
await store.start();
