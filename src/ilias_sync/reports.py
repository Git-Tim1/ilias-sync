"""Serialisable sync reports."""

from dataclasses import dataclass, field
from datetime import datetime


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


@dataclass
class FileEntry:
    path: str
    name: str
    course: str
    folder: str
    size: int
    downloaded_at: str


@dataclass
class CourseReport:
    name: str
    short_name: str
    url: str
    found: int = 0
    downloaded: int = 0
    skipped: int = 0
    errors: int = 0
    error_message: str | None = None


@dataclass
class RunProgress:
    courses_done: int = 0
    courses_total: int = 0
    current_course: str | None = None


@dataclass
class RunReport:
    run_id: str
    trigger: str
    started_at: str = field(default_factory=now_iso)
    finished_at: str | None = None
    result: str = "running"
    message: str = ""
    dry_run: bool = False
    semester: str | None = None
    totals: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(
            ("found", "downloaded", "skipped", "errors"), 0
        )
    )
    courses: list[CourseReport] = field(default_factory=list)
    new_files: list[FileEntry] = field(default_factory=list)
    progress: RunProgress | None = None
