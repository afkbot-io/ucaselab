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
