# SHRED.

Website mit Admin-Menü: Texte lassen sich direkt im Browser bearbeiten und werden
online für **alle** Besucher gespeichert.

## Starten

```bash
npm start          # http://localhost:3000
```

Es wird kein `npm install` benötigt (keine Abhängigkeiten).

## Admin-Bereich

- **Admin-Button** (Logo oben rechts) drücken → Passwort-Fenster
- Passwort eingeben → Bearbeitungs-Panel öffnet sich
- Erneut auf den Button drücken → das, was gerade offen ist, wird geschlossen
  (Passwort-Fenster **oder** Panel)
- Panel schließen geht auch mit `✕`, `Esc` oder `Strg/Cmd + Shift + A`

### Passwort ändern

In `server.js` ganz oben:

```js
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'shred-admin';
```

Entweder den String ersetzen oder beim Start setzen:

```bash
ADMIN_PASSWORD=meinGeheimesPasswort npm start
```

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
- „Speichern“ schickt die Änderungen an den Server → `data/content.json`.
- Alle Besucher laden diese Texte beim Aufruf der Seite (`GET /api/content`).
  Zusätzlich wird alle 30 s aktualisiert.
- „Alles zurücksetzen“ stellt die Originaltexte aus der HTML-Datei wieder her
  (leerer Text = Standardtext).

## API

| Methode | Pfad           | Beschreibung                          |
| ------- | -------------- | ------------------------------------- |
| GET     | `/api/content` | Gespeicherte Texte (öffentlich)       |
| POST    | `/api/login`   | `{ password }` → `{ token }`          |
| GET     | `/api/session` | Login mit `X-Admin-Token` prüfen      |
| POST    | `/api/content` | `{ token, updates, deletes }` speichern |
| POST    | `/api/logout`  | Token ungültig machen                 |

## Online hosten

Der Server ist ein normaler Node-Prozess – läuft z. B. auf **Render**, **Railway**,
**Fly.io** oder einem eigenen Server.

- Startbefehl: `npm start`
- Port wird über `PORT` gesetzt (wird automatisch erkannt)
- **Wichtig:** Auf Hostern mit flüchtigem Dateisystem (z. B. Render Free) gehen
  `data/content.json` bei einem Neustart verloren. Dann entweder ein persistentes
  Volume einbinden und `DATA_DIR` auf diesen Pfad setzen:

  ```bash
  DATA_DIR=/var/data npm start
  ```

  …oder die Datei regelmäßig sichern.
- Passwort immer über `ADMIN_PASSWORD` setzen, nicht im Code lassen.
