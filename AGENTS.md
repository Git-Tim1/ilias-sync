# Regeln für Agenten in diesem Repo

Ziel: Öffentlich teilbares Open-Source-Projekt „ILIAS Sync“ – lädt
Kursmaterialien aus ILIAS (Standard: Uni Köln) per Playwright-Browser-Session
herunter, mit lokaler Web-Oberfläche und Desktop-Fenster.

## Datenschutz (hart)
- Niemals persönliche Daten committen oder in Dateien schreiben: keine echten
  Namen, E-Mail-Adressen, Benutzernamen, Passwörter, Cookies, Browser-Profile,
  Storage-State-JSONs, heruntergeladene Kursdateien, absolute Pfade wie
  `/Users/<name>/…`. Beispiele nutzen Platzhalter (`~/Documents/Uni`).
- Laufzeitdaten (Config, Profile, State, Logs, Verlauf) liegen im
  Benutzerverzeichnis via `platformdirs` (`user_config_dir("ilias-sync")` /
  `user_data_dir` / `user_log_dir`), nie im Repo.
- Keine echten Logins gegen ILIAS ausführen. Tests nutzen HTML-Fixtures/Mocks.

## Aufteilung
- Backend, Paket, CLI, Tests, CI, Packaging: `src/ilias_sync/` (außer `web/`
  und `desktop.py`), `tests/`, `pyproject.toml`, `.github/`.
- Oberfläche + Desktop-Fenster: `src/ilias_sync/web/`, `src/ilias_sync/desktop.py`.
- Gemeinsamer Vertrag: `docs/API.md`. Nicht eigenmächtig ändern; Abweichungen
  im Abschlussbericht nennen.
- Fremde Bereiche nicht bearbeiten. Nicht `git commit`/`git push` – das macht
  der Orchestrator.

## Konventionen
- Python ≥ 3.11, Typannotationen, `ruff`-sauber, `pytest`.
- UI-Sprache Deutsch. Code-Bezeichner Englisch.
- `legacy/` enthält den bisherigen, funktionierenden Code als Referenz (nicht
  importieren). Wird am Ende gelöscht.
