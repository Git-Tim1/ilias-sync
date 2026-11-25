# Mitwirken

Installiere die Entwicklungsabhängigkeiten und prüfe deine Änderungen
vor einem Pull Request:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
ruff check .
ruff format --check .
pytest -q
```

Verwende für Tests synthetische HTML-Fixtures und Mocks. Teile keine
persönlichen Konfigurationen, Sitzungsdaten oder Kursmaterialien.
Bei Änderungen an der HTTP-API berücksichtige bitte die Oberfläche
und den Vertrag in [docs/API.md](docs/API.md).
