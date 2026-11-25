"""Cross-process coordination, persistent reports and API process control."""

from __future__ import annotations

import _thread
import errno
import json
import logging
import mmap
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Iterator
from dataclasses import asdict
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Self

from . import paths
from .reports import RunReport, now_iso

LOGGER = logging.getLogger("ilias-sync")
LOG_NAME = "sync.log"
BUSY_EXIT = 75
HISTORY_LIMIT = 500


class AlreadyRunning(RuntimeError):
    pass


class BrowserLock:
    def __init__(self, timeout: float = 0) -> None:
        self.timeout = timeout

    def __enter__(self) -> Self:
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                return self._acquire()
            except AlreadyRunning:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise
                time.sleep(min(0.05, remaining))

    def _acquire(self) -> Self:
        paths.LOCK.parent.mkdir(parents=True, exist_ok=True)
        self.stream = paths.LOCK.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt

                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise AlreadyRunning(
                    "Ein Sync oder eine Session-Prüfung läuft bereits."
                ) from exc
            raise
        return self

    def __exit__(self, *args: object) -> None:
        self.stream.close()


def disk_log_handler() -> RotatingFileHandler:
    paths.LOGS.mkdir(parents=True, exist_ok=True)
    disk = RotatingFileHandler(
        paths.LOGS / LOG_NAME, maxBytes=512_000, backupCount=3, encoding="utf-8"
    )
    disk.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    return disk


def setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
        handlers=[logging.StreamHandler(), disk_log_handler()],
        force=True,
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def report_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def write_current(report: RunReport) -> None:
    snapshot = {**asdict(report), "pid": os.getpid()}
    paths.atomic_write(paths.CURRENT, json.dumps(snapshot, ensure_ascii=False))


def archive(report: RunReport) -> None:
    # Called while the process holds BrowserLock. Readers see either complete version.
    reports = history(HISTORY_LIMIT - 1)
    reports.reverse()
    reports.append(asdict(report))
    content = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in reports)
    paths.atomic_write(paths.HISTORY, content)


def _last_report() -> list[dict[str, Any]]:
    # Archives are replaced atomically. Mapping the snapshot lets a status poll
    # find the newest line without reading and decoding the whole history.
    try:
        with paths.HISTORY.open("rb") as stream:
            if os.fstat(stream.fileno()).st_size == 0:
                return []
            with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as content:
                end = len(content)
                if content[end - 1] == 10:
                    end -= 1
                while end > 0:
                    start = content.rfind(b"\n", 0, end)
                    try:
                        report = json.loads(content[start + 1 : end])
                    except (json.JSONDecodeError, UnicodeError):
                        report = None
                    if isinstance(report, dict):
                        return [report]
                    end = start
    except FileNotFoundError:
        pass
    return []


def history(limit: int | None) -> list[dict[str, Any]]:
    if limit == 1:
        return _last_report()
    reports: deque[dict[str, Any]] = deque(maxlen=limit)
    try:
        with paths.HISTORY.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    report = json.loads(line)
                    if isinstance(report, dict):
                        reports.append(report)
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        pass
    return list(reversed(reports))


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258  # WAIT_TIMEOUT
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def current_run() -> dict[str, Any] | None:
    try:
        snapshot = json.loads(paths.CURRENT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    if not isinstance(snapshot, dict):
        return None
    pid = snapshot.pop("pid", None)
    if type(pid) is int and 0 < pid <= 2**31 - 1 and _pid_alive(pid):
        return snapshot
    return None


def log_lines(limit: int) -> list[str]:
    lines: deque[str] = deque(maxlen=limit)
    for suffix in (".3", ".2", ".1", ""):
        try:
            with (paths.LOGS / (LOG_NAME + suffix)).open(
                encoding="utf-8", errors="replace"
            ) as stream:
                lines.extend(line.rstrip("\r\n") for line in stream)
        except FileNotFoundError:
            continue
    return list(lines)


def stop_requested(run_id: str) -> bool:
    return (paths.DATA / f"cancel-{run_id}").exists()


def cancellation_watch(run_id: str, done: threading.Event) -> None:
    while not done.wait(0.2):
        if stop_requested(run_id):
            if os.name == "nt":
                _thread.interrupt_main()
            else:
                os.kill(os.getpid(), signal.SIGINT)
            return


def recent_files(limit: int) -> Iterator[dict[str, Any]]:
    remaining = limit
    for report in history(limit=None):
        for entry in reversed(report["new_files"]):
            if remaining == 0:
                return
            yield entry
            remaining -= 1


class SyncRunner:
    def __init__(self) -> None:
        self._start_lock = threading.Lock()
        self.session = {"state": "unknown", "checked_at": None}

    def current(self) -> dict[str, Any] | None:
        return current_run()

    def runs(self, limit: int) -> list[dict[str, Any]]:
        return history(limit)

    def files(self, limit: int) -> list[dict[str, Any]]:
        return list(recent_files(limit))

    def logs(self, lines: int) -> list[str]:
        return log_lines(lines)

    def set_session(self, state: str, checked_at: str | None = None) -> None:
        self.session = {
            "state": state if state in {"valid", "expired"} else "unknown",
            "checked_at": checked_at or now_iso(),
        }

    def start(self, dry_run: bool = False, course: str | None = None) -> str:
        with self._start_lock:
            directory = TemporaryDirectory(dir=self._data_dir())
            report_path = Path(directory.name) / "report.json"
            handshake = Path(directory.name) / "started.json"
            command = [
                sys.executable,
                "-m",
                "ilias_sync",
                "run",
                "--trigger",
                "manual",
                "--report-json",
                str(report_path),
            ]
            if dry_run:
                command.append("--dry-run")
            if course is not None:
                command.extend(["--course=" + course])
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
                if os.name == "nt"
                else 0,
                env={**os.environ, "ILIAS_SYNC_START_REPORT": str(handshake)},
            )
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if handshake.exists():
                    run_id = json.loads(handshake.read_text(encoding="utf-8"))["run_id"]
                    threading.Thread(
                        target=self._reap, args=(process, directory), daemon=True
                    ).start()
                    return run_id
                code = process.poll()
                if code is not None:
                    if handshake.exists():
                        run_id = json.loads(handshake.read_text(encoding="utf-8"))[
                            "run_id"
                        ]
                        directory.cleanup()
                        return run_id
                    directory.cleanup()
                    if code == BUSY_EXIT:
                        raise AlreadyRunning(
                            "Ein Sync oder eine Session-Prüfung läuft bereits."
                        )
                    raise RuntimeError(
                        "Der Sync-Prozess konnte nicht gestartet werden."
                    )
                time.sleep(0.02)
            process.terminate()
            process.wait()
            directory.cleanup()
            raise RuntimeError("Der Sync-Prozess antwortet nicht.")

    @staticmethod
    def _reap(process: subprocess.Popen, directory: TemporaryDirectory) -> None:
        process.wait()
        directory.cleanup()

    def cancel(self) -> bool:
        current = self.current()
        if current is None:
            return False
        marker = paths.DATA / f"cancel-{current['run_id']}"
        paths.atomic_write(marker, "")
        active = self.current()
        if active is None or active["run_id"] != current["run_id"]:
            marker.unlink(missing_ok=True)
        return True

    @staticmethod
    def _data_dir() -> os.PathLike[str]:
        paths.DATA.mkdir(parents=True, exist_ok=True)
        return paths.DATA
