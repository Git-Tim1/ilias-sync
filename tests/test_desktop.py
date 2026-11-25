from threading import Event
from types import SimpleNamespace

from ilias_sync import desktop


def test_desktop_shows_error_when_status_unavailable(monkeypatch):
    windows = []
    starts = []
    stopped = Event()
    webview = SimpleNamespace(
        create_window=lambda *_, **options: windows.append(options),
        start=lambda: starts.append(True),
    )
    server = SimpleNamespace(run=lambda: stopped.set(), should_exit=False)
    monkeypatch.setattr(desktop, "wait_until_ready", lambda *_, **__: False)
    assert desktop.STARTUP_TIMEOUT == 15
    assert desktop._run_window(webview, server, "http://127.0.0.1:8765") == 1
    assert stopped.wait(1)
    assert server.should_exit
    assert starts == [True]
    assert "nicht rechtzeitig" in windows[0]["html"]


def test_desktop_open_in_browser(monkeypatch):
    api = desktop._DesktopApi()
    opened = []
    monkeypatch.setattr(
        desktop.webbrowser, "open", lambda url: opened.append(url) or True
    )
    assert api.open_in_browser("http://127.0.0.1:8765/#/einstellungen") is True
    assert api.open_in_browser("https://example.com") is False
    assert opened == ["http://127.0.0.1:8765/#/einstellungen"]
