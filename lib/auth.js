/**
 * SHRED. – Login & Tokens
 * -----------------------
 * Tokens sind signiert (HMAC-SHA256) und damit *stateless*.
 * Das ist auf Vercel wichtig: dort laufen mehrere Instanzen,
 * ein Token muss also ohne gemeinsamen Serverspeicher gültig sein.
 */

'use strict';

const crypto = require('crypto');

/** Passwort für den Admin-Bereich */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shred-admin';

/** Gültigkeit eines Logins */
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 Stunden

/** Signatur-Secret: eigenes Secret oder vom Passwort abgeleitet */
const SECRET =
  process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('shred-admin-session|' + ADMIN_PASSWORD).digest('hex');

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Passwort prüfen (Leerzeichen + Groß/Kleinschreibung tolerant) */
function passwordMatches(input) {
  const entered = String(input ?? '').trim();
  const expected = String(ADMIN_PASSWORD).trim();
  if (safeEqual(entered, expected)) return true;
  return safeEqual(entered.toLowerCase(), expected.toLowerCase());
}

/** Neues Token erzeugen */
function createToken() {
  const payload = base64url(JSON.stringify({ exp: Date.now() + SESSION_TTL }));
  return payload + '.' + sign(payload);
}

/** Token prüfen */
function isValidToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  if (!safeEqual(signature, sign(payload))) return false;

  try {
    const data = JSON.parse(fromBase64url(payload));
    return typeof data.exp === 'number' && Date.now() < data.exp;
  } catch {
    return false;
  }
}

module.exports = {
  ADMIN_PASSWORD,
  SESSION_TTL,
  passwordMatches,
  createToken,
  isValidToken,
};
