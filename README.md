# FarmWorx

Helping farmers manage time & tasks.

Website and live demo: https://fedor-i.github.io/FarmWorx/

A prototype for small farms: time tracking, picture tasks that work without reading, notes and photos,
geofencing for people and equipment, and NFC/RFID tags. The reasoning is in [RESEARCH.md](RESEARCH.md).

## Run it

Needs Node 22.13 or newer. Running it needs nothing installed.

```bash
npm start
```

Open http://localhost:3210. Demo data is created on first run, and `npm run seed` resets it. `npm test` runs the tests.

The website in `docs/` includes a live demo at `docs/demo`. GitHub Pages can't run `server.js`, so the demo runs the same
app logic inside a service worker in the visitor's browser (`src/demo`), with each visitor's made-up farm saved locally.
After changing the app, rebuild it:

```bash
npm install
npm run build:demo
```

## Five-minute demo

Open **Supervisor** and **Worker phone** side by side. The worker screen suits a narrow window.

1. **Worker:** tap a face. The app switches to that person's language with no menu. Tap 🔊 to hear a task.
2. **Supervisor, Tasks:** build a task from pictures, pick a worker and send. It appears on their phone at once.
3. **Worker:** tap Problema, pick a picture and send. It lands in the supervisor's Problem column.
4. **Worker:** tap Avisar al jefe to send something up. It lands in From crew, ready to assign.
5. **Supervisor, Live map:** turn on Simulate and drag a worker onto the yellow field, or close their field. Their phone turns red and speaks.
6. **Supervisor, Equipment:** press the GPS tracker button. The tractor leaves the farm and raises an alert.
7. **Gate kiosk:** tap a test badge to clock someone in. A second tap within 8 seconds is ignored.
8. **Offline:** stop the server, keep using the worker phone, then start it again. Everything arrives with its original time.

## On real phones

Camera, microphone, GPS, Web NFC and offline support all need HTTPS. A tunnel is the quickest route:

```bash
cloudflared tunnel --url http://localhost:3210
```

The app has **no login yet**, so anyone with that link can see farm data. Keep it to demo data and close the tunnel afterwards.
By default the server only accepts connections from this computer. `HOST=0.0.0.0 npm start` opens it to your network.

To set up an NFC tag, open Equipment & tags on an Android phone in Chrome and press Write to tag. Tapping that tag then opens
the app on Android or iPhone (XS and later).

## Connecting hardware

Gate readers, BLE gateways and GPS trackers all post the same thing:

```bash
curl -X POST http://localhost:3210/api/readings -H 'Content-Type: application/json' \
  -d '{"readerId":"gate-uhf","reads":[{"uid":"E280-1170-0000-GEN"}]}'
```

A reader with a fixed place uses its saved position. A tracker leaves out `readerId` and sends `lat` and `lng` on each read.
Tags the system hasn't seen appear under Equipment & tags, ready to assign. This endpoint has no authentication yet.

## How it fits together

- Every change is an **op**: a small record with an id made on the device. Phones queue ops and resend until confirmed, and the server ignores repeats (`src/ops.js`, `public/js/core.js`).
- Every position goes through `recordSighting`, whether it came from a phone, tag, reader or tracker, so all geofence rules live in one place.
- Punches are never edited. Hours are worked out from them on demand, and shifts with a missing end are flagged rather than guessed (`src/timesheet.js`).
- Geofence maths is one file used by both server and phone (`public/js/geo.js`), so a phone can warn with no signal.

## Not done yet

- **Login and permissions.** Nothing is protected, including the supervisor screen and worker data. Do this before any real data goes in.
- **Background location.** Geofencing only works while the app is open and the screen is on. No-entry warnings are not a safety system until a native app solves this.
- **Tested on real devices.** Live NFC, GPS, the camera, the microphone and speech have not been tried on a real phone.
- **Time corrections.** A supervisor can add a missing punch, but not cancel a wrong one.
- **Piece rate, payroll export, crew setup screens and drawing fields on the map.** Demo people, fields and equipment are seeded in `src/seed.js`.
- **Picture testing.** Emoji are placeholders until tested with real workers.
- **Spoken words.** Turned off for now because browser voices sound poor. `SPEECH_ENABLED` in `public/js/core.js` brings them back. Recorded voice clips still work.
- **Boss screen languages.** The supervisor screen is English only. Worker screens are English and Spanish.
