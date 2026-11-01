"""Release version shared by runtime metadata and the source manifest."""

import tomllib
from pathlib import Path

VERSION = tomllib.loads((Path(__file__).resolve().parents[3] / "pyproject.toml").read_text())["project"][
    "version"
]
