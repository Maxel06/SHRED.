/**
 * SHRED. – kleiner Webserver für die Website + Admin-Speicherung
 * ---------------------------------------------------------------
 * Start:  npm start   (oder: node server.js)
 * Port:   http://localhost:3000
 *
 * Passwort:  hier unten ändern oder als Umgebungsvariable setzen:
 *            ADMIN_PASSWORD=meinPasswort npm start
 *
 * Die Texte werden in  data/content.json  gespeichert und an ALLE
 * Besucher ausgeliefert (GET /api/content).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/* ============================================================
   EINSTELLUNGEN
   ============================================================ */

/** Passwort für den Admin-Bereich (hier ändern!) */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shred-admin';

/** Port (Render/Railway geben PORT automatisch vor) */
const PORT = Number(process.env.PORT) || 3000;

/** Ordner, der die Website ausliefert */
const ROOT = __dirname;

/** Datei mit den gespeicherten Texten */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'content.json');

/** Wie lange ein Login gültig bleibt (Millisekunden) */
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 Stunden

/** Max. Textlänge pro Element */
const MAX_TEXT_LENGTH = 20000;
const MAX_ENTRIES = 5000;

/* ============================================================
   SPEICHER (JSON-Datei)
   ============================================================ */

/** @type {Record<string, string>} */
let content = {};
let writeQueue = Promise.resolve();

async function loadContent() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const clean = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') clean[k] = v;
      }
      content = clean;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[content] konnte nicht gelesen werden:', err.message);
    }
    content = {};
  }
}

function saveContent() {
  // Schreibvorgänge nacheinander ausführen (kein kaputtes JSON)
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(content, null, 2), 'utf8');
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => {
    console.error('[content] Schreiben fehlgeschlagen:', err.message);
  });
  return writeQueue;
}

/* ============================================================
   LOGIN / SESSIONS
   ============================================================ */

/** token -> Zeitpunkt des Ablaufs */
const sessions = new Map();
/** ip -> {count, firstTry} (einfacher Brute-Force-Schutz) */
const loginAttempts = new Map();

function newToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function isValidToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function passwordMatches(input) {
  const a = Buffer.from(String(input ?? ''), 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
  if (a.length !== b.length) {
    // trotzdem vergleichen, damit die Zeit nicht verrät, wie lang das Passwort ist
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

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

function readBody(req, limit = 1024 * 200) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
}

/* ============================================================
   API
   ============================================================ */

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '');

  /* ---- Texte laden (öffentlich) ---- */
  if (route === '/api/content' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      content,
      updatedAt: content.__updatedAt || null,
    });
  }

  /* ---- Login ---- */
  if (route === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const record = loginAttempts.get(ip) || { count: 0, firstTry: now };
    if (now - record.firstTry > 10 * 60 * 1000) {
      record.count = 0;
      record.firstTry = now;
    }
    if (record.count >= 15) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.',
      });
    }

    let body;
    try {
      body = await readBody(req, 4096);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Ungültige Anfrage' });
    }

    if (!passwordMatches(body.password)) {
      record.count += 1;
      loginAttempts.set(ip, record);
      return sendJson(res, 401, { ok: false, error: 'Falsches Passwort' });
    }

    loginAttempts.delete(ip);
    const token = newToken();
    return sendJson(res, 200, { ok: true, token, expiresIn: SESSION_TTL });
  }

  /* ---- Login prüfen ---- */
  if (route === '/api/session' && req.method === 'GET') {
    const token = req.headers['x-admin-token'];
    return sendJson(res, 200, { ok: isValidToken(token) });
  }

  /* ---- Speichern ---- */
  if (route === '/api/content' && (req.method === 'POST' || req.method === 'PUT')) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }

    const token = body.token || req.headers['x-admin-token'];
    if (!isValidToken(token)) {
      return sendJson(res, 401, {
        ok: false,
        error: 'Sitzung abgelaufen – bitte neu einloggen.',
      });
    }

    const updates = body.updates && typeof body.updates === 'object' ? body.updates : {};
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];

    const next = { ...content };

    for (const key of deletes) {
      if (typeof key === 'string') delete next[key];
    }

    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== 'string' || key.length > 500) continue;
      if (typeof value !== 'string') continue;
      const text = value.slice(0, MAX_TEXT_LENGTH);
      if (text.trim() === '') {
        delete next[key]; // leerer Text = Standardtext aus der HTML-Datei
      } else {
        next[key] = text;
      }
    }

    if (Object.keys(next).length > MAX_ENTRIES) {
      return sendJson(res, 400, { ok: false, error: 'Zu viele Einträge.' });
    }

    next.__updatedAt = new Date().toISOString();
    content = next;
    await saveContent();

    return sendJson(res, 200, { ok: true, content, updatedAt: next.__updatedAt });
  }

  /* ---- Abmelden ---- */
  if (route === '/api/logout' && req.method === 'POST') {
    const token = req.headers['x-admin-token'];
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'Unbekannte API-Route' });
}

/* ============================================================
   STATISCHE DATEIEN
   ============================================================ */

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }

  if (pathname === '/') pathname = '/index.html';

  // data/ und server.js nicht ausliefern
  if (/^\/(data\/|server\.js$|package(-lock)?\.json$|\.git\/)/.test(pathname)) {
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
      await handleApi(req, res, url);
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

loadContent().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('SHRED. läuft auf http://localhost:' + PORT);
    console.log('Admin-Passwort:' , ADMIN_PASSWORD === 'shred-admin' ? 'shred-admin  (Standard – bitte in server.js ändern!)' : '(aus ADMIN_PASSWORD gesetzt)');
    console.log('Gespeicherte Texte:', DATA_FILE);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
