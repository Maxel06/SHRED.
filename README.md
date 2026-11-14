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
| `vercel.json` | Rewrite `/api/*` → Function, `data/` & `server.js` nicht ausliefern |
| `api/index.js` | Serverless-Einstiegspunkt |
| `lib/api.js` | alle API-Routen (auch lokal genutzt) |
| `lib/auth.js` | Passwortprüfung + signierte Tokens |
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
