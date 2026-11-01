---
name: ucaselab-read-use-cases
description: "Находи и анализируй сценарии, публикации, данные и историю проверок UCaseLab без их выполнения."
metadata:
  version: 1.9.2
  contract-version: 1.9.2
---

# Чтение сценариев

Используй выбранный project_id и актуальный guide из get_project_context; не повторяй выбор проекта, если он уже известен.

- Если дан ID, прочитай объект напрямую. Для поиска используй list_use_cases(search, folder_id, status, tags, platforms, priority, specification_id, account_id, sort, limit, offset). Все слова search и выбранные теги применяются вместе. Точный набор полей смотри в схеме инструмента.
- Останови поиск, когда достаточно данных для ответа. Для запроса «все» или полного аудита пройди все нужные страницы до next_offset=null и явно укажи область охвата. Первую страницу не выдавай за весь каталог.
- search_project ищет выбранные entities; totals/next_offsets отдельные для каждого каталога. list_tags имеет независимые scope: use_cases, specifications, platforms.
- Для ожидаемого поведения используй get_use_case(published_only=true). Обычный запрос для QA может вернуть рабочий черновик. Для уже созданного прогона читай get_run_check: его снимок закреплён и не заменяется текущим кейсом.
- list_use_case_history/get_use_case_revision/compare_use_case_revisions показывают происхождение и diff. list_specification_revisions читает закреплённые требования. Стабильный key обозначает тот же шаг или вариант после перемещения.
- list_use_case_executions показывает факты выполнения. Проверяй case_source и is_current_publication/is_current_revision: прошлый успех не подтверждает другую публикацию или новый черновик.

Отделяй ожидание от наблюдения и неизвестного. Отрицательные данные могут иметь успешный ожидаемый отказ. Для ответа о содержимом не создавай прогон и не записывай результат. Пароли не нужны для чтения сценария; аккаунты связываются через alias, например @account:actor:password.

Для поиска по разделу используй list_folders(search=...) и полные path, затем list_use_cases(folder_id=..., include_subfolders=true), если нужны также вложенные разделы. По умолчанию фильтр папки берёт только её прямые кейсы.
