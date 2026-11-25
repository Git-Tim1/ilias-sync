"""macOS notifications and graphical session detection."""

import logging
import os
import subprocess
import sys

from .reports import RunReport

LOGGER = logging.getLogger("ilias-sync")
DISPLAY_NOTIFICATION = """
on run argv
    display notification (item 2 of argv) with title (item 1 of argv)
end run
"""


def in_gui_session() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        uid = os.getuid()
        if uid == 0 or os.stat("/dev/console").st_uid != uid:
            return False
        return (
            subprocess.run(
                ["/bin/launchctl", "print", f"gui/{uid}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
            ).returncode
            == 0
        )
    except (OSError, subprocess.TimeoutExpired):
        return False


def notify(report: RunReport) -> None:
    if sys.platform != "darwin":
        return
    if report.result == "session_expired":
        title = "ILIAS-Login erforderlich"
        message = "Bitte melde dich erneut bei ILIAS an."
    elif report.result in {"success", "errors"} and report.new_files:
        count = len(report.new_files)
        title = (
            "1 neue Datei in ILIAS" if count == 1 else f"{count} neue Dateien in ILIAS"
        )
        message = "\n".join(entry.name for entry in report.new_files[:3])
    else:
        return
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e", DISPLAY_NOTIFICATION, "--", title, message],
            capture_output=True,
            timeout=10,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        LOGGER.warning("Die macOS-Mitteilung konnte nicht angezeigt werden.")
