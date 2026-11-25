# -*- mode: python ; coding: utf-8 -*-

import sys
from pathlib import Path

root = Path(SPECPATH).resolve().parent
source = root / "src"
sys.path.insert(0, str(source))
from ilias_sync import __version__

is_mac = sys.platform == "darwin"
is_windows = sys.platform == "win32"
name = "ilias-sync"

analysis = Analysis(
    [str(root / "packaging" / "entry.py")],
    pathex=[str(source)],
    datas=[
        (str(source / "ilias_sync" / "web"), "ilias_sync/web"),
    ],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    excludes=["webview"] if sys.platform == "linux" else [],
)
exe = EXE(
    PYZ(analysis.pure),
    analysis.scripts,
    [],
    exclude_binaries=True,
    name=name,
    console=True,
    hide_console="hide-early" if is_windows else None,
)
files = COLLECT(exe, analysis.binaries, analysis.datas, name=name)

if is_mac:
    app = BUNDLE(
        files,
        name="ILIAS Sync.app",
        icon=str(root / "packaging" / "assets" / "app.icns"),
        bundle_identifier="io.github.ilias-sync",
        version=__version__,
        info_plist={
            "CFBundleVersion": __version__,
            "CFBundleDisplayName": "ILIAS Sync",
            # Keep CLI output attached to the terminal and launch the app in the Dock.
            "LSBackgroundOnly": False,
        },
    )
