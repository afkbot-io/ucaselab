#!/usr/bin/env python3
"""Validate packaged skills against sources and the exported operation catalog."""
import hashlib
import json
import re
from zipfile import ZipFile

from package_skills import CONTRACT_VERSION, OUTPUT, ROOT, SOURCES, inline_scalar


def check():
    catalog = json.loads((OUTPUT / "index.json").read_text())
    schema = json.loads((ROOT / "docs/API_SCHEMA.json").read_text())
    assert catalog["contract_version"] == schema["version"] == CONTRACT_VERSION
    names = {p.name for p in SOURCES.iterdir() if p.is_dir()}
    assert names == {p["name"] for p in catalog["skills"]}
    tools = set(schema["operations"])
    references = re.compile(r"\b(?:get|list|create|update|save|publish|restore|move|rename|archive|preview|begin|finish|record|reveal|cancel|complete|add|submit|check|accept|delete|moderate|resolve|revoke|transfer)_[a-z_]+\b")
    for package in catalog["skills"]:
        source = SOURCES / package["name"]
        markdown = (source / "SKILL.md").read_text()
        header = re.match(r"\A---\n(.*?)\n---(?:\n|$)", markdown, re.S)
        assert header, package["name"]
        assert inline_scalar(header[1], "name") == package["name"]
        assert inline_scalar(header[1], "description") == package["description"]
        assert inline_scalar(header[1], "version", 2) == package["version"]
        assert inline_scalar(header[1], "contract-version", 2) == CONTRACT_VERSION
        unknown = set(references.findall(markdown)) - tools - {"update_use_case"}  # Proposal item discriminator.
        assert not unknown, (package["name"], unknown)
        for target in re.findall(r"\[[^]]+\]\(([^)]+)\)", markdown):
            if "://" not in target and not target.startswith("#"):
                assert (source / target.split("#")[0]).is_file(), target
        archive = OUTPUT / package["archive"]
        binary = archive.read_bytes()
        assert len(binary) == package["size_bytes"]
        assert hashlib.sha256(binary).hexdigest() == package["sha256"]
        with ZipFile(archive) as bundle:
            assert bundle.testzip() is None
            expected = {str(p.relative_to(SOURCES)): p.read_bytes() for p in source.rglob("*") if p.is_file()}
            assert set(bundle.namelist()) == set(expected)
            assert all(bundle.read(name) == data for name, data in expected.items())
    print(f"Validated {len(names)} skills: metadata, tool references, links, ZIP contents and SHA-256")


if __name__ == "__main__":
    check()
