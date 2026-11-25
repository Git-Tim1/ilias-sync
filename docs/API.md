# API-Vertrag (Backend ↔ Oberfläche)

Dieser Vertrag ist verbindlich für Backend (`src/ilias_sync/server.py`) und
Oberfläche (`src/ilias_sync/web/`). Änderungen nur in Absprache mit dem
Orchestrator. Alle Antworten sind JSON (UTF-8), Zeitstempel ISO-8601 mit
Zeitzone (`2026-11-25T19:27:53+01:00`). Fehler: HTTP 4xx/5xx mit
`{"error": "<code>", "message": "<deutscher Text>"}`.

Server: `127.0.0.1`, Standardport `8765`, nur lokal. Die Oberfläche wird unter
`/` als statische Dateien ausgeliefert (`index.html`, `app.js`, `styles.css`,
weitere Dateien unter `/static/...` bzw. relativ). Kein Build-Schritt.

Python-Einstiegspunkte (vom Desktop-Launcher genutzt):

```python
from ilias_sync.server import create_app, run
app = create_app()             # FastAPI-Instanz
run(host="127.0.0.1", port=8765, open_browser=False)  # blockierend (uvicorn)
```

## Datentypen

```jsonc
// RunReport – ein Sync-Lauf
{
  "run_id": "20261125-192753",
  "trigger": "manual" | "schedule" | "cli",
  "started_at": "…", "finished_at": "…" | null,
  "result": "running" | "success" | "errors" | "session_expired" | "offline" | "failed" | "cancelled",
  "message": "",                       // deutscher Klartext bei Problemen
  "dry_run": false,
  "semester": "WS26/27" | null,
  "totals": {"found": 26, "downloaded": 1, "skipped": 20, "errors": 0},
  "courses": [CourseReport],
  "progress": {"courses_done": 1, "courses_total": 3, "current_course": "Softwaretechnik"} | null,
  "new_files": [FileEntry]
}

// CourseReport
{ "name": "[WS26/27] Softwaretechnik", "short_name": "Softwaretechnik",
  "url": "https://…/goto.php/crs/123", "found": 26, "downloaded": 1,
  "skipped": 20, "errors": 0, "error_message": null }

// FileEntry
{ "path": "/abs/pfad/datei.pdf", "name": "datei.pdf",
  "course": "Softwaretechnik", "folder": "Lecture-Slides",
  "size": 123456, "downloaded_at": "…" }
```

`progress` enthält die Zahl abgeschlossener Kurse, die Gesamtzahl im Kursplan
und den Kurznamen des aktuell bearbeiteten Kurses (`null` zwischen Kursen).
Vor der Kurssuche steht `progress` auf `null`. Frühere Berichte können das
Feld auslassen. Der Verlauf behält die letzten 500 Läufe.

## Endpunkte

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/status` | `{"running": bool, "current": RunReport\|null, "last_run": RunReport\|null, "session": {"state": "valid"\|"expired"\|"unknown", "checked_at": "…"\|null}, "credentials_configured": bool, "setup": {"completed": bool, "required": bool}, "schedule": Schedule, "version": "0.2.2"}` |
| POST | `/api/sync` | Body `SyncOptions` (alle Felder optional) → `202 {"run_id": "…"}`; `409 {"error":"already_running"}`; `422 {"error":"invalid_sync_options","fields":{…}}` |
| POST | `/api/sync/cancel` | Laufenden Sync abbrechen → `200 {"cancelled": true}` |
| GET | `/api/runs?limit=20` | Verlauf, neuester zuerst → `[RunReport]` |
| GET | `/api/files/recent?limit=50` | Zuletzt geladene Dateien über alle Läufe → `[FileEntry]` |
| POST | `/api/files/open` | Body `{"path": "…"}` → öffnet Datei mit Standard-App. Nur Pfade innerhalb der Download-Ordner, sonst `403`. |
| POST | `/api/files/reveal` | wie oben, zeigt Datei im Finder/Explorer |
| POST | `/api/folders/open` | Body `{"which": "download" \| "local"}` → öffnet Ordner |
| GET | `/api/logs?lines=200` | `{"lines": ["…"]}` |
| GET | `/api/events` | Server-Sent Events. Events: `log` (`{"line": "…"}`), `status` (gleiche Form wie `/api/status`), `run_finished` (RunReport). Heartbeat-Kommentar alle 15 s. |
| GET | `/api/config` | Konfiguration → `Config` (siehe unten) |
| GET | `/api/config/defaults` | Standardwerte → `Config` (ohne gespeicherte Änderungen) |
| GET | `/api/config/yaml` | Wirksame Konfiguration als YAML (wie `ilias-sync config show`) → `{"path": "…", "exists": bool, "yaml": "…"}` |
| GET | `/api/paths` | Speicherorte (wie `ilias-sync config path`) → `{"config": {"path","exists"}, "data": {…}, "logs": {…}}` |
| POST | `/api/paths/reveal` | Body `{"which": "config" \| "data" \| "logs"}` → zeigt die Config-Datei im Finder bzw. öffnet den Ordner (legt ihn bei Bedarf an) |
| GET | `/api/setup/suggestions` | `{"download_dirs": [{"id","label","description","path","kind": "local"\|"cloud","exists"}], "defaults": Config}` – erster Eintrag ist immer `documents` |
| POST | `/api/setup/complete` | Einrichtung abschließen (legt bei Bedarf die Config-Datei an) → `{"completed": true, "required": false}`. Ohne gespeicherte Zugangsdaten `409` mit `error: "credentials_missing"`, bei nicht erreichbarem Schlüsselbund `500` mit `error: "keyring_unavailable"`. |
| POST | `/api/setup/reset` | Einrichtung erneut anbieten → `{"completed": false, "required": bool}` |
| PUT | `/api/config` | Teil-Update von `Config`; validiert; `422` mit `{"error":"invalid_config","message":…,"fields":{"feld":"Fehlertext"}}` |
| GET | `/api/credentials` | `{"configured": bool, "username": "ab***z" \| null}` (maskiert) |
| PUT | `/api/credentials` | Body `{"username": "…", "password": "…"}` → speichert im System-Schlüsselbund. Bei ungültigen Eingaben liefert die API `422` mit `error: "invalid_credentials"` und `fields.username` bzw. `fields.password`. Passwort wird nie zurückgegeben oder geloggt. |
| DELETE | `/api/credentials` | entfernt die Zugangsdaten |
| POST | `/api/session/check` | prüft Session (headless) → `{"state": "valid"\|"expired"\|"offline"}` |
| POST | `/api/session/login` | startet sichtbares Login-Fenster (Chromium) im Hintergrund → `202`; Fortschritt kommt über `/api/events` (`log`/`status`) |
| GET | `/api/browser` | Browser-Komponente (Playwright-Chromium) → `{"installed": bool, "executable": "…"\|null, "installing": bool, "error": "…"\|null}`; `503 browser_unavailable`, wenn die Version keine Browser-Verwaltung enthält |
| POST | `/api/browser/install` | Installiert Chromium im Hintergrund (wie `ilias-sync browser install`) → `202 {"started": true}`; Ausgabe als `log`-Events über `/api/events`; Ende erkennbar an `installing: false` in `GET /api/browser`. `409 already_installing` bzw. `409 already_running` (Sync läuft) |
| GET | `/api/shell-command` | Status des optionalen Terminal-Befehls → `ShellCommandStatus` |
| POST | `/api/shell-command/install` | Installiert den Befehl ohne Body und ohne Administratorrechte → `ShellCommandStatus`; bei Fehler `422 shell_command_install_failed` |
| POST | `/api/shell-command/uninstall` | Entfernt den von ILIAS Sync angelegten Link ohne Body → `ShellCommandStatus`; bei Fehler `422 shell_command_uninstall_failed` |
| GET | `/api/schedule` | `Schedule` |
| PUT | `/api/schedule` | `Schedule` setzen; installiert/entfernt auf macOS einen LaunchAgent. Auf anderen Systemen `{"supported": false, "instructions": "…"}`. |

```jsonc
// Config
{
  "base_url": "https://www.ilias.uni-koeln.de/ilias/",
  "login_url": "https://www.ilias.uni-koeln.de/ilias/login.php?client_id=uk&cmd=force_login&lang=de",
  "download_dir": "/abs/pfad",
  "local_download_dir": "/abs/pfad" | null,
  "auto_discover_current_semester": true,
  "semester_filter": "auto",
  "include_configured_courses": false,
  "courses": {"Name": "URL"},
  "file_extensions": ["pdf", "pptx", "…"],
  "max_depth": 10,
  "overwrite": false,
  "auto_login": true,
  "keychain_service": "ilias-koeln-sync",
  "notifications": true,
  "open_login_window_on_failure": true
}

// Schedule
{ "supported": true, "enabled": true, "time": "09:00", "run_at_login": true }

// ShellCommandStatus
{
  "installed": false, "path": "/abs/pfad/.local/bin/ilias-sync", "target": "/abs/pfad/ilias-sync",
  "on_path": false, "frozen": true, "supported": true,
  "path_line": "export PATH=\"$HOME/.local/bin\":\"$PATH\"", "instructions": null
}

// SyncOptions – entspricht den Optionen von `ilias-sync run`
{
  "dry_run": false,            // --dry-run
  "course": null,              // --course  (voller Kursname wie im RunReport, z. B. "[WS26/27] Softwaretechnik")
  "semester": null,            // --semester (überschreibt semester_filter für diesen Lauf)
  "max_depth": null,           // --max-depth (1–100)
  "overwrite": false,          // --overwrite
  "no_auto_discover": false,   // --no-auto-discover (nur eingetragene Kurse)
  "no_auto_login": false,      // --no-auto-login
  "headful": false,            // --headful (sichtbarer Browser)
  "verbose": false,            // --verbose (ausführliches Protokoll)
  "debug_links": false,        // --debug-links
  "notify": false              // --notify (Mitteilung nach dem Lauf)
}
```

`on_path` prüft das Zielverzeichnis im PATH des laufenden Prozesses.
`path_line` ist die optionale Zeile für `~/.zprofile` und ist `null`, wenn
das Verzeichnis bereits im PATH steht. Auf Windows liefern alle drei
Endpunkte `supported: false`, `path`, `target` und `path_line` sind `null`,
und `instructions` erklärt den direkten Aufruf der EXE. Auch bei einer
Quellinstallation ohne auffindbares Konsolenskript kann `target` `null` sein.

`course` und `semester`: leere Zeichenketten gelten als `null`; höchstens 300
Zeichen, keine Steuerzeichen. Unbekannte Felder und falsche Typen liefern
`422 invalid_sync_options` mit `fields`.

`setup.required` ist `true`, solange die Einrichtung nicht abgeschlossen ist und
entweder keine Config-Datei existiert oder keine Zugangsdaten gespeichert sind.
Die Oberfläche entscheidet damit, ob der Einrichtungsassistent erscheint (nicht
über `localStorage`, das das Desktop-Fenster bei jedem Start vergisst).

Neue Werte für `max_depth` müssen ganze Zahlen ab 1 sein. Bestehende
Konfigurationen mit 0 können weiterhin nur die Kursebene durchsuchen.

## Desktop-Brücke (nur im Desktop-Fenster)

pywebview stellt `window.pywebview.api` bereit (Ereignis `pywebviewready`).
Im Browser fehlen diese Funktionen; die Oberfläche zeigt dann Texteingaben.

| Funktion | Rückgabe |
|---|---|
| `choose_folder(initial)` | gewählter Ordnerpfad oder `null` |
| `open_in_browser(url)` | `true`, wenn die lokale Adresse (`http://127.0.0.1:…`) im Standardbrowser geöffnet wurde |
