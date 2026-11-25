"""Command-line interface."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
from dataclasses import asdict
from getpass import getpass
from pathlib import Path

from keyring.errors import KeyringError

from . import auth, notifications, paths, schedule
from .config import ConfigError, import_legacy_config, load_config, validate_config
from .crawler import CrawlConfig, IliasUnreachableError, SessionExpiredError, run_sync
from .reports import RunReport, now_iso
from .runner import (
    BUSY_EXIT,
    AlreadyRunning,
    BrowserLock,
    archive,
    cancellation_watch,
    report_id,
    setup_logging,
    stop_requested,
    write_current,
)

LOGGER = logging.getLogger("ilias-sync")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="ILIAS-Kursmaterialien lokal synchronisieren."
    )
    commands = root.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("run", help="Kursmaterialien abrufen")
    for flag in (
        "dry-run",
        "headful",
        "overwrite",
        "no-auto-discover",
        "no-auto-login",
        "verbose",
        "debug-links",
        "notify",
    ):
        sync.add_argument(f"--{flag}", action="store_true")
    sync.add_argument("--course")
    sync.add_argument("--semester")
    sync.add_argument("--max-depth", type=int)
    sync.add_argument("--trigger", choices=("manual", "schedule", "cli"), default="cli")
    sync.add_argument("--report-json", type=Path)

    commands.add_parser("login", help="Sichtbaren Login starten")
    serve = commands.add_parser("serve", help="Lokale Oberfläche ausliefern")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--open-browser", action="store_true")
    commands.add_parser("app", help="Desktop-Fenster öffnen")

    config = commands.add_parser("config").add_subparsers(dest="action", required=True)
    config.add_parser("path")
    config.add_parser("show")
    config.add_parser("import").add_argument("file", type=Path)
    credentials = commands.add_parser("credentials").add_subparsers(
        dest="action", required=True
    )
    credentials.add_parser("set").add_argument("username", nargs="?")
    credentials.add_parser("delete")
    jobs = commands.add_parser("schedule").add_subparsers(dest="action", required=True)
    enable = jobs.add_parser("enable")
    enable.add_argument("--time", default="09:00")
    enable.add_argument("--run-at-login", action="store_true")
    jobs.add_parser("disable")
    jobs.add_parser("status")
    return root


def run_command(args: argparse.Namespace) -> int:
    with BrowserLock(timeout=5):
        setup_logging(args.verbose)
        report, options, retry = run_attempt(
            args, allow_fallback=args.trigger == "schedule" and not args.headful
        )
        if retry:
            report, options, _ = run_attempt(args, allow_fallback=False)
    if (
        options
        and options.notifications
        and (args.trigger == "schedule" or args.notify)
    ):
        notifications.notify(report)
    return {"success": 0, "cancelled": 130}.get(report.result, 1)


def run_attempt(
    args: argparse.Namespace, *, allow_fallback: bool
) -> tuple[RunReport, CrawlConfig | None, bool]:
    report = RunReport(report_id(), args.trigger, dry_run=args.dry_run)
    write_current(report)
    handshake = os.environ.get("ILIAS_SYNC_START_REPORT")
    if handshake and args.trigger == "manual":
        paths.atomic_write(Path(handshake), json.dumps(asdict(report)))
    done = threading.Event()
    if sys.platform == "win32":
        # Deliver Python's interrupt on the main thread on Windows as well.
        interrupt = signal.getsignal(signal.SIGINT)
        if not callable(interrupt):
            signal.signal(signal.SIGINT, signal.default_int_handler)
    watcher = threading.Thread(
        target=cancellation_watch, args=(report.run_id, done), daemon=True
    )
    options = None
    retry = False
    try:
        watcher.start()
        config = load_config().to_dict()
        if args.no_auto_discover:
            config.update(
                auto_discover_current_semester=False,
                include_configured_courses=True,
            )
        if args.no_auto_login:
            config["auto_login"] = False
        if args.max_depth is not None:
            config["max_depth"] = args.max_depth
        if args.overwrite:
            config["overwrite"] = True
        if args.semester is not None:
            config["semester_filter"] = args.semester
        options = CrawlConfig(
            **vars(validate_config(config, allow_root_only=args.max_depth is None)),
            dry_run=args.dry_run,
            debug_links=args.debug_links,
            course_filter=args.course,
        )
        run_sync(options, args.headful, report, on_progress=write_current)
        report.result = "errors" if report.totals["errors"] else "success"
        if report.result == "errors":
            report.message = (
                "Einige Kursmaterialien konnten nicht synchronisiert werden."
            )
    except KeyboardInterrupt:
        report.result = "cancelled"
        report.message = "Synchronisierung abgebrochen."
    except SessionExpiredError as exc:
        report.result, report.message = "session_expired", str(exc)
        if allow_fallback and options and options.open_login_window_on_failure:
            try:
                if notifications.in_gui_session():
                    LOGGER.info("Sichtbarer ILIAS-Login für den geplanten Lauf.")
                    retry = auth.visible_login(options)
            except KeyboardInterrupt:
                report.result = "cancelled"
                report.message = "Synchronisierung abgebrochen."
            except Exception:  # noqa: BLE001 — preserve the expired-session report
                LOGGER.warning(
                    "Der sichtbare ILIAS-Login konnte nicht abgeschlossen werden."
                )
    except IliasUnreachableError as exc:
        report.result, report.message = "offline", str(exc)
    except ConfigError as exc:
        report.result = "failed"
        report.message = "\n".join(
            f"{field}: {message}" for field, message in exc.fields.items()
        )
    except Exception as exc:  # noqa: BLE001 — always record a terminal result
        report.result, report.message = "failed", str(exc)
    finally:
        done.set()
        watcher.join()
        if stop_requested(report.run_id):
            report.result = "cancelled"
            report.message = "Synchronisierung abgebrochen."
        report.finished_at = now_iso()
        try:
            archive(report)
            if args.report_json is not None:
                paths.atomic_write(
                    args.report_json, json.dumps(asdict(report), ensure_ascii=False)
                )
        finally:
            paths.CURRENT.unlink(missing_ok=True)
            (paths.DATA / f"cancel-{report.run_id}").unlink(missing_ok=True)
    if report.message:
        LOGGER.info("%s", report.message)
    LOGGER.info(
        "Gefunden: %d | Downloads: %d | Übersprungen: %d | Fehler: %d",
        *report.totals.values(),
    )
    return report, options, retry and report.result == "session_expired"


def login_command() -> int:
    with BrowserLock(timeout=5):
        paths.CURRENT.unlink(missing_ok=True)
        setup_logging()
        return 0 if auth.visible_login(load_config()) else 1


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "run":
            return run_command(args)
        if args.command == "login":
            return login_command()
        if args.command == "app":
            try:
                from .desktop import main as desktop_main
            except ModuleNotFoundError as exc:
                if exc.name != "ilias_sync.desktop":
                    raise
                print(
                    "Das Desktop-Fenster ist nicht verfügbar. Die Oberfläche öffnet sich im Browser."
                )
                from .server import run

                run(open_browser=True)
            else:
                return desktop_main([]) or 0
        if args.command == "serve":
            from .server import run

            run(port=args.port, open_browser=args.open_browser)
        if args.command == "config":
            if args.action == "path":
                print(paths.CONFIG)
            elif args.action == "show":
                print(json.dumps(load_config().to_dict(), ensure_ascii=False, indent=2))
            else:
                import_legacy_config(args.file)
                print(f"Konfiguration importiert: {paths.CONFIG}")
        if args.command == "credentials":
            if args.action == "set":
                username = args.username or input("ILIAS-Benutzername: ").strip()
                auth.set_credentials(
                    username,
                    getpass("ILIAS-Passwort: "),
                    load_config().keychain_service,
                )
            else:
                auth.delete_credentials(load_config().keychain_service)
        if args.command == "schedule":
            if args.action == "status":
                result = schedule.status()
            elif args.action == "enable":
                result = schedule.configure(True, args.time, args.run_at_login)
            else:
                result = schedule.configure(False)
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except AlreadyRunning as exc:
        print(exc, file=sys.stderr)
        return BUSY_EXIT
    except ConfigError as exc:
        for field, message in exc.fields.items():
            print(f"{field}: {message}", file=sys.stderr)
        return 2
    except KeyringError:
        print("Der System-Schlüsselbund ist nicht verfügbar.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except (OSError, RuntimeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0
