"""Run the UI test API in a disposable PostgreSQL schema; never reuse application data."""

from __future__ import annotations

import argparse
import base64
import os
import secrets
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/api"))
from app.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18017)
    parser.add_argument("--origin", default="http://localhost:4173")
    args = parser.parse_args()
    if settings().environment == "production":
        raise SystemExit("UI tests require a development PostgreSQL server.")
    schema = "ucaselab_e2e_" + uuid4().hex
    engine = create_engine(settings().database_url)
    child = None

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    with tempfile.TemporaryDirectory(prefix="ucaselab-e2e-") as storage:
        with engine.begin() as conn:
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
        print(f"UI test schema created: {schema}", flush=True)
        try:
            url = make_url(settings().database_url).update_query_dict({"options": "-csearch_path=" + schema})
            environment = {
                **os.environ,
                "DATABASE_URL": url.render_as_string(hide_password=False),
                "ENVIRONMENT": "development",
                "PUBLIC_URL": args.origin,
                "COOKIE_SECURE": "false",
                "EMAIL_ENABLED": "false",
                "ALLOWED_HOSTS": "localhost,127.0.0.1",
                "ALLOWED_ORIGINS": args.origin,
                "STORAGE_PATH": storage,
                "SECRET_KEY": secrets.token_urlsafe(48),
                "ENCRYPTION_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
            }
            subprocess.run(
                [sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, env=environment, check=True
            )
            environment["PYTHONPATH"] = str(ROOT / "apps/api")
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(args.port),
                    "--no-access-log",
                    "--log-level",
                    "warning",
                ],
                cwd=ROOT,
                env=environment,
            )
            child.wait()
            if child.returncode:
                raise SystemExit(child.returncode)
        except KeyboardInterrupt:
            pass
        finally:
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            with engine.begin() as conn:
                conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            engine.dispose()
            print(f"UI test schema removed: {schema}", flush=True)


if __name__ == "__main__":
    main()
