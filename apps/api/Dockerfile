FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.10.9 /uv /uvx /bin/
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/apps/api UV_COMPILE_BYTECODE=1 UV_NO_DEV=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY apps/api ./apps/api
COPY alembic.ini ./
COPY docs/ai.template.md ./docs/ai.template.md
COPY skills ./skills
COPY dist/skills ./dist/skills
RUN useradd --uid 10001 --create-home ucaselab && mkdir -p /data/attachments && chown -R ucaselab:ucaselab /data /app
USER ucaselab
EXPOSE 8000
CMD ["uv", "run", "--frozen", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
