#!/usr/bin/env python3
"""Build the project's versioned skill archives and checksum catalog."""

from __future__ import annotations

import hashlib
import tomllib
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "skills"
OUTPUT = ROOT / "dist" / "skills"
CONTRACT_VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["version"]


def inline_scalar(frontmatter: str, key: str, indent: int = 0) -> str:
    """Read the intentionally inline scalar fields used by these skill files."""
    match = re.search(rf"^{' ' * indent}{re.escape(key)}: (.+)$", frontmatter, re.M)
    if match is None:
        raise ValueError(f"Missing inline frontmatter field: {key}")
    value = match.group(1).strip()
    if value.startswith('"'):
        value = json.loads(value)
    elif value.startswith("'") and value.endswith("'"):
        value = value[1:-1].replace("''", "'")
    elif value in {"|", ">"}:
        raise ValueError(f"Field {key} must be inline for packaging")
    if not isinstance(value, str) or not value:
        raise ValueError(f"Field {key} must be a non-empty string")
    return value


def build() -> dict:
    if not SOURCES.is_dir():
        raise ValueError("No skills source directory")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    packages = []

    for directory in sorted(SOURCES.iterdir()):
        if directory.name.startswith("."):
            continue
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError(f"Unexpected skill source: {directory}")
        document = (directory / "SKILL.md").read_text(encoding="utf-8")
        header = re.match(r"\A---\n(.*?)\n---(?:\n|$)", document, re.S)
        if header is None:
            raise ValueError(f"Missing frontmatter: {directory.name}")
        name = inline_scalar(header[1], "name")
        description = inline_scalar(header[1], "description")
        version = inline_scalar(header[1], "version", indent=2)
        contract = inline_scalar(header[1], "contract-version", indent=2)
        if name != directory.name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            raise ValueError(f"Invalid or mismatched skill name: {name}")
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError(f"Invalid package version: {version}")
        if contract != CONTRACT_VERSION:
            raise ValueError(f"Unsupported contract version in {name}: {contract}")

        archive = OUTPUT / f"{name}-{version}.zip"
        temporary = archive.with_suffix(".zip.tmp")
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=9) as bundle:
            for source in sorted(directory.rglob("*")):
                if source.is_symlink():
                    raise ValueError(f"Symlink cannot enter a package: {source}")
                relative = source.relative_to(directory)
                if any(part.startswith(".") for part in relative.parts):
                    raise ValueError(f"Hidden file cannot enter a package: {source}")
                if not source.is_file():
                    continue
                entry = ZipInfo(f"{name}/{relative.as_posix()}", date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = ZIP_DEFLATED
                bundle.writestr(entry, source.read_bytes(), compresslevel=9)
        if archive.exists() and archive.read_bytes() != temporary.read_bytes():
            temporary.unlink()
            raise ValueError(f"Package {archive.name} changed: increment the skill version before publishing")
        temporary.replace(archive)
        binary = archive.read_bytes()
        packages.append({
            "name": name,
            "version": version,
            "contract_version": contract,
            "description": description,
            "archive": archive.name,
            "entrypoint": f"{name}/SKILL.md",
            "size_bytes": len(binary),
            "sha256": hashlib.sha256(binary).hexdigest(),
        })

    if not packages:
        raise ValueError("No skill packages found")
    catalog = {"schema_version": 1, "contract_version": CONTRACT_VERSION, "skills": packages}
    (OUTPUT / "index.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return catalog


if __name__ == "__main__":
    result = build()
    print(f"Built {len(result['skills'])} skill packages in {OUTPUT}")
