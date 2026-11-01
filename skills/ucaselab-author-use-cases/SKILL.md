---
name: ucaselab-author-use-cases
description: "Создавай и редактируй черновики юзер-кейсов UCaseLab; публикуй версии в рамках поручения."
metadata:
  version: 1.9.2
  contract-version: 1.9.2
---

# Описание одной фичи

Используй актуальный контекст выбранного проекта. Один юзер-кейс описывает функционал; положительные и отрицательные данные — варианты внутри него. Разработчик предлагает изменения через proposal, QA может сохранять сценарии напрямую.

## Содержимое

content: title, goal, preconditions, cleanup, priority, tags, platforms, steps, variants, specifications, accounts. Включай понятные действия и наблюдаемые ожидания; неизвестные требования обозначай в черновике.

- steps: key/action/expected; сохраняй key существующих строк при правке и перестановке.
- variants: key/name/polarity/inputs/expected/notes/enabled/steps_override. inputs — простые JSON-значения: строка, число, boolean, null. Не превращай null и false в строки; отрицательные значения сохраняй точно, включая пробелы.
- specifications: specification_id и необязательный revision_id; accounts: account_id и уникальный alias. Пароли заменяй ссылками @account:alias:password.

При необходимости подбери существующие теги через list_tags(scope=use_cases), платформы — scope=platforms; теги спецификаций независимы. Не загружай словари и связанные сущности, которые задача не меняет.

## Сохранение

Для нового сценария проверь возможный дубль коротким поиском, затем create_use_case(content, folder_id, message). Для правки прочитай get_use_case и сохрани полное content через save_use_case_draft с expected_version и base_revision_id. Сохраняй неизменённые связи и варианты. После VERSION_CONFLICT/REVISION_CONFLICT перечитай объект и сопоставь правки; не повторяй запись вслепую.

Проверь возвращённую ревизию и относящиеся к изменению поля; compare_use_case_revisions используй, когда нужен diff. Публикация отдельная: publish_use_case с точным revision_id и expected_version, если входит в поручение или политику проекта. Принятие предложения не публикует автоматически. restore_use_case_revision создаёт новый черновик; move_use_case меняет папку с expected_version.

Для изменяющих операций можно передать idempotency_key: один ключ — один точный запрос. Сохранение и публикация не подтверждают прохождение приложения.

Если нужно поменять только спецификации, set_use_case_specifications(use_case_id, expected_version, base_revision_id, specifications) сохранит остальные поля. Передай полный нужный список {specification_id, revision_id?}; пустой список удаляет связи. Без revision_id закрепляется текущая ревизия, последующие обновления спецификации её не заменяют. Для перехода на новую ревизию обнови связь явно. Уже сохранённую архивную связь можно оставить с прежним точным revision_id; новые связи с архивной спецификацией требуют её восстановления.
