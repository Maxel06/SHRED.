/**
 * SHRED. – lokaler Webserver (auch für Render / Railway / eigener Server)
 * -----------------------------------------------------------------------
 * Start:  npm start   (oder: node server.js)
 * Port:   http://localhost:3000
 *
 * Passwort:  server.js → ADMIN_PASSWORD  oder Umgebungsvariable:
 *            ADMIN_PASSWORD=meinPasswort npm start
 *
 * Gespeichert wird:
 *   - mit Upstash/Vercel-KV-Variablen  → in Redis
 *   - sonst                            → in data/content.json
 *
 * Die API-Logik liegt in  lib/api.js  und wird 1:1 auch auf Vercel benutzt
 * (dort über  api/index.js ).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { handleApi } = require('./lib/api');
const { ADMIN_PASSWORD } = require('./lib/auth');
const store = require('./lib/store');

/* ============================================================
   EINSTELLUNGEN
   ============================================================ */

/** Port (Render/Railway geben PORT automatisch vor) */
const PORT = Number(process.env.PORT) || 3000;

/** Ordner, der die Website ausliefert */
const ROOT = __dirname;

/* ============================================================
   HTTP-HILFEN
   ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Dateien, die nicht ausgeliefert werden dürfen */
const BLOCKED = /^\/(data\/|lib\/|api\/|server\.js$|package(-lock)?\.json$|vercel\.json$|\.git\/|\.env)/;

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  if (pathname === '/') pathname = '/index.html';

  if (BLOCKED.test(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  const filePath = path.join(ROOT, path.normalize(pathname));

  // kein Ausbruch aus dem Website-Ordner
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 – Seite nicht gefunden</h1>');
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html' || ext === '.htm';

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  });
}

/* ============================================================
   SERVER START
   ============================================================ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res);
    } catch (err) {
      console.error('[api]', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Serverfehler' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }

  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SHRED. läuft auf http://localhost:' + PORT);
  if (process.env.ADMIN_PASSWORD) {
    console.log('Admin-Passwort: aus Umgebungsvariable ADMIN_PASSWORD');
  } else {
    console.log('Admin-Passwort: ' + ADMIN_PASSWORD + '   (Standardwert)');
  }
  console.log(
    'Speicher:',
    store.USE_REDIS ? 'Redis (Upstash/Vercel KV)' : store.DATA_FILE
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
