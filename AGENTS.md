# Hinweise für KI-Agenten und Mitwirkende

ILIAS Sync lädt Kursmaterialien aus ILIAS (Standard: Universität zu Köln) über
eine Playwright-Browser-Session herunter. Es bringt eine lokale
Web-Oberfläche, ein Desktop-Fenster und eine CLI mit. Für Menschen gilt
zusätzlich [CONTRIBUTING.md](CONTRIBUTING.md).

## Datenschutz (verbindlich)
- Keine persönlichen Daten committen oder in Dateien schreiben: keine echten
  Namen, E-Mail-Adressen, Benutzernamen, Passwörter, Cookies,
  Browser-Profile, Storage-State-JSONs, heruntergeladenen Kursdateien und
  keine absoluten Pfade wie `/Users/<name>/…`. Beispiele nutzen Platzhalter
  wie `~/Documents/Uni`.
- Laufzeitdaten (Config, Browser-Profil, Logs, Verlauf) liegen im
  Benutzerverzeichnis (`platformdirs`: `user_config_dir("ilias-sync")`,
  `user_data_dir`, `user_log_dir`), nie im Repo.
- Keine echten Logins gegen ILIAS. Tests nutzen HTML-Fixtures und Mocks.

## Aufbau
- `src/ilias_sync/`: Paket mit CLI (`cli.py`), Crawler, Anmeldung,
  Zeitplan und HTTP-Server (`server.py`, FastAPI).
- `src/ilias_sync/web/`: Oberfläche ohne Build-Schritt (Vanilla-JS-Module).
  Mit `index.html?mock=1` läuft sie im Demo-Modus ohne Server
  (`mock.js`, alle Daten erfunden).
- `src/ilias_sync/desktop.py`: Desktop-Fenster über pywebview.
- `docs/API.md`: Schnittstelle zwischen Server und Oberfläche. Wer einen
  Endpunkt ändert, passt Server, `web/api.js`, `web/mock.js` und diese Datei
  gemeinsam an.
- `packaging/` und `.github/workflows/`: PyInstaller-Builds, CI und Release.

## Konventionen
- Python ≥ 3.11 mit Typannotationen. `ruff check`, `ruff format` und
  `pytest` müssen sauber durchlaufen.
- UI-Texte auf Deutsch, Bezeichner im Code auf Englisch.
- Die Version steht nur in `src/ilias_sync/__init__.py` (und als Beispiel in
  `web/mock.js`). Ein Tag `v<Version>` startet den Release-Workflow.
