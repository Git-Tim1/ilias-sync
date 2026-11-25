"""Entry point shared by desktop users and bundled CLI subprocesses."""

import sys

if len(sys.argv) > 1:
    from ilias_sync.cli import main

    raise SystemExit(main())

from ilias_sync.desktop import main

raise SystemExit(main(["--browser"] if sys.platform == "linux" else []))
