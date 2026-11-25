"""Discover ILIAS courses and download materials with a browser session."""

from __future__ import annotations

import filecmp
import json
import logging
import mimetypes
import re
import shutil
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup, Tag
from playwright.sync_api import (
    BrowserContext,
    Page,
    sync_playwright,
)
from playwright.sync_api import (
    Error as PlaywrightError,
)
from playwright.sync_api import (
    TimeoutError as PlaywrightTimeoutError,
)
from slugify import slugify
from tqdm import tqdm

from . import paths
from .config import EXTENSIONS, Config
from .reports import CourseReport, FileEntry, RunProgress, RunReport

CONTENT_TYPE_EXTENSIONS = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/x-ipynb+json": ".ipynb",
}
IGNORED_URL_MARKERS = (
    "cmd=logout",
    "logout",
    "cmd=delete",
    "cmd=edit",
    "cmd=create",
    "cmd=copy",
    "cmd=cut",
    "cmd=link",
    "cmd=permissions",
    "cmd=leave",
    "cmd=join",
    "cmd=addtodesk",
    "cmd=removefromdesk",
    "cmd=setsort",
    "cmd=setpdevents",
    "cmd=setpdmodeevents",
    "cmdclass=ilcalendar",
    "cmdclass=ilcalendarblockgui",
    "cmdclass=ilcalendarpresentationgui",
    "cmdclass=ilusersgallerygui",
    "cmdclass=ilinfoscreengui",
    "cmdclass=ilobjtagginggui",
    "block_type=cal",
    "seed=",
    "mail.php",
    "mailto:",
)
IGNORED_STATIC_SUFFIXES = {
    ".avif",
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".map",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
}

LOGGER = logging.getLogger("ilias-sync")


class SessionExpiredError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(
            "Session abgelaufen. Bitte melde dich mit ilias-sync login erneut an."
        )


class IliasUnreachableError(RuntimeError):
    pass


@dataclass
class CrawlConfig(Config):
    dry_run: bool = False
    debug_links: bool = False
    course_filter: str | None = None


@dataclass(frozen=True)
class LinkCandidate:
    url: str
    raw_href: str
    text: str
    title: str
    classes: tuple[str, ...]
    target: str | None


@dataclass
class SyncStats:
    downloaded: int = 0
    skipped: int = 0
    errors: int = 0
    found: int = 0
    new_files: list[Path] = field(default_factory=list)


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = re.sub(r"/+", "/", parsed.path)
    return urlunparse((scheme, netloc, path, "", parsed.query, ""))


def same_domain(url: str, base_url: str) -> bool:
    return urlparse(url).netloc.lower() == urlparse(base_url).netloc.lower()


def is_ignored_url(url: str) -> bool:
    lower_url = url.lower()
    parsed = urlparse(url)
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        return True
    if parsed.fragment and not parsed.path and not parsed.query:
        return True
    if Path(parsed.path).suffix.lower() in IGNORED_STATIC_SUFFIXES:
        return True
    return any(marker in lower_url for marker in IGNORED_URL_MARKERS)


def goto_object_type(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path.lower()

    match = re.search(r"/goto(?:_[^/_]+)?_(crs|grp|fold|file)_", path)
    if match:
        return match.group(1)

    match = re.search(r"/goto\.php/(crs|grp|fold|file)(?:/|$)", path)
    if match:
        return match.group(1)

    query = parsed.query.lower()
    match = re.search(r"(?:^|[?&])target=(crs|grp|fold|file)_", query)
    if match:
        return match.group(1)

    return None


def repository_object_key(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path.lower()
    query = parsed.query.lower()

    match = re.search(r"/goto(?:_[^/_]+)?_(crs|grp|fold|file)_(\d+)", path)
    if match:
        return f"{match.group(1)}:{match.group(2)}"

    match = re.search(r"/goto\.php/(crs|grp|fold|file)/(\d+)(?:/|$)", path)
    if match:
        return f"{match.group(1)}:{match.group(2)}"

    match = re.search(r"(?:^|[&?])target=(crs|grp|fold|file)_(\d+)", query)
    if match:
        return f"{match.group(1)}:{match.group(2)}"

    ref_match = re.search(r"(?:^|[&?])ref_id=(\d+)", query)
    if not ref_match:
        return None

    ref_id = ref_match.group(1)
    if "cmdclass=ilobjfoldergui" in query:
        return f"fold:{ref_id}"
    if "cmdclass=ilobjcoursegui" in query:
        return f"crs:{ref_id}"
    if "cmdclass=ilobjgroupgui" in query:
        return f"grp:{ref_id}"
    return None


def navigation_key(url: str) -> str:
    return repository_object_key(url) or normalize_url(url)


def is_repository_content_url(url: str) -> bool:
    parsed = urlparse(url)
    query = parsed.query.lower()

    object_type = goto_object_type(url)
    if object_type in {"crs", "grp", "fold"}:
        return True

    if "baseclass=ilrepositorygui" not in query:
        return False

    ignored_cmd_classes = (
        "cmdclass=ilcalendar",
        "cmdclass=ilcalendarblockgui",
        "cmdclass=ilcalendarpresentationgui",
        "cmdclass=ilusersgallerygui",
        "cmdclass=ilinfoscreengui",
        "cmdclass=ilobjtagginggui",
    )
    if any(marker in query for marker in ignored_cmd_classes):
        return False

    non_content_commands = (
        "cmd=leave",
        "cmd=join",
        "cmd=addtodesk",
        "cmd=removefromdesk",
        "cmd=setsort",
        "cmd=setpdevents",
        "cmd=setpdmodeevents",
    )
    if any(marker in query for marker in non_content_commands):
        return False

    content_markers = (
        "target=fold_",
        "target=crs_",
        "target=grp_",
        "target%3dfold_",
        "target%3dcrs_",
        "target%3dgrp_",
        "cmdclass=ilobjfoldergui",
        "cmdclass=ilobjcoursegui",
        "cmdclass=ilobjgroupgui",
        "cmd=view",
    )
    if any(marker in query for marker in content_markers):
        return True

    # ILIAS often links repository objects as ilias.php?baseClass=ilrepositorygui&ref_id=...
    # without an explicit object type in the URL. Keep this as a fallback, while
    # the caller still has to confirm a repository-looking link context.
    return "ref_id=" in query and "cmd=" not in query


def extract_urlish_values(element: Tag) -> list[str]:
    values: list[str] = []
    direct_attributes = (
        "href",
        "formaction",
        "data-href",
        "data-url",
        "data-link",
        "data-action",
    )
    for attribute in direct_attributes:
        value = element.get(attribute)
        if value:
            values.append(str(value))

    onclick = str(element.get("onclick") or "")
    if onclick:
        values.extend(
            re.findall(
                r"""(?:location\.href|window\.location|document\.location)\s*=\s*['"]([^'"]+)['"]""",
                onclick,
            )
        )
        values.extend(
            re.findall(
                r"""(?:open|il\.Util\.sendAjaxGetRequestToUrl)\(\s*['"]([^'"]+)['"]""",
                onclick,
            )
        )
        values.extend(re.findall(r"""['"]((?:https?://|/|\.?/)[^'"]+)['"]""", onclick))

    seen: set[str] = set()
    unique_values: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            unique_values.append(value)
    return unique_values


def collect_classes(element: Tag) -> tuple[str, ...]:
    classes: list[str] = []
    current: Tag | None = element
    for _ in range(3):
        if current is None:
            break
        classes_raw = current.get("class") or []
        classes.extend(str(item) for item in classes_raw)
        parent = current.parent
        current = parent if isinstance(parent, Tag) else None
    return tuple(classes)


def element_text(element: Tag) -> str:
    text = element.get_text(" ", strip=True)
    if text:
        return text

    current = element.parent
    for _ in range(2):
        if not isinstance(current, Tag):
            return ""
        text = current.get_text(" ", strip=True)
        if text:
            return text
        current = current.parent
    return ""


def element_title(element: Tag) -> str:
    values = [
        element.get("title"),
        element.get("aria-label"),
        element.get("alt"),
        element.get("data-title"),
        element.get("data-original-title"),
    ]
    return " ".join(str(value) for value in values if value)


def safe_name(value: str, fallback: str = "datei") -> str:
    cleaned = unquote(value).strip().replace("\x00", "")
    cleaned = re.sub(r"[\\/]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        cleaned = fallback

    suffix = Path(cleaned).suffix
    stem = cleaned[: -len(suffix)] if suffix else cleaned
    slug = slugify(stem, lowercase=False, max_length=120) or fallback
    if suffix:
        slug += suffix.lower()
    return slug


def folder_name(value: str, fallback: str = "ordner") -> str:
    return slugify(value.strip(), lowercase=False, max_length=120) or fallback


def display_name(value: str, fallback: str = "objekt") -> str:
    cleaned = re.sub(r"\s+", " ", value).strip()
    cleaned = re.sub(
        r"\b(Info|Aktionen|Download|Herunterladen|Mehr|Optionen)\b",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -_")
    if not cleaned:
        cleaned = fallback
    return cleaned[:140]


def link_label(link: LinkCandidate, fallback: str = "objekt") -> str:
    for value in (link.title, link.text):
        label = display_name(value, "")
        if label:
            return label
    path_name = Path(urlparse(link.url).path).name
    return display_name(path_name, fallback)


def extension_from_text(value: str, allowed_extensions: Iterable[str]) -> str | None:
    lowered = value.lower().split("?", 1)[0]
    for ext in sorted(allowed_extensions, key=len, reverse=True):
        if lowered.endswith(f".{ext}") or re.search(
            rf"\.{re.escape(ext)}(\b|$)", lowered
        ):
            return ext
    return None


def has_allowed_extension(value: str, allowed_extensions: Iterable[str]) -> bool:
    return extension_from_text(value, allowed_extensions) is not None


def filename_allowed(filename: str, allowed_extensions: Iterable[str]) -> bool:
    return Path(filename).suffix.lower().lstrip(".") in allowed_extensions


def content_type_to_extension(content_type: str | None) -> str:
    if not content_type:
        return ""
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type in CONTENT_TYPE_EXTENSIONS:
        return CONTENT_TYPE_EXTENSIONS[media_type]
    guessed = mimetypes.guess_extension(media_type) or ""
    return guessed if guessed != ".bin" else ""


def filename_from_content_disposition(value: str | None) -> str | None:
    if not value:
        return None
    message = Message()
    message["content-disposition"] = value
    filename = message.get_filename()
    return unquote(filename) if filename else None


def filename_from_url(url: str) -> str | None:
    name = Path(unquote(urlparse(url).path)).name
    return name or None


def choose_filename(
    url: str,
    link_text: str,
    headers: requests.structures.CaseInsensitiveDict[str]
    | dict[str, str]
    | None = None,
    allowed_extensions: Iterable[str] | None = None,
) -> str:
    headers = headers or {}
    allowed_extensions = allowed_extensions or EXTENSIONS

    disposition_name = filename_from_content_disposition(
        headers.get("content-disposition")
    )
    candidates = [disposition_name, filename_from_url(url), link_text]
    for candidate in candidates:
        if candidate and has_allowed_extension(candidate, allowed_extensions):
            return safe_name(candidate)

    for candidate in candidates:
        if candidate and Path(candidate).name.strip():
            filename = safe_name(Path(candidate).name)
            extension = content_type_to_extension(headers.get("content-type"))
            if extension and not Path(filename).suffix:
                filename += extension
            return filename

    return "download" + content_type_to_extension(headers.get("content-type"))


def choose_allowed_filename(
    url: str,
    link_text: str,
    headers: requests.structures.CaseInsensitiveDict[str] | dict[str, str] | None,
    allowed_extensions: Iterable[str],
) -> str | None:
    filename = choose_filename(
        url, link_text, headers=headers, allowed_extensions=allowed_extensions
    )
    if filename_allowed(filename, allowed_extensions):
        return filename

    headers = headers or {}
    extension = content_type_to_extension(headers.get("content-type"))
    if extension.lstrip(".") in allowed_extensions:
        base_candidates = [
            filename_from_content_disposition(headers.get("content-disposition")),
            link_text,
            filename_from_url(url),
            "download",
        ]
        for candidate in base_candidates:
            if not candidate:
                continue
            stem = Path(safe_name(candidate)).stem or "download"
            return safe_name(stem + extension)
    return None


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    for index in range(2, 10000):
        candidate = path.with_name(f"{stem}-{index}{suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Kein freier Dateiname gefunden fuer {path}")


def unique_links_by_navigation_key(
    links: Iterable[LinkCandidate],
) -> list[LinkCandidate]:
    seen: set[str] = set()
    unique: list[LinkCandidate] = []
    for link in links:
        key = navigation_key(link.url)
        if key in seen:
            continue
        seen.add(key)
        unique.append(link)
    return unique


def extract_links(html: str, current_url: str, base_url: str) -> list[LinkCandidate]:
    soup = BeautifulSoup(html, "html.parser")
    candidates: list[LinkCandidate] = []

    for element in soup.find_all(True):
        if not isinstance(element, Tag):
            continue
        href_values = extract_urlish_values(element)
        if not href_values:
            continue

        text = element_text(element)
        title = element_title(element)
        classes = collect_classes(element)
        target = element.get("target")

        for href in href_values:
            absolute_url = normalize_url(urljoin(current_url, str(href)))
            if not same_domain(absolute_url, base_url) or is_ignored_url(absolute_url):
                continue

            candidates.append(
                LinkCandidate(
                    url=absolute_url,
                    raw_href=str(href),
                    text=text,
                    title=title,
                    classes=classes,
                    target=str(target) if target else None,
                )
            )

    seen: set[tuple[str, str]] = set()
    unique_candidates: list[LinkCandidate] = []
    for candidate in candidates:
        key = (candidate.url, candidate.text or candidate.title)
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(candidate)
    return unique_candidates


def settle_page(page: Page) -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except PlaywrightTimeoutError:
        LOGGER.debug("networkidle nicht erreicht; fahre mit aktuellem DOM fort.")
    try:
        page.locator("body").wait_for(timeout=5000)
    except PlaywrightTimeoutError:
        LOGGER.debug("body-Element wurde nicht explizit sichtbar.")


def is_dashboard_page(page: Page) -> bool:
    current_url = page.url.lower()
    if (
        "baseclass=ildashboardgui" in current_url
        or "baseclass=ilmembershipoverviewgui" in current_url
    ):
        return True
    try:
        title = page.title().lower()
    except PlaywrightError:
        title = ""
    return "dashboard" in title


def looks_like_download(link: LinkCandidate, allowed_extensions: Iterable[str]) -> bool:
    haystack = " ".join(
        [
            link.url,
            link.raw_href,
            link.text,
            link.title,
            link.target or "",
            " ".join(link.classes),
        ]
    ).lower()
    download_markers = (
        "download",
        "cmd=download",
        "sendfile",
        "cmd=sendfile",
        "cmd=deliver",
        "cmd=getfile",
        "cmd=downloadfile",
    )

    if any(marker in haystack for marker in download_markers):
        return True
    if has_allowed_extension(link.url, allowed_extensions):
        return True
    if has_allowed_extension(link.text, allowed_extensions):
        return True
    if re.search(r"\bdownload\b", link.text, flags=re.IGNORECASE):
        return True
    if goto_object_type(link.url) == "file":
        return True

    # ILIAS often exposes file objects through goto links before the actual
    # download endpoint is known. Treat explicit file object hints as candidates.
    file_object_markers = (
        "goto_uk_file",
        "/goto.php/file/",
        "target=file_",
        "target%3dfile_",
        "objtype=file",
        "cmdclass=ilobjfilegui",
        "ilobjfilegui",
    )
    if any(marker in haystack for marker in file_object_markers):
        return True
    return re.search(r"(^|[?&/_=-])file([_=&/-]|$)", haystack) is not None


def looks_like_folder(link: LinkCandidate) -> bool:
    haystack = " ".join(
        [
            link.url,
            link.raw_href,
            link.text,
            link.title,
            link.target or "",
            " ".join(link.classes),
        ]
    ).lower()
    folder_markers = (
        "goto_uk_fold",
        "/goto.php/fold/",
        "target=fold_",
        "target%3dfold_",
        "objtype=fold",
        "cmdclass=ilobjfoldergui",
        "ilobjfolder",
        "folder",
        "ordner",
    )
    course_or_group_markers = (
        "goto_uk_crs",
        "goto_uk_grp",
        "/goto.php/crs/",
        "/goto.php/grp/",
        "target=crs_",
        "target=grp_",
        "target%3dcrs_",
        "target%3dgrp_",
        "objtype=crs",
        "objtype=grp",
    )
    if goto_object_type(link.url) in {"crs", "grp", "fold"}:
        return True
    if not is_repository_content_url(link.url):
        return False
    if any(marker in haystack for marker in folder_markers + course_or_group_markers):
        return True

    repository_context_markers = (
        "il_container",
        "ilcontainer",
        "ilrepository",
        "repository",
        "object",
        "item",
        "title",
    )
    parsed = urlparse(link.url)
    query = parsed.query.lower()
    return (
        "baseclass=ilrepositorygui" in query
        and "ref_id=" in query
        and any(marker in haystack for marker in repository_context_markers)
    )


def is_traversable_folder(link: LinkCandidate) -> bool:
    """Return True only for links that should create local subfolders.

    Course/group links are useful for finding entry points, but inside a course
    they tend to explode into dashboard, membership, calendar, and info pages.
    Local hierarchy should therefore follow ILIAS folder objects only.
    """
    object_type = goto_object_type(link.url)
    if object_type == "fold":
        return True

    haystack = " ".join(
        [
            link.url,
            link.raw_href,
            link.text,
            link.title,
            link.target or "",
            " ".join(link.classes),
        ]
    ).lower()
    folder_markers = (
        "target=fold_",
        "target%3dfold_",
        "objtype=fold",
        "cmdclass=ilobjfoldergui",
        "ilobjfolder",
    )
    return is_repository_content_url(link.url) and any(
        marker in haystack for marker in folder_markers
    )


def log_link_debug(
    url: str,
    links: list[LinkCandidate],
    downloads: list[LinkCandidate],
    folders: list[LinkCandidate],
) -> None:
    LOGGER.info(
        "Link-Debug fuer %s: %d Links, %d Download-Kandidaten, %d Ordner-Kandidaten",
        url,
        len(links),
        len(downloads),
        len(folders),
    )
    download_urls = {link.url for link in downloads}
    folder_urls = {link.url for link in folders}
    for index, link in enumerate(links[:80], start=1):
        labels = []
        if link.url in download_urls:
            labels.append("download")
        if link.url in folder_urls:
            labels.append("folder")
        label_text = ",".join(labels) if labels else "-"
        text = (link.text or link.title or "").strip()
        if len(text) > 80:
            text = text[:77] + "..."
        LOGGER.info("  [%02d] %-15s text=%r url=%s", index, label_text, text, link.url)
    if len(links) > 80:
        LOGGER.info("  ... %d weitere Links ausgeblendet", len(links) - 80)


def cookies_to_requests_session(context: BrowserContext) -> requests.Session:
    session = requests.Session()
    for cookie in context.cookies():
        session.cookies.set(
            cookie["name"],
            cookie["value"],
            domain=cookie.get("domain"),
            path=cookie.get("path", "/"),
        )
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36"
            )
        }
    )
    return session


def cookie_identity(cookie: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(cookie.get("name", "")),
        str(cookie.get("domain", "")).lstrip(".").lower(),
        str(cookie.get("path", "/")),
    )


def restore_missing_cookies(context: BrowserContext, storage_state_path: Path) -> int:
    """Re-add cookies from the JSON state that the persistent profile lost.

    ILIAS keeps the login in PHPSESSID, a *session* cookie. Chromium drops
    session cookies when a persistent profile is closed, so the profile alone
    is logged out again right after save_session.py finished. The JSON state
    still contains the cookie. Only cookies missing in the profile are added,
    so newer cookies in the profile are never overwritten with stale ones.
    """
    if not storage_state_path.exists():
        return 0

    try:
        with storage_state_path.open("r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        LOGGER.debug("Storage-State konnte nicht gelesen werden: %s", exc)
        return 0

    saved = state.get("cookies") if isinstance(state, dict) else None
    if not isinstance(saved, list) or not saved:
        return 0

    try:
        present = {cookie_identity(dict(cookie)) for cookie in context.cookies()}
    except PlaywrightError:
        return 0

    now = time.time()
    missing = [
        cookie
        for cookie in saved
        if isinstance(cookie, dict)
        and cookie_identity(cookie) not in present
        and isinstance(cookie.get("expires", -1), (int, float))
        and not (0 < cookie.get("expires", -1) < now)
    ]
    if not missing:
        return 0

    try:
        context.add_cookies(missing)
    except PlaywrightError:
        LOGGER.debug("Cookies aus Storage-State konnten nicht geladen werden.")
        return 0
    LOGGER.debug("%d fehlende Cookie(s) aus Storage-State ergaenzt.", len(missing))
    return len(missing)


def dashboard_url(base_url: str) -> str:
    return urljoin(
        base_url, "ilias.php?baseClass=ilDashboardGUI&cmd=jumpToSelectedItems"
    )


def page_is_login_form(page: Page) -> bool:
    current_url = page.url.lower()
    if "login.php" in current_url or "cmd=force_login" in current_url:
        return True
    # Do not reject pages just because they contain words like "Login" or
    # "Anmelden"; ILIAS dashboards and help tours may contain those strings
    # even for authenticated users. A password field is the reliable signal
    # that we are on an actual login form.
    try:
        return page.locator("input[type='password']").count() > 0
    except PlaywrightError:
        return False


def goto_with_retry(
    page: Page,
    url: str,
    timeout: int = 45000,
    attempts: int = 3,
) -> None:
    """Navigate with a few retries for flaky university/home networks."""
    last_error: PlaywrightError | None = None
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            settle_page(page)
            return
        except PlaywrightError as exc:
            last_error = exc
            if attempt < attempts:
                wait_seconds = 5 * attempt
                LOGGER.warning(
                    "Laden fehlgeschlagen (Versuch %d/%d), neuer Versuch in %ds: %s",
                    attempt,
                    attempts,
                    wait_seconds,
                    url,
                )
                time.sleep(wait_seconds)
    assert last_error is not None
    raise last_error


def is_logged_in(page: Page, config: Config) -> bool:
    # The public start page renders fine without a session, so check a page
    # that really requires authentication.
    try:
        goto_with_retry(page, dashboard_url(config.base_url), timeout=30000)
    except PlaywrightError as exc:
        raise IliasUnreachableError(
            "ILIAS nicht erreichbar; Session-Pruefung fehlgeschlagen. "
            "Bitte den Sync spaeter erneut starten."
        ) from exc
    return same_domain(page.url, config.base_url) and not page_is_login_form(page)


def current_semester_label(today: date | None = None) -> str:
    """Return the semester label used in ILIAS course titles.

    Uni Koeln course names commonly use compact labels such as SoSe26 and
    WS25/26. The semester boundary is intentionally date-based, so the daily
    automation switches on April 1 and October 1 without a config edit.
    """
    today = today or date.today()
    year_short = today.year % 100
    if 4 <= today.month <= 9:
        return f"SoSe{year_short:02d}"
    if today.month >= 10:
        return f"WS{year_short:02d}/{(year_short + 1) % 100:02d}"
    return f"WS{(year_short - 1) % 100:02d}/{year_short:02d}"


def normalize_semester_text(value: str) -> str:
    return re.sub(r"[\s._-]+", "", value.lower())


def semester_aliases(semester: str) -> set[str]:
    cleaned = semester.strip()
    normalized = normalize_semester_text(cleaned)
    aliases = {normalized}

    sose_match = re.fullmatch(
        r"(?:sose|ss|sommersemester|sommer)(?:20)?(\d{2})", normalized
    )
    if sose_match:
        year_short = int(sose_match.group(1))
        aliases.update(
            {
                f"sose{year_short:02d}",
                f"sose20{year_short:02d}",
                f"ss{year_short:02d}",
                f"ss20{year_short:02d}",
                f"sommersemester20{year_short:02d}",
                f"sommer20{year_short:02d}",
            }
        )
        return aliases

    ws_match = re.fullmatch(r"(?:ws|wise)(\d{2})/?(\d{2})", normalized)
    if ws_match:
        start_short = int(ws_match.group(1))
        end_short = int(ws_match.group(2))
        aliases.update(
            {
                f"ws{start_short:02d}/{end_short:02d}",
                f"ws{start_short:02d}{end_short:02d}",
                f"wise{start_short:02d}/{end_short:02d}",
                f"wise{start_short:02d}{end_short:02d}",
                f"wise20{start_short:02d}/20{end_short:02d}",
                f"ws20{start_short:02d}/20{end_short:02d}",
                f"wintersemester20{start_short:02d}/20{end_short:02d}",
                f"wintersemester20{start_short:02d}20{end_short:02d}",
            }
        )
    return aliases


def course_matches_semester(course_name: str, semester: str) -> bool:
    normalized_name = normalize_semester_text(course_name)
    return any(alias in normalized_name for alias in semester_aliases(semester))


def configured_semester_filter(config: CrawlConfig) -> str:
    if config.semester_filter.strip().lower() == "auto":
        return current_semester_label()
    return config.semester_filter.strip()


def membership_urls(base_url: str) -> list[str]:
    return [
        urljoin(base_url, "ilias.php?baseClass=ilmembershipoverviewgui"),
        urljoin(base_url, "ilias.php?baseClass=ilDashboardGUI&cmd=jumpToMemberships"),
        urljoin(base_url, "ilias.php?baseClass=ilDashboardGUI&cmd=jumpToSelectedItems"),
    ]


def extract_course_links_from_html(
    html: str, current_url: str, config: Config
) -> dict[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    courses: dict[str, str] = {}
    seen_keys: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        if not isinstance(anchor, Tag):
            continue
        text = display_name(anchor.get_text(" ", strip=True), "")
        if not text:
            continue

        url = normalize_url(urljoin(current_url, str(anchor.get("href") or "")))
        if not same_domain(url, config.base_url) or is_ignored_url(url):
            continue
        if goto_object_type(url) != "crs":
            continue

        key = repository_object_key(url) or normalize_url(url)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        courses[text] = url

    return courses


def discover_semester_courses(page: Page, config: CrawlConfig) -> dict[str, str]:
    semester = configured_semester_filter(config)
    discovered: dict[str, str] = {}

    LOGGER.info("Suche ILIAS-Kurse fuer Semester: %s", semester)
    for url in membership_urls(config.base_url):
        try:
            goto_with_retry(page, url, timeout=60000, attempts=2)
        except PlaywrightError as exc:
            LOGGER.warning(
                "Kursuebersicht konnte nicht geladen werden: %s (%s)", url, exc
            )
            continue

        if page_is_login_form(page):
            raise SessionExpiredError()

        for course_name, course_url in extract_course_links_from_html(
            page.content(), page.url, config
        ).items():
            if course_matches_semester(course_name, semester):
                discovered.setdefault(course_name, course_url)

    if discovered:
        LOGGER.info(
            "%d Kurs(e) fuer %s automatisch erkannt: %s",
            len(discovered),
            semester,
            ", ".join(sorted(discovered)),
        )
    else:
        LOGGER.warning("Keine Kurse fuer %s automatisch erkannt.", semester)
    return discovered


def build_course_plan(page: Page, config: CrawlConfig) -> dict[str, str]:
    courses: dict[str, str] = {}

    if config.include_configured_courses or not config.auto_discover_current_semester:
        courses.update(config.courses)

    if config.auto_discover_current_semester:
        discovered = discover_semester_courses(page, config)
        # Discovered courses are authoritative for the current semester; manual
        # entries with the same name can still override details if configured.
        courses = {**discovered, **courses}

    if config.course_filter:
        if config.course_filter not in courses:
            available = ", ".join(sorted(courses)) or "keine"
            raise ValueError(
                f"Kurs nicht gefunden: {config.course_filter}. Verfuegbar: {available}"
            )
        courses = {config.course_filter: courses[config.course_filter]}

    if not courses:
        raise ValueError("Keine Kurse zum Synchronisieren gefunden.")
    return courses


def fetch_headers(session: requests.Session, url: str) -> requests.Response | None:
    try:
        response = session.get(url, stream=True, timeout=30, allow_redirects=True)
        response.raise_for_status()
        return response
    except requests.RequestException as exc:
        LOGGER.debug("Direkter Abruf fehlgeschlagen fuer %s: %s", url, exc)
        return None


def response_looks_like_file(
    response: requests.Response, allowed_extensions: Iterable[str], url: str
) -> bool:
    disposition = response.headers.get("content-disposition", "").lower()
    content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
    disposition_name = filename_from_content_disposition(disposition)
    if disposition_name and has_allowed_extension(disposition_name, allowed_extensions):
        return True
    if has_allowed_extension(url, allowed_extensions):
        return True
    mapped_extension = content_type_to_extension(content_type).lstrip(".")
    if mapped_extension and mapped_extension in allowed_extensions:
        return True
    if "attachment" in disposition:
        LOGGER.debug("Attachment ohne erlaubte Dateiendung ignoriert: %s", url)
    return False


def save_response_atomic(response: requests.Response, destination: Path) -> None:
    with download_staging(destination) as temporary, temporary.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=1024 * 256):
            if chunk:
                handle.write(chunk)


@contextmanager
def download_staging(destination: Path) -> Iterator[Path]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=destination.parent, suffix=".part", delete=False
    ) as handle:
        temporary = Path(handle.name)
    try:
        yield temporary
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def try_playwright_download(
    page: Page,
    link: LinkCandidate,
    destination_dir: Path,
    allowed_extensions: Iterable[str],
    overwrite: bool,
    dry_run: bool,
    new_files: list[Path] | None = None,
) -> str | None:
    selector = f'a[href="{css_escape(link.raw_href)}"]'
    source_url = page.url
    locator_group = page.locator(selector)
    try:
        if locator_group.count() < 1:
            return None
    except PlaywrightError:
        return None

    locator = locator_group.first
    if dry_run:
        LOGGER.info("[dry-run] Browser-Download-Klick: %s", link.text or link.url)
        return "dry-run"

    try:
        with page.expect_download(timeout=5000) as download_info:
            locator.click(button="left", timeout=5000, modifiers=["Alt"])
        download = download_info.value
    except PlaywrightTimeoutError:
        restore_page(page, source_url)
        return None
    except PlaywrightError as exc:
        LOGGER.debug("Playwright-Download fehlgeschlagen fuer %s: %s", link.url, exc)
        restore_page(page, source_url)
        return None

    suggested = download.suggested_filename or choose_filename(
        link.url, link.text, allowed_extensions=allowed_extensions
    )
    filename = safe_name(suggested)
    if not filename_allowed(filename, allowed_extensions):
        download.cancel()
        restore_page(page, source_url)
        LOGGER.debug("Browser-Download ohne erlaubte Endung ignoriert: %s", filename)
        return "not-file"

    destination = destination_dir / filename
    if destination.exists() and not overwrite:
        download.cancel()
        restore_page(page, source_url)
        return "skipped"
    if not overwrite:
        destination = unique_path(destination)

    try:
        with download_staging(destination) as temporary:
            download.save_as(str(temporary))
        if new_files is not None:
            new_files.append(destination)
    finally:
        restore_page(page, source_url)
    return "downloaded"


def restore_page(page: Page, url: str) -> None:
    if normalize_url(page.url) == normalize_url(url):
        return
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=15000)
    except PlaywrightError as exc:
        LOGGER.debug(
            "Konnte Ursprungsseite nach Download-Klick nicht erneut laden: %s", exc
        )


def css_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def download_with_requests(
    session: requests.Session,
    link: LinkCandidate,
    destination_dir: Path,
    allowed_extensions: Iterable[str],
    overwrite: bool,
    dry_run: bool,
    new_files: list[Path] | None = None,
) -> str:
    response = fetch_headers(session, link.url)
    if response is None:
        return "error"

    with response:
        if not response_looks_like_file(response, allowed_extensions, link.url):
            return "not-file"

        filename = choose_allowed_filename(
            str(response.url), link.text, response.headers, allowed_extensions
        )
        if filename is None:
            LOGGER.debug("Download ohne erlaubte Endung ignoriert: %s", response.url)
            return "not-file"

        destination = destination_dir / filename
        if destination.exists() and not overwrite:
            return "skipped"
        if not overwrite:
            destination = unique_path(destination)

        if dry_run:
            LOGGER.info("[dry-run] Download: %s -> %s", link.url, destination)
            return "dry-run"

        save_response_atomic(response, destination)
        if new_files is not None:
            new_files.append(destination)
        return "downloaded"


def handle_download_candidate(
    page: Page,
    session: requests.Session,
    link: LinkCandidate,
    destination_dir: Path,
    config: CrawlConfig,
    new_files: list[Path] | None = None,
) -> str:
    # Direct authenticated downloads avoid opening and cancelling a browser
    # download for every existing file. Keep browser clicks as a fallback for
    # endpoints that require interactive navigation.
    result = download_with_requests(
        session,
        link,
        destination_dir,
        config.file_extensions,
        config.overwrite,
        config.dry_run,
        new_files,
    )
    if result in {"downloaded", "skipped", "dry-run", "not-file"}:
        return result
    browser_result = try_playwright_download(
        page,
        link,
        destination_dir,
        config.file_extensions,
        config.overwrite,
        config.dry_run,
        new_files,
    )
    return browser_result or result


def crawl_course(
    page: Page,
    session: requests.Session,
    config: CrawlConfig,
    course_name: str,
    course_url: str,
    stats: SyncStats | None = None,
) -> SyncStats:
    if stats is None:
        stats = SyncStats()
    visited_urls: set[str] = set()
    course_dir = config.download_dir / folder_name(course_name, "kurs")

    def crawl(url: str, local_dir: Path, depth: int) -> None:
        normalized = normalize_url(url)
        visit_key = navigation_key(url)
        if visit_key in visited_urls or depth > config.max_depth:
            return
        visited_urls.add(visit_key)

        LOGGER.info("Oeffne: %s", normalized)
        try:
            goto_with_retry(page, normalized)
        except PlaywrightError as exc:
            LOGGER.error("Seite konnte nicht geladen werden: %s (%s)", normalized, exc)
            stats.errors += 1
            return

        if page_is_login_form(page):
            raise SessionExpiredError()
        if (
            depth == 0
            and is_dashboard_page(page)
            and goto_object_type(course_url) == "crs"
        ):
            LOGGER.error(
                "Die Kurs-URL fuer '%s' fuehrt auf das Dashboard statt in den Kurs. "
                "Pruefe den Eintrag in config.yaml: %s",
                course_name,
                course_url,
            )
            stats.errors += 1
            return

        links = extract_links(page.content(), page.url, config.base_url)
        downloads = [
            link for link in links if looks_like_download(link, config.file_extensions)
        ]
        folders = unique_links_by_navigation_key(
            link
            for link in links
            if is_traversable_folder(link)
            and not looks_like_download(link, config.file_extensions)
            and navigation_key(link.url) not in visited_urls
        )

        if config.debug_links:
            log_link_debug(normalized, links, downloads, folders)
        elif depth == 0 and not downloads and not folders:
            LOGGER.info(
                "Keine Download- oder Ordnerlinks erkannt. "
                "Starte zur Diagnose erneut mit: --dry-run --verbose --debug-links --headful"
            )

        for link in tqdm(
            downloads,
            desc=f"{course_name} Tiefe {depth}",
            unit="Datei",
            disable=not sys.stderr.isatty(),
        ):
            stats.found += 1
            try:
                result = handle_download_candidate(
                    page, session, link, local_dir, config, stats.new_files
                )
            except Exception as exc:  # noqa: BLE001 — isolate file or course failures
                LOGGER.error("Download fehlgeschlagen: %s (%s)", link.url, exc)
                stats.errors += 1
                continue

            if result in {"downloaded", "dry-run"}:
                stats.downloaded += 1
            elif result == "skipped":
                stats.skipped += 1
            elif result == "not-file":
                LOGGER.debug("Kandidat war keine direkt ladbare Datei: %s", link.url)
            else:
                stats.errors += 1

        if folders and depth == config.max_depth:
            LOGGER.warning(
                "Maximale Ordnertiefe %d erreicht: %d Unterordner in %s ausgelassen.",
                config.max_depth,
                len(folders),
                normalized,
            )
            stats.errors += 1

        for link in folders:
            child_name = folder_name(link_label(link, "ordner"), "ordner")
            crawl(link.url, local_dir / child_name, depth + 1)

    crawl(course_url, course_dir, 0)
    return stats


def local_copy_path(config: CrawlConfig, path: Path) -> Path:
    """Return the matching file in local_download_dir, if one is configured."""
    if config.local_download_dir is None:
        return path
    try:
        return config.local_download_dir / path.relative_to(config.download_dir)
    except ValueError:
        return path


def sync_local_course(config: CrawlConfig, course_name: str) -> int:
    """Copy downloaded materials without deletions and return the error count.

    The primary download folder lives in Google Drive. Its file provider can
    briefly refuse access (e.g. EDEADLK "Resource deadlock avoided" while a
    file is still materialising), so a single file error is logged and skipped
    instead of aborting the whole run.
    """
    if config.local_download_dir is None or config.dry_run:
        return 0
    source = config.download_dir / folder_name(course_name, "kurs")
    target = config.local_download_dir / source.name
    if not source.exists() or source.resolve() == target.resolve():
        return 0
    copied = 0
    failed = 0
    for path in source.rglob("*"):
        try:
            if (
                not path.is_file()
                or path.is_symlink()
                or not filename_allowed(path.name, config.file_extensions)
            ):
                continue
            destination = target / path.relative_to(source)
            if destination.exists() and filecmp.cmp(path, destination, shallow=False):
                continue
            with download_staging(destination) as temporary:
                shutil.copy2(path, temporary)
            copied += 1
        except OSError as exc:
            failed += 1
            LOGGER.warning(
                "Lokale Kopie fehlgeschlagen, naechster Lauf versucht es erneut: %s (%s)",
                path,
                exc,
            )
    LOGGER.info(
        "Lokal synchronisiert: %s (%d Datei(en) kopiert%s)",
        target,
        copied,
        f", {failed} uebersprungen" if failed else "",
    )
    return failed


def launch_context(playwright: Any, headful: bool) -> BrowserContext:
    paths.PROFILE.mkdir(parents=True, exist_ok=True)
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=str(paths.PROFILE),
        channel="chromium",
        headless=not headful,
        accept_downloads=True,
        timeout=60000,
    )
    restore_missing_cookies(context, paths.STORAGE_STATE)
    return context


def save_session(context: BrowserContext) -> None:
    paths.atomic_write(paths.STORAGE_STATE, json.dumps(context.storage_state()))


def short_course_name(name: str) -> str:
    return (
        re.sub(
            r"^\[(?:WS|WiSe|SS|SoSe)\s*[^\]]+\]\s*", "", name, flags=re.IGNORECASE
        ).strip()
        or name
    )


def add_files(
    report: RunReport, config: CrawlConfig, stats: SyncStats, course: CourseReport
) -> None:
    course_root = config.download_dir / folder_name(course.name, "kurs")
    for original in stats.new_files:
        path = local_copy_path(config, original)
        try:
            if not path.is_file():
                path = original
            info = original.stat()
            path = path.resolve()
        except OSError as exc:
            LOGGER.warning("Dateiinformationen konnten nicht gelesen werden: %s", exc)
            continue
        folder = original.parent.relative_to(course_root)
        report.new_files.append(
            FileEntry(
                str(path),
                path.name,
                course.short_name,
                "" if folder == Path(".") else str(folder),
                info.st_size,
                datetime.fromtimestamp(info.st_mtime)
                .astimezone()
                .isoformat(timespec="seconds"),
            )
        )


def run_sync(
    config: CrawlConfig,
    headful: bool,
    report: RunReport,
    on_progress: Callable[[RunReport], None] | None = None,
) -> None:
    from .auth import headless_login

    if config.auto_discover_current_semester:
        report.semester = configured_semester_filter(config)
    if on_progress:
        on_progress(report)
    if not config.dry_run:
        config.download_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        context = launch_context(playwright, headful)
        try:
            page = context.new_page()
            if not is_logged_in(page, config):
                if not (config.auto_login and headless_login(page, config)):
                    raise SessionExpiredError()
                LOGGER.info("Headless-Login erfolgreich.")
                save_session(context)

            with cookies_to_requests_session(context) as session:
                plan = build_course_plan(page, config)
                progress = report.progress = RunProgress(courses_total=len(plan))
                if on_progress:
                    on_progress(report)
                for name, url in plan.items():
                    LOGGER.info("Synchronisiere Kurs: %s", name)
                    course = CourseReport(name, short_course_name(name), url)
                    report.courses.append(course)
                    progress.current_course = course.short_name
                    if on_progress:
                        on_progress(report)
                    stats = SyncStats()
                    try:
                        crawl_course(page, session, config, name, url, stats)
                        stats.errors += sync_local_course(config, name)
                    except SessionExpiredError:
                        raise
                    except Exception as exc:  # noqa: BLE001 — isolate file or course failures
                        LOGGER.error("Kurs '%s' abgebrochen: %s", name, exc)
                        stats.errors += 1
                        course.error_message = str(exc)
                    finally:
                        for key in report.totals:
                            count = getattr(stats, key)
                            setattr(course, key, count)
                            report.totals[key] += count
                        add_files(report, config, stats, course)
                    progress.courses_done += 1
                    progress.current_course = None
                    if on_progress:
                        on_progress(report)
            save_session(context)
        finally:
            context.close()
