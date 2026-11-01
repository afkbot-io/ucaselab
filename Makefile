.PHONY: env dev-db api worker web migrate test test-ui test-all build up down skills
env:
	python3 scripts/init_env.py
dev-db:
	docker compose -f compose.yaml -f compose.dev.yaml up -d db mailpit
api:
	PYTHONPATH=apps/api uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8017 --reload
worker:
	PYTHONPATH=apps/api uv run --frozen python -m app.worker
web:
	cd apps/web && npm run dev
migrate:
	uv run --frozen alembic upgrade head
test: skills
	uv run --frozen pytest -q
	uv run --frozen ruff check apps/api
	uv run --frozen mypy
	uv run --frozen python scripts/check_docs.py
	cd apps/web && npm run build
	npm run typecheck:e2e --prefix apps/web
test-ui:
	npm run test:ui --prefix apps/web
test-all: test test-ui
build: skills
	docker compose build
up: skills
	docker compose up -d --build
down:
	docker compose down
skills:
	uv run --frozen python scripts/package_skills.py
	uv run --frozen python scripts/check_skills.py
