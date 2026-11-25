from dataclasses import asdict
from pathlib import Path
from threading import Event
from time import monotonic, sleep

import pytest
from fastapi.testclient import TestClient

from ilias_sync import paths
from ilias_sync.config import Config, save_config
from ilias_sync.reports import RunReport
from ilias_sync.runner import AlreadyRunning, SyncRunner
from ilias_sync.server import create_app


class FakeRunner(SyncRunner):
    report = None

    def current(self) -> dict | None:
        return self.report

    def runs(self, limit: int) -> list[dict]:
        return []

    def start(self, dry_run: bool, course: str | None) -> str:
        if self.report:
            raise AlreadyRunning("Ein Sync läuft bereits.")
        self.report = asdict(RunReport("20261125-192753", "manual", dry_run=dry_run))
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
    with TestClient(create_app(FakeRunner())) as api:
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
        "schedule": {"supported": False, "instructions": "Test"},
        "version": "0.1.0",
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
    with TestClient(create_app(FakeRunner())) as api:
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
