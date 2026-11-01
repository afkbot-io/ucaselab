"""Release archives must remain reproducible and immutable after publication."""
import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def packager(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[3] / "scripts/package_skills.py"
    spec = importlib.util.spec_from_file_location("package_skills_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = tmp_path / "sources"
    skill = source / "example-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: example-skill\ndescription: Example skill\nmetadata:\n"
        f"  version: 1.0.0\n  contract-version: {module.CONTRACT_VERSION}\n---\nOriginal instructions\n"
    )
    monkeypatch.setattr(module, "SOURCES", source)
    monkeypatch.setattr(module, "OUTPUT", tmp_path / "packages")
    return module, skill


def test_published_skill_cannot_be_replaced(packager):
    module, source = packager
    first = module.build()
    archive = module.OUTPUT / first["skills"][0]["archive"]
    original = archive.read_bytes()
    assert module.build() == first
    (source / "SKILL.md").write_text((source / "SKILL.md").read_text() + "Changed behavior\n")
    with pytest.raises(ValueError, match="increment the skill version"):
        module.build()
    assert archive.read_bytes() == original
    assert not list(module.OUTPUT.glob("*.tmp"))


def test_new_skill_version_preserves_previous_archive(packager):
    module, source = packager
    first = module.build()
    previous = module.OUTPUT / first["skills"][0]["archive"]
    original = previous.read_bytes()
    path = source / "SKILL.md"
    path.write_text(path.read_text().replace("version: 1.0.0", "version: 1.0.1") + "New instructions\n")
    second = module.build()
    assert second["skills"][0]["version"] == "1.0.1"
    assert previous.read_bytes() == original
    assert (module.OUTPUT / second["skills"][0]["archive"]).exists()
