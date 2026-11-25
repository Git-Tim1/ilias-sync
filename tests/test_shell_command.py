import sys
from pathlib import Path

import pytest

from ilias_sync import paths, shell_command


@pytest.fixture
def shell_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    if not shell_command.status()["supported"]:
        pytest.skip("Symbolische Terminal-Verknüpfungen benötigen macOS oder Linux")
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(shell_command, "SYSTEM_BIN", tmp_path / "system-bin")
    target = tmp_path / "tool" / "ilias-sync"
    target.parent.mkdir()
    target.touch(mode=0o755)
    monkeypatch.setattr(
        shell_command.sysconfig, "get_path", lambda key: str(target.parent)
    )
    monkeypatch.setenv("PATH", str(target.parent))
    return tmp_path / "home" / ".local/bin" / "ilias-sync", target


def test_install_status_and_uninstall(
    shell_paths, monkeypatch: pytest.MonkeyPatch
) -> None:
    link, target = shell_paths
    assert not shell_command.status()["installed"]
    info = shell_command.install()
    assert info["installed"]
    assert info["path"] == str(link)
    assert link.readlink() == target
    assert info["path_line"] == 'export PATH="$HOME/.local/bin":"$PATH"'
    assert shell_command.install() == info

    monkeypatch.setenv("PATH", str(link.parent))
    assert shell_command.status()["on_path"]
    assert shell_command.status()["path_line"] is None
    assert not shell_command.uninstall()["installed"]
    assert not link.is_symlink()
    assert not shell_command.uninstall()["installed"]


def test_never_removes_foreign_entry(shell_paths) -> None:
    link, target = shell_paths
    link.parent.mkdir(parents=True)
    link.write_text("Fremder Befehl")
    with pytest.raises(RuntimeError, match="bereits belegt"):
        shell_command.install()
    shell_command.uninstall()
    assert link.read_text() == "Fremder Befehl"

    link.unlink()
    shell_command.install()
    link.rename(link.with_name("alter-link"))
    link.symlink_to(target)
    assert not shell_command.status()["installed"]
    shell_command.uninstall()
    assert link.readlink() == target


def test_fallback(shell_paths) -> None:
    link, target = shell_paths
    link.parent.parent.mkdir(parents=True)
    link.parent.touch()
    shell_command.SYSTEM_BIN.mkdir()
    info = shell_command.install()
    system_link = shell_command.SYSTEM_BIN / "ilias-sync"
    assert info["path"] == str(system_link)
    assert system_link.readlink() == target
    shell_command.uninstall()
    assert not system_link.is_symlink()


def test_frozen_custom_location(
    shell_paths, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, target = shell_paths
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(target))
    folder = tmp_path / "bin with spaces"
    info = shell_command.install(folder)
    assert info["frozen"]
    assert (folder / "ilias-sync").readlink() == target.resolve()
    assert info["path_line"] == "export PATH=" + repr(str(folder)) + ':"$PATH"'


def test_windows_returns_instructions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    info = shell_command.install()
    assert not info["supported"]
    assert "ilias-sync.exe" in info["instructions"]
    assert shell_command.uninstall() == info
