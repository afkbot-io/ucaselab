"""Exercise backup restart behavior without using Docker or touching a database."""

import os
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("dump_fails", [False, True])
def test_backup_resumes_only_previously_running_services(tmp_path, dump_fails):
    root = Path(__file__).resolve().parents[3]
    (tmp_path / "scripts").mkdir()
    script = tmp_path / "scripts/backup.sh"
    script.write_text((root / "scripts/backup.sh").read_text())
    (tmp_path / ".env").write_text("EXAMPLE=private\n")
    (tmp_path / "uv.lock").write_text("example\n")
    binaries = tmp_path / "bin"
    binaries.mkdir()
    docker = binaries / "docker"
    docker.write_text('#!/usr/bin/env bash\n'
        'printf "%s\\n" "$*" >> "$DOCKER_CALLS"\n'
        'case "$*" in\n'
        '  "compose ps --status running --services") printf "db\\napi\\nweb\\n";;\n'
        '  "compose exec"*) if [[ "$DUMP_FAILS" == 1 ]]; then exit 7; fi; printf "database fixture";;\n'
        '  "compose run"*) printf "attachments fixture";;\n'
        'esac\n')
    docker.chmod(0o700)
    calls_path = tmp_path / "calls.txt"
    env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"], "DOCKER_CALLS": str(calls_path), "DUMP_FAILS": str(int(dump_fails))}
    result = subprocess.run(["bash", str(script), str(tmp_path / "backups")], env=env, capture_output=True, text=True)
    assert result.returncode == (7 if dump_fails else 0), result.stderr
    calls = calls_path.read_text().splitlines()
    assert "compose stop api web" in calls
    assert calls[-1] == "compose start api web"
    assert not any("worker" in call for call in calls)
    assert "Backup created" in result.stdout if not dump_fails else "Backup created" not in result.stdout


@pytest.mark.parametrize("healthy", [False, True])
def test_dev_db_waits_for_health_and_propagates_startup_failure(tmp_path, healthy):
    """The Docker boundary must finish readiness before make allows migrations."""
    root = Path(__file__).resolve().parents[3]
    docker = tmp_path / "docker"
    docker.write_text(
        '#!/usr/bin/env bash\n'
        'if [[ " $* " != *" --wait "* ]]; then exit 0; fi\n'
        'if [[ "$DB_HEALTHY" != 1 ]]; then exit 1; fi\n'
        'touch "$READY_MARKER"\n'
    )
    docker.chmod(0o700)
    marker = tmp_path / "ready"
    result = subprocess.run(
        ["make", "dev-db"], cwd=root, capture_output=True, text=True,
        env={**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"],
             "DB_HEALTHY": str(int(healthy)), "READY_MARKER": str(marker)},
    )
    assert (result.returncode == 0) == healthy, result.stderr
    assert marker.exists() == healthy
