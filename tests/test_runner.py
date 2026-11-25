import json
import threading
import time
from pathlib import Path

import pytest

from ilias_sync import paths
from ilias_sync.cli import parser, run_command
from ilias_sync.runner import AlreadyRunning, BrowserLock, SyncRunner


@pytest.fixture
def isolated_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in {
        "DATA": tmp_path,
        "LOGS": tmp_path / "logs",
        "LOCK": tmp_path / "browser.lock",
        "HISTORY": tmp_path / "history.jsonl",
        "CURRENT": tmp_path / "current.json",
        "CONFIG": tmp_path / "config.yaml",
    }.items():
        monkeypatch.setattr(paths, name, value)
    monkeypatch.setattr("ilias_sync.cli.setup_logging", lambda _: None)


def test_scheduled_run_shares_lock_and_can_be_cancelled(
    isolated_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    runner = SyncRunner()
    with BrowserLock(), pytest.raises(AlreadyRunning), BrowserLock():
        pytest.fail("Doppelter Lock wurde zugelassen")

    def simulate_browser(*args: object, **kwargs: object) -> None:
        if not runner.cancel():
            pytest.fail("Lauf konnte nicht gefunden werden")
        # Windows delivers the exception at the next Python instruction. A
        # timed Event avoids a tight loop and caps the wait if cancellation fails.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            threading.Event().wait(0.05)
        pytest.fail("Lauf wurde nicht unterbrochen")

    monkeypatch.setattr("ilias_sync.cli.run_sync", simulate_browser)
    args = parser().parse_args(
        ["run", "--trigger", "schedule", "--report-json", str(tmp_path / "run.json")]
    )
    assert run_command(args) == 130
    assert runner.current() is None
    [report] = runner.runs(1)
    assert report["result"] == "cancelled"
    assert report["trigger"] == "schedule"
    assert json.loads((tmp_path / "run.json").read_text()) == report


def test_current_snapshot_and_lock_retry(isolated_paths, monkeypatch):
    from ilias_sync import runner
    from ilias_sync.reports import RunReport

    monkeypatch.setattr(runner, "_pid_alive", lambda pid: pid == runner.os.getpid())
    report = RunReport("active", "schedule")
    with BrowserLock():
        runner.write_current(report)
        assert runner.current_run()["run_id"] == "active"
        assert "pid" not in runner.current_run()
    snapshot = json.loads(paths.CURRENT.read_text())
    paths.CURRENT.write_text(json.dumps({**snapshot, "pid": 0}))
    assert runner.current_run() is None

    acquired = threading.Event()
    release = threading.Event()

    def hold_lock():
        with BrowserLock():
            acquired.set()
            release.wait(2)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    try:
        assert acquired.wait(1)
        monkeypatch.setattr(
            runner.time, "sleep", lambda _: (release.set(), holder.join(1))
        )
        with BrowserLock(timeout=1):
            assert not holder.is_alive()
    finally:
        release.set()
        holder.join(2)


def test_scheduled_login_fallback_retries_under_lock(isolated_paths, monkeypatch):
    from ilias_sync import cli
    from ilias_sync.crawler import SessionExpiredError

    calls = []

    def sync(options, headful, report, on_progress):
        calls.append("sync")
        if len(calls) == 1:
            raise SessionExpiredError

    def login(config):
        with pytest.raises(AlreadyRunning), BrowserLock():
            pytest.fail("Browser lock released before visible login")
        calls.append("login")
        return True

    monkeypatch.setattr(cli, "run_sync", sync)
    monkeypatch.setattr(cli.notifications, "in_gui_session", lambda: True)
    monkeypatch.setattr(cli.auth, "visible_login", login)
    monkeypatch.setattr(
        cli.notifications, "notify", lambda report: calls.append(report.result)
    )
    assert run_command(parser().parse_args(["run", "--trigger", "schedule"])) == 0
    assert calls == ["sync", "login", "sync", "success"]
    assert [r["result"] for r in SyncRunner().runs(500)] == [
        "success",
        "session_expired",
    ]


def test_archive_caps_history(isolated_paths):
    from ilias_sync.reports import RunReport
    from ilias_sync.runner import HISTORY_LIMIT, archive

    paths.HISTORY.write_text(
        "".join(json.dumps({"run_id": i}) + "\n" for i in range(510))
    )
    with BrowserLock():
        archive(RunReport("newest", "cli"))
    reports = SyncRunner().runs(600)
    assert len(reports) == HISTORY_LIMIT
    assert reports[0]["run_id"] == "newest"
    assert reports[-1]["run_id"] == 11
