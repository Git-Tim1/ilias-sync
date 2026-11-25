import json
from datetime import date
from pathlib import Path

import pytest

from ilias_sync.config import Config
from ilias_sync.crawler import (
    choose_allowed_filename,
    course_matches_semester,
    current_semester_label,
    extract_course_links_from_html,
    extract_links,
    goto_object_type,
    is_traversable_folder,
    looks_like_download,
    normalize_url,
    repository_object_key,
    restore_missing_cookies,
    short_course_name,
)

BASE = "https://ilias.example/ilias/"


def test_classification() -> None:
    html = (Path(__file__).parent / "fixtures" / "course.html").read_text()
    links = extract_links(html, BASE, BASE)
    assert {link.text for link in links if is_traversable_folder(link)} == {"Vorlesung"}
    assert {link.text for link in links if looks_like_download(link, {"pdf"})} == {
        "Einführung.pdf",
        "Arbeitsblatt",
    }
    assert extract_course_links_from_html(html, BASE, Config(base_url=BASE)) == {
        "[WS26/27] Softwaretechnik": BASE + "goto.php/crs/103"
    }


@pytest.mark.parametrize("url", ["goto.php/crs/103", "goto_uk_crs_103.html"])
def test_course_url_aliases(url: str) -> None:
    assert goto_object_type(BASE + url) == "crs"
    assert repository_object_key(BASE + url) == repository_object_key(
        BASE + "goto.php/crs/103"
    )
    assert normalize_url(BASE + url + "#abschnitt") == BASE + url


def test_filename_selection() -> None:
    assert (
        choose_allowed_filename(
            BASE,
            "Anderer Titel.pdf",
            {
                "content-disposition": "attachment; filename*=UTF-8''Folien%20Kapitel%201.pdf"
            },
            {"pdf"},
        )
        == "Folien-Kapitel-1.pdf"
    )
    assert (
        choose_allowed_filename(
            "https://ilias.example/",
            "Einführung",
            {"content-type": "application/pdf"},
            {"pdf"},
        )
        == "Einfuhrung.pdf"
    )
    assert (
        choose_allowed_filename(
            BASE, "Unbekannt", {"content-type": "text/html"}, {"pdf"}
        )
        is None
    )


@pytest.mark.parametrize(
    ("day", "label"),
    [
        (date(2026, 9, 30), "SoSe26"),
        (date(2026, 10, 1), "WS26/27"),
        (date(2026, 12, 31), "WS26/27"),
        (date(2027, 1, 1), "WS26/27"),
        (date(2027, 3, 31), "WS26/27"),
        (date(2027, 4, 1), "SoSe27"),
    ],
)
def test_semester(day: date, label: str) -> None:
    assert current_semester_label(day) == label


def test_course_semester() -> None:
    assert course_matches_semester("[WiSe 2026/2027] Softwaretechnik", "WS26/27")
    assert not course_matches_semester("[WS25/26] Softwaretechnik", "WS26/27")
    assert short_course_name("[WS26/27] Softwaretechnik") == "Softwaretechnik"


def test_restore_only_missing_cookies(tmp_path: Path) -> None:
    browser_cookie = {
        "name": "persisted",
        "value": "new",
        "domain": "ilias.example",
        "path": "/",
    }
    session_cookie = {
        **browser_cookie,
        "name": "PHPSESSID",
        "value": "fixture",
        "expires": -1,
    }

    class FakeContext:
        def __init__(self) -> None:
            self.added: list[dict] = []

        def cookies(self) -> list[dict]:
            return [browser_cookie]

        def add_cookies(self, cookies: list[dict]) -> None:
            self.added.extend(cookies)

    state = tmp_path / "storage-state.json"
    state.write_text(
        json.dumps(
            {
                "cookies": [
                    session_cookie,
                    {**browser_cookie, "value": "old"},
                    {**browser_cookie, "name": "expired", "expires": 1},
                ]
            }
        )
    )
    context = FakeContext()
    assert restore_missing_cookies(context, state) == 1
    assert context.added == [session_cookie]


@pytest.mark.parametrize("alias", ["SS27", "SoSe27", "SoSe 27", "Sommersemester 2027"])
def test_summer_semester_aliases(alias):
    assert course_matches_semester("[Sommersemester 2027] Kurs", alias)
    assert course_matches_semester(f"[{alias}] Kurs", "SoSe27")
    assert not course_matches_semester("[SoSe28] Kurs", alias)


@pytest.mark.parametrize("alias", ["WS26/27", "WiSe 26/27"])
def test_winter_semester_aliases(alias):
    assert course_matches_semester("[WS26/27] Kurs", alias)
    assert course_matches_semester(f"[{alias}] Kurs", "WS26/27")


def test_course_progress(monkeypatch):
    from contextlib import nullcontext
    from dataclasses import asdict
    from types import SimpleNamespace

    from ilias_sync import crawler
    from ilias_sync.reports import RunReport

    plan = {"[SoSe27] Alpha": BASE, "[SoSe27] Beta": BASE}
    context = SimpleNamespace(new_page=object, close=lambda: None)
    for name, fake in {
        "sync_playwright": nullcontext,
        "launch_context": lambda *_: context,
        "is_logged_in": lambda *_: True,
        "cookies_to_requests_session": lambda *_: nullcontext(),
        "build_course_plan": lambda *_: plan,
        "crawl_course": lambda *_: None,
        "sync_local_course": lambda *_: 0,
        "save_session": lambda *_: None,
    }.items():
        monkeypatch.setattr(crawler, name, fake)
    snapshots = []
    report = RunReport("progress", "cli", dry_run=True)
    crawler.run_sync(
        crawler.CrawlConfig(dry_run=True),
        False,
        report,
        on_progress=lambda current: snapshots.append(asdict(current)["progress"]),
    )
    assert snapshots == [
        None,
        {"courses_done": 0, "courses_total": 2, "current_course": None},
        {"courses_done": 0, "courses_total": 2, "current_course": "Alpha"},
        {"courses_done": 1, "courses_total": 2, "current_course": None},
        {"courses_done": 1, "courses_total": 2, "current_course": "Beta"},
        {"courses_done": 2, "courses_total": 2, "current_course": None},
    ]
