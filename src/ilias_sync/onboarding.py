"""First-run setup state and sensible download folder suggestions."""

import sys
from pathlib import Path
from typing import Any

from . import paths

SUBFOLDER = "Uni"


def marker() -> Path:
    return paths.DATA / "setup-complete"


def setup_state(credentials_present: bool | None) -> dict[str, bool]:
    """Tell the UI whether to show the first-run wizard.

    ``credentials_present`` is ``None`` while the keychain probe is still
    running. Existing installations (config file present) must not be sent
    into the wizard just because that probe has not finished yet.
    """
    completed = marker().exists()
    configured = paths.CONFIG.exists()
    required = not completed and (not configured or credentials_present is False)
    return {"completed": completed, "required": required}


def mark_complete() -> dict[str, bool]:
    paths.atomic_write(marker(), "")
    return {"completed": True, "required": False}


def reset() -> None:
    marker().unlink(missing_ok=True)


def _first_dir(*candidates: Path) -> Path | None:
    return next((path for path in candidates if path.is_dir()), None)


def _suggestion(
    key: str, label: str, description: str, base: Path, kind: str
) -> dict[str, Any]:
    path = base / SUBFOLDER
    return {
        "id": key,
        "label": label,
        "description": description,
        "path": str(path),
        "kind": kind,
        "exists": path.is_dir(),
    }


def folder_suggestions(home: Path | None = None) -> list[dict[str, Any]]:
    """Return download folder options, local Documents folder first.

    Cloud folders are only offered when their sync client is installed, i.e.
    the folder already exists on this computer.
    """
    home = home or Path.home()
    suggestions = [
        _suggestion(
            "documents",
            "Dokumente",
            "Nur auf diesem Computer. Schnell und zuverlässig.",
            home / "Documents",
            "local",
        )
    ]
    if sys.platform == "darwin" or (home / "Library").is_dir():
        icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
        if icloud.is_dir():
            suggestions.append(
                _suggestion(
                    "icloud",
                    "iCloud Drive",
                    "Auch auf iPhone und iPad verfügbar.",
                    icloud,
                    "cloud",
                )
            )
        storage = home / "Library" / "CloudStorage"
        if storage.is_dir():
            for index, account in enumerate(sorted(storage.glob("GoogleDrive-*"))):
                drive = _first_dir(account / "My Drive", account / "Meine Ablage")
                if drive is not None:
                    suggestions.append(
                        _suggestion(
                            f"google-drive-{index}",
                            "Google Drive",
                            "Wird von der Google-Drive-App in die Cloud übertragen.",
                            drive,
                            "cloud",
                        )
                    )
            for index, account in enumerate(sorted(storage.glob("OneDrive*"))):
                suggestions.append(
                    _suggestion(
                        f"onedrive-{index}",
                        "OneDrive",
                        "Wird von der OneDrive-App in die Cloud übertragen.",
                        account,
                        "cloud",
                    )
                )
    dropbox = _first_dir(
        home / "Library" / "CloudStorage" / "Dropbox", home / "Dropbox"
    )
    if dropbox is not None:
        suggestions.append(
            _suggestion(
                "dropbox",
                "Dropbox",
                "Wird von der Dropbox-App in die Cloud übertragen.",
                dropbox,
                "cloud",
            )
        )
    return suggestions
