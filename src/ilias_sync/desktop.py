"""Desktop-Fenster für ILIAS Sync.

Startet den lokalen Server (nur 127.0.0.1) in einem Hintergrund-Thread und
zeigt die Oberfläche in einem nativen Fenster (pywebview). Ohne pywebview wird
stattdessen der Standardbrowser geöffnet und der Server läuft im Vordergrund.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from typing import Any

HOST = "127.0.0.1"
PREFERRED_PORT = 8765
WINDOW_TITLE = "ILIAS Sync"
WINDOW_SIZE = (1100, 760)
WINDOW_MIN_SIZE = (760, 560)
STARTUP_TIMEOUT = 15.0
STARTUP_ERROR = (
    "ILIAS Sync konnte nicht gestartet werden. Der lokale Server hat nicht rechtzeitig "
    "auf /api/status geantwortet."
)

INSTALL_HINT = "pip install 'ilias-sync[desktop]'"


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((HOST, port))
        except OSError:
            return False
        return True


def find_free_port(preferred: int = PREFERRED_PORT) -> int:
    """Bevorzugt ``preferred``; ist der Port belegt, wählt das System einen freien."""
    if preferred and _port_is_free(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def _fetch_status(base_url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(
            f"{base_url}/api/status", timeout=timeout
        ) as response:
            if response.status != 200:
                return None
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def is_ilias_sync_server(base_url: str) -> bool:
    """Erkennt eine bereits laufende ILIAS-Sync-Instanz am Antwortformat von /api/status."""
    data = _fetch_status(base_url)
    return bool(data and "version" in data and "running" in data)


def wait_until_ready(
    base_url: str,
    timeout: float = STARTUP_TIMEOUT,
    alive: threading.Thread | None = None,
) -> bool:
    """Wartet, bis ``/api/status`` antwortet (oder der Server-Thread endet)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if alive is not None and not alive.is_alive():
            return False
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        if _fetch_status(base_url, timeout=min(0.5, remaining)) is not None:
            return True
        time.sleep(max(0, min(0.15, deadline - time.monotonic())))
    return False


class _DesktopApi:
    """Wird der Oberfläche als ``window.pywebview.api`` bereitgestellt."""

    def __init__(self) -> None:
        # Unterstrich: pywebview reicht das Attribut nicht an JavaScript weiter.
        self._window: Any = None

    def bind(self, window: Any) -> None:
        self._window = window

    def choose_folder(self, initial: str | None = None) -> str | None:
        """Öffnet einen nativen Ordnerauswahl-Dialog und gibt den Pfad zurück."""
        if self._window is None:
            return None
        import webview

        folder_dialog = getattr(getattr(webview, "FileDialog", None), "FOLDER", None)
        if folder_dialog is None:  # pywebview < 5
            folder_dialog = webview.FOLDER_DIALOG
        kwargs: dict[str, Any] = {}
        if initial:
            from pathlib import Path

            path = Path(initial).expanduser()
            if path.is_dir():
                kwargs["directory"] = str(path)
        result = self._window.create_file_dialog(folder_dialog, **kwargs)
        return _first_path(result)

    def open_in_browser(self, url: str) -> bool:
        """Öffnet die lokale Oberfläche im Standardbrowser (nur 127.0.0.1)."""
        if not isinstance(url, str) or not url.startswith(f"http://{HOST}:"):
            return False
        return bool(webbrowser.open(url))


def _first_path(result: Any) -> str | None:
    if not result:
        return None
    return str(result[0] if isinstance(result, (list, tuple)) else result)


def _build_server(port: int) -> Any:
    import uvicorn

    from ilias_sync.server import create_app  # lazy: Backend wird separat entwickelt

    config = uvicorn.Config(
        create_app(),
        host=HOST,
        port=port,
        log_level="warning",
        access_log=False,
    )
    return uvicorn.Server(config)


def _run_in_browser(server: Any, url: str) -> int:
    """Fallback ohne pywebview: Browser öffnen, Server im Vordergrund laufen lassen."""
    print(
        "Hinweis: Für das Desktop-Fenster wird pywebview benötigt.\n"
        f"  Installation: {INSTALL_HINT}\n"
        f"Die Oberfläche wird stattdessen im Browser geöffnet: {url}\n"
        "Beenden mit Strg+C.",
        file=sys.stderr,
    )

    startup_failed = threading.Event()

    def open_when_ready() -> None:
        if wait_until_ready(url):
            webbrowser.open(url)
        else:
            print(STARTUP_ERROR, file=sys.stderr)
            startup_failed.set()
            server.should_exit = True

    threading.Thread(
        target=open_when_ready, name="ilias-sync-browser", daemon=True
    ).start()
    server.run()  # blockiert; Strg+C beendet uvicorn sauber
    return int(startup_failed.is_set())


def _run_window(webview: Any, server: Any, url: str) -> int:
    thread = threading.Thread(target=server.run, name="ilias-sync-server", daemon=True)
    thread.start()
    if not wait_until_ready(url, alive=thread):
        print(STARTUP_ERROR, file=sys.stderr)
        server.should_exit = True
        webview.create_window(
            WINDOW_TITLE,
            html=f'<html lang="de"><meta charset="utf-8"><p>{STARTUP_ERROR}</p></html>',
            width=520,
            height=220,
        )
        webview.start()
        return 1

    # Externe Links (z. B. „In ILIAS öffnen“) im Standardbrowser öffnen.
    settings = getattr(webview, "settings", None)
    if isinstance(settings, dict) and "OPEN_EXTERNAL_LINKS_IN_BROWSER" in settings:
        settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

    js_api = _DesktopApi()
    window = webview.create_window(
        WINDOW_TITLE,
        url,
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=WINDOW_MIN_SIZE,
        js_api=js_api,
        text_select=True,
    )
    js_api.bind(window)
    try:
        webview.start()  # blockiert, bis das Fenster geschlossen wird
    finally:
        server.should_exit = True
        thread.join(timeout=10)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ilias-sync-desktop", description="ILIAS Sync im Desktop-Fenster starten."
    )
    parser.add_argument(
        "--port",
        type=int,
        default=PREFERRED_PORT,
        help=f"bevorzugter Port (Standard: {PREFERRED_PORT})",
    )
    parser.add_argument(
        "--browser",
        action="store_true",
        help="im Standardbrowser statt im eigenen Fenster öffnen",
    )
    args = parser.parse_args(argv)

    try:
        import webview  # type: ignore[import-not-found]
    except ImportError:
        webview = None

    # Läuft bereits eine Instanz auf dem bevorzugten Port, diese wiederverwenden.
    preferred_url = f"http://{HOST}:{args.port}"
    if not _port_is_free(args.port) and is_ilias_sync_server(preferred_url):
        if webview is None or args.browser:
            webbrowser.open(preferred_url)
            return 0
        webview.create_window(
            WINDOW_TITLE,
            preferred_url,
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=WINDOW_MIN_SIZE,
        )
        webview.start()
        return 0

    port = find_free_port(args.port)
    url = f"http://{HOST}:{port}"
    server = _build_server(port)

    if webview is None or args.browser:
        return _run_in_browser(server, url)
    return _run_window(webview, server, url)


if __name__ == "__main__":
    raise SystemExit(main())
