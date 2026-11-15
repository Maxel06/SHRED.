# SHRED.

Website mit Admin-Menü: Texte lassen sich direkt im Browser bearbeiten und werden
online für **alle** Besucher gespeichert.

Unterstützt zwei Betriebsarten mit demselben Code:

| | Lokal / Render / Railway | Vercel |
| --- | --- | --- |
| Server | `server.js` (eigener Node-Prozess) | `api/index.js` (Serverless Function) |
| Speicher | `data/content.json` | **Upstash Redis / Vercel KV** |
| Login | signierte Tokens | signierte Tokens (stateless – nötig für mehrere Instanzen) |

---

## Shop-Seite (index.html im Hauptordner)

Die Startseite (Produkte, Footer-Text, Warenkorb) hat ihr eigenes Staff-Menü:
einfach auf das **SHRED.-Logo oben links** klicken.

- **Login** läuft über den Server (`/api/login`) – es gilt dasselbe Passwort wie
  im Admin-Bereich (`ADMIN_PASSWORD`, Standard `shred-admin`).
- **Änderungen speichern** schreibt den Footer-Text und alle Produkte
  (inkl. Produktbildern) in den Online-Speicher – sie sind sofort für
  **alle Besucher** sichtbar.
- Produktbilder werden im Browser automatisch verkleinert und komprimiert
  (max. 1000 Pixel, ~450 KB) und unter dem Schlüssel `shopImage:<id>` gespeichert;
  die Shop-Daten liegen als JSON unter `shopData`.
- Besucher sehen Änderungen automatisch (die Seite prüft alle 30 Sekunden),
  ohne sie neu laden zu müssen.
- Ist der Server nicht erreichbar (z. B. Datei direkt geöffnet), greift ein
  Offline-Modus: Änderungen werden dann nur lokal im Browser gespeichert
  (altes Verhalten, Passwort `67`).

### Bestellungen an Discord (Ticketsystem)

Klickt ein Kunde auf **Zur Kasse gehen**, gibt er bei der Bestellübersicht
seinen **Discord-Namen** ein (Pflichtfeld, mit Anleitung und Server-Link).
Beim Abschicken passiert Folgendes:

1. Der Bot sucht den Kunden anhand des Namens auf dem Discord-Server –
   **Anzeigename und Benutzername funktionieren** (auch Server-Spitzname).
   Findet die Discord-Suche nichts Genaues, wird zusätzlich die komplette
   Member-Liste durchsucht. Bei mehrdeutigen Namen wird niemand angepingt.
2. Der Bot legt einen **privaten Kanal** in der Kategorie **Bestellungen** an,
   z. B. `bestellung-maxel06`
3. Der Kanal ist nur sichtbar für die Rollen **Paxy** und **Oxkar**, den
   Bot und den **Kunden** (@everyone ist ausgesperrt)
4. Die Bestellliste wird im Kanal gepostet, der Kunde angepingt – mit dem
   Hinweis *„Wir bearbeiten deine Bestellung und melden uns bei dir. Wenn du
   7 Tage nicht antwortest, wird dieses Ticket automatisch geschlossen."*
   und einem roten **„Bestellung schließen“-Button**
5. Der Kunde wird direkt zu seinem Bestell-Ticket weitergeleitet

**„Bestellung schließen“-Button:** Drücken dürfen nur die Staff-Rollen
(Standard: Paxy & Oxkar) und Server-Administratoren – der Kanal wird sofort
**gelöscht**. Alle anderen (z. B. der Kunde selbst) sehen nur eine kurze
Ablehnung. Die Prüfung läuft in `api/interactions.mjs` (Edge Function) mit
Signaturprüfung von Discord.

**Auto-Close nach 7 Tagen:** Einmal täglich (04:00 Uhr UTC) prüft ein
Vercel-Cron alle Tickets: Hat der **Kunde** als Letztes geschrieben, wartet
das Team – das Ticket bleibt offen. Ist die letzte Nachricht von Team/Bot
und älter als 7 Tage (ohne Kundenantwort), wird der Kanal automatisch
gelöscht. Jede Antwort des Kunden startet die Frist neu.

**Einrichtung (Umgebungsvariablen in Vercel):**

| Variable | Bedeutung |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Token des Discord-Bots (Pflicht) |
| `DISCORD_GUILD_ID` | Server-ID (Standard: SHRED.-Server) |
| `DISCORD_STAFF_ROLES` | Rollen, die Tickets sehen & schließen dürfen (Standard: `Paxy,Oxkar`) |
| `DISCORD_CATEGORY` | Kategorie-Name (Standard: `Bestellungen`) |
| `DISCORD_WEBHOOK_URL` | Fallback, falls der Bot nicht kann |
| `CRON_SECRET` | schützt den Auto-Close-Cron (Pflicht, damit der Cron läuft) |
| `DISCORD_PUBLIC_KEY` | optional: Public Key der Discord-Applikation (wird sonst automatisch über den Bot-Token geladen) |

Zusätzlich einmalig im **Discord Developer Portal** eintragen
(*General Information → Interactions Endpoint URL*):

```
https://<deine-domain>/api/interactions
```

Discord schickt beim Speichern einen PING, der automatisch beantwortet wird.
Der Public Key für die Signaturprüfung wird über den Bot-Token von
`/applications/@me` geladen – eintragen muss man ihn nicht.

Der Bot braucht die Rechte *Kanäle verwalten*, *Rollen verwalten*,
*Kanäle ansehen*, *Nachrichten senden* – und seine Rolle muss in der
Server-Rollenliste **über** den Staff-Rollen stehen, sonst darf er deren
Zugriff nicht setzen. Außerdem muss im Developer-Portal der
**Server Members Intent** aktiviert sein (für die Namenssuche).

**Diagnose:** `GET /api/discord/status` prüft die Einrichtung,
`GET /api/discord/status?test=1` legt zusätzlich ein Test-Ticket an.

**Auto-Close manuell testen:** `GET /api/cron/close-tickets?secret=<CRON_SECRET>`
(ohne `/dryRun=1` wird wirklich gelöscht). Vercel ruft die Route täglich
automatisch auf.

**Fallback:** Schlägt das Ticket fehl (z. B. Name nicht gefunden → 404 mit
Hinweis), bleibt der Warenkorb erhalten; bei Bot-Problemen wird die
Bestellung notfalls als normale Nachricht über den Webhook gepostet.

---

## 1. Lokal starten

```bash
npm start          # http://localhost:3000
```

Kein `npm install` nötig (keine Abhängigkeiten).

## 2. Admin-Bereich

- **Admin-Button** (Logo oben rechts) drücken → Passwort-Fenster
- Passwort eingeben → Bearbeitungs-Panel öffnet sich
- Erneut auf den Button drücken → das, was gerade offen ist, wird geschlossen
  (Passwort-Fenster **oder** Panel)
- Panel schließen geht auch mit `✕`, `Esc` oder `Strg/Cmd + Shift + A`

### Passwort

Standard: **`shred-admin`**

Ändern über die Umgebungsvariable `ADMIN_PASSWORD` (empfohlen), lokal:

```bash
ADMIN_PASSWORD=meinGeheimesPasswort npm start
```

Auf Vercel: *Project → Settings → Environment Variables → `ADMIN_PASSWORD`*.
Ohne Variable gilt der Standardwert aus `lib/auth.js`.

Tippfehler werden verziehen: Leerzeichen davor/danach und Groß-/Kleinschreibung
werden ignoriert.

### Welche Elemente sind bearbeitbar?

Ganz oben im `<script>` in `index.html`:

```js
var ADMIN_CONFIG = {
    // LEER = alle Textelemente der Seite sind bearbeitbar
    editableClasses: [],

    // Oder nur bestimmte Klassen:
    // editableClasses: ["editierbar", "preis", "titel"],
    ...
};
```

Beispiel: nur Elemente mit der Klasse `editierbar` sollen bearbeitbar sein:

```html
<h1 class="editierbar">Alles auf Lager</h1>
<p class="editierbar">Neuer Text…</p>
```

Einzelne Elemente ausnehmen: `data-no-edit` Attribut setzen.

Dauerhaft stabile Zuordnung (empfohlen, wenn sich die Seitenstruktur ändert):

```html
<h1 data-edit-id="titel">Alles auf Lager</h1>
```

### Wie es funktioniert

- Jedes bearbeitbare Element bekommt einen stabilen Schlüssel aus seiner Position
  im DOM (z. B. `div[1]/h1[1]`) oder aus `data-edit-id`.
- Beim Tippen ändert sich der Text sofort auf der Seite.
- „Speichern“ schickt die Änderungen an die API (`POST /api/content`).
- Alle Besucher laden diese Texte beim Aufruf der Seite (`GET /api/content`),
  zusätzlich alle 30 s automatisch.
- „Alles zurücksetzen“ stellt die Originaltexte aus der HTML-Datei wieder her
  (leerer Text = Standardtext).

---

## 3. Auf Vercel deployen

### Schritt 1 – Upstash Redis verbinden

Vercel → Projekt → **Storage** → **Upstash Redis** (Free) → *Connect*.

Dabei entstehen automatisch die Variablen `KV_REST_API_URL` und
`KV_REST_API_TOKEN`. Der Code erkennt auch `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`, falls du Upstash direkt nutzt.

> Warum überhaupt eine Datenbank? Vercel hat kein dauerhaft beschreibbares
> Dateisystem. `/tmp` wird bei jedem Kaltstart geleert – Änderungen wären also
> nach wenigen Minuten weg.

### Schritt 2 – Passwort setzen (optional)

Settings → Environment Variables → `ADMIN_PASSWORD` = dein Passwort.
Ohne Eintrag gilt `shred-admin`.

### Schritt 3 – Deployen

Einfach nach `main` pushen – Vercel baut automatisch. Oder:
`vercel --prod`.

### Dateien, die Vercel benutzt

| Datei | Zweck |
| --- | --- |
| `index.html` (+ Bilder) | statische Seite |
| `vercel.json` | Rewrite `/api/*` → Function, Cron-Job, `data/` & `server.js` nicht ausliefern |
| `api/index.js` | Serverless-Einstiegspunkt |
| `api/interactions.mjs` | Edge Function: Discord-Button (Signaturprüfung, Staff-Check) |
| `lib/api.js` | alle API-Routen (auch lokal genutzt) |
| `lib/auth.js` | Passwortprüfung + signierte Tokens |
| `lib/discord.js` | Discord-Ticketsystem (Namenssuche, Tickets, Auto-Close) |
| `lib/vendor/nacl-fast.js` | tweetnacl (Ed25519-Verifikation für Discord-Interaktionen) |
| `lib/store.js` | Upstash Redis **oder** JSON-Datei |

### Deployment Protection

Falls `*.vercel.app` nach einem Passwort/Login fragt („Vercel Authentication“),
ist das die Vercel-**Deployment Protection**, nicht der Admin-Login:
Project → Settings → Deployment Protection → *Vercel Authentication* deaktivieren,
sonst erreichen Besucher die Seite nicht.

---

## 4. Auf Render / Railway / eigenem Server

Der Node-Prozess läuft dort unverändert:

- Start Command: `npm start`
- Port kommt über `PORT`
- Für dauerhafte Speicherung **eine** von zwei Varianten:
  - **Persistent Disk** auf `/var/data` mounten und `DATA_DIR=/var/data` setzen
  - oder dieselben Upstash-Variablen wie bei Vercel setzen (dann liegt alles in Redis)
- `ADMIN_PASSWORD` als Environment Variable setzen

---

## API

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET | `/api/content` | Gespeicherte Texte (öffentlich) |
| POST | `/api/login` | `{ password }` → `{ token }` |
| GET | `/api/session` | Login mit `X-Admin-Token` prüfen |
| POST | `/api/content` | `{ token, updates, deletes }` speichern |
| POST | `/api/logout` | Abmelden (Token liegt im Client) |
| GET | `/api/health` | Healthcheck |
| POST | `/api/order` | `{ items, customer }` → Ticket anlegen (Discord) |
| GET | `/api/discord/status` | Discord-Einrichtung prüfen (`?test=1` = Test-Ticket) |
| GET | `/api/cron/close-tickets` | Auto-Close (nur mit `CRON_SECRET`, `&dryRun=1` möglich) |
| POST | `/api/interactions` | Discord-Interaktionen (Edge, signiert – von Discord aufgerufen) |

Tokens sind mit HMAC-SHA256 signiert und 12 Stunden gültig. Das Secret kommt aus
`ADMIN_SECRET`; ohne diese Variable wird es vom Passwort abgeleitet. Änderst du
das Passwort, werden alte Logins automatisch ungültig.

## Umgebungsvariablen

| Variable | Zweck |
| --- | --- |
| `ADMIN_PASSWORD` | Admin-Passwort (Standard `shred-admin`) |
| `ADMIN_SECRET` | optional: eigenes Secret für Token-Signatur |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV / Upstash |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash direkt |
| `CONTENT_KEY` | optional: Redis-Key (Standard `shred:content`) |
| `DATA_DIR` | optional: Ordner für `content.json` (nur Datei-Modus) |
| `PORT` | Port des lokalen Servers (Standard 3000) |
| `DISCORD_BOT_TOKEN` | Discord-Bot (Ticketsystem) |
| `DISCORD_PUBLIC_KEY` | optional: Public Key der Discord-Applikation (sonst automatisch) |
| `CRON_SECRET` | schützt `/api/cron/close-tickets` (Vercel-Cron sendet ihn mit) |
| `DISCORD_API_BASE` | nur für Tests: lokale Fake-Discord-API |
