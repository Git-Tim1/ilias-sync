"""Keyring credentials and Playwright login flows."""

import logging
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any, TypeVar
from urllib.parse import urlparse

import keyring
from keyring.errors import KeyringError, PasswordDeleteError
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, sync_playwright

from .config import DEFAULT_KEYCHAIN_SERVICE, Config
from .crawler import (
    IliasUnreachableError,
    goto_with_retry,
    is_logged_in,
    launch_context,
    save_session,
)

LOGGER = logging.getLogger("ilias-sync")
USERNAME_ACCOUNT = "__username__"
KEYCHAIN_TIMEOUT = 10
# macOS getpass(3) silently discards bytes beyond _PASSWORD_LEN.
MACOS_PASSWORD_BYTES = 128
T = TypeVar("T")
_keyring_slot = threading.Lock()


def _bounded_keyring(operation: Callable[[], T]) -> T:
    # A native keyring call cannot be interrupted from Python. Keep at most one
    # worker alive so subsequent requests cannot pile up behind a hung backend.
    if not _keyring_slot.acquire(blocking=False):
        raise KeyringError("Der Schlüsselbund ist beschäftigt.")
    result: Future[T] = Future()

    def worker() -> None:
        try:
            result.set_result(operation())
        except Exception as exc:  # noqa: BLE001 — forward worker errors to the caller
            result.set_exception(exc)
        finally:
            _keyring_slot.release()

    threading.Thread(target=worker, daemon=True).start()
    try:
        return result.result(timeout=KEYCHAIN_TIMEOUT)
    except TimeoutError:
        raise KeyringError("Der Schlüsselbund antwortet nicht.") from None


def _security(
    command: str, service: str, account: str, *options: str, password: str | None = None
) -> bytes | None:
    # With -w last, security prompts twice. Detaching from the terminal makes
    # getpass read our pipe, keeping the password out of the process arguments.
    stdin = (
        (password + "\n" + password + "\n").encode() if password is not None else None
    )
    try:
        result = subprocess.run(
            ["/usr/bin/security", command, "-s", service, "-a", account, *options],
            input=stdin,
            check=False,
            stdin=subprocess.DEVNULL if stdin is None else None,
            capture_output=True,
            start_new_session=True,
            timeout=KEYCHAIN_TIMEOUT,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise KeyringError("Der Schlüsselbund ist nicht erreichbar.") from None
    if result.returncode == 44 and command != "add-generic-password":
        return None
    if result.returncode:
        raise KeyringError("Der Schlüsselbund konnte die Aktion nicht ausführen.")
    return result.stdout


def _get(service: str, account: str) -> str | None:
    if sys.platform == "darwin":
        result = _security("find-generic-password", service, account, "-w")
        return result.removesuffix(b"\n").decode() if result is not None else None
    return keyring.get_password(service, account)


def _set(service: str, account: str, password: str) -> None:
    if sys.platform == "darwin":
        _security(
            "add-generic-password", service, account, "-U", "-w", password=password
        )
    else:
        keyring.set_password(service, account, password)


def _delete(service: str, account: str) -> None:
    if sys.platform == "darwin":
        _security("delete-generic-password", service, account)
    else:
        try:
            keyring.delete_password(service, account)
        except PasswordDeleteError:
            if keyring.get_password(service, account) is not None:
                raise


def _with_backend(operation: Callable[[], T]) -> T:
    return operation() if sys.platform == "darwin" else _bounded_keyring(operation)


def credentials_configured(service: str) -> bool:
    if sys.platform == "darwin":
        return _security("find-generic-password", service, USERNAME_ACCOUNT) is not None
    # keyring has no portable metadata-only lookup. This runs off the status path.
    return bool(
        _bounded_keyring(lambda: keyring.get_password(service, USERNAME_ACCOUNT))
    )


def credential_username(service: str) -> str | None:
    return _with_backend(lambda: _get(service, USERNAME_ACCOUNT))


def load_credentials(service: str = DEFAULT_KEYCHAIN_SERVICE) -> tuple[str, str] | None:
    def read() -> tuple[str, str] | None:
        username = _get(service, USERNAME_ACCOUNT)
        password = _get(service, username) if username else None
        return (username, password) if username and password else None

    try:
        return _with_backend(read)
    except (KeyringError, UnicodeError):
        return None


def credential_errors(username: object, password: object) -> dict[str, str]:
    errors = {}
    if (
        not isinstance(username, str)
        or not username.strip()
        or username == USERNAME_ACCOUNT
        or any(char in username for char in "\x00\r\n")
    ):
        errors["username"] = "Bitte einen gültigen Benutzernamen eingeben."
    if (
        not isinstance(password, str)
        or not password
        or any(char in password for char in "\x00\r\n")
    ):
        errors["password"] = "Bitte ein gültiges Passwort eingeben."
    if sys.platform == "darwin":
        for field, value in (("username", username), ("password", password)):
            if (
                field not in errors
                and len(value.encode("utf-8")) > MACOS_PASSWORD_BYTES
            ):
                errors[field] = (
                    "Der macOS-Schlüsselbund akzeptiert hier bis zu 128 UTF-8-Bytes."
                )
    return errors


def set_credentials(
    username: str, password: str, service: str = DEFAULT_KEYCHAIN_SERVICE
) -> None:
    errors = credential_errors(username, password)
    if errors:
        raise ValueError(" ".join(errors.values()))

    def write() -> None:
        previous = _get(service, USERNAME_ACCOUNT)
        _set(service, username, password)
        _set(service, USERNAME_ACCOUNT, username)
        if previous and previous != username:
            _delete(service, previous)

    _with_backend(write)


def delete_credentials(service: str = DEFAULT_KEYCHAIN_SERVICE) -> None:
    def delete() -> None:
        username = _get(service, USERNAME_ACCOUNT)
        if username:
            _delete(service, username)
            _delete(service, USERNAME_ACCOUNT)

    _with_backend(delete)


def first_visible(page: Any, selectors: list[str]) -> Any | None:
    for selector in selectors:
        locator = page.locator(selector)
        try:
            count = min(locator.count(), 8)
        except PlaywrightError:
            continue
        for index in range(count):
            candidate = locator.nth(index)
            try:
                if candidate.is_visible(timeout=500):
                    return candidate
            except PlaywrightError:
                continue
    return None


def attempt_auto_login(
    page: Any, username: str, password: str, timeout_seconds: int = 75
) -> bool:
    username_selectors = [
        "input[type='email']",
        "input[name='username']",
        "input[name='j_username']",
        "input[name='user']",
        "input[name*='user']",
        "input[id*='user']",
        "input[name*='login']",
        "input[id*='login']",
        "input[name*='name']",
        "input[type='text']",
    ]
    password_selectors = ["input[type='password']"]

    deadline = time.monotonic() + timeout_seconds
    username_filled = False
    password_filled = False

    while time.monotonic() < deadline:
        password_field = first_visible(page, password_selectors)
        username_field = first_visible(page, username_selectors)

        if username_field is not None and not username_filled:
            try:
                username_field.fill(username, timeout=3000)
                username_filled = True

            except PlaywrightError:
                pass

        if password_field is not None:
            try:
                password_field.fill(password, timeout=3000)
                password_filled = True

                password_field.press("Enter", timeout=3000)
                LOGGER.info(
                    "Loginformular abgeschickt. Falls nötig, bitte MFA im Browser abschließen."
                )
                return True
            except PlaywrightError:
                pass

        if username_filled and password_field is None:
            try:
                if username_field is not None:
                    username_field.press("Enter", timeout=2000)
            except PlaywrightError:
                pass

        time.sleep(1)

    return password_filled


def is_authenticated_ilias_page(page: Any, login_url: str) -> bool:
    current = page.url.lower()
    login_host = urlparse(login_url).netloc.lower()
    current_host = urlparse(page.url).netloc.lower()

    if current_host != login_host:
        return False
    if "login.php" in current or "cmd=force_login" in current:
        return False

    try:
        if page.locator("input[type='password']").count() > 0:
            return False
    except PlaywrightError:
        return False

    return True


def wait_for_authenticated_ilias_page(
    page: Any, login_url: str, timeout_seconds: int = 180
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if is_authenticated_ilias_page(page, login_url):
            return True
        try:
            page.wait_for_load_state("domcontentloaded", timeout=3000)
        except PlaywrightError:
            pass
        time.sleep(1)
    return False


def headless_login(page: Page, config: Config) -> bool:
    credentials = load_credentials(config.keychain_service)
    if credentials is None:
        LOGGER.info("Keine Zugangsdaten für den automatischen Login gefunden.")
        return False

    LOGGER.info("Session abgelaufen. Automatischer Login wird versucht.")
    try:
        goto_with_retry(page, config.login_url, timeout=30000)
        if not attempt_auto_login(page, *credentials, timeout_seconds=30):
            return False
        if not wait_for_authenticated_ilias_page(
            page, config.login_url, timeout_seconds=45
        ):
            return False
    except PlaywrightError:
        LOGGER.debug("Automatischer Login fehlgeschlagen.")
        return False

    return is_logged_in(page, config)


def visible_login(config: Config) -> bool:
    LOGGER.info("Bitte im Chromium-Fenster bei ILIAS anmelden.")
    with sync_playwright() as playwright:
        context = launch_context(playwright, headful=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            if not is_logged_in(page, config):
                goto_with_retry(page, config.login_url)
                credentials = (
                    load_credentials(config.keychain_service)
                    if config.auto_login
                    else None
                )
                if credentials:
                    attempt_auto_login(page, *credentials)
                if not wait_for_authenticated_ilias_page(page, config.login_url):
                    return False
                if not is_logged_in(page, config):
                    return False
            save_session(context)
            LOGGER.info("ILIAS-Session gespeichert.")
            return True
        finally:
            context.close()


def check_session(config: Config) -> str:
    with sync_playwright() as playwright:
        context = launch_context(playwright, headful=False)
        try:
            if not is_logged_in(context.new_page(), config):
                return "expired"
            save_session(context)
            return "valid"
        except IliasUnreachableError:
            return "offline"
        finally:
            context.close()
