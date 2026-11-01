"""Public agent onboarding; only release-owned instructions and packages are exposed."""

import json
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, PlainTextResponse

from .config import settings
from .security import fail
from .version import VERSION

ROOT = Path(__file__).resolve().parents[3]
router = APIRouter(tags=["Agent setup"])


def load_skill_catalog():
    return json.loads((ROOT / "dist/skills/index.json").read_text())


def find_skill(name):
    skill = next((item for item in load_skill_catalog()["skills"] if item["name"] == name), None)
    if not skill:
        fail("NOT_FOUND", "Навык не найден", 404)
    return skill


def public_manifest():
    base = settings().public_url.rstrip("/")
    catalog = load_skill_catalog()
    return {
        "schema_version": 1,
        "platform_version": VERSION,
        "contract_version": catalog["contract_version"],
        "bootstrap_url": base + "/ai.md",
        "manifest_url": base + "/api/agent/manifest",
        "mcp": {
            "url": base + "/mcp/",
            "transport": "streamable-http",
            "authentication": "Bearer personal token; obtain separately from the user",
        },
        "skills": [
            {
                **item,
                "read_url": f"{base}/api/agent/skills/{item['name']}/SKILL.md",
                "download_url": f"{base}/api/agent/skills/{item['name']}/{item['archive']}",
            }
            for item in catalog["skills"]
        ],
    }


@router.get("/api/agent/manifest")
def agent_manifest():
    """Public discovery without credentials, membership or project data."""
    return public_manifest()


@router.get("/api/agent/skills/{name}/SKILL.md", response_class=PlainTextResponse)
def public_skill_document(name: str):
    skill = find_skill(name)
    document = (ROOT / "skills" / skill["name"] / "SKILL.md").read_text()
    return PlainTextResponse(document, media_type="text/markdown")


@router.get("/api/agent/skills/{name}/{archive}")
def public_skill_archive(name: str, archive: str):
    skill = find_skill(name)
    if archive != skill["archive"]:
        fail("NOT_FOUND", "Архив не найден. Обновите каталог навыков", 404)
    return FileResponse(ROOT / "dist/skills" / archive, filename=archive, media_type="application/zip")


@router.get("/ai.md", response_class=PlainTextResponse)
def agent_instructions():
    manifest = public_manifest()
    catalog = "\n\n".join(
        f"### {skill['name']} · {skill['version']}\n"
        f"{skill['description']}\n\n"
        f"- [Прочитать SKILL.md]({skill['read_url']})\n"
        f"- [Скачать ZIP]({skill['download_url']})\n"
        f"- SHA-256 ZIP: `{skill['sha256']}`"
        for skill in manifest["skills"]
    )
    document = f"""# Подключение ИИ-агента к UCaseLab

Версия платформы: {VERSION}. [Каталог JSON]({manifest['manifest_url']}) содержит
актуальные версии навыков, ссылки и SHA-256 архивов. Эта инструкция и пакеты
общие для всех пользователей; закрытых данных проектов здесь нет.

## Начало работы

1. Работай в рамках поручения пользователя. Если MCP UCaseLab уже подключён,
   используй его без создания дубликата. Если поручено подключение, настрой
   поддерживаемый клиентом Streamable HTTP с адресом ниже.
2. Для доступа нужен персональный MCP-токен. Пользователь создаёт его в профиле
   в разделе «MCP-доступ» и передаёт отдельно через защищённые настройки клиента.
   Если токена нет, запроси его настройку; не пытайся получить доступ без него.
   Ссылка на эту инструкцию не содержит токена и не выдаёт доступ к проектам.
3. Для известного project_id вызови get_project_context. Если проект не выбран,
   найди его через list_projects. Проектный guide и testing policy получи через
   MCP после авторизации; не считай эту общую инструкцию заменой правил проекта.
4. Выбери навык под текущую задачу в каталоге ниже. Прочитай его SKILL.md или
   скачай ZIP и проверь SHA-256 по JSON-каталогу. Если клиент поддерживает skills,
   установи пакет штатным способом. Иначе используй Markdown как инструкцию.
   Загружай остальные навыки по мере необходимости, а не все сразу.

## MCP-подключение

- Адрес: {manifest['mcp']['url']}
- Транспорт: Streamable HTTP.
- Аутентификация: заголовок `Authorization: Bearer <PERSONAL_TOKEN>`.
- Токен передаётся только заголовком, не в URL и не в документах проекта.
- Доступ ограничен ролью, scopes и проектами токена; MCP не выпускает токены.

Нативные HTTP MCP-клиенты формируют handshake и routing-заголовки самостоятельно.
Не заменяй MCP endpoint адресом этой Markdown-инструкции.

## Выбор навыка

- Проекты, команда и настройки: ucaselab-platform.
- Поиск и чтение сценариев: ucaselab-read-use-cases.
- Создание и редактирование: ucaselab-author-use-cases.
- Реальное тестирование: ucaselab-test-use-cases.
- Предложения после изменений связанного кода: ucaselab-propose-changes.
- Аудит предложений и выявление пробелов: ucaselab-review-proposals.
- Подготовка и применение предложений в черновики: ucaselab-apply-proposals.
- Кейс-планы и отчёты: ucaselab-case-plans.
- Комментарии и обсуждения: ucaselab-discussions.

Платформа хранит сценарии и результаты; браузер или устройство предоставляет
проверяющий агент. Не записывай непроверенное как успешный результат. Сохраняй
секреты отдельно от сценариев, результатов и доказательств.

## Каталог пакетов

{catalog}

При смене релиза обнови JSON-каталог, если прежний архив больше недоступен.
Несовпадение SHA-256 требует повторного получения каталога и пакета; не используй
архив с неподтверждённой целостностью.
"""
    return PlainTextResponse(document, media_type="text/markdown")
