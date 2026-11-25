from ilias_sync import notifications
from ilias_sync.reports import FileEntry, RunReport


def test_notification_passes_text_as_data_and_limits_names(monkeypatch):
    calls = []
    monkeypatch.setattr(notifications.sys, "platform", "darwin")
    monkeypatch.setattr(
        notifications.subprocess, "run", lambda argv, **_: calls.append(argv)
    )
    report = RunReport("fixture", "schedule", result="success")
    notifications.notify(report)
    assert calls == []

    report.new_files = [
        FileEntry("", name, "", "", 0, "")
        for name in ('"quoted".pdf', "\\slashes.pdf", "third.pdf", "fourth.pdf")
    ]
    notifications.notify(report)
    assert calls[-1][2] == notifications.DISPLAY_NOTIFICATION
    assert calls[-1][-2:] == [
        "4 neue Dateien in ILIAS",
        '"quoted".pdf\n\\slashes.pdf\nthird.pdf',
    ]

    report.result = "session_expired"
    notifications.notify(report)
    assert calls[-1][-2] == "ILIAS-Login erforderlich"

    monkeypatch.setattr(notifications.sys, "platform", "linux")
    notifications.notify(report)
    assert len(calls) == 2
