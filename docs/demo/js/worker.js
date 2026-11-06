import { ACTIONS, THINGS, REQUESTS, PROBLEMS, STRINGS } from './catalog.js';
import { pointInPolygon, smallestZoneAt } from './geo.js';
import {
  $, esc, uid, kvGet, kvSet, createStore, registerServiceWorker, speak, buzz, watchLocation, quickFix, capturePhoto,
  startRecording, NFC_SUPPORTED, scanNfc, duration, clockTime, zoneRestricted, miniMap,
} from './core.js';

const app = $('#app');
const LOCATION_MIN_INTERVAL = 30_000;

let personId = null;
let store = null;
let lang = 'es';
let stopWatching = null;
let lastSentFix = 0;
let myFix = null;
let dangerDismissed = null;
let sheetOpen = false;
let pendingTag = new URLSearchParams(location.search).get('tag');

const t = (key) => STRINGS[lang][key];
const label = (item) => item?.[lang] ?? item?.en ?? '';
const me = () => store?.state?.people.find((p) => p.id === personId);
const zoneById = (id) => store.state.zones.find((z) => z.id === id);
const zoneName = (zone) => zone?.names[lang] ?? zone?.names.en ?? '';

function say(text) {
  speak(text, lang);
}

function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

function confirmSent(text) {
  buzz();
  const message = store.online ? text : `${text}. ${t('waiting')}`;
  toast(message);
  say(text);
}

function zonePic(zone) {
  if (!zone) return '';
  return `<span class="pic pic-zone" style="background:${esc(zone.color)}" title="${esc(zoneName(zone))}">${esc(zone.symbol)}</span>`;
}

function taskPicture(task) {
  const action = ACTIONS[task.action] ?? REQUESTS[task.action];
  const thing = THINGS[task.thing];
  return [
    `<span class="pic emoji">${action?.icon ?? '❓'}</span>`,
    thing ? `<span class="pic emoji">${thing.icon}</span>` : '',
    task.qty ? `<span class="pic-qty">×${esc(task.qty)}</span>` : '',
    zonePic(zoneById(task.zoneId)),
  ].join('');
}

function taskWords(task) {
  const action = ACTIONS[task.action] ?? REQUESTS[task.action];
  return t('speakTask')(label(action), label(THINGS[task.thing]), zoneName(zoneById(task.zoneId)), task.qty);
}

function taskCard(task) {
  const zone = zoneById(task.zoneId);
  const blocked = zoneRestricted(zone);
  const problem = task.status === 'problem' ? PROBLEMS[task.problem] : null;
  const clips = store.state.notes.filter((n) => n.taskId === task.id && n.personId !== personId);
  const media = clips.map((n) => (n.kind === 'voice'
    ? `<audio class="clip" controls src="${esc(n.url)}"></audio>`
    : n.kind === 'photo' ? `<img src="${esc(n.url)}" alt="" style="width:100%;border-radius:10px">` : `<div>${esc(n.text)}</div>`)).join('');
  const actions = blocked
    ? `<div class="task-blocked"><span class="emoji">⛔</span>${esc(t('noEntry'))} · ${esc(t('openUntil'))} ${esc(clockTime(zone.restrictedUntil, store.state.farm.timezone))}</div>`
    : `<div class="task-actions">
        <button data-act="task-doing" data-id="${esc(task.id)}" class="${task.status === 'doing' ? 'on' : ''}"><span class="emoji">▶️</span>${esc(t('begin'))}</button>
        <button data-act="task-done" data-id="${esc(task.id)}"><span class="emoji">✅</span>${esc(t('done'))}</button>
        <button data-act="task-problem" data-id="${esc(task.id)}"><span class="emoji">⚠️</span>${esc(t('problem'))}</button>
      </div>`;
  return `<article class="task is-${esc(task.status)}">
    <div class="task-top">
      <div class="pics">${taskPicture(task)}</div>
      <button class="say emoji" data-act="say-task" data-id="${esc(task.id)}" aria-label="${esc(taskWords(task))}">🔊</button>
    </div>
    <div class="task-words">${esc(taskWords(task))}</div>
    ${zone ? `<div class="task-map">${miniMap(store.state.zones, zone.id, myFix ?? me())}<span class="muted">${esc(zoneName(zone))}</span></div>` : ''}
    ${media ? `<div class="task-words">${media}</div>` : ''}
    ${problem ? `<div class="task-blocked"><span class="emoji">${problem.icon}</span>${esc(label(problem))}</div>` : ''}
    ${actions}
  </article>`;
}

function clockArea(person) {
  if (person.status === 'off') {
    return `<button class="clock-btn go" data-act="clock" data-type="in"><span class="glyph">▶</span>${esc(t('start'))}</button>`;
  }
  const onBreak = person.status === 'break';
  return `<div class="clock-row">
    <button class="clock-btn pause" data-act="clock" data-type="${onBreak ? 'break_end' : 'break_start'}">${onBreak ? '<span class="glyph">▶</span>' : '<span class="emoji">☕</span>'}${esc(onBreak ? t('backToWork') : t('break'))}</button>
    <button class="clock-btn stop" data-act="clock" data-type="out"><span class="glyph">■</span>${esc(t('stop'))}</button>
  </div>`;
}

function home() {
  const { state } = store;
  const person = me();
  const tasks = state.tasks.filter((x) => x.assigneeId === personId);
  const open = tasks.filter((x) => x.status !== 'done').sort((a, b) => (a.status === 'doing' ? -1 : b.status === 'doing' ? 1 : 0));
  const doneCount = tasks.filter((x) => x.status === 'done').length;
  const sent = state.tasks.filter((x) => x.createdBy === personId && x.origin === 'worker' && x.status === 'request');
  const syncLabel = store.pending ? `⏳ ${store.pending}` : store.online ? '✓' : '📵';

  app.innerHTML = `<div class="phone">
    <header class="topbar">
      <button data-act="switch" aria-label="${esc(t('workerSwitch'))}"><span class="face emoji" style="background:${esc(person.color)}">${person.avatar}</span></button>
      <div class="topbar-name">${esc(person.name.split(' ')[0])}</div>
      <div class="sync ${store.online ? '' : 'offline'}" aria-label="${store.pending} ${esc(t('waiting'))}">${syncLabel}</div>
    </header>
    <main class="scroll">
      ${clockArea(person)}
      <div class="worked"><span>${esc(t('worked'))}</span><span>${duration(person.todayMin ?? 0)}</span></div>
      <h2 class="section-head">${esc(t('tasks'))}</h2>
      ${open.map(taskCard).join('') || `<div class="task-small"><span class="emoji" style="font-size:28px">☀️</span>${esc(t('noTasks'))}</div>`}
      ${doneCount ? `<div class="task-small"><span class="emoji" style="font-size:28px">✅</span>${esc(t('doneToday'))}: ${doneCount}</div>` : ''}
      ${sent.length ? `<h2 class="section-head">${esc(t('sentToBoss'))}</h2>${sent.map((x) => `<div class="task-small"><span class="emoji" style="font-size:28px">${REQUESTS[x.action]?.icon ?? '❓'}</span>${esc(label(REQUESTS[x.action]))}</div>`).join('')}` : ''}
    </main>
    <nav class="dock">
      <button data-act="photo"><span class="emoji">📷</span>${esc(t('photo'))}</button>
      <button data-act="voice"><span class="emoji">🎤</span>${esc(t('voice'))}</button>
      <button data-act="write"><span class="emoji">✏️</span>${esc(t('write'))}</button>
      <button data-act="scan"><span class="emoji">📲</span>${esc(t('scan'))}</button>
      <button class="primary" data-act="ask"><span class="emoji">🙋</span>${esc(t('ask'))}</button>
    </nav>
  </div>`;
  checkDanger();
}

function render() {
  if (!store?.state) return;
  // Redrawing under an open sheet would discard what the worker is doing in it.
  if (sheetOpen) return;
  home();
}

function closeSheet() {
  sheetOpen = false;
  $('.sheet-back')?.remove();
  render();
}

function openSheet(html, bind) {
  $('.sheet-back')?.remove();
  sheetOpen = true;
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  back.addEventListener('click', (e) => {
    if (e.target === back) closeSheet();
  });
  document.body.append(back);
  bind?.(back);
}

// Danger: red screen and voice as soon as a phone or the server puts this worker in a no-entry field.
function checkDanger() {
  const person = me();
  if (person?.status === 'off') return;
  const zones = store.state.zones.filter(zoneRestricted);
  const here = (myFix && zones.find((z) => pointInPolygon([myFix.lat, myFix.lng], z.polygon))) || zones.find((z) => z.id === person?.zoneId);
  if (!here) {
    dangerDismissed = null;
    $('.danger')?.remove();
    return;
  }
  if (dangerDismissed === here.id || $('.danger')) return;
  const el = document.createElement('div');
  el.className = 'danger';
  el.setAttribute('role', 'alert');
  el.innerHTML = `<span class="emoji">⛔</span><h2>${esc(t('noEntry'))}</h2>
    <p>${esc(t('noEntryLong'))}</p>
    <p>${esc(t('openUntil'))} ${esc(clockTime(here.restrictedUntil, store.state.farm.timezone))}</p>
    <button>${esc(t('leave'))}</button>`;
  el.querySelector('button').onclick = () => {
    dangerDismissed = here.id;
    el.remove();
  };
  document.body.append(el);
  buzz([400, 150, 400, 150, 400]);
  say(`${t('noEntryLong')}`);
}

function followLocation(person) {
  const shouldWatch = person.status !== 'off' && person.locationConsent === 'yes';
  if (shouldWatch && !stopWatching) {
    stopWatching = watchLocation((fix) => {
      myFix = fix;
      checkDanger();
      if (Date.now() - lastSentFix < LOCATION_MIN_INTERVAL) return;
      lastSentFix = Date.now();
      store.send('sighting', { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
    });
  } else if (!shouldWatch && stopWatching) {
    stopWatching();
    stopWatching = null;
    myFix = null;
  }
}

async function clock(type) {
  const person = me();
  const fix = person.locationConsent === 'yes' ? await quickFix() : {};
  await store.send('punch', { type, method: 'button', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
  const words = { in: 'started', out: 'stopped', break_start: 'onBreak', break_end: 'resumed' }[type];
  confirmSent(`${t(words)} · ${clockTime(Date.now(), store.state.farm.timezone)}`);
}

function here() {
  const person = me();
  if (myFix) return smallestZoneAt([myFix.lat, myFix.lng], store.state.zones.filter((z) => z.kind !== 'farm'))?.id ?? person.zoneId;
  return person.zoneId;
}

async function sendNote({ kind, data = null, text = null, taskId = null }) {
  const fix = me().locationConsent === 'yes' ? await quickFix() : {};
  return store.send('note', { kind, data, text, taskId, lat: fix.lat, lng: fix.lng });
}

async function takePhoto(after) {
  try {
    const data = await capturePhoto();
    if (data) after(data);
  } catch {
    toast(t('noCamera'));
  }
}

function recorderButton(onClip) {
  let stop = null;
  return async (button) => {
    if (stop) {
      button.classList.remove('live');
      const clip = await stop();
      stop = null;
      onClip(clip);
      return;
    }
    try {
      stop = await startRecording();
      button.classList.add('live');
      buzz();
    } catch {
      toast(t('noVoice'));
    }
  };
}

function voiceSheet() {
  const record = recorderButton(async (data) => {
    closeSheet();
    await sendNote({ kind: 'voice', data });
    confirmSent(t('sent'));
  });
  openSheet(`<h2>${esc(t('voice'))}</h2>
    <button class="record emoji" data-go aria-label="${esc(t('tapRecord'))}">🎤</button>
    <p class="muted" style="margin:0;text-align:center">${esc(t('tapRecord'))}</p>
    <div class="sheet-row"><button class="big" data-close><span class="glyph">←</span>${esc(t('cancel'))}</button></div>`, (back) => {
    $('[data-go]', back).onclick = (e) => record(e.currentTarget);
    $('[data-close]', back).onclick = closeSheet;
  });
}

function writeSheet() {
  openSheet(`<h2>${esc(t('write'))}</h2>
    <textarea aria-label="${esc(t('typeNote'))}" placeholder="${esc(t('typeNote'))}"></textarea>
    <div class="sheet-row"><button class="big" data-close><span class="glyph">←</span>${esc(t('cancel'))}</button><button class="big main" data-go><span class="emoji">📨</span>${esc(t('send'))}</button></div>`, (back) => {
    $('[data-close]', back).onclick = closeSheet;
    $('[data-go]', back).onclick = async () => {
      const text = $('textarea', back).value.trim();
      if (!text) return;
      closeSheet();
      await sendNote({ kind: 'text', text });
      confirmSent(t('sent'));
    };
  });
}

// Shared by "tell boss" and "report a problem": pick a picture, optionally add a photo or voice, send.
function pictureSheet({ title, items, onSend }) {
  let picked = null;
  const extras = [];
  const record = recorderButton((data) => {
    extras.push({ kind: 'voice', data });
    refresh();
  });
  let back;
  const refresh = () => {
    $('.grid-pick', back).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.key === picked));
    $('.attachments', back).innerHTML = extras.map((x) => (x.kind === 'photo' ? `<img src="${esc(x.data)}" alt="">` : '<span class="emoji" style="font-size:40px">🎙️</span>')).join('');
    $('[data-go]', back).disabled = !picked;
    $('[data-go]', back).style.opacity = picked ? 1 : 0.45;
  };
  openSheet(`<h2>${esc(title)}</h2>
    <div class="grid-pick">${Object.entries(items).map(([key, item]) => `<button data-key="${key}" aria-label="${esc(label(item))}"><span class="emoji">${item.icon}</span>${esc(label(item))}</button>`).join('')}</div>
    <div class="attachments"></div>
    <div class="sheet-row">
      <button class="big" data-photo><span class="emoji">📷</span>${esc(t('photo'))}</button>
      <button class="big" data-voice><span class="emoji">🎤</span>${esc(t('voice'))}</button>
    </div>
    <div class="sheet-row"><button class="big" data-close><span class="glyph">←</span>${esc(t('cancel'))}</button><button class="big main" data-go><span class="emoji">📨</span>${esc(t('send'))}</button></div>`, (el) => {
    back = el;
    $('.grid-pick', back).onclick = (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      picked = button.dataset.key;
      say(label(items[picked]));
      refresh();
    };
    $('[data-photo]', back).onclick = () => takePhoto((data) => {
      extras.push({ kind: 'photo', data });
      refresh();
    });
    $('[data-voice]', back).onclick = (e) => record(e.currentTarget);
    $('[data-close]', back).onclick = closeSheet;
    $('[data-go]', back).onclick = async () => {
      if (!picked) return;
      closeSheet();
      await onSend(picked, extras);
      confirmSent(t('sent'));
    };
    refresh();
  });
}

function askSheet() {
  pictureSheet({
    title: t('ask'),
    items: REQUESTS,
    onSend: async (action, extras) => {
      const id = uid();
      await store.send('task_create', { action, zoneId: here(), origin: 'worker' }, { id });
      for (const extra of extras) await sendNote({ ...extra, taskId: id });
    },
  });
}

function problemSheet(task) {
  pictureSheet({
    title: t('problem'),
    items: PROBLEMS,
    onSend: async (reason, extras) => {
      await store.send('task_update', { taskId: task.id, status: 'problem', reason });
      for (const extra of extras) await sendNote({ ...extra, taskId: task.id });
    },
  });
}

async function onTag(rawUid) {
  const tagUid = rawUid.toUpperCase();
  const tag = store.state.tags.find((x) => x.uid === tagUid);
  // The screen answers the tap at once; the GPS fix can follow in the background.
  quickFix().then((fix) => store.send('tag_read', { uid: tagUid, kind: 'nfc', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }));

  if (tag?.ownerType === 'zone') {
    closeSheet();
    const zone = zoneById(tag.ownerId);
    confirmSent(`${t('noted')}: ${zoneName(zone)}`);
  } else if (tag?.ownerType === 'asset') {
    assetSheet(store.state.assets.find((a) => a.id === tag.ownerId));
  } else {
    closeSheet();
    toast(t('unknownTag'));
    say(t('unknownTag'));
  }
}

function assetSheet(asset) {
  const mine = asset.holderId === personId;
  const holder = store.state.people.find((p) => p.id === asset.holderId);
  openSheet(`<div style="text-align:center"><div class="emoji" style="font-size:96px">${asset.icon}</div><h2>${esc(asset.name)}</h2>
      ${holder ? `<p class="muted" style="margin:6px 0 0">${esc(mine ? t('taken') : `${t('heldBy')} ${holder.name}`)}</p>` : ''}</div>
    <div class="sheet-row">
      <button class="big" data-close><span class="glyph">←</span>${esc(t('cancel'))}</button>
      <button class="big ${mine ? 'no' : 'yes'}" data-go><span class="emoji">🤝</span>${esc(mine ? t('giveBack') : t('take'))}</button>
    </div>`, (back) => {
    $('[data-close]', back).onclick = closeSheet;
    $('[data-go]', back).onclick = async () => {
      closeSheet();
      const fix = await quickFix();
      await store.send('asset_checkout', { assetId: asset.id, action: mine ? 'return' : 'take', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
      confirmSent(t('saved'));
    };
  });
}

async function scanSheet() {
  let stopScan = null;
  const tags = store.state.tags.filter((x) => x.kind === 'nfc' && x.ownerType !== 'person');
  const nameOf = (tag) => {
    if (tag.ownerType === 'zone') return zoneName(zoneById(tag.ownerId));
    const asset = store.state.assets.find((a) => a.id === tag.ownerId);
    return asset ? `${asset.icon} ${asset.name}` : tag.uid;
  };
  openSheet(`<div style="text-align:center"><div class="emoji" style="font-size:80px">📲</div><h2>${esc(t('tapTag'))}</h2></div>
    ${NFC_SUPPORTED ? '' : `<div><div class="field-label">${esc(t('simTags'))}</div>
      <div class="pick-row">${tags.map((x) => `<button data-uid="${esc(x.uid)}">${esc(nameOf(x))}</button>`).join('')}</div></div>`}
    <div class="sheet-row"><button class="big" data-close><span class="glyph">←</span>${esc(t('cancel'))}</button></div>`, (back) => {
    $('[data-close]', back).onclick = () => {
      stopScan?.();
      closeSheet();
    };
    back.querySelectorAll('[data-uid]').forEach((b) => {
      b.onclick = () => onTag(b.dataset.uid);
    });
  });
  if (NFC_SUPPORTED) {
    say(t('tapTag'));
    try {
      stopScan = await scanNfc((tagUid) => {
        stopScan?.();
        onTag(tagUid);
      });
    } catch {
      toast(t('unknownTag'));
    }
  }
}

function consentSheet() {
  say(t('consentSay'));
  openSheet(`<div style="text-align:center"><div class="emoji" style="font-size:80px">📍</div><h2>${esc(t('consentTitle'))}</h2></div>
    <p style="margin:0;font-size:20px">${esc(t('consentSay'))}</p>
    <button class="say emoji" data-say style="justify-self:center" aria-label="${esc(t('consentSay'))}">🔊</button>
    <div class="sheet-row">
      <button class="big no" data-no><span class="glyph">✕</span>${esc(t('no'))}</button>
      <button class="big yes" data-yes><span class="glyph">✓</span>${esc(t('yes'))}</button>
    </div>`, (back) => {
    $('[data-say]', back).onclick = () => say(t('consentSay'));
    const answer = (location) => {
      closeSheet();
      store.send('consent', { location });
    };
    $('[data-yes]', back).onclick = () => answer(true);
    $('[data-no]', back).onclick = () => answer(false);
  });
}

app.addEventListener('click', (e) => {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const { act, id, type } = button.dataset;
  const task = store?.state?.tasks.find((x) => x.id === id);
  if (act === 'clock') clock(type);
  else if (act === 'say-task') say(taskWords(task));
  else if (act === 'task-doing') store.send('task_update', { taskId: id, status: 'doing' }).then(() => confirmSent(t('begin')));
  else if (act === 'task-done') store.send('task_update', { taskId: id, status: 'done' }).then(() => confirmSent(t('done')));
  else if (act === 'task-problem') problemSheet(task);
  else if (act === 'photo') takePhoto(async (data) => {
    await sendNote({ kind: 'photo', data });
    confirmSent(t('sent'));
  });
  else if (act === 'voice') voiceSheet();
  else if (act === 'write') writeSheet();
  else if (act === 'scan') scanSheet();
  else if (act === 'ask') askSheet();
  else if (act === 'switch') signOut();
});

async function signOut() {
  await kvSet('personId', null);
  location.href = 'worker.html';
}

async function enter(id) {
  personId = id;
  await kvSet('personId', id);
  store = createStore({
    personId,
    onChange: () => {
      const person = me();
      if (!person) return;
      lang = person.lang;
      document.documentElement.lang = lang;
      followLocation(person);
      render();
    },
  });
  await store.start();
  if (!me()) return signOut();
  if (!me().locationConsent) consentSheet();
  if (pendingTag) {
    const tagUid = pendingTag;
    pendingTag = null;
    history.replaceState(null, '', 'worker.html');
    onTag(tagUid);
  }
  return undefined;
}

async function chooseFace() {
  const picker = createStore({ personId: '_', onChange: () => {} });
  await picker.refresh();
  const people = picker.state?.people.filter((p) => p.role === 'worker') ?? [];
  app.innerHTML = `<div class="phone"><h1 style="padding:20px 14px 0;font-size:36px">${esc(STRINGS.es.who)} / ${esc(STRINGS.en.who)}</h1>
    <div class="faces">${people.map((p) => `<button data-id="${esc(p.id)}"><span class="face emoji" style="background:${esc(p.color)}">${p.avatar}</span>${esc(p.name.split(' ')[0])}</button>`).join('')}</div></div>`;
  $('.faces').onclick = (e) => {
    const button = e.target.closest('[data-id]');
    if (button) enter(button.dataset.id);
  };
}

setInterval(() => {
  if (store?.state && !sheetOpen) checkDanger();
}, 30_000);

registerServiceWorker();
const saved = new URLSearchParams(location.search).get('person') ?? (await kvGet('personId'));
if (saved) enter(saved);
else chooseFace();
