/**
 * SHRED. – Speicher für die bearbeiteten Texte
 * ---------------------------------------------
 * Zwei Betriebsarten, automatisch erkannt:
 *
 * 1) Upstash Redis / Vercel KV  (für Vercel & andere Serverless-Hoster)
 *    Erkannt an einer dieser Umgebungsvariablen:
 *      KV_REST_API_URL        + KV_REST_API_TOKEN        (Vercel KV)
 *      UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (Upstash direkt)
 *
 * 2) JSON-Datei  data/content.json  (lokal, Render, Railway, eigener Server)
 *    Pfad änderbar über DATA_DIR.
 *
 * Beide Varianten haben dieselbe API:
 *   await readContent()        -> { ... }
 *   await writeContent(obj)    -> void
 */

'use strict';

const fsp = require('fs/promises');
const path = require('path');

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  '';

const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  '';

const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const REDIS_KEY = process.env.CONTENT_KEY || 'shred:content';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'content.json');

/* ------------------------------------------------------------
   Redis (Upstash REST API)
   ------------------------------------------------------------ */

async function redisCommand(command, body) {
  const url = REDIS_URL.replace(/\/+$/, '') + '/' + command;
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + REDIS_TOKEN,
      ...(body === undefined ? {} : { 'Content-Type': 'text/plain' }),
    },
    body: body === undefined ? undefined : body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Redis ' + res.status + ': ' + text.slice(0, 200));
  }

  const data = await res.json();
  if (data && data.error) throw new Error('Redis: ' + data.error);
  return data ? data.result : null;
}

async function readFromRedis() {
  const raw = await redisCommand('get/' + encodeURIComponent(REDIS_KEY));
  if (!raw) return {};
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return cleanContent(parsed);
}

async function writeToRedis(value) {
  await redisCommand(
    'set/' + encodeURIComponent(REDIS_KEY),
    JSON.stringify(value)
  );
}

/* ------------------------------------------------------------
   Datei
   ------------------------------------------------------------ */

async function readFromFile() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    return cleanContent(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[content] Datei nicht lesbar:', err.message);
    }
    return {};
  }
}

async function writeToFile(value) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

/* ------------------------------------------------------------
   Gemeinsam
   ------------------------------------------------------------ */

function cleanContent(parsed) {
  const clean = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') clean[key] = value;
    }
  }
  return clean;
}

async function readContent() {
  return USE_REDIS ? readFromRedis() : readFromFile();
}

async function writeContent(value) {
  if (USE_REDIS) return writeToRedis(value);
  return writeToFile(value);
}

module.exports = {
  readContent,
  writeContent,
  USE_REDIS,
  DATA_FILE,
  REDIS_KEY,
};
