---
name: ucaselab-case-plans
description: "Составляй кейс-планы UCaseLab, запускай закреплённые прогоны и формируй отчёты."
metadata:
  version: 1.9.2
  contract-version: 1.9.2
---

# План и отчёт

Используй актуальный контекст выбранного проекта. План — повторяемый набор сценариев; прогон — конкретное выполнение; отчёт — неизменяемый снимок результатов. Не создавай новый объект, если пользователь просит прочитать или продолжить существующий.

## Состав и запуск

create_case_plan/update_case_plan принимают content и status; обновление требует expected_version. content: title/purpose/environment_id/items. Item: use_case_id, version_policy (latest_published/fixed_publication), publication_id для fixed, variant_selection (all_enabled/explicit), variant_keys, assignee_id. Кейсы в плане не дублируются.

Перед новым запуском preview_case_plan возвращает конкретные публикации и варианты, plan_revision_id и selection_hash. Проверь состав и передай их в create_run как expected_plan_revision_id и selection_hash. PLAN_SELECTION_CHANGED/STALE требует нового preview и оценки изменений; не исключай варианты молча. После создания прогон не меняется вслед за планом, кейсом или окружением.

Для выполнения используй ucaselab-test-use-cases: begin_run_check и finish_run_check, затем next_action. Для чтения существующего прогона достаточно get_run_overview и нужных get_run_check. Закрытый прогон не переоткрывается; cancel_run требует причины.

Для порученной проверки черновиков используй прямой preview_run/create_run с case_source=draft, не публикуй кейсы ради запуска. План по-прежнему закрепляет публикации. Перед началом нового прогона нужны get_run_readiness/confirm_run_readiness. Итог хранит ревизию, источник draft/published и подтверждения готовности; поздние изменения кейса не меняют результаты.

## Отчёт

get_run_report — живая сводка. generate_report(title, run_ids, interim, audience) фиксирует до 30 прогонов. Для активных нужен interim=true; final — только для completed/cancelled. audience=project/qa_team. get_report_download(format=pdf/csv/json) возвращает защищённый путь; скачивай с Bearer в заголовке. Публичной ссылки нет; не передавай файл посторонним без поручения.

Покрытие = (passed+failed)/selected; успех = passed/(passed+failed), при нуле не определён. Отдельно учитывай blocked/skipped/cancelled/pending. Попытки не увеличивают исходный объём; завершение не подтверждает готовность релиза. Для предоставляемого отчёта используй сохранённый снимок, а не меняющуюся сводку.

scenario_issue учитывается отдельно: это неточность сценария, а не ошибка приложения, и не входит в знаменатель успеха. Отчёт с черновиками автоматически имеет аудиторию qa_team, включая смешанный набор прогонов; не обещай доступ разработчикам к неопубликованным данным.
