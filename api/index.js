/**
 * Vercel Serverless Function für die komplette Admin-API.
 *
 * Diese Datei wird von Vercel automatisch als Function erkannt.
 * Alle Aufrufe unter /api/* landen hier (siehe vercel.json).
 *
 * WICHTIG: kein server.listen() – Vercel ruft den Handler direkt auf.
 */

'use strict';

const { handleApi } = require('../lib/api');

module.exports = async function handler(req, res) {
  // CORS: die Seite liegt auf derselben Domain, aber so klappt es auch,
  // wenn sie z. B. über eine eigene Domain oder www aufgerufen wird.
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    await handleApi(req, res);
  } catch (err) {
    console.error('[api] Fehler:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Serverfehler' }));
    }
  }
};
