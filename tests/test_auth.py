import subprocess
import threading

import pytest
from keyring.errors import KeyringError

from ilias_sync import auth


def test_macos_probe_and_writes_keep_password_off_argv(monkeypatch):
    monkeypatch.setattr(auth.sys, "platform", "darwin")
    calls = []

    def security(argv, **kwargs):
        calls.append((argv, kwargs))
        result = b"fixture\n" if argv[1] == "find-generic-password" else b""
        return subprocess.CompletedProcess(argv, 0, stdout=result)

    monkeypatch.setattr(auth.subprocess, "run", security)
    assert auth.credentials_configured("test-service")
    assert "-w" not in calls[0][0]
    auth.set_credentials("fixture", 'Pass " phrase ', "test-service")
    auth.delete_credentials("test-service")
    write_argv, write_kwargs = calls[2]
    assert write_argv == [
        "/usr/bin/security",
        "add-generic-password",
        "-s",
        "test-service",
        "-a",
        "fixture",
        "-U",
        "-w",
    ]
    assert write_kwargs["input"] == b'Pass " phrase \nPass " phrase \n'
    assert write_kwargs["timeout"] == 10
    assert [argv[1] for argv, _ in calls[-2:]] == ["delete-generic-password"] * 2


def test_macos_timeout(monkeypatch):
    monkeypatch.setattr(auth.sys, "platform", "darwin")

    def timeout(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(auth.subprocess, "run", timeout)
    assert auth.load_credentials("test-service") is None


def test_keyring_timeout_bounds_background_workers(monkeypatch):
    monkeypatch.setattr(auth.sys, "platform", "linux")
    monkeypatch.setattr(auth, "KEYCHAIN_TIMEOUT", 0.02)
    release = threading.Event()
    slot = threading.Lock()
    monkeypatch.setattr(auth, "_keyring_slot", slot)
    monkeypatch.setattr(auth.keyring, "get_password", lambda *_: release.wait(2))
    try:
        assert auth.load_credentials("test-service") is None
        with pytest.raises(KeyringError, match="beschäftigt"):
            auth.credential_username("test-service")
    finally:
        release.set()
        assert slot.acquire(timeout=1)
        slot.release()
