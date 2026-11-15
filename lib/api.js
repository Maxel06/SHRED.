/**
 * SHRED. – Admin-API (framework-unabhängig)
 * -----------------------------------------
 * Wird von zwei Seiten benutzt:
 *   - api/index.js  (Vercel Serverless Function)
 *   - server.js     (lokaler Node-Server / Render / Railway)
 *
 * Routen:
 *   GET  /api/content   gespeicherte Texte (öffentlich)
 *   POST /api/login     { password } -> { token }
 *   GET  /api/session   Login prüfen (X-Admin-Token)
 *   POST /api/content   { updates, deletes } speichern (Token nötig)
 *   POST /api/logout    Token verwerfen (bei stateless Tokens nur Client-seitig)
 */

'use strict';

const { readContent, writeContent } = require('./store');
const { passwordMatches, createToken, isValidToken, SESSION_TTL } = require('./auth');
const {
  createOrderTicket,
  sendOrderViaWebhook,
  webhookChannelUrl,
  discordStatus,
} = require('./discord');

const MAX_TEXT_LENGTH = 20000;
const MAX_ENTRIES = 5000;

/*
 * Größere Limits für die Shop-Seite (index.html im Hauptordner):
 *   "shopData"        = kompletter Shop (Footer + Produkte) als JSON-String
 *   "shopImage:<id>"  = Produktbild als Data-URL (im Browser komprimiert)
 */
const MAX_SHOPDATA_LENGTH = 300000; // ~300 KB
const MAX_SHOPIMAGE_LENGTH = 600000; // ~600 KB pro Bild

function maxLengthFor(key) {
  if (key === 'shopData') return MAX_SHOPDATA_LENGTH;
  if (key.startsWith('shopImage:')) return MAX_SHOPIMAGE_LENGTH;
  return MAX_TEXT_LENGTH;
}

/* Discord-Integration liegt in lib/discord.js (Bot-Ticketsystem + Webhook) */

const MAX_ORDER_ITEMS = 50;

/** ip -> { count, firstTry } für Bestellungen */
const orderAttempts = new Map();
const MAX_ORDER_ATTEMPTS = 10;
const ORDER_WINDOW = 10 * 60 * 1000;

/** ip -> { count, firstTry } */
const loginAttempts = new Map();
const MAX_ATTEMPTS = 15;
const ATTEMPT_WINDOW = 10 * 60 * 1000;

/* ------------------------------------------------------------
   Hilfen
   ------------------------------------------------------------ */

function sendJson(res, status, data) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    // Express-artige Signaturen (nicht genutzt, aber schadet nicht)
    return res.status(status).json(data);
  }
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** Body lesen – funktioniert mit Vercel (bereits geparst) und rohem Node */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('Ungültiges JSON');
    }
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // 4 MB – passend zu Vercels Limit für Request-Bodies (4,5 MB)
      if (size > 1024 * 1024 * 4) {
        reject(new Error('Anfrage zu groß'));
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
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return (
    (req.headers['x-real-ip'] && String(req.headers['x-real-ip'])) ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

function getToken(req, body) {
  if (body && typeof body.token === 'string' && body.token) return body.token;
  const header = req.headers['x-admin-token'];
  return typeof header === 'string' ? header : '';
}

function pathOf(req) {
  const raw = req.url || '/';
  return raw.split('?')[0].replace(/\/+$/, '') || '/';
}

/* ------------------------------------------------------------
   API-Handler
   ------------------------------------------------------------ */

async function handleApi(req, res) {
  const route = pathOf(req);
  const method = (req.method || 'GET').toUpperCase();

  /* ---- Texte laden (öffentlich) ---- */
  if (route === '/api/content' && method === 'GET') {
    const content = await readContent();
    return sendJson(res, 200, {
      ok: true,
      content,
      updatedAt: content.__updatedAt || null,
    });
  }

  /* ---- Login ---- */
  if (route === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const record = loginAttempts.get(ip) || { count: 0, firstTry: now };
    if (now - record.firstTry > ATTEMPT_WINDOW) {
      record.count = 0;
      record.firstTry = now;
    }
    if (record.count >= MAX_ATTEMPTS) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.',
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Ungültige Anfrage' });
    }

    if (!passwordMatches(body && body.password)) {
      record.count += 1;
      loginAttempts.set(ip, record);
      return sendJson(res, 401, { ok: false, error: 'Falsches Passwort' });
    }

    loginAttempts.delete(ip);
    return sendJson(res, 200, {
      ok: true,
      token: createToken(),
      expiresIn: SESSION_TTL,
    });
  }

  /* ---- Login prüfen ---- */
  if (route === '/api/session' && method === 'GET') {
    const token = req.headers['x-admin-token'];
    return sendJson(res, 200, { ok: isValidToken(typeof token === 'string' ? token : '') });
  }

  /* ---- Speichern ---- */
  if (route === '/api/content' && (method === 'POST' || method === 'PUT')) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }

    if (!isValidToken(getToken(req, body))) {
      return sendJson(res, 401, {
        ok: false,
        error: 'Sitzung abgelaufen – bitte neu einloggen.',
      });
    }

    const updates = body && typeof body.updates === 'object' && body.updates ? body.updates : {};
    const deletes = body && Array.isArray(body.deletes) ? body.deletes : [];

    const next = { ...(await readContent()) };

    for (const key of deletes) {
      if (typeof key === 'string') delete next[key];
    }

    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== 'string' || !key || key.length > 500) continue;
      if (typeof value !== 'string') continue;

      // Shop-Daten/Bilder dürfen größer sein, aber nicht abgeschnitten werden
      if (key === 'shopData' && value.length > MAX_SHOPDATA_LENGTH) {
        return sendJson(res, 400, { ok: false, error: 'Shop-Daten zu groß.' });
      }
      if (key.startsWith('shopImage:') && value.length > MAX_SHOPIMAGE_LENGTH) {
        return sendJson(res, 400, { ok: false, error: 'Produktbild zu groß.' });
      }

      const text = value.slice(0, maxLengthFor(key));
      if (text.trim() === '') {
        delete next[key]; // leer = Standardtext aus der HTML
      } else {
        next[key] = text;
      }
    }

    if (Object.keys(next).length > MAX_ENTRIES) {
      return sendJson(res, 400, { ok: false, error: 'Zu viele Einträge.' });
    }

    next.__updatedAt = new Date().toISOString();
    await writeContent(next);

    return sendJson(res, 200, {
      ok: true,
      content: next,
      updatedAt: next.__updatedAt,
    });
  }

  /* ---- Bestellung an Discord schicken (öffentlich, ratelimited) ---- */
  if (route === '/api/order' && method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const record = orderAttempts.get(ip) || { count: 0, firstTry: now };
    if (now - record.firstTry > ORDER_WINDOW) {
      record.count = 0;
      record.firstTry = now;
    }
    if (record.count >= MAX_ORDER_ATTEMPTS) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Zu viele Bestellungen. Bitte in ein paar Minuten erneut versuchen.',
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Ungültige Anfrage' });
    }

    const rawItems = Array.isArray(body && body.items) ? body.items : [];
    const items = [];

    for (const raw of rawItems.slice(0, MAX_ORDER_ITEMS)) {
      if (!raw || typeof raw !== 'object') continue;
      const name = String(raw.name || '')
        .replace(/[*_`~<>|]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 200);
      const quantity = Math.floor(Number(raw.quantity));
      if (!name) continue;
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) continue;
      items.push({ name, quantity });
    }

    if (items.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Keine gültigen Artikel in der Bestellung.',
      });
    }

    /* Discord-Name des Bestellers (wird für das Ticket benötigt) */
    const customer = String(body.customer || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[*_`~<>|@]/g, '')
      .trim()
      .slice(0, 40);

    if (customer.length < 2) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Bitte gib deinen Discord-Namen an.',
      });
    }

    record.count += 1;
    orderAttempts.set(ip, record);

    /* 1) Versuch: privates Bestell-Ticket über den Bot anlegen */
    try {
      const ticket = await createOrderTicket({ customerName: customer, items });
      return sendJson(res, 200, {
        ok: true,
        mode: 'ticket',
        channelUrl: ticket.channelUrl,
        items: items.length,
      });
    } catch (err) {
      if (err.code === 'member_not_found') {
        return sendJson(res, 404, {
          ok: false,
          error:
            'Discord-Name nicht gefunden. Bitte prüfe deinen Namen – ' +
            'du musst auch auf unserem Discord-Server sein.',
        });
      }
      console.error('[api] Ticket fehlgeschlagen, Webhook-Fallback:', err.message);
    }

    /* 2) Fallback: normale Nachricht über den Webhook */
    try {
      await sendOrderViaWebhook(items);
      return sendJson(res, 200, {
        ok: true,
        mode: 'webhook',
        channelUrl: webhookChannelUrl(),
        items: items.length,
      });
    } catch (err) {
      console.error('[api] Discord-Bestellung fehlgeschlagen:', err.message);
      return sendJson(res, 502, {
        ok: false,
        error: 'Bestellung konnte nicht an Discord gesendet werden.',
      });
    }
  }

  /* ---- Discord-Einrichtung prüfen (Diagnose) ---- */
  if (route === '/api/discord/status' && method === 'GET') {
    const query = String(req.url || '').split('?')[1] || '';
    const withTest = new URLSearchParams(query).get('test') === '1';
    const status = await discordStatus(withTest);
    return sendJson(res, 200, { ok: true, status });
  }

  /* ---- Abmelden (Tokene sind stateless -> nur Hinweis) ---- */
  if (route === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }

  /* ---- Healthcheck ---- */
  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  return sendJson(res, 404, { ok: false, error: 'Unbekannte API-Route' });
}

module.exports = { handleApi, sendJson, readBody };
