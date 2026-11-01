"""Public projections keep build inputs and notices, never local operator state."""
import importlib.util
from pathlib import Path

import pytest


def load_exporter():
    script = Path(__file__).resolve().parents[3] / "scripts/export_public.py"
    spec = importlib.util.spec_from_file_location("export_public_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_projection_includes_product_and_excludes_runtime_and_internal_files(tmp_path):
    module = load_exporter()
    for name in ["README.md", ".env.example", ".github/workflows/ci.yml", "apps/api/app/main.py",
                 "apps/api/app/fonts/LICENSE", "infra/nginx.conf", "scripts/check_docs.py", "skills/example/SKILL.md",
                 "infra/scion/workflow.py", "AGENTS.md", "docs/implementation/STATUS.md", "docs/implementation/UI_REVIEW.md",
                 "docs/MCP_CONTRACT_PLAN_0.3.md", "docs/SYSTEM_ANALYSIS.md", "docs/COLLABORATION_PLANS_AND_UX.md",
                 "docs/VERSIONING_AND_PROPOSALS.md", "docs/SKILL_REVIEW.md", "data/secret",
                 "output/auth/session.json", "apps/web/node_modules/private", "apps/web/dist/old.js",
                 "apps/web/.env", "apps/web/.cache/stale", "apps/api/app/__pycache__/old.pyc"]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic")
    names = {p.relative_to(tmp_path).as_posix() for p in module.product_files(tmp_path)}
    assert names == {"README.md", ".env.example", ".github/workflows/ci.yml", "apps/api/app/main.py",
                     "apps/api/app/fonts/LICENSE", "infra/nginx.conf", "scripts/check_docs.py", "skills/example/SKILL.md"}


def test_projection_rejects_symlink_escape(tmp_path):
    module = load_exporter()
    (tmp_path / "apps").mkdir()
    (tmp_path / "apps/leak").symlink_to(tmp_path.parent)
    with pytest.raises(ValueError, match="Symlink"):
        module.product_files(tmp_path)


def test_export_is_manifested_and_refuses_existing_destination(tmp_path):
    module = load_exporter()
    source = tmp_path / "source"
    source.mkdir()
    (source / "README.md").write_text("Продукт")
    destination = tmp_path / "public"
    manifest = module.export(source, destination, "a" * 40)
    assert manifest["private_source_sha"] == "a" * 40
    assert manifest["files"]["README.md"]["size"] == len("Продукт".encode())
    assert (destination / "README.md").read_text() == "Продукт"
    assert not (destination / ".git").exists()
    with pytest.raises(FileExistsError):
        module.export(source, destination, "a" * 40)


@pytest.mark.parametrize("manifest_kind", ["source", "existing", "destination"])
def test_cli_rejects_unsafe_manifest_before_mutating_any_file(tmp_path, manifest_kind):
    import subprocess
    import sys

    script = Path(__file__).resolve().parents[3] / "scripts/export_public.py"
    source = tmp_path / "source"
    source.mkdir()
    readme = source / "README.md"
    readme.write_text("Original product")
    existing = tmp_path / "operator-report.md"
    existing.write_text("Original report")
    destination = tmp_path / "public"
    manifest = {"source": readme, "existing": existing, "destination": destination / "manifest.json"}[manifest_kind]
    result = subprocess.run(
        [sys.executable, str(script), "--source", str(source), "--destination", str(destination),
         "--source-sha", "a" * 40, "--manifest", str(manifest)], capture_output=True,
    )
    assert result.returncode != 0
    assert readme.read_text() == "Original product"
    assert existing.read_text() == "Original report"
    assert not destination.exists()


def test_legal_notices_survive_public_export_and_source_release(tmp_path):
    import hashlib
    import json
    import shutil
    import subprocess
    import sys
    import tarfile

    root = Path(__file__).resolve().parents[3]
    source = tmp_path / "source"
    source.mkdir()
    legal_names = (
        "LICENSE", "THIRD_PARTY_NOTICES.md", "apps/api/app/fonts/LICENSE",
        "apps/web/public/licenses/Manrope-OFL.txt",
    )
    originals = {name: (root / name).read_bytes() for name in legal_names}
    for name, data in originals.items():
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    scripts = source / "scripts"
    scripts.mkdir()
    for name in ("export_public.py", "build_release.py"):
        shutil.copyfile(root / "scripts" / name, scripts / name)
    (source / "pyproject.toml").write_text('[project]\nversion = "0.0.0"\n')
    catalog = source / "dist/skills/index.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text('{"skills": []}\n')

    public = tmp_path / "public"
    manifest = load_exporter().export(source, public, "a" * 40)
    for name, data in originals.items():
        assert (public / name).read_bytes() == data
        assert manifest["files"][name] == {
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
        }

    subprocess.run([sys.executable, str(scripts / "build_release.py")], check=True, capture_output=True)
    archive = source / "dist/ucaselab-0.0.0.tar.gz"
    first_build = archive.read_bytes()
    with tarfile.open(archive) as release:
        release_manifest = json.load(release.extractfile("ucaselab-0.0.0/release-manifest.json"))
        for name, data in originals.items():
            assert release.extractfile(f"ucaselab-0.0.0/{name}").read() == data
            assert release_manifest["files"][name] == manifest["files"][name]
    subprocess.run([sys.executable, str(scripts / "build_release.py")], check=True, capture_output=True)
    assert archive.read_bytes() == first_build
