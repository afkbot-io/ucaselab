#!/usr/bin/env python3
"""Detect broken repository documentation links and drift in the published MCP contract."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/api"))
from app.main import REGISTRY
from app.version import VERSION


def check() -> None:
    """Validate local file links, operation descriptions, schemas and release metadata."""
    documents = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]
    for document in documents:
        # Ignore code examples: project templates contain intentionally illustrative paths.
        prose = re.sub(r"```.*?```", "", document.read_text(), flags=re.S)
        for link in re.findall(r"\[[^\]]+\]\(([^\s)]+)\)", prose):
            if ":" in link or link.startswith(("#", "/")):
                continue
            target = link.split("#", 1)[0]
            assert not target or (document.parent / target).exists(), (document, link)
    schema = json.loads((ROOT / "docs/API_SCHEMA.json").read_text())
    assert schema["version"] == VERSION
    assert set(schema["operations"]) == set(REGISTRY)
    contract = (ROOT / "docs/MCP_CONTRACT.md").read_text()
    assert contract.startswith(f"# MCP-контракт UCaseLab {VERSION}\n")
    for name, operation in REGISTRY.items():
        assert operation["func"].__doc__, f"Missing MCP description: {name}"
        exported = schema["operations"][name]
        assert exported["description"] == operation["func"].__doc__, name
        assert exported["arguments"] == operation["model"].model_json_schema(), name
        assert f"| `{name}` |" in contract, f"Missing contract table entry: {name}"
    package = json.loads((ROOT / "apps/web/package.json").read_text())
    assert package["version"] == VERSION
    catalog = json.loads((ROOT / "dist/skills/index.json").read_text())
    assert catalog["contract_version"] == VERSION
    print(f"Validated {len(documents)} documents and {len(REGISTRY)} documented operation schemas ({VERSION})")


if __name__ == "__main__":
    check()
