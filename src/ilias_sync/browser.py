"""Inspect and install the Chromium build used by Playwright."""

import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from playwright._impl._driver import compute_driver_executable, get_driver_env
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

MISSING = (
    "Browser-Komponente fehlt – in der App unter Einstellungen installieren "
    "oder `ilias-sync browser install`"
)


def status() -> dict[str, bool | str | None]:
    with sync_playwright() as playwright:
        executable = Path(playwright.chromium.executable_path)
    installed = executable.is_file()
    return {
        "installed": installed,
        "executable": str(executable) if installed else None,
    }


def install(on_line: Callable[[str], None]) -> None:
    try:
        driver = compute_driver_executable()
        # Both headed and headless syncs use the full Chromium channel.
        with subprocess.Popen(
            [*driver, "install", "--no-shell", "chromium"],
            env=get_driver_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        ) as process:
            assert process.stdout is not None
            try:
                for line in process.stdout:
                    on_line(line.rstrip("\r\n"))
            except BaseException:
                process.kill()
                raise
            code = process.wait()
    except (OSError, PlaywrightError) as exc:
        raise RuntimeError(
            f"Chromium-Installation konnte nicht gestartet werden: {exc}"
        ) from exc
    if code:
        raise RuntimeError(
            f"Chromium konnte nicht installiert werden (Exit-Code {code})."
        )
