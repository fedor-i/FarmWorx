// Shared phone or tablet at the gate: crew with no smartphone clock in and out with a badge.
import { STRINGS } from './catalog.js';
import { $, esc, createStore, registerServiceWorker, speak, buzz, quickFix, NFC_SUPPORTED, scanNfc, clockTime } from './core.js';

const main = $('#gate-main');
const test = $('#gate-test');
const REPEAT_TAP_MS = 8000;
const RESET_MS = 4000;

const lastTap = new Map();
let resetTimer = null;

const store = createStore({ onChange: renderIdle });

function idle() {
  main.className = 'gate-main';
  main.innerHTML = `<span class="emoji">📲</span><h2>Tap your badge</h2><p class="muted">Acerca tu tarjeta</p>`;
}

function renderIdle(state) {
  $('#gate-sync').textContent = store.pending ? `⏳ ${store.pending}` : store.online ? '✓' : '📵';
  if (NFC_SUPPORTED) return;
  const badges = state.tags.filter((tag) => tag.ownerType === 'person');
  test.innerHTML = `<span class="muted small">This device has no NFC. Test badges:</span>` + badges.map((tag) => {
    const person = state.people.find((p) => p.id === tag.ownerId);
    return `<button data-uid="${esc(tag.uid)}"><span class="emoji">${person.avatar}</span>${esc(person.name.split(' ')[0])}</button>`;
  }).join('');
}

async function onBadge(rawUid) {
  const { state } = store;
  const tagUid = rawUid.toUpperCase();
  const tag = state.tags.find((x) => x.uid === tagUid && x.ownerType === 'person');
  clearTimeout(resetTimer);
  resetTimer = setTimeout(idle, RESET_MS);

  if (!tag) {
    main.className = 'gate-main out';
    main.innerHTML = `<span class="emoji">❓</span><h2>Unknown badge</h2>`;
    store.send('tag_read', { uid: tagUid, kind: 'nfc' });
    buzz([200, 100, 200]);
    return;
  }

  // An NFC reader fires several times for one tap, which would clock someone straight back out.
  if (Date.now() - (lastTap.get(tagUid) ?? 0) < REPEAT_TAP_MS) return;
  lastTap.set(tagUid, Date.now());

  const person = state.people.find((p) => p.id === tag.ownerId);
  const clockingIn = person.status === 'off';
  const fix = await quickFix();
  await store.send('punch', { type: 'toggle', method: 'badge', lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }, { actor: person.id });

  const strings = STRINGS[person.lang];
  const words = clockingIn ? strings.started : strings.stopped;
  main.className = `gate-main ${clockingIn ? 'in' : 'out'}`;
  main.innerHTML = `<span class="emoji">${person.avatar}</span><h2>${esc(person.name.split(' ')[0])}</h2>
    <p style="font-size:30px;margin:0">${clockingIn ? '▶️' : '⏹️'} ${esc(words)} · ${esc(clockTime(Date.now(), state.farm.timezone))}</p>`;
  buzz();
  speak(`${person.name.split(' ')[0]}. ${words}`, person.lang);
}

test.addEventListener('click', (e) => {
  const button = e.target.closest('[data-uid]');
  if (button) onBadge(button.dataset.uid);
});

idle();
registerServiceWorker();
await store.start();

if (NFC_SUPPORTED) {
  // The browser only allows the NFC prompt after a tap on the page.
  test.innerHTML = '<button id="nfc-on">Turn on badge reader</button>';
  $('#nfc-on').onclick = async () => {
    await scanNfc(onBadge);
    test.innerHTML = '<span class="muted small">Badge reader is on</span>';
  };
}
