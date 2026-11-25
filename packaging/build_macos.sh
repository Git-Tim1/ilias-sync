#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
python_bin="${PYTHON:-.venv/bin/python}"
version="$("$python_bin" -c 'from ilias_sync import __version__; print(__version__)')"
arch="$("$python_bin" -c 'import platform; print(platform.machine())')"
app="dist/ILIAS Sync.app"
dmg="dist/ILIAS-Sync-$version-macOS-$arch.dmg"

"$python_bin" -m PyInstaller --noconfirm --clean packaging/ilias-sync.spec
codesign --verify --deep --strict "$app"
"$app/Contents/MacOS/ilias-sync" --help
"$app/Contents/MacOS/ilias-sync" browser status
"$python_bin" -m dmgbuild -s packaging/dmg_settings.py -D "app=$app" "ILIAS Sync" "$dmg"
hdiutil verify "$dmg"
