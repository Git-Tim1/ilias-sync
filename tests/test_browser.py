"""Browser management without downloads or ILIAS access."""

import sys
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from ilias_sync import browser, paths
from ilias_sync.crawler import launch_context


def test_status_and_missing_browser(monkeypatch, tmp_path):
    executable = tmp_path / "chromium"
    playwright = SimpleNamespace(
        chromium=SimpleNamespace(executable_path=str(executable))
    )
    monkeypatch.setattr(browser, "sync_playwright", lambda: nullcontext(playwright))
    assert browser.status() == {"installed": False, "executable": None}
    with pytest.raises(RuntimeError, match="Browser-Komponente fehlt"):
        launch_context(playwright, headful=True)
    executable.touch()
    assert browser.status() == {"installed": True, "executable": str(executable)}


@pytest.mark.parametrize("code", [0, 3])
def test_install_streams_driver_output(monkeypatch, tmp_path, code):
    driver = tmp_path / "driver.py"
    driver.write_text(
        "import sys\n"
        "assert sys.argv[1:] == ['install', '--no-shell', 'chromium']\n"
        "print('Fortschritt', flush=True)\n"
        "print('Letzte Zeile', file=sys.stderr, flush=True)\n"
        f"sys.exit({code})\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        browser, "compute_driver_executable", lambda: (sys.executable, str(driver))
    )
    lines = []
    if code:
        with pytest.raises(RuntimeError, match="Exit-Code 3"):
            browser.install(lines.append)
    else:
        browser.install(lines.append)
    assert lines == ["Fortschritt", "Letzte Zeile"]


def test_install_reports_start_error(monkeypatch, tmp_path):
    monkeypatch.setattr(
        browser,
        "compute_driver_executable",
        lambda: (str(tmp_path / "missing"), "cli.js"),
    )
    with pytest.raises(
        RuntimeError, match="Chromium-Installation konnte nicht gestartet werden"
    ):
        browser.install(lambda _: None)


@pytest.mark.parametrize("frozen", [False, True])
def test_cli_command(monkeypatch, frozen):
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)
    expected = [] if frozen else ["-m", "ilias_sync"]
    assert paths.cli_command("run", "--dry-run") == [
        sys.executable,
        *expected,
        "run",
        "--dry-run",
    ]


@pytest.mark.parametrize("action", ["status", "install"])
def test_browser_cli(monkeypatch, capsys, action):
    from ilias_sync.cli import main

    monkeypatch.setattr(sys, "argv", ["ilias-sync", "browser", action])
    monkeypatch.setattr(
        browser, "status", lambda: {"installed": False, "executable": None}
    )
    monkeypatch.setattr(browser, "install", lambda on_line: on_line("Fortschritt"))
    assert main() == 0
    assert (
        '"installed": false' if action == "status" else "Fortschritt"
    ) in capsys.readouterr().out
