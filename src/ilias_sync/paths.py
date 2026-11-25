"""Locations for private runtime data."""

import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from platformdirs import user_config_dir, user_data_dir, user_log_dir

APP = "ilias-sync"
CONFIG = Path(user_config_dir(APP)) / "config.yaml"
DATA = Path(user_data_dir(APP))
PROFILE = DATA / "browser-profile"
STORAGE_STATE = DATA / "storage-state.json"
HISTORY = DATA / "history.jsonl"
CURRENT = DATA / "current.json"
LOCK = DATA / "browser.lock"
LOGS = Path(user_log_dir(APP))


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
    try:
        temporary.write_text(content, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
