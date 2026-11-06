import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from './src/db.js';
import { applyOps, ingestReadings } from './src/ops.js';
import { buildState } from './src/state.js';
import { timesheet, timesheetCsv } from './src/timesheet.js';
import { seedIfEmpty } from './src/seed.js';

const ROOT = import.meta.dirname;
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function serveFile(req, res, baseDir, urlPath) {
  const file = normalize(join(baseDir, urlPath));
  if (!file.startsWith(baseDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

export function createApp({ db, mediaDir, publicDir = join(ROOT, 'public') }) {
  const listeners = new Set();
  const broadcast = () => {
    for (const res of listeners) res.write('data: changed\n\n');
  };
  const ctx = () => ({ db, mediaDir, now: Date.now() });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, buildState(db, { personId: url.searchParams.get('person') }));
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
        listeners.add(res);
        req.on('close', () => {
          clearInterval(keepAlive);
          listeners.delete(res);
        });
        return undefined;
      }
      if (req.method === 'GET' && (pathname === '/api/timesheet' || pathname === '/api/timesheet.csv')) {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
          return sendJson(res, 400, { error: 'from and to must be YYYY-MM-DD' });
        }
        const sheet = timesheet(db, from, to);
        if (pathname === '/api/timesheet') return sendJson(res, 200, sheet);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="timesheet-${from}-to-${to}.csv"`,
        });
        return res.end(timesheetCsv(sheet));
      }
      if (req.method === 'POST' && pathname === '/api/sync') {
        const { ops } = await readJson(req);
        if (!Array.isArray(ops)) return sendJson(res, 400, { error: 'ops must be an array' });
        const result = applyOps(ctx(), ops);
        sendJson(res, 200, result);
        return broadcast();
      }
      // Hardware input: UHF gate readers, BLE gateways and GPS trackers all post here.
      if (req.method === 'POST' && pathname === '/api/readings') {
        const result = ingestReadings(ctx(), await readJson(req));
        sendJson(res, 200, result);
        return broadcast();
      }
      // NFC tags hold this URL, so an iPhone can open it from a tap without any app.
      if (req.method === 'GET' && pathname.startsWith('/t/')) {
        const uid = encodeURIComponent(decodeURIComponent(pathname.slice(3)));
        res.writeHead(302, { Location: `/worker.html?tag=${uid}` });
        return res.end();
      }
      if (req.method === 'GET' && pathname.startsWith('/media/')) {
        return serveFile(req, res, mediaDir, decodeURIComponent(pathname.slice('/media/'.length)));
      }
      if (req.method === 'GET') {
        return serveFile(req, res, publicDir, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(res, error.status ?? 500, { error: error.status ? error.message : 'server error' });
      else res.end();
      return undefined;
    }
  });

  server.on('close', () => {
    for (const res of listeners) res.end();
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = join(ROOT, 'data');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'farmworx.db'));
  seedIfEmpty(db);

  const port = Number(process.env.PORT ?? 3210);
  // No login yet, so the app stays on this computer unless HOST is set on purpose.
  const host = process.env.HOST ?? '127.0.0.1';
  createApp({ db, mediaDir: join(dataDir, 'media') }).listen(port, host, () => {
    console.log(`FarmWorx running at http://${host}:${port}`);
  });
}
