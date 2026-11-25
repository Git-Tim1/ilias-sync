from dataclasses import asdict
from pathlib import Path
from threading import Event
from time import monotonic, sleep

import pytest
from fastapi.testclient import TestClient

from ilias_sync import paths
from ilias_sync.config import Config, save_config
from ilias_sync.reports import RunReport
from ilias_sync.runner import AlreadyRunning, SyncOptions, SyncRunner
from ilias_sync.server import create_app


class FakeRunner(SyncRunner):
    report = None
    options: SyncOptions | None = None

    def current(self) -> dict | None:
        return self.report

    def runs(self, limit: int) -> list[dict]:
        return []

    def start(self, options: SyncOptions | None = None) -> str:
        options = options or SyncOptions()
        if self.report:
            raise AlreadyRunning("Ein Sync läuft bereits.")
        self.options = options
        self.report = asdict(
            RunReport("20261125-192753", "manual", dry_run=options.dry_run)
        )
        return self.report["run_id"]

    def cancel(self) -> bool:
        self.report = None
        return True


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(paths, "CONFIG", tmp_path / "config.yaml")
    monkeypatch.setattr("ilias_sync.auth.credential_username", lambda service: "abcdez")
    monkeypatch.setattr(
        "ilias_sync.schedule.status",
        lambda: {"supported": False, "instructions": "Test"},
    )
    save_config(Config(download_dir=tmp_path / "downloads"))
    monkeypatch.setattr("ilias_sync.auth.credentials_configured", lambda service: True)
    runner = FakeRunner()
    with TestClient(create_app(runner)) as api:
        api.fake_runner = runner  # type: ignore[attr-defined]
        deadline = monotonic() + 1
        while not api.get("/api/status").json()["credentials_configured"]:
            assert monotonic() < deadline
            sleep(0.01)
        yield api


def test_status_and_duplicate_start(client: TestClient) -> None:
    assert client.get("/api/status").json() == {
        "running": False,
        "current": None,
        "last_run": None,
        "session": {"state": "unknown", "checked_at": None},
        "credentials_configured": True,
        "setup": {"completed": False, "required": False},
        "schedule": {"supported": False, "instructions": "Test"},
        "version": "0.2.1",
    }
    started = client.post("/api/sync", json={"dry_run": True, "course": None})
    assert started.status_code == 202
    status = client.get("/api/status").json()
    assert status["running"] is True
    assert status["current"]["run_id"] == started.json()["run_id"]
    assert status["current"]["dry_run"] is True
    conflict = client.post("/api/sync", json={})
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "already_running"
    assert client.post("/api/sync/cancel").json() == {"cancelled": True}


def test_path_protection(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "downloads"
    root.mkdir()
    inside = root / "inside.pdf"
    inside.touch()
    outside = tmp_path / "outside.pdf"
    outside.touch()
    link = root / "link.pdf"
    link.symlink_to(outside)
    opened = []
    monkeypatch.setattr("ilias_sync.server.open_path", opened.append)
    for action in ("open", "reveal"):
        for path in (outside, root / ".." / outside.name, link, Path("relative.pdf")):
            response = client.post(f"/api/files/{action}", json={"path": str(path)})
            assert response.status_code == 403
    assert opened == []
    assert client.post("/api/files/open", json={"path": str(inside)}).status_code == 200
    assert opened == [inside.resolve()]


def test_credentials_are_masked(client: TestClient) -> None:
    assert client.get("/api/credentials").json() == {
        "configured": True,
        "username": "ab***z",
    }


def test_config_update(client: TestClient) -> None:
    response = client.put(
        "/api/config", json={"max_depth": 0, "overwrite": "true", "file_extensions": []}
    )
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_config"
    assert set(response.json()["fields"]) == {
        "max_depth",
        "overwrite",
        "file_extensions",
    }
    good = client.put("/api/config", json={"max_depth": 5})
    assert good.status_code == 200
    assert client.get("/api/config").json() == good.json()
    assert good.json()["max_depth"] == 5


def test_cross_origin_rejected(client: TestClient) -> None:
    response = client.post("/api/sync", headers={"Origin": "https://external.example"})
    assert response.status_code == 403


def test_events_publish_log_status_and_finished_run() -> None:
    import asyncio

    from ilias_sync.server import Events

    class EventRunner(FakeRunner):
        finished = None
        line = None

        def runs(self, limit: int) -> list[dict]:
            return [self.finished] if self.finished else []

        def logs(self, lines: int) -> list[str]:
            return [self.line] if self.line else []

    async def receive() -> None:
        runner = EventRunner()
        events = Events(runner, lambda: {"last_run": runner.finished})
        stream = events.stream()
        try:
            assert (await anext(stream)).startswith("event: status\n")
            runner.line = "Testlauf abgeschlossen"
            runner.finished = asdict(
                RunReport("test-run", "schedule", result="success")
            )
            await events.refresh()
            assert (await asyncio.wait_for(anext(stream), 1)).startswith("event: log\n")
            assert (await asyncio.wait_for(anext(stream), 1)).startswith(
                "event: status\n"
            )
            ended = await asyncio.wait_for(anext(stream), 1)
            assert ended.startswith("event: run_finished\n")
            assert '"run_id": "test-run"' in ended
        finally:
            await stream.aclose()

    asyncio.run(receive())


def test_status_does_not_wait_for_keychain(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "CONFIG", tmp_path / "config.yaml")
    started, release = Event(), Event()

    def blocked_presence(service):
        started.set()
        return release.wait(5)

    def forbidden(*args):
        pytest.fail("Status attempted to read a credential")

    monkeypatch.setattr("ilias_sync.auth.credentials_configured", blocked_presence)
    monkeypatch.setattr("ilias_sync.auth.load_credentials", forbidden)
    monkeypatch.setattr("ilias_sync.auth.credential_username", forbidden)
    runner = FakeRunner()
    with TestClient(create_app(runner)) as api:
        api.fake_runner = runner  # type: ignore[attr-defined]
        try:
            assert started.wait(1)
            start = monotonic()
            assert api.get("/api/status").json()["credentials_configured"] is False
            assert monotonic() - start < 0.2
        finally:
            release.set()


def test_credentials_fields_and_cache(client, monkeypatch):
    response = client.put("/api/credentials", json={"username": "", "password": 123})
    assert response.status_code == 422
    assert set(response.json()["fields"]) == {"username", "password"}
    calls = []
    monkeypatch.setattr(
        "ilias_sync.auth.delete_credentials", lambda service: calls.append(service)
    )
    monkeypatch.setattr(
        "ilias_sync.auth.set_credentials",
        lambda user, password, service: calls.append((user, password, service)),
    )
    client.put("/api/config", json={"keychain_service": "fixture-service"})
    assert client.delete("/api/credentials").json()["configured"] is False
    assert client.get("/api/status").json()["credentials_configured"] is False
    result = client.put(
        "/api/credentials", json={"username": "fixture", "password": "test"}
    )
    assert result.json() == {"configured": True, "username": "fi***e"}
    assert client.get("/api/status").json()["credentials_configured"] is True
    assert calls == ["fixture-service", ("fixture", "test", "fixture-service")]


def test_setup_flow_and_suggestions(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    suggestions = client.get("/api/setup/suggestions").json()
    first = suggestions["download_dirs"][0]
    assert first["id"] == "documents"
    assert first["path"].endswith("Uni")
    assert suggestions["defaults"]["auto_login"] is True
    assert client.get("/api/config/defaults").json()["max_depth"] == 10
    assert client.post("/api/setup/complete").json() == {
        "completed": True,
        "required": False,
    }
    assert client.get("/api/status").json()["setup"]["completed"] is True
    client.post("/api/setup/reset")
    assert client.get("/api/status").json()["setup"]["completed"] is False


def test_setup_complete_requires_credentials(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("ilias_sync.auth.credential_username", lambda service: None)
    response = client.post("/api/setup/complete")
    assert response.status_code == 409
    assert response.json()["error"] == "credentials_missing"
    assert client.get("/api/status").json()["setup"]["completed"] is False


def test_setup_required_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ilias_sync import onboarding

    monkeypatch.setattr(paths, "CONFIG", tmp_path / "missing.yaml")
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    assert onboarding.setup_state(None) == {"completed": False, "required": True}
    (tmp_path / "missing.yaml").write_text("{}")
    # Existing installation: do not force the wizard while the keychain probe runs.
    assert onboarding.setup_state(None)["required"] is False
    assert onboarding.setup_state(False)["required"] is True
    onboarding.mark_complete()
    assert onboarding.setup_state(False)["required"] is False


def test_folder_suggestions_detect_cloud_folders(tmp_path: Path) -> None:
    from ilias_sync import onboarding

    (tmp_path / "Library" / "Mobile Documents" / "com~apple~CloudDocs").mkdir(
        parents=True
    )
    (tmp_path / "Library" / "CloudStorage" / "GoogleDrive-x" / "My Drive").mkdir(
        parents=True
    )
    ids = [item["id"] for item in onboarding.folder_suggestions(tmp_path)]
    assert ids == ["documents", "icloud", "google-drive-0"]


def test_sync_options_are_validated_and_forwarded(client: TestClient) -> None:
    bad = client.post(
        "/api/sync",
        json={
            "dry_run": "yes",
            "max_depth": 0,
            "course": "a\nb",
            "semester": 5,
            "rm": True,
        },
    )
    assert bad.status_code == 422
    assert bad.json()["error"] == "invalid_sync_options"
    assert set(bad.json()["fields"]) == {
        "dry_run",
        "max_depth",
        "course",
        "semester",
        "rm",
    }
    assert client.post("/api/sync", json={"max_depth": True}).status_code == 422
    good = client.post(
        "/api/sync",
        json={
            "dry_run": True,
            "course": "  [WS26/27] Softwaretechnik ",
            "semester": "",
            "max_depth": 3,
            "overwrite": True,
            "no_auto_discover": True,
            "no_auto_login": True,
            "headful": True,
            "verbose": True,
            "debug_links": True,
            "notify": True,
        },
    )
    assert good.status_code == 202
    assert client.fake_runner.options == SyncOptions(  # type: ignore[attr-defined]
        dry_run=True,
        course="[WS26/27] Softwaretechnik",
        semester=None,
        max_depth=3,
        overwrite=True,
        no_auto_discover=True,
        no_auto_login=True,
        headful=True,
        verbose=True,
        debug_links=True,
        notify=True,
    )


def test_sync_options_to_cli_arguments() -> None:
    from ilias_sync.cli import parser

    options = SyncOptions(
        dry_run=True,
        course="-[WS26/27] Kurs",
        semester="WS26/27",
        max_depth=3,
        overwrite=True,
        no_auto_discover=True,
        no_auto_login=True,
        headful=True,
        verbose=True,
        debug_links=True,
        notify=True,
    )
    args = parser().parse_args(["run", *options.to_args()])
    assert (args.dry_run, args.course, args.semester, args.max_depth) == (
        True,
        "-[WS26/27] Kurs",
        "WS26/27",
        3,
    )
    assert all(
        getattr(args, flag)
        for flag in (
            "overwrite",
            "no_auto_discover",
            "no_auto_login",
            "headful",
            "verbose",
            "debug_links",
            "notify",
        )
    )
    assert SyncOptions().to_args() == []


def test_paths_yaml_and_reveal(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(paths, "LOGS", tmp_path / "logs")
    result = client.get("/api/paths").json()
    assert result["config"] == {"path": str(tmp_path / "config.yaml"), "exists": True}
    assert result["logs"]["exists"] is False
    shown = client.get("/api/config/yaml").json()
    assert shown["path"] == str(tmp_path / "config.yaml")
    assert "max_depth: 10" in shown["yaml"]
    opened = []
    monkeypatch.setattr(
        "ilias_sync.server.open_path",
        lambda path, reveal=False: opened.append((path, reveal)),
    )
    for which in ("config", "data", "logs"):
        assert client.post("/api/paths/reveal", json={"which": which}).json() == {
            "opened": True
        }
    assert opened == [
        (tmp_path / "config.yaml", True),
        (tmp_path / "data", False),
        (tmp_path / "logs", False),
    ]
    assert (tmp_path / "logs").is_dir()
    bad = client.post("/api/paths/reveal", json={"which": "/etc"})
    assert bad.status_code == 422


def test_config_import(client: TestClient, tmp_path: Path) -> None:
    legacy = tmp_path / "old" / "config.yaml"
    legacy.parent.mkdir()
    legacy.write_text(
        "download_dir: Kurse\n"
        "current_semester: WS26/27\n"
        "courses:\n"
        "  Mathe: https://www.ilias.uni-koeln.de/ilias/goto.php/crs/1\n"
        "unknown_key: ignored\n",
        encoding="utf-8",
    )
    imported = client.post("/api/config/import", json={"path": str(legacy)})
    assert imported.status_code == 200
    data = imported.json()
    assert data["download_dir"] == str((legacy.parent / "Kurse").resolve())
    assert data["semester_filter"] == "WS26/27"
    assert data["auto_discover_current_semester"] is False
    assert client.get("/api/config").json() == data
    for path, status in (
        ("relative.yaml", 422),
        (str(tmp_path / "missing.yaml"), 404),
        (str(tmp_path / "notes.txt"), 422),
    ):
        response = client.post("/api/config/import", json={"path": path})
        assert response.status_code == status
    broken = tmp_path / "broken.yaml"
    broken.write_text("courses: [unclosed", encoding="utf-8")
    response = client.post("/api/config/import", json={"path": str(broken)})
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_config"


def test_browser_endpoints(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import sys
    import types

    monkeypatch.setattr(paths, "LOGS", tmp_path / "logs")
    monkeypatch.setattr(paths, "LOCK", tmp_path / "browser.lock")
    monkeypatch.setitem(sys.modules, "ilias_sync.browser", None)
    missing = client.get("/api/browser")
    assert missing.status_code == 503
    assert missing.json()["error"] == "browser_unavailable"
    assert client.post("/api/browser/install").status_code == 503

    release = Event()
    state = {"installed": False}

    def install(on_line):
        on_line("Downloading Chromium 1.0")
        release.wait(2)
        state["installed"] = True

    fake = types.ModuleType("ilias_sync.browser")
    fake.status = lambda: {
        "installed": state["installed"],
        "executable": "/fake/chromium" if state["installed"] else None,
    }
    fake.install = install
    monkeypatch.setitem(sys.modules, "ilias_sync.browser", fake)
    assert client.get("/api/browser").json() == {
        "installed": False,
        "executable": None,
        "installing": False,
        "error": None,
    }
    assert client.post("/api/browser/install").status_code == 202
    assert client.get("/api/browser").json()["installing"] is True
    assert client.post("/api/browser/install").status_code == 409
    release.set()
    deadline = monotonic() + 2
    while client.get("/api/browser").json()["installing"]:
        assert monotonic() < deadline
        sleep(0.01)
    assert client.get("/api/browser").json()["installed"] is True
    log = (tmp_path / "logs" / "sync.log").read_text(encoding="utf-8")
    assert "Downloading Chromium 1.0" in log

    def broken(on_line):
        raise RuntimeError("Chromium konnte nicht installiert werden (Exit-Code 1).")

    fake.install = broken
    assert client.post("/api/browser/install").status_code == 202
    deadline = monotonic() + 2
    while client.get("/api/browser").json()["installing"]:
        assert monotonic() < deadline
        sleep(0.01)
    assert "Exit-Code 1" in client.get("/api/browser").json()["error"]


def test_shell_command_endpoints(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ilias_sync import shell_command

    if not shell_command.status()["supported"]:
        pytest.skip("Symbolische Terminal-Verknüpfungen benötigen macOS oder Linux")
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    target = tmp_path / "app"
    target.touch()
    monkeypatch.setattr(shell_command, "_target", lambda: target)
    url = "/api/shell-command"
    assert not client.get(url).json()["installed"]
    installed = client.post(f"{url}/install")
    assert installed.status_code == 200
    assert installed.json()["installed"]
    link = Path(installed.json()["path"])
    assert link.readlink() == target
    assert not client.post(f"{url}/uninstall").json()["installed"]
    assert not link.is_symlink()
    link.touch()
    failed = client.post(f"{url}/install")
    assert failed.status_code == 422
    assert failed.json()["error"] == "shell_command_install_failed"
