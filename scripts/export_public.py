#!/usr/bin/env python3
"""Project a clean source snapshot into a product-only tree without Git history.

The caller supplies an immutable source SHA and must run this from its git archive.
This allowlist is shared with source releases; generated skills are added separately
by the release builder. File hashes describe the projection, not a public Git commit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import TypedDict

ROOT_FILES = (
    "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "Makefile", "pyproject.toml", "uv.lock", "alembic.ini",
    "compose.yaml", "compose.dev.yaml", "compose.local.yaml", ".env.example",
    ".gitignore", ".dockerignore",
)
PRODUCT_DIRS = ("apps", "docs", "scripts", "skills", ".github")
INFRA_FILES = ("infra/nginx.conf", "infra/security-headers.conf")
EXCLUDED_DIRS = {
    "node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache",
    "dist", "output", "data", ".git", ".scion", ".playwright-cli",
}
EXCLUDED_FILES = {
    "docs/implementation/STATUS.md",
    "docs/implementation/UI_REVIEW.md",
    "docs/MCP_CONTRACT_PLAN_0.3.md",
    "docs/SYSTEM_ANALYSIS.md",
    "docs/COLLABORATION_PLANS_AND_UX.md",
    "docs/VERSIONING_AND_PROPOSALS.md",
    "docs/SKILL_REVIEW.md",
}


def product_files(root: Path) -> list[Path]:
    """Return sorted product files; reject symlinks rather than dereferencing them."""
    root = root.resolve()
    result: list[Path] = []

    def visit(path: Path) -> None:
        relative = path.relative_to(root).as_posix()
        if path.name in EXCLUDED_DIRS or relative in EXCLUDED_FILES:
            return
        if path.is_symlink():
            raise ValueError(f"Symlink in product source: {relative}")
        if path.is_dir():
            for child in sorted(path.iterdir()):
                if not child.name.startswith(".") or child.name == ".github":
                    visit(child)
        elif path.is_file():
            if path.name.startswith(".") and relative not in ROOT_FILES:
                return
            if path.name.endswith((".pyc", ".tsbuildinfo", ".log")):
                return
            result.append(path)

    for name in (*ROOT_FILES, *PRODUCT_DIRS, *INFRA_FILES):
        path = root / name
        if path.exists() or path.is_symlink():
            visit(path)
    return sorted(set(result))


class FileInfo(TypedDict):
    size: int
    sha256: str


class ExportManifest(TypedDict):
    private_source_sha: str
    projection_version: int
    root_files: tuple[str, ...]
    product_directories: tuple[str, ...]
    infra_files: tuple[str, ...]
    excluded_directories: list[str]
    excluded_files: list[str]
    files: dict[str, FileInfo]


def file_manifest(root: Path, paths: list[Path]) -> dict[str, FileInfo]:
    """Hash each included byte stream; never record environment values or host paths."""
    return {
        path.relative_to(root).as_posix(): {
            "size": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in paths
    }


def export(source: Path, destination: Path, source_sha: str) -> ExportManifest:
    """Create a new tree; refuse overwrites and destinations inside the input tree."""
    source = source.resolve()
    destination = destination.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", source_sha):
        raise ValueError("Expected full source commit SHA")
    if destination.is_relative_to(source):
        raise ValueError("Export destination must be outside the source tree")
    paths = product_files(source)
    destination.mkdir(parents=True, exist_ok=False)
    for path in paths:
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        target.chmod(0o644)
    return {
        "private_source_sha": source_sha,
        "projection_version": 1,
        "root_files": ROOT_FILES,
        "product_directories": PRODUCT_DIRS,
        "infra_files": INFRA_FILES,
        "excluded_directories": sorted(EXCLUDED_DIRS | {"infra/scion"}),
        "excluded_files": sorted(EXCLUDED_FILES | {"AGENTS.md"}),
        "files": file_manifest(source, paths),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    if manifest_path.is_relative_to(args.source.resolve()) or manifest_path.is_relative_to(args.destination.resolve()):
        raise ValueError("Keep provenance manifest outside source and product trees")
    if manifest_path.exists():
        raise FileExistsError("Manifest already exists; refusing to overwrite")
    if not manifest_path.parent.is_dir():
        raise ValueError("Manifest parent directory must already exist")
    manifest = export(args.source, args.destination, args.source_sha)
    with manifest_path.open("x") as stream:
        stream.write(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    print(f"Exported {len(manifest['files'])} product files")


if __name__ == "__main__":
    main()
