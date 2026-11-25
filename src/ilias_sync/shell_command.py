"""Install and track the optional terminal shortcut."""

import json
import os
import shlex
import shutil
import sys
import sysconfig
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from typing_extensions import (
    TypedDict,  # Pydantic braucht unter Python 3.11 diese Variante
)

from . import paths

COMMAND = "ilias-sync"
SYSTEM_BIN = Path("/usr/local/bin")
WINDOWS_HELP = (
    "Führe ilias-sync.exe im entpackten Ordner aus, z. B. .\\ilias-sync.exe --help."
)


class Status(TypedDict):
    installed: bool
    path: str | None
    target: str | None
    on_path: bool
    frozen: bool
    supported: bool
    path_line: str | None
    instructions: str | None


def _supported() -> bool:
    return sys.platform == "darwin" or sys.platform.startswith("linux")


def _target() -> Path | None:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve()
    script = Path(sysconfig.get_path("scripts")) / COMMAND
    if script.is_file() and os.access(script, os.X_OK):
        return script.absolute()
    found = shutil.which(COMMAND)
    if found and not Path(found).is_symlink():
        return Path(found).absolute()
    return None


@contextmanager
def _locked() -> Iterator[None]:
    from fcntl import LOCK_EX, flock

    paths.DATA.mkdir(parents=True, exist_ok=True)
    with (paths.DATA / "shell-command.lock").open("a") as stream:
        flock(stream, LOCK_EX)
        yield


def _receipt() -> Path:
    return paths.DATA / "shell-command.json"


def _identity(link: Path) -> list[int | str]:
    stat = link.lstat()
    return [stat.st_dev, stat.st_ino, stat.st_ctime_ns, os.readlink(link)]


def _owned_link() -> Path | None:
    try:
        record = json.loads(_receipt().read_text(encoding="utf-8"))
        link = Path(record["path"])
        if (
            link.is_absolute()
            and link.name == COMMAND
            and _identity(link) == record["identity"]
        ):
            return link
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return None


def status() -> Status:
    supported = _supported()
    frozen = bool(getattr(sys, "frozen", False))
    result = Status(
        installed=False,
        path=None,
        target=None,
        on_path=False,
        frozen=frozen,
        supported=supported,
        path_line=None,
        instructions=None,
    )
    if not supported:
        result["instructions"] = (
            WINDOWS_HELP
            if sys.platform == "win32"
            else "Verwende den vollständigen Pfad zum Programm."
        )
        return result

    owned = _owned_link()
    link = owned or Path.home() / ".local" / "bin" / COMMAND
    on_path = any(
        Path(entry).expanduser().resolve() == link.parent.resolve()
        for entry in os.get_exec_path()
    )
    target = _target()
    if owned:
        try:
            target = owned.readlink()
        except OSError:
            owned = None
    path_line = None
    if not on_path:
        directory = (
            '"$HOME/.local/bin"'
            if link.parent == Path.home() / ".local/bin"
            else shlex.quote(str(link.parent))
        )
        path_line = f'export PATH={directory}:"$PATH"'
    result.update(
        installed=owned is not None,
        path=str(link),
        target=str(target) if target else None,
        on_path=on_path,
        path_line=path_line,
    )
    return result


def install(location: Path | str | None = None) -> Status:
    """Install in the given directory or choose a user-writable bin directory."""
    if not _supported():
        return status()
    with _locked():
        if _owned_link():
            return status()
        target = _target()
        if not target:
            raise RuntimeError(
                "Der Terminal-Befehl dieser Installation wurde nicht gefunden."
            )
        if location is not None:
            directories = [Path(location).expanduser().absolute()]
        else:
            directories = [Path.home() / ".local/bin"]
            if SYSTEM_BIN.is_dir() and os.access(SYSTEM_BIN, os.W_OK):
                directories.append(SYSTEM_BIN)
        for directory in directories:
            try:
                directory.mkdir(parents=True, exist_ok=True)
                link = directory / COMMAND
                try:
                    link.symlink_to(target)
                except FileExistsError as exc:
                    raise RuntimeError(f"Der Pfad ist bereits belegt: {link}") from exc
            except OSError as exc:
                if directory == directories[-1]:
                    raise RuntimeError(
                        f"Der Terminal-Befehl konnte in {directory} nicht installiert werden."
                    ) from exc
                continue
            identity = _identity(link)
            try:
                paths.atomic_write(
                    _receipt(), json.dumps({"path": str(link), "identity": identity})
                )
            except OSError:
                if _identity(link) == identity:
                    link.unlink()
                raise
            return status()
    return status()


def uninstall() -> Status:
    if not _supported():
        return status()
    with _locked():
        link = _owned_link()
        if link:
            link.unlink(missing_ok=True)
        _receipt().unlink(missing_ok=True)
        return status()
