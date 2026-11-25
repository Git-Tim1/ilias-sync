"""Install and remove the per-user macOS schedule."""

import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from . import paths

LABEL = "io.github.ilias-sync"
INSTRUCTIONS = "Richte im Aufgabenplaner oder in cron den Befehl ilias-sync run --trigger schedule ein."


def agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def status() -> dict[str, Any]:
    if sys.platform != "darwin":
        return {"supported": False, "instructions": INSTRUCTIONS}

    result = {
        "supported": True,
        "enabled": False,
        "time": "09:00",
        "run_at_login": False,
    }
    try:
        data = plistlib.loads(agent_path().read_bytes())
    except (FileNotFoundError, plistlib.InvalidFileException):
        return result
    interval = data["StartCalendarInterval"]
    return {
        "supported": True,
        "enabled": True,
        "time": f"{interval['Hour']:02}:{interval['Minute']:02}",
        "run_at_login": bool(data.get("RunAtLoad")),
    }


def configure(
    enabled: bool, time: str = "09:00", run_at_login: bool = False
) -> dict[str, Any]:
    if sys.platform != "darwin":
        return status()
    if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", time):
        raise ValueError("Bitte eine Uhrzeit im Format HH:MM angeben.")

    path = agent_path()
    domain = f"gui/{os.getuid()}"
    launchctl = "/bin/launchctl"
    if path.exists():
        subprocess.run(
            [launchctl, "bootout", f"{domain}/{LABEL}"],
            capture_output=True,
            check=False,
        )
    if not enabled:
        path.unlink(missing_ok=True)
        return status()

    hour, minute = map(int, time.split(":"))
    paths.LOGS.mkdir(parents=True, exist_ok=True)
    # The CLI maintains its own rotated log. launchd must not duplicate it.
    contents = plistlib.dumps(
        {
            "Label": LABEL,
            "ProgramArguments": [
                sys.executable,
                "-m",
                "ilias_sync",
                "run",
                "--trigger",
                "schedule",
            ],
            "StartCalendarInterval": {"Hour": hour, "Minute": minute},
            "RunAtLoad": run_at_login,
            "StandardOutPath": os.devnull,
            "StandardErrorPath": os.devnull,
        }
    )
    previous = path.read_text(encoding="utf-8") if path.exists() else None
    paths.atomic_write(path, contents.decode())
    result = subprocess.run(
        [launchctl, "bootstrap", domain, str(path)], capture_output=True, check=False
    )
    if result.returncode:
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            paths.atomic_write(path, previous)
            subprocess.run(
                [launchctl, "bootstrap", domain, str(path)],
                capture_output=True,
                check=False,
            )
        raise RuntimeError("Der Zeitplan konnte nicht bei launchd aktiviert werden.")
    return status()
