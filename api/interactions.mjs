/**
 * SHRED. – Discord-Interaktions-Endpunkt (Edge Runtime)
 * -----------------------------------------------------
 * Empfängt die Button-Klicks aus den Bestell-Tickets
 * („Bestellung schließen“) direkt von Discord.
 *
 * URL: https://<seite>/discord/interactions
 * (per Rewrite auf diese Funktion gelenkt, siehe vercel.json)
 *
 * Warum Edge? Discord signiert jede Anfrage (Ed25519) – dafür brauchen
 * wir den unveränderten Request-Body, den nur die Edge-Runtime liefert.
 *
 * Ablauf:
 *  - PING (type 1)  -> PONG (für die Registrierung im Developer-Portal)
 *  - Button „shred_close_order“:
 *      nur Rollen Paxy/Oxkar dürfen -> Kanal wird gelöscht
 *      alle anderen -> kurze Ablehnung (nur für den Klicker sichtbar)
 */

export const config = { runtime: 'edge' };

import nacl from '../lib/vendor/nacl-fast.js';

const API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1571213152681463938';
const STAFF_ROLE_NAMES = (process.env.DISCORD_STAFF_ROLES || 'Paxy,Oxkar')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const PUBLIC_KEY_OVERRIDE = process.env.DISCORD_PUBLIC_KEY || '';

const CLOSE_BUTTON_ID = 'shred_close_order';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Bricht das Warten auf ein Promise nach ms Millisekunden ab */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/* Public Key der Applikation (für die Signaturprüfung) */
let verifyKeyCache = null;

async function getVerifyKey() {
  if (PUBLIC_KEY_OVERRIDE) return PUBLIC_KEY_OVERRIDE;
  if (verifyKeyCache) return verifyKeyCache;

  const res = await fetch(API_BASE + '/applications/@me', {
    headers: { Authorization: 'Bot ' + BOT_TOKEN },
  });
  if (!res.ok) throw new Error('applications/@me: ' + res.status);

  const app = await res.json();
  if (!app || !app.verify_key) throw new Error('verify_key fehlt');

  verifyKeyCache = app.verify_key;
  return verifyKeyCache;
}

/* Staff-Rollen-IDs (kleiner Cache pro Instanz) */
let staffRoleIdsCache = null;

async function getStaffRoleIds() {
  if (staffRoleIdsCache) return staffRoleIdsCache;

  const res = await fetch(API_BASE + '/guilds/' + GUILD_ID + '/roles', {
    headers: { Authorization: 'Bot ' + BOT_TOKEN },
  });
  if (!res.ok) throw new Error('roles: ' + res.status);

  const roles = await res.json();
  staffRoleIdsCache = (Array.isArray(roles) ? roles : [])
    .filter((role) => STAFF_ROLE_NAMES.includes(String(role.name).toLowerCase()))
    .map((role) => role.id);
  return staffRoleIdsCache;
}

export default async function handler(request) {
  /* Info-Antwort für Browser (damit man die URL prüfen kann) */
  if (request.method !== 'POST') {
    return json({
      ok: true,
      endpoint: 'discord-interactions',
      hint: 'Dieser Endpunkt ist für Discord-Interaktionen (POST von Discord).',
    });
  }

  const signature = request.headers.get('x-signature-ed25519') || '';
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  const rawBody = await request.text();

  if (!signature || !timestamp || !rawBody) {
    return json({ error: 'Ungültige Anfrage' }, 401);
  }

  /* Signatur prüfen (Discord signiert timestamp + body) */
  let publicKey;
  try {
    publicKey = await getVerifyKey();
  } catch (err) {
    return json({ error: 'Bot nicht erreichbar' }, 500);
  }

  let verified = false;
  try {
    verified = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + rawBody),
      hexToBytes(signature),
      hexToBytes(publicKey)
    );
  } catch (err) {
    verified = false;
  }

  if (!verified) {
    return json({ error: 'Ungültige Signatur' }, 401);
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (err) {
    return json({ error: 'Ungültiges JSON' }, 400);
  }

  /* PING – schickt Discord bei der Registrierung der URL */
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  /* Button-Klick */
  if (interaction.type === 3) {
    const customId = interaction.data && interaction.data.custom_id;

    if (customId !== CLOSE_BUTTON_ID) {
      return json({
        type: 4,
        data: { content: '❌ Unbekannte Aktion.', flags: 64 },
      });
    }

    const member = interaction.member || {};
    const userRoles = Array.isArray(member.roles) ? member.roles : [];

    /* Server-Administratoren (Permission-Bit 3) dürfen immer */
    let isAdmin = false;
    try {
      isAdmin = (BigInt(member.permissions || '0') & (1n << 3n)) !== 0n;
    } catch (err) {
      isAdmin = false;
    }

    let staffRoleIds = [];
    try {
      staffRoleIds = await getStaffRoleIds();
    } catch (err) {
      /* ohne Rollen-Info lieber niemanden lassen */
    }

    const isStaff =
      isAdmin || userRoles.some((id) => staffRoleIds.includes(String(id)));

    if (!isStaff) {
      return json({
        type: 4,
        data: {
          content: '❌ Du darfst dieses Ticket nicht schließen.',
          flags: 64, // nur für den Klicker sichtbar
        },
      });
    }

    /* Kanal löschen – mit Zeitlimit, damit wir Discord sicher
       rechtzeitig antworten (Interaktionen müssen in 3 s beantwortet werden) */
    const channelId = interaction.channel_id;
    if (channelId && BOT_TOKEN) {
      try {
        await withTimeout(
          fetch(API_BASE + '/channels/' + channelId, {
            method: 'DELETE',
            headers: { Authorization: 'Bot ' + BOT_TOKEN },
          }),
          2000
        );
      } catch (err) {
        /* Kanal ist dann weg oder schon weg – ok */
      }
    }

    /* Bestätigung ohne sichtbare Nachricht – der Kanal verschwindet
       sichtbar als Feedback. (Das Aufräumen der Tracking-Liste
       übernimmt der tägliche Cleanup-Job.) */
    return json({ type: 6 });
  }

  return json({
    type: 4,
    data: { content: 'Unbekannter Interaktionstyp.', flags: 64 },
  });
}
