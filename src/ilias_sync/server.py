"""Local HTTP API and static UI."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import subprocess
import sys
import threading
import webbrowser
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated, Any, Literal

import uvicorn
import yaml
from fastapi import Body, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from keyring.errors import KeyringError
from pydantic import BaseModel, StrictBool
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from . import __version__, auth, onboarding, paths, schedule, shell_command
from .config import (
    DEFAULT_KEYCHAIN_SERVICE,
    Config,
    ConfigError,
    load_config,
    save_config,
    validate_config,
)
from .runner import (
    AlreadyRunning,
    BrowserLock,
    SyncOptions,
    SyncRunner,
    disk_log_handler,
)

LOGGER = logging.getLogger("ilias-sync")


class ApiError(Exception):
    def __init__(self, status: int, error: str, message: str):
        self.status = status
        self.body: dict[str, Any] = {"error": error, "message": message}


SYNC_FLAGS = SyncOptions.FLAGS
SYNC_TEXT_FIELDS = {"course": "Kurs", "semester": "Semester"}
MAX_TEXT_OPTION = 300


def sync_options(body: Any) -> SyncOptions:
    """Validate the body of ``POST /api/sync`` (the options of ``ilias-sync run``)."""
    if body is None:
        return SyncOptions()
    if not isinstance(body, dict):
        raise invalid_sync({"sync": "Bitte ein JSON-Objekt angeben."})
    fields: dict[str, str] = {
        str(key): "Unbekannte Option."
        for key in body.keys() - {*SYNC_FLAGS, *SYNC_TEXT_FIELDS, "max_depth"}
    }
    values: dict[str, Any] = {}
    for key in SYNC_FLAGS:
        value = body.get(key, False)
        if type(value) is not bool:
            fields[key] = "Bitte true oder false angeben."
        values[key] = value
    for key, label in SYNC_TEXT_FIELDS.items():
        value = body.get(key)
        if isinstance(value, str):
            value = value.strip() or None
        if value is not None and (
            not isinstance(value, str)
            or len(value) > MAX_TEXT_OPTION
            or any(ord(character) < 32 for character in value)
        ):
            fields[key] = f"{label}: Bitte einen einzeiligen Text angeben."
        values[key] = value
    depth = body.get("max_depth")
    if depth is not None and (type(depth) is not int or not 1 <= depth <= 100):
        fields["max_depth"] = "Bitte eine ganze Zahl von 1 bis 100 angeben."
    values["max_depth"] = depth
    if fields:
        raise invalid_sync(fields)
    return SyncOptions(**values)


def invalid_sync(fields: dict[str, str]) -> ApiError:
    error = ApiError(422, "invalid_sync_options", "Bitte prüfe die Sync-Optionen.")
    error.body["fields"] = fields
    return error


class RevealRequest(BaseModel):
    which: Literal["config", "data", "logs"]


class PathRequest(BaseModel):
    path: str


class FolderRequest(BaseModel):
    which: Literal["download", "local"]


class ScheduleRequest(BaseModel):
    enabled: StrictBool
    time: str = "09:00"
    run_at_login: StrictBool = False


def mask_username(username: str) -> str:
    if len(username) < 4:
        return "***"
    return f"{username[:2]}***{username[-1]}"


def open_path(path: Path, reveal: bool = False) -> None:
    if sys.platform == "darwin":
        subprocess.Popen(["open", *(["-R"] if reveal else []), str(path)])
    elif sys.platform == "win32":
        if reveal:
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(path)
    else:
        subprocess.Popen(["xdg-open", str(path.parent if reveal else path)])


def protected_file(value: str) -> Path:
    config = load_config()
    try:
        candidate = Path(value).expanduser()
        if not candidate.is_absolute() or "\x00" in value:
            raise ValueError()
        resolved = candidate.resolve()
        if any(
            root and resolved.is_relative_to(root.resolve())
            for root in (config.download_dir, config.local_download_dir)
        ):
            return resolved
    except (OSError, ValueError, RuntimeError):
        pass
    raise ApiError(
        403, "forbidden_path", "Der Pfad liegt außerhalb der Download-Ordner."
    )


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


class Events:
    def __init__(self, runner: SyncRunner, status: Callable[[], dict[str, Any]]):
        self.runner = runner
        self.status = status
        self.listeners: set[asyncio.Queue[str]] = set()
        self.subscription_lock = asyncio.Lock()
        self.snapshot: tuple[dict[str, Any], list[str]] | None = None

    def publish(self, event: str, data: dict[str, Any]) -> None:
        message = sse(event, data)
        for queue in self.listeners:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)

    async def watch(self) -> None:
        while True:
            if self.listeners and self.snapshot is not None:
                try:
                    await self.refresh()
                except Exception:
                    LOGGER.debug(
                        "SSE-Daten konnten nicht gelesen werden.", exc_info=True
                    )
            await asyncio.sleep(0.4)

    async def refresh(self) -> None:
        snapshot = self.snapshot
        if snapshot is None:
            return
        previous_status, previous_logs = snapshot
        status = await run_in_threadpool(self.status)
        logs = await run_in_threadpool(self.runner.logs, 2048)
        if self.snapshot is not snapshot:
            return
        overlap = min(len(previous_logs), len(logs))
        while overlap and previous_logs[-overlap:] != logs[:overlap]:
            overlap -= 1
        for line in logs[overlap:]:
            self.publish("log", {"line": line})
        if status != previous_status:
            self.publish("status", status)
        last_run = status["last_run"]
        old_run = previous_status["last_run"]
        if last_run and (not old_run or last_run["run_id"] != old_run["run_id"]):
            runs = await run_in_threadpool(self.runner.runs, 100)
            pending = []
            for run_report in runs:
                if old_run and run_report["run_id"] == old_run["run_id"]:
                    break
                pending.append(run_report)
            if self.snapshot is not snapshot:
                return
            for run_report in reversed(pending):
                self.publish("run_finished", run_report)
        self.snapshot = status, logs

    async def stream(self) -> AsyncIterator[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=4096)
        async with self.subscription_lock:
            initial = await run_in_threadpool(self.status)
            if not self.listeners:
                logs = await run_in_threadpool(self.runner.logs, 2048)
                self.snapshot = initial, logs
            self.listeners.add(queue)
        try:
            yield sse("status", initial)
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            self.listeners.discard(queue)
            if not self.listeners:
                self.snapshot = None


def create_app(runner: SyncRunner | None = None) -> FastAPI:
    runner = runner if runner is not None else SyncRunner()
    config_lock = threading.Lock()
    schedule_lock = threading.Lock()
    credentials_lock = threading.Lock()
    presence_lock = threading.Lock()
    presence_token = object()
    credentials_present: bool | None = None  # None: Schlüsselbund-Prüfung läuft noch

    def refresh_credentials(service: str) -> None:
        nonlocal presence_token, credentials_present
        token = object()
        with presence_lock:
            presence_token = token
            credentials_present = None

        def probe() -> None:
            nonlocal credentials_present
            try:
                present = auth.credentials_configured(service)
            except (KeyringError, OSError, ValueError):
                return
            with presence_lock:
                if presence_token is token:
                    credentials_present = present

        threading.Thread(target=probe, daemon=True).start()

    def credential_service() -> str:
        try:
            return load_config().keychain_service
        except ConfigError:
            return DEFAULT_KEYCHAIN_SERVICE

    def status() -> dict[str, Any]:
        current = runner.current()
        last_run = next(iter(runner.runs(1)), None)
        session = runner.session
        if last_run and last_run["finished_at"]:
            state = {
                "success": "valid",
                "errors": "valid",
                "session_expired": "expired",
                "offline": "unknown",
            }.get(last_run["result"])
            checked_at = last_run["finished_at"]
            if state and (
                session["checked_at"] is None or checked_at > session["checked_at"]
            ):
                session = {"state": state, "checked_at": checked_at}
        return {
            "running": current is not None,
            "current": current,
            "last_run": last_run,
            "session": session,
            "credentials_configured": bool(credentials_present),
            "setup": onboarding.setup_state(credentials_present),
            "schedule": schedule.status(),
            "version": __version__,
        }

    events = Events(runner, status)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        refresh_credentials(credential_service())
        watch = asyncio.create_task(events.watch())
        try:
            yield
        finally:
            watch.cancel()
            with suppress(asyncio.CancelledError):
                await watch

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_requests(request: Request, next_handler: Callable) -> Any:
        host = request.headers.get("host", "").partition(":")[0].lower()
        origin = request.headers.get("origin")
        allowed_hosts = {"127.0.0.1", "localhost"}
        if request.client and request.client.host == "testclient":
            allowed_hosts.add("testserver")
        if host not in allowed_hosts or (
            origin and origin != f"http://{request.headers.get('host')}"
        ):
            return JSONResponse(
                status_code=403,
                content={
                    "error": "forbidden_origin",
                    "message": "Die API ist nur lokal erreichbar.",
                },
            )
        return await next_handler(request)

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.body)

    @app.exception_handler(AlreadyRunning)
    async def busy(_: Request, exc: AlreadyRunning) -> JSONResponse:
        return JSONResponse(
            status_code=409, content={"error": "already_running", "message": str(exc)}
        )

    @app.exception_handler(ConfigError)
    async def config_error(_: Request, exc: ConfigError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_config",
                "message": str(exc),
                "fields": exc.fields,
            },
        )

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_request",
                "message": "Bitte prüfe die Eingabefelder.",
            },
        )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        messages = {
            404: "Die angeforderte Adresse wurde nicht gefunden.",
            405: "Diese HTTP-Methode ist an dieser Adresse nicht verfügbar.",
        }
        return JSONResponse(
            status_code=exc.status_code,
            headers=exc.headers,
            content={
                "error": f"http_{exc.status_code}",
                "message": messages.get(exc.status_code, "HTTP-Fehler."),
            },
        )

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "message": "Die Aktion konnte nicht ausgeführt werden.",
            },
        )

    @app.get("/api/status")
    async def get_status() -> dict[str, Any]:
        return status()

    @app.post("/api/sync", status_code=202)
    def start_sync(body: Annotated[Any, Body()] = None) -> dict[str, str]:
        return {"run_id": runner.start(sync_options(body))}

    @app.post("/api/sync/cancel")
    def cancel_sync() -> dict[str, bool]:
        return {"cancelled": runner.cancel()}

    @app.get("/api/runs")
    def runs(limit: int = Query(20, ge=1)) -> list[dict[str, Any]]:
        return runner.runs(limit)

    @app.get("/api/files/recent")
    def files(limit: int = Query(50, ge=1)) -> list[dict[str, Any]]:
        return runner.files(limit)

    @app.post("/api/files/open")
    def open_file(body: PathRequest) -> dict[str, bool]:
        path = protected_file(body.path)
        if not path.is_file():
            raise ApiError(404, "file_not_found", "Die Datei wurde nicht gefunden.")
        open_path(path)
        return {"opened": True}

    @app.post("/api/files/reveal")
    def reveal_file(body: PathRequest) -> dict[str, bool]:
        path = protected_file(body.path)
        if not path.is_file():
            raise ApiError(404, "file_not_found", "Die Datei wurde nicht gefunden.")
        open_path(path, reveal=True)
        return {"opened": True}

    @app.post("/api/folders/open")
    def open_folder(body: FolderRequest) -> dict[str, bool]:
        config = load_config()
        path = (
            config.download_dir
            if body.which == "download"
            else config.local_download_dir
        )
        if path is None:
            raise ApiError(
                404, "folder_not_configured", "Dieser Ordner ist nicht konfiguriert."
            )
        path.mkdir(parents=True, exist_ok=True)
        open_path(path)
        return {"opened": True}

    @app.get("/api/logs")
    def logs(lines: int = Query(200, ge=1)) -> dict[str, list[str]]:
        return {"lines": runner.logs(lines)}

    @app.get("/api/events")
    async def stream_events() -> StreamingResponse:
        return StreamingResponse(
            events.stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/config")
    def get_config() -> dict[str, Any]:
        return load_config().to_dict()

    @app.get("/api/config/defaults")
    def get_config_defaults() -> dict[str, Any]:
        return Config().to_dict()

    @app.get("/api/setup/suggestions")
    def setup_suggestions() -> dict[str, Any]:
        return {
            "download_dirs": onboarding.folder_suggestions(),
            "defaults": Config().to_dict(),
        }

    @app.post("/api/setup/complete")
    def setup_complete() -> dict[str, bool]:
        # Ohne Zugangsdaten kann ILIAS Sync nichts abrufen: die Einrichtung
        # lässt sich erst abschließen, wenn sie im Schlüsselbund liegen.
        with credentials_lock:
            try:
                username = auth.credential_username(credential_service())
            except (KeyringError, UnicodeError):
                raise keyring_unavailable() from None
        if not username:
            raise ApiError(
                409,
                "credentials_missing",
                "Bitte zuerst deine ILIAS-Zugangsdaten speichern.",
            )
        with config_lock:
            if not paths.CONFIG.exists():
                save_config(load_config())
        return onboarding.mark_complete()

    @app.post("/api/setup/reset")
    def setup_reset() -> dict[str, bool]:
        onboarding.reset()
        return onboarding.setup_state(credentials_present)

    @app.get("/api/config/yaml")
    def get_config_yaml() -> dict[str, Any]:
        config = load_config().to_dict()
        return {
            "path": str(paths.CONFIG),
            "exists": paths.CONFIG.exists(),
            "yaml": yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
        }

    def runtime_paths() -> dict[str, Path]:
        return {"config": paths.CONFIG, "data": paths.DATA, "logs": paths.LOGS}

    @app.get("/api/paths")
    def get_paths() -> dict[str, dict[str, Any]]:
        return {
            key: {"path": str(path), "exists": path.exists()}
            for key, path in runtime_paths().items()
        }

    @app.post("/api/paths/reveal")
    def reveal_path(body: RevealRequest) -> dict[str, bool]:
        path = runtime_paths()[body.which]
        if body.which == "config":
            if path.is_file():
                open_path(path, reveal=True)
                return {"opened": True}
            path = path.parent
        path.mkdir(parents=True, exist_ok=True)
        open_path(path)
        return {"opened": True}

    @app.put("/api/config")
    def put_config(body: Annotated[Any, Body()] = None) -> dict[str, Any]:
        with config_lock:
            if not isinstance(body, dict):
                raise ConfigError({"config": "Bitte ein JSON-Objekt angeben."})
            try:
                current_config = load_config().to_dict()
            except ConfigError:
                current_config = {}
                # An invalid on-disk configuration can be replaced through the API.
            config = validate_config(
                {**current_config, **body},
                allow_root_only="max_depth" not in body
                and current_config.get("max_depth") == 0,
            )
            save_config(config)
            if config.keychain_service != current_config.get("keychain_service"):
                refresh_credentials(config.keychain_service)
            return config.to_dict()

    @app.get("/api/credentials")
    def credentials() -> dict[str, Any]:
        with credentials_lock:
            try:
                username = auth.credential_username(credential_service())
            except (KeyringError, UnicodeError):
                username = None
        return {
            "configured": bool(username),
            "username": mask_username(username) if username else None,
        }

    def keyring_unavailable() -> ApiError:
        return ApiError(
            500, "keyring_unavailable", "Der System-Schlüsselbund ist nicht verfügbar."
        )

    def change_credentials(operation: Callable[[str], None], present: bool) -> None:
        nonlocal presence_token, credentials_present
        with credentials_lock:
            service = credential_service()
            try:
                operation(service)
            except (KeyringError, UnicodeError):
                with config_lock:
                    if credential_service() == service:
                        refresh_credentials(service)
                raise keyring_unavailable() from None
            with config_lock:
                if credential_service() == service:
                    with presence_lock:
                        presence_token = object()
                        credentials_present = present

    @app.put("/api/credentials")
    def put_credentials(body: Annotated[Any, Body()] = None) -> dict[str, Any]:
        data = body if isinstance(body, dict) else {}
        username, password = data.get("username"), data.get("password")
        fields = auth.credential_errors(username, password)
        if fields:
            error = ApiError(
                422, "invalid_credentials", "Bitte Benutzername und Passwort prüfen."
            )
            error.body["fields"] = fields
            raise error
        change_credentials(
            lambda service: auth.set_credentials(username, password, service), True
        )
        return {"configured": True, "username": mask_username(username)}

    @app.delete("/api/credentials")
    def delete_credentials() -> dict[str, Any]:
        change_credentials(auth.delete_credentials, False)
        return {"configured": False, "username": None}

    @app.post("/api/session/check")
    def check_session() -> dict[str, str]:
        with BrowserLock():
            paths.CURRENT.unlink(missing_ok=True)
            state = auth.check_session(load_config())
            runner.set_session(state)
        return {"state": state}

    @app.post("/api/session/login", status_code=202)
    def login() -> dict[str, bool]:
        config = load_config()
        lock = BrowserLock(timeout=5)
        lock.__enter__()

        def login_worker() -> None:
            handler = None
            previous_level = LOGGER.level
            try:
                handler = disk_log_handler()
                LOGGER.addHandler(handler)
                LOGGER.setLevel(logging.INFO)
                paths.CURRENT.unlink(missing_ok=True)
                if auth.visible_login(config):
                    runner.set_session("valid")
                else:
                    LOGGER.info("Der Login wurde nicht bestätigt.")
                    runner.set_session("expired")
            except Exception:  # noqa: BLE001 — report background failures through SSE
                LOGGER.error("Der Login konnte nicht abgeschlossen werden.")
                runner.set_session("unknown")
            finally:
                if handler:
                    LOGGER.removeHandler(handler)
                    handler.close()
                LOGGER.setLevel(previous_level)
                lock.__exit__()

        try:
            threading.Thread(target=login_worker, daemon=True).start()
        except BaseException:
            lock.__exit__()
            raise
        return {"started": True}

    @app.get("/api/shell-command")
    def get_shell_command() -> shell_command.Status:
        return shell_command.status()

    @app.post("/api/shell-command/install")
    def install_shell_command() -> shell_command.Status:
        try:
            return shell_command.install()
        except (OSError, RuntimeError) as exc:
            raise ApiError(422, "shell_command_install_failed", str(exc)) from exc

    @app.post("/api/shell-command/uninstall")
    def uninstall_shell_command() -> shell_command.Status:
        try:
            return shell_command.uninstall()
        except OSError as exc:
            raise ApiError(422, "shell_command_uninstall_failed", str(exc)) from exc

    browser_install: dict[str, Any] = {"running": False, "error": None}
    browser_lock = threading.Lock()

    def browser_module() -> Any:
        try:
            return importlib.import_module(f"{__package__}.browser")
        except ModuleNotFoundError as exc:
            if exc.name != f"{__package__}.browser":
                raise
            raise ApiError(
                503,
                "browser_unavailable",
                "Die Browser-Verwaltung ist in dieser Version nicht verfügbar.",
            ) from None

    @app.get("/api/browser")
    def get_browser() -> dict[str, Any]:
        module = browser_module()
        with browser_lock:
            installing = browser_install["running"]
            error = browser_install["error"]
        result = dict(module.status())
        return {
            "installed": bool(result.get("installed")),
            "executable": result.get("executable"),
            "installing": installing,
            "error": error,
        }

    @app.post("/api/browser/install", status_code=202)
    def install_browser() -> dict[str, bool]:
        module = browser_module()
        with browser_lock:
            if browser_install["running"]:
                raise ApiError(
                    409,
                    "already_installing",
                    "Die Browser-Komponente wird bereits installiert.",
                )
            lock = BrowserLock(timeout=5)
            lock.__enter__()
            browser_install.update(running=True, error=None)

        def install_worker() -> None:
            handler = None
            previous_level = LOGGER.level
            error = None
            try:
                handler = disk_log_handler()
                LOGGER.addHandler(handler)
                LOGGER.setLevel(logging.INFO)
                LOGGER.info("Installiere die Browser-Komponente (Chromium) …")
                module.install(lambda line: LOGGER.info("%s", str(line).rstrip()[:500]))
                LOGGER.info("Browser-Komponente installiert.")
            except Exception as exc:  # noqa: BLE001 — report failures through SSE
                error = "Die Browser-Komponente konnte nicht installiert werden."
                if isinstance(exc, RuntimeError) and str(exc):
                    error = str(exc)
                LOGGER.error("%s", error)
            finally:
                if handler:
                    LOGGER.removeHandler(handler)
                    handler.close()
                LOGGER.setLevel(previous_level)
                lock.__exit__()
                with browser_lock:
                    browser_install.update(running=False, error=error)

        try:
            threading.Thread(target=install_worker, daemon=True).start()
        except BaseException:
            with browser_lock:
                browser_install.update(running=False)
            lock.__exit__()
            raise
        return {"started": True}

    @app.get("/api/schedule")
    def get_schedule() -> dict[str, Any]:
        return schedule.status()

    @app.put("/api/schedule")
    def put_schedule(body: ScheduleRequest) -> dict[str, Any]:
        with schedule_lock:
            try:
                return schedule.configure(body.enabled, body.time, body.run_at_login)
            except ValueError as exc:
                raise ApiError(422, "invalid_schedule", str(exc)) from exc

    web = Path(__file__).with_name("web")
    if (web / "index.html").is_file():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    else:

        @app.get("/", response_class=HTMLResponse)
        def landing() -> str:
            return '<html lang="de"><meta charset="utf-8"><title>ILIAS Sync</title><p>Die Oberfläche ist in dieser Installation nicht verfügbar.</p></html>'

    return app


def run(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = False) -> None:
    if host != "127.0.0.1":
        raise ValueError("ILIAS Sync kann nur an 127.0.0.1 gebunden werden.")
    if open_browser:
        threading.Timer(0.75, webbrowser.open, args=(f"http://{host}:{port}/",)).start()
    uvicorn.run(create_app(), host=host, port=port)
