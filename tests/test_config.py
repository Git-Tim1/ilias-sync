import pytest

from ilias_sync.config import ConfigError, validate_config


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
