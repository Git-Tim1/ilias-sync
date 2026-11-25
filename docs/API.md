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
| GET | `/api/status` | `{"running": bool, "current": RunReport\|null, "last_run": RunReport\|null, "session": {"state": "valid"\|"expired"\|"unknown", "checked_at": "…"\|null}, "credentials_configured": bool, "schedule": Schedule, "version": "0.1.0"}` |
| POST | `/api/sync` | Body `{"dry_run": false, "course": null}` → `202 {"run_id": "…"}`; `409 {"error":"already_running"}` |
| POST | `/api/sync/cancel` | Laufenden Sync abbrechen → `200 {"cancelled": true}` |
| GET | `/api/runs?limit=20` | Verlauf, neuester zuerst → `[RunReport]` |
| GET | `/api/files/recent?limit=50` | Zuletzt geladene Dateien über alle Läufe → `[FileEntry]` |
| POST | `/api/files/open` | Body `{"path": "…"}` → öffnet Datei mit Standard-App. Nur Pfade innerhalb der Download-Ordner, sonst `403`. |
| POST | `/api/files/reveal` | wie oben, zeigt Datei im Finder/Explorer |
| POST | `/api/folders/open` | Body `{"which": "download" \| "local"}` → öffnet Ordner |
| GET | `/api/logs?lines=200` | `{"lines": ["…"]}` |
| GET | `/api/events` | Server-Sent Events. Events: `log` (`{"line": "…"}`), `status` (gleiche Form wie `/api/status`), `run_finished` (RunReport). Heartbeat-Kommentar alle 15 s. |
| GET | `/api/config` | Konfiguration → `Config` (siehe unten) |
| PUT | `/api/config` | Teil-Update von `Config`; validiert; `422` mit `{"error":"invalid_config","message":…,"fields":{"feld":"Fehlertext"}}` |
| GET | `/api/credentials` | `{"configured": bool, "username": "ab***z" \| null}` (maskiert) |
| PUT | `/api/credentials` | Body `{"username": "…", "password": "…"}` → speichert im System-Schlüsselbund. Bei ungültigen Eingaben liefert die API `422` mit `error: "invalid_credentials"` und `fields.username` bzw. `fields.password`. Passwort wird nie zurückgegeben oder geloggt. |
| DELETE | `/api/credentials` | entfernt die Zugangsdaten |
| POST | `/api/session/check` | prüft Session (headless) → `{"state": "valid"\|"expired"\|"offline"}` |
| POST | `/api/session/login` | startet sichtbares Login-Fenster (Chromium) im Hintergrund → `202`; Fortschritt kommt über `/api/events` (`log`/`status`) |
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
```

Neue Werte für `max_depth` müssen ganze Zahlen ab 1 sein. Bestehende
Konfigurationen mit 0 können weiterhin nur die Kursebene durchsuchen.
