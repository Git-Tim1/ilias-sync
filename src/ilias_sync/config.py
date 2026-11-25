"""YAML configuration shared by the CLI and the local API."""

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import yaml

from . import paths

BASE_URL = "https://www.ilias.uni-koeln.de/ilias/"
DEFAULT_KEYCHAIN_SERVICE = "ilias-koeln-sync"
EXTENSIONS = [
    "csv",
    "doc",
    "docx",
    "ipynb",
    "java",
    "jpeg",
    "jpg",
    "md",
    "odp",
    "ods",
    "odt",
    "pdf",
    "png",
    "ppt",
    "pptx",
    "py",
    "rtf",
    "tex",
    "txt",
    "xls",
    "xlsx",
    "zip",
]


@dataclass
class Config:
    base_url: str = BASE_URL
    login_url: str = BASE_URL + "login.php?client_id=uk&cmd=force_login&lang=de"
    download_dir: Path = field(
        default_factory=lambda: Path.home() / "Documents" / "Uni"
    )
    local_download_dir: Path | None = None
    auto_discover_current_semester: bool = True
    semester_filter: str = "auto"
    include_configured_courses: bool = False
    courses: dict[str, str] = field(default_factory=dict)
    file_extensions: list[str] = field(default_factory=lambda: EXTENSIONS.copy())
    max_depth: int = 10
    overwrite: bool = False
    auto_login: bool = True
    notifications: bool = True
    open_login_window_on_failure: bool = True
    keychain_service: str = DEFAULT_KEYCHAIN_SERVICE

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["download_dir"] = str(self.download_dir)
        if self.local_download_dir is not None:
            data["local_download_dir"] = str(self.local_download_dir)
        return data


class ConfigError(ValueError):
    def __init__(self, fields: dict[str, str]):
        super().__init__("Bitte korrigiere die markierten Konfigurationsfelder.")
        self.fields = fields


def valid_url(value: Any) -> bool:
    if not isinstance(value, str) or any(character.isspace() for character in value):
        return False
    try:
        url = urlsplit(value)
        if url.port is not None and url.port == 0:
            return False
        return (
            url.scheme in {"http", "https"}
            and bool(url.hostname)
            and url.username is None
        )
    except ValueError:
        return False


def validate_config(
    raw: Any, *, relative_to: Path | None = None, allow_root_only: bool = False
) -> Config:
    if not isinstance(raw, dict):
        raise ConfigError({"config": "Die Konfiguration muss ein Objekt sein."})
    data = Config().to_dict()
    errors = {str(key): "Unbekanntes Feld." for key in raw.keys() - data.keys()}
    data.update(raw)
    for key in ("base_url", "login_url"):
        if not valid_url(data[key]):
            errors[key] = "Bitte eine vollständige HTTP- oder HTTPS-Adresse angeben."
    if "base_url" not in errors and any(urlsplit(data["base_url"])[3:]):
        errors["base_url"] = (
            "Bitte eine Basisadresse ohne Abfrageparameter oder Fragment angeben."
        )
    for key in ("download_dir", "local_download_dir"):
        value = data[key]
        if value is None and key == "local_download_dir":
            continue
        try:
            if not isinstance(value, str) or not value.strip() or "\x00" in value:
                raise ValueError()
            directory = Path(value).expanduser()
            if relative_to is not None:
                directory = relative_to / directory
            if not directory.is_absolute():
                raise ValueError()
            data[key] = directory.resolve()
        except (ValueError, OSError, RuntimeError):
            errors[key] = "Bitte einen gültigen absoluten Ordnerpfad angeben."
    for key in (
        "auto_discover_current_semester",
        "include_configured_courses",
        "overwrite",
        "auto_login",
        "notifications",
        "open_login_window_on_failure",
    ):
        if type(data[key]) is not bool:
            errors[key] = "Bitte true oder false angeben."
    if (
        not isinstance(data["semester_filter"], str)
        or not data["semester_filter"].strip()
    ):
        errors["semester_filter"] = "Bitte ein Semester oder „auto“ angeben."
    service = data["keychain_service"]
    if not isinstance(service, str) or not service.strip() or "\x00" in service:
        errors["keychain_service"] = (
            "Bitte einen gültigen Schlüsselbund-Dienst angeben."
        )
    courses = data["courses"]
    if not isinstance(courses, dict) or not all(
        isinstance(name, str) and name.strip() and valid_url(url)
        for name, url in courses.items()
    ):
        errors["courses"] = (
            "Bitte Kursnamen mit vollständigen HTTP- oder HTTPS-Adressen angeben."
        )
    elif not courses and data["auto_discover_current_semester"] is False:
        errors["courses"] = (
            "Bitte mindestens einen Kurs eintragen oder die automatische Suche aktivieren."
        )
    extensions = data["file_extensions"]
    if (
        not isinstance(extensions, list)
        or not extensions
        or not all(
            isinstance(ext, str) and re.fullmatch(r"\.?[a-zA-Z0-9]+", ext.strip())
            for ext in extensions
        )
    ):
        errors["file_extensions"] = (
            "Bitte mindestens eine Dateiendung angeben, zum Beispiel pdf."
        )
    else:
        data["file_extensions"] = list(
            dict.fromkeys(ext.strip().lower().lstrip(".") for ext in extensions)
        )
    if type(data["max_depth"]) is not int or data["max_depth"] < (
        0 if allow_root_only else 1
    ):
        errors["max_depth"] = "Bitte eine ganze Zahl ab 1 angeben."
    if errors:
        raise ConfigError(errors)
    data["base_url"] = data["base_url"].rstrip("/") + "/"
    data["semester_filter"] = data["semester_filter"].strip()
    data["keychain_service"] = service.strip()
    return Config(**data)


def read_yaml(path: Path) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise ConfigError(
            {"config": "Die YAML-Datei konnte nicht gelesen werden."}
        ) from exc
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ConfigError({"config": "Die YAML-Datei muss eine Zuordnung enthalten."})
    return raw


def load_config() -> Config:
    try:
        raw = read_yaml(paths.CONFIG)
    except ConfigError:
        if not paths.CONFIG.exists():
            return Config()
        raise
    return validate_config(raw, allow_root_only=True)


def save_config(config: Config) -> None:
    paths.atomic_write(
        paths.CONFIG,
        yaml.safe_dump(config.to_dict(), allow_unicode=True, sort_keys=False),
    )
