from pathlib import Path

import pytest

from ilias_sync import paths
from ilias_sync.config import (
    ConfigError,
    import_legacy_config,
    load_config,
    validate_config,
)


def test_field_validation() -> None:
    with pytest.raises(ConfigError) as error:
        validate_config(
            {
                "max_depth": True,
                "local_download_dir": "relative",
                "base_url": "file:///tmp",
                "courses": {"Test": "kein-link"},
                "file_extensions": [],
                "overwrite": "false",
            }
        )
    assert set(error.value.fields) == {
        "max_depth",
        "local_download_dir",
        "base_url",
        "courses",
        "file_extensions",
        "overwrite",
    }


def test_legacy_import(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    old = tmp_path / "original.yaml"
    old.write_text(
        "download_dir: downloads\ncurrent_semester: WS26/27\n"
        "file_extensions: ['.PDF', 'pdf']\nbrowser_profile_dir: ignored\n"
        "keychain_service: fixture-service\n"
        "courses: {Test: 'https://ilias.example/goto.php/crs/103'}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(paths, "CONFIG", tmp_path / "new" / "config.yaml")
    config = import_legacy_config(old)
    assert config.download_dir == tmp_path.resolve() / "downloads"
    assert config.semester_filter == "WS26/27"
    assert config.file_extensions == ["pdf"]
    assert config.keychain_service == "fixture-service"
    assert load_config() == config
    assert "browser_profile_dir" not in config.to_dict()
