/**
 * SHRED. – Discord-Integration (Ticketsystem für Bestellungen)
 * ------------------------------------------------------------
 * Pro Bestellung wird automatisch ein privater Kanal in der
 * Kategorie "Bestellungen" angelegt:
 *
 *   - sichtbar nur für die Staff-Rollen (Standard: Paxy, Oxkar),
 *     den Besteller und den Bot selbst
 *   - die Bestellliste wird gepostet und der Besteller angepingt
 *
 * Alles läuft rein über die Discord-REST-API (kein Gateway nötig).
 *
 * Umgebungsvariablen:
 *   DISCORD_BOT_TOKEN   Bot-Token (Pflicht für Tickets)
 *   DISCORD_GUILD_ID    Server-ID   (Standard: SHRED.-Server)
 *   DISCORD_STAFF_ROLES Rollen, die Tickets sehen (Standard: Paxy,Oxkar)
 *   DISCORD_CATEGORY    Kategorie-Name (Standard: Bestellungen)
 *   DISCORD_WEBHOOK_URL Webhook für den Fallback (normale Nachricht)
 *   DISCORD_API_BASE    nur für Tests (lokaler Mock-Server)
 */

'use strict';

const API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '1571213152681463938';
const STAFF_ROLES = (process.env.DISCORD_STAFF_ROLES || 'Paxy,Oxkar')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const CATEGORY_NAME = (process.env.DISCORD_CATEGORY || 'Bestellungen').toLowerCase();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/* Discord-Permission-Bits */
const VIEW_CHANNEL = 1 << 10; // 1024
const SEND_MESSAGES = 1 << 11; // 2048

/* ------------------------------------------------------------
   REST-Hilfen
   ------------------------------------------------------------ */

async function discordFetch(path, options = {}) {
  return fetch(API_BASE + path, {
    ...options,
    headers: {
      Authorization: 'Bot ' + BOT_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function discordJson(path, options = {}) {
  const res = await discordFetch(path, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('Discord ' + res.status + ': ' + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

let botUserCache = null;

async function getBotUser() {
  if (botUserCache) return botUserCache;
  botUserCache = await discordJson('/users/@me');
  return botUserCache;
}

async function getGuildRoles() {
  return discordJson('/guilds/' + GUILD_ID + '/roles');
}

async function getGuildChannels() {
  return discordJson('/guilds/' + GUILD_ID + '/channels');
}

/* ------------------------------------------------------------
   Besteller anhand des Discord-Namens finden
   ------------------------------------------------------------ */

async function findMemberByName(name) {
  const query = String(name || '').trim();
  if (!query) return null;

  const res = await discordFetch(
    '/guilds/' + GUILD_ID + '/members/search?query=' +
      encodeURIComponent(query) +
      '&limit=10'
  );

  if (res.status === 403) {
    const err = new Error('Server-Members-Intent fehlt');
    err.code = 'intent_missing';
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Discord ' + res.status);
    err.status = res.status;
    throw err;
  }

  const members = await res.json();
  if (!Array.isArray(members) || members.length === 0) return null;

  const wanted = query.toLowerCase();
  const norm = (value) => String(value || '').trim().toLowerCase();

  /* Möglichst exakt treffen, damit niemand Falsches angepingt wird */
  return (
    members.find((m) => norm(m.user && m.user.username) === wanted) ||
    members.find((m) => norm(m.user && m.user.global_name) === wanted) ||
    members.find((m) => norm(m.nick) === wanted) ||
    (members.length === 1 ? members[0] : null)
  );
}

/* ------------------------------------------------------------
   Ticket-Kanal anlegen und Bestellung posten
   ------------------------------------------------------------ */

function buildChannelName(username) {
  const base = ('bestellung-' + String(username || 'kunde'))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'bestellung';
}

/**
 * Legt einen privaten Bestell-Kanal an und postet die Bestellung.
 * Liefert { channelId, channelUrl, channelName } zurück.
 * Wirft Fehler mit err.code: 'no_bot' | 'intent_missing' | 'member_not_found'
 */
async function createOrderTicket({ customerName, items }) {
  if (!BOT_TOKEN) {
    const err = new Error('Kein Bot-Token konfiguriert');
    err.code = 'no_bot';
    throw err;
  }

  const member = await findMemberByName(customerName);
  if (!member || !member.user || !member.user.id) {
    const err = new Error('Discord-Name nicht gefunden');
    err.code = 'member_not_found';
    throw err;
  }

  const username = member.user.username || 'kunde';
  const displayName =
    member.nick || member.user.global_name || username;

  const [roles, channels, botUser] = await Promise.all([
    getGuildRoles(),
    getGuildChannels(),
    getBotUser(),
  ]);

  /* Staff-Rollen nach Name suchen (Groß/Klein egal) */
  const staffRoleIds = STAFF_ROLES.map((roleName) =>
    roles.find((r) => String(r.name).toLowerCase() === roleName.toLowerCase())
  )
    .filter(Boolean)
    .map((r) => r.id);

  /* Kategorie "Bestellungen" suchen oder anlegen */
  let category = channels.find(
    (c) => c.type === 4 && String(c.name).toLowerCase() === CATEGORY_NAME
  );

  if (!category) {
    category = await discordJson('/guilds/' + GUILD_ID + '/channels', {
      method: 'POST',
      body: JSON.stringify({ name: CATEGORY_NAME, type: 4 }),
    });
  }

  /* Kanalname frei? -> sonst -2, -3 … anhängen */
  const existingNames = new Set(
    channels.map((c) => String(c.name).toLowerCase())
  );
  const baseName = buildChannelName(username);
  let channelName = baseName;
  let suffix = 2;
  while (existingNames.has(channelName)) {
    channelName = baseName + '-' + suffix;
    suffix += 1;
  }

  /* Sichtbarkeit: niemand – außer Staff-Rollen, Bot und Besteller */
  const overwrites = [
    { id: GUILD_ID, type: 0, deny: VIEW_CHANNEL },
    ...staffRoleIds.map((id) => ({
      id,
      type: 0,
      allow: VIEW_CHANNEL | SEND_MESSAGES,
    })),
    { id: botUser.id, type: 1, allow: VIEW_CHANNEL | SEND_MESSAGES },
    { id: member.user.id, type: 1, allow: VIEW_CHANNEL | SEND_MESSAGES },
  ];

  const channel = await discordJson('/guilds/' + GUILD_ID + '/channels', {
    method: 'POST',
    body: JSON.stringify({
      name: channelName,
      type: 0, // Textkanal
      parent_id: category.id,
      permission_overwrites: overwrites,
    }),
  });

  /* Bestellliste posten und Besteller anpingen */
  const list = items
    .map((item) => '**' + item.quantity + ' ×** ' + item.name)
    .join('\n');

  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });

  await discordJson('/channels/' + channel.id + '/messages', {
    method: 'POST',
    body: JSON.stringify({
      content: '<@' + member.user.id + '> 🎫 Deine Bestellung ist eingegangen!',
      embeds: [
        {
          title: '🎫 Neue Bestellung von ' + displayName,
          description: (
            '**Besteller:** ' + displayName + ' (@' + username + ')\n\n' + list
          ).slice(0, 4000),
          color: 0x9aa7ff,
          footer: { text: 'SHRED. Shop • ' + time },
        },
      ],
    }),
  });

  return {
    channelId: channel.id,
    channelName: channel.name || channelName,
    channelUrl:
      'https://discord.com/channels/' + GUILD_ID + '/' + channel.id,
  };
}

/* ------------------------------------------------------------
   Fallback: Bestellung per Webhook in den Kanal posten
   ------------------------------------------------------------ */

function isDiscordWebhookUrl(url) {
  if (typeof url !== 'string') return false;
  if (
    url.startsWith('https://discord.com/api/webhooks/') ||
    url.startsWith('https://discordapp.com/api/webhooks/')
  ) {
    return true;
  }
  // Für lokale Tests: lokaler Webhook-Server erlaubt (nicht in Production)
  if (
    process.env.NODE_ENV !== 'production' &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)
  ) {
    return true;
  }
  return false;
}

async function sendOrderViaWebhook(items) {
  if (!isDiscordWebhookUrl(WEBHOOK_URL)) {
    throw new Error('Ungültige oder fehlende Webhook-URL');
  }

  const list = items
    .map((item) => '**' + item.quantity + ' ×** ' + item.name)
    .join('\n');

  const time = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });

  const payload = {
    username: 'SHRED. Shop',
    embeds: [
      {
        title: '🛒 Neue Bestellung',
        description: list.slice(0, 4000),
        color: 0x9aa7ff,
        footer: { text: 'SHRED. Shop • ' + time },
      },
    ],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Discord ' + res.status + ': ' + text.slice(0, 200));
  }
}

/** Kanal-Link zum Webhook (für die Weiterleitung beim Fallback) */
function webhookChannelUrl() {
  const match = WEBHOOK_URL.match(/\/api\/webhooks\/(\d+)/);
  if (!match) return null;
  return 'https://discord.com/channels/' + GUILD_ID + '/' + match[1];
}

/* ------------------------------------------------------------
   Status-Diagnose (für Einrichtung & Fehlersuche)
   ------------------------------------------------------------ */

let statusCache = { at: 0, data: null };

async function discordStatus(withTest) {
  const now = Date.now();
  if (!withTest && statusCache.data && now - statusCache.at < 30000) {
    return statusCache.data;
  }

  const out = {
    botTokenConfigured: Boolean(BOT_TOKEN),
    webhookConfigured: Boolean(WEBHOOK_URL),
    guildId: GUILD_ID,
    staffRoles: [],
    category: null,
    membersSearch: null,
    ticketTest: null,
  };

  if (!BOT_TOKEN) {
    out.error = 'DISCORD_BOT_TOKEN ist nicht gesetzt.';
    return out;
  }

  let botUser = null;
  try {
    botUser = await getBotUser();
    out.botOk = true;
    out.botUser = botUser.username + ' (' + botUser.id + ')';
  } catch (err) {
    out.botOk = false;
    out.error = 'Bot-Token ungültig: ' + err.message;
    return out;
  }

  try {
    const roles = await getGuildRoles();
    out.rolesAvailable = Array.isArray(roles) ? roles.length : null;
    out.staffRoles = STAFF_ROLES.map((roleName) => {
      const role = roles.find(
        (r) => String(r.name).toLowerCase() === roleName.toLowerCase()
      );
      return { name: roleName, found: Boolean(role), id: role ? role.id : null };
    });
  } catch (err) {
    out.rolesAvailable = null;
    out.error =
      'Rollen nicht abrufbar – ist der Bot auf dem Server eingeladen? (' +
      err.message + ')';
  }

  try {
    const channels = await getGuildChannels();
    const category = channels.find(
      (c) => c.type === 4 && String(c.name).toLowerCase() === CATEGORY_NAME
    );
    out.category = category
      ? { name: category.name, id: category.id, exists: true }
      : {
          name: CATEGORY_NAME,
          exists: false,
          note: 'wird beim ersten Auftrag automatisch erstellt',
        };
  } catch (err) {
    out.category = null;
  }

  try {
    const res = await discordFetch(
      '/guilds/' + GUILD_ID + '/members/search?query=a&limit=1'
    );
    out.membersSearch = res.ok
      ? 'ok'
      : 'fehlgeschlagen (' + res.status + ') – Server-Members-Intent aktivieren!';
  } catch (err) {
    out.membersSearch = 'fehlgeschlagen: ' + err.message;
  }

  if (withTest) {
    try {
      const ticket = await createOrderTicket({
        customerName: botUser.username,
        items: [{ name: 'Setup-Test (kann ignoriert werden)', quantity: 1 }],
      });
      out.ticketTest = 'ok – Kanal "' + ticket.channelName + '" erstellt';
    } catch (err) {
      out.ticketTest =
        'fehlgeschlagen: ' + err.message + (err.code ? ' (' + err.code + ')' : '');
    }
  }

  statusCache = { at: now, data: out };
  return out;
}

module.exports = {
  GUILD_ID,
  STAFF_ROLES,
  CATEGORY_NAME,
  createOrderTicket,
  sendOrderViaWebhook,
  webhookChannelUrl,
  discordStatus,
};
