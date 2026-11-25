"""Finder layout for the release disk image."""

from pathlib import Path

app = Path(defines["app"])  # noqa: F821 - supplied by dmgbuild
files = [str(app)]
symlinks = {"Applications": "/Applications"}
icon_locations = {app.name: (135, 125), "Applications": (405, 125)}
window_rect = ((200, 150), (540, 285))
icon_size = 96
format = "UDZO"
