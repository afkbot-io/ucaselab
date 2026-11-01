# MCP-контракт UCaseLab 1.9.2

Действующий контракт приложения. Полные JSON Schema аргументов: [API_SCHEMA.json](API_SCHEMA.json), авторизованный GET `/api/operations` и MCP `tools/list`.

В 1.2.1 добавлена настройка EMAIL_ENABLED. get_project_context и get_notification_preferences возвращают email_enabled; при false приглашение создаёт ссылку без письма. GET /api/auth/config доступен без входа и возвращает только email_enabled.

## Общая ссылка для агента

Публичный GET `/ai.md` — точка входа с адресом MCP и каталогом навыков. GET `/api/agent/manifest` содержит версии, SHA-256, read_url/download_url; Markdown и ZIP выдаются только для записей текущего каталога. Эти endpoints не читают контекст пользователя и проекта. Доступ к MCP и проектному guide по-прежнему авторизованный. list_skills дополнительно возвращает bootstrap_url и manifest_url; прежние поля и download_path get_skill сохранены.

## Подключение

Endpoint `/mcp/`, Streamable HTTP через официальный Python SDK 2.3.0. Персональный токен создаётся в профиле; передаётся заголовком `Authorization: Bearer <token>`. Токены не передаются query-параметрами. Поддерживаются актуальный протокол 2026-07-28 и legacy handshake клиентов, поддерживаемых SDK. Вызовы 2026-07-28 должны использовать envelope/routing заголовки, которые формирует SDK клиента. Самостоятельно реализовывать handshake не требуется.

MCP доступен по Bearer-токену; browser cookie не даёт доступ к MCP. Защищённые REST-скачивания принимают тот же Bearer. OAuth/discovery в 1.3 отсутствует; выбирайте клиент с персональным Bearer/header transport.

Для известного project_id достаточно get_project_context; повторно используйте актуальный контекст. list_projects нужен для выбора неизвестного проекта, get_me — для проверки личности. get_project_context также возвращает credential_scopes текущего credential. project_id явный для каждого проектного инструмента. Автор определяется credential. Доступ = актуальное членство × роль × scopes × allowlist проектов × видимость объекта. Руководитель — owner, далее manager, tester, developer. Токен не выпускает другие токены.

Входная MCP-схема отклоняет неизвестные аргументы (additionalProperties=false), включая опечатки и actor_id. Каталог объявляет readOnlyHint и destructiveHint для планирования клиентом; эти подсказки не заменяют проверку доступа. Сервер не возвращает значения входных полей в ошибках валидации.

## Запись и ошибки

REST использует ту же границу: POST `/api/actions/{tool_name}` с `{project_id, arguments, idempotency_key?}`. В MCP аргументы передаются напрямую согласно схеме инструмента.

Изменение версионированного объекта требует expected_version. Кейс дополнительно требует base_revision_id при save_use_case_draft. Каждое save создаёт новую неизменяемую ревизию только при изменении content. Публикация — отдельный publish_use_case с точным revision_id и сообщением. Ревизии не равны оптимистическому version или номеру публикации.

Для изменяющих операций доступен idempotency_key до 100 символов. Ключ связан с автором, проектом, инструментом и точными аргументами; повтор других аргументов даёт IDEMPOTENCY_CONFLICT. Читающие операции и reveal_test_account_secret не кэшируются.

Ошибки возвращают code/message и HTTP status в REST; MCP возвращает isError=true с безопасным описанием. Важные коды: UNAUTHENTICATED, INSUFFICIENT_SCOPE, FORBIDDEN, NOT_FOUND, VERSION_CONFLICT, REVISION_CONFLICT, PROPOSAL_BASE_CONFLICT, PLAN_SELECTION_CHANGED, PLAN_SELECTION_STALE, EXECUTION_IMMUTABLE, ACCOUNT_BUSY. После конфликта перечитайте состояние и подготовьте актуальное изменение, не перезаписывайте молча.

## Поиск и каталоги

`list_use_cases` выполняет поиск и пагинацию в PostgreSQL по видимой ревизии: рабочей для QA, опубликованной для разработчика. Параметры: search, folder_id, include_subfolders, without_folder, status, tags, platforms, priority, specification_id, account_id, archived, sort, limit, offset. Слова search объединяются через AND; символы `%` и `_` ищутся буквально. Все выбранные теги и платформы обязательны. Сортировки: created/created_desc, updated/updated_desc (дата ревизии), title/title_desc, key, priority. Ответ содержит total, next_offset, total_project и folder_counts.

`list_specifications`, `list_test_accounts`, `list_case_plans`, `list_proposals`, `list_runs`, `list_reports` принимают search, sort, limit и offset; возвращают items, total, next_offset. Общие сортировки: title/title_desc, created/created_desc. У спецификаций независимый фильтр tags; у аккаунтов — environment_id/application_role; у предложений — status/kind/author_id/use_case_id; у планов — status; у прогонов — status/author_id/plan_id; у отчётов — audience/interim/author_id. Права применяются до подсчёта результатов. limit: 1–1000, offset ≥ 0. Значение по умолчанию 500 сохраняет удобство прежних клиентов; UI запрашивает страницы по 50, элементы выбора — по 20.

`search_project(query, entities?, limit=20, offset=0)` ищет в use_cases, specifications, plans, proposals, accounts. `totals` и `next_offsets` относятся к каждому каталогу отдельно. В общем поиске не более 100 записей на каталог за запрос. Указывайте entities для продолжения нужного каталога.

`list_tags(scope, search, limit=30, offset=0)` возвращает строки в items, total, next_offset. scope: use_cases, specifications, platforms. Словари хранятся в проекте отдельно; повторное написание нормализуется по регистру и пробелам. QA видит прежние значения, разработчик получает теги и платформы доступных публикаций. Платформы Web/iOS/Android/API/Desktop предлагаются по умолчанию.

Имена инструментов планов в 1.1: create_case_plan, list_case_plans, get_case_plan, update_case_plan, copy_case_plan, archive_case_plan, list_case_plan_revisions. Старые названия с user_plan заменены; обновите установленный навык. Существующие планы сохраняются миграцией 0002.

## Содержимое кейса

content: title, goal, preconditions, cleanup, priority (low/normal/high/critical), tags, platforms, steps, variants, specifications, accounts.

- steps: `{key, action, expected}`; ключ стабилен при перемещении и исправлении.
- variants: `{key, name, polarity: positive|negative, inputs, expected, notes, enabled, steps_override?}`. В одной таблице данных хранятся оба типа; интерфейс показывает две секции.
- specifications: `{specification_id, revision_id?}`. При сохранении конкретная версия фиксируется.
- accounts: `{account_id, alias}`. Пароль хранится и раскрывается отдельно; используйте синтетические значения или `@account:alias:password`.

get_use_case для QA по умолчанию возвращает рабочую версию. Для чтения перед выполнением используйте published_only=true, а для уже созданной проверки — get_execution_bundle. Разработчик не видит неопубликованный текст и QA-обсуждения. Исторические публикации остаются доступны.

## Предложения

В новых предложениях выбирайте kind=new_use_case (новый сценарий, без target_use_case_id) или update_use_case (правка: target_use_case_id либо items с use_case_id/base_revision_id). Для идеи достаточно content.description. Не создавайте новый кейс перед submit_proposal. При необходимости приложите полный предложенный сценарий в content.items. До принятия он хранится только в предложении.

После изменения кода заполните repository и commit_sha (40/64 hex) либо diff_fingerprint, а также impact. Эти поля доступны обоим видам предложений. check_change_proposals принимает repository и SHA или отпечаток, учитывает доступные предложения всех видов. Прежние implementation_change/feature_idea остаются читаемыми и поддерживаются API.

Автор может обновлять open-предложение с expected_version. preview_proposal показывает изменения и конфликты базовых ревизий. accept_proposal атомарно применяет подготовленные пункты в черновики; публикация отдельная. Принятие идеи без пунктов фиксирует решение без создания кейса. При конфликте не применяется ни один пункт. reject_proposal требует причины; withdraw_proposal доступен автору. История ревизий предложения неизменяема.

`delete_proposal(proposal_id, expected_version)` мягко удаляет только отклонённое (`rejected`) предложение. Требует `proposals:write`: автор может удалить своё; тестировщик, менеджер и руководитель для чужого также требуют `proposals:review`. Роль и членство, allowlist проекта токена и версия проверяются заново. Удаление сериализуется вместе с другими изменениями проекта; устаревшая версия даёт `VERSION_CONFLICT`, другой статус — `PROPOSAL_NOT_REJECTED`, повторный запрос без idempotency_key — `NOT_FOUND`. Общий механизм idempotency_key допускает повтор той же операции.

Используется существующий `Proposal.archived`, без нового статуса и миграции. Ответ: `{id, archived: true, version}`. Решение, содержимое, ревизии, обсуждения и аудит сохраняются; записывается `proposal.deleted`. Удалённое предложение недоступно в обычном API, истории ревизий и обсуждениях, исключено из списков, уведомлений, активности, счётчиков и покрытия изменений кода. Все операции изменения/подготовки/предпросмотра также возвращают `NOT_FOUND`. Это не общая политика архивирования других сущностей; восстановления через публичное API нет.


## Планы и выполнение

Plan content: title/purpose/environment_id/items. Item: use_case_id, version_policy latest_published|fixed_publication, publication_id?, variant_selection all_enabled|explicit, variant_keys, assignee_id?. preview_case_plan разрешает состав в конкретные публикации и варианты и возвращает plan_revision_id/selection_hash. create_run с plan_id требует expected_plan_revision_id и selection_hash. Прямой прогон создаётся через use_case_ids: preview_run возвращает selection_hash, create_run принимает case_source=published|draft. draft закрепляет рабочие ревизии без публикации; разработчикам эти прогоны, вложения и отчёты недоступны. Прямой selection_hash необязателен для совместимости; при его наличии изменение состава даёт RUN_SELECTION_CHANGED. План по-прежнему использует публикации. Подробно: [подготовка и классификация](RUN_PREPARATION.md).

Run: draft → running → completed/cancelled. Execution: queued → running → passed/failed/scenario_issue/blocked/skipped; отмена прогона переводит незавершённые в cancelled. get_run возвращает items и attempts; действующей является последняя попытка. start_execution закрепляет исполнителя. record_step_result необязателен для каждого шага, итоговый actual_result обязателен. Терминальный результат неизменяем. retry_execution работает только в активном прогоне; add_execution_annotation создаёт отдельное пояснение. Одновременное использование общего тестового аккаунта блокируется.

Перед первым запуском нового прогона: `get_run_readiness` → реальная проверка стенда и доступов → `confirm_run_readiness(expected_version,checks,notes,actual_base_url?,allow_partial?)`. Готовность хранится в прогоне, версии аккаунтов проверяются повторно перед началом. Проверка URL самим сервером не выполняется. Ограничения требуют allow_partial=true и причины; они не становятся готовностью. Старые прогоны с пустым readiness не блокируются ретроспективно.

Рекомендуемый процесс: `get_run_overview` → `begin_run_check` → реальные действия → `finish_run_check` → возвращённый `run.next_action`. begin_run_check атомарно начинает draft-прогон и резервирует доступный вариант либо возвращает свою начатую проверку. Явный run_item_id выбирает конкретную проверку; retry=true создаёт новую попытку. Назначение другому участнику и занятые общие аккаунты учитываются. Исполнитель определяется пользователем credential; повторный вызов под тем же пользователем продолжает его работу.

`list_run_checks(run_id, search, status, assignment, limit=50, offset=0)` возвращает лёгкую очередь, total и next_offset. status: all/pending/running/passed/failed/scenario_issue/blocked/skipped/cancelled/attention; pending означает queued, attention — failed/scenario_issue/blocked. assignment: all/mine/unassigned. `get_run_check(run_item_id)` содержит один pinned snapshot, попытки, наблюдения, файлы и actions.

`finish_run_check(execution_id, status, actual_result, step_results?, external_issue_url?)` проверяет и атомарно сохраняет шаги и итог. step_results: массив {step_key, status, actual_result?}. Для passed все закреплённые шаги должны быть явно passed; можно использовать ранее сохранённые отметки. При ошибке набор не сохраняется частично. record_execution_result также требует passed всех закреплённых шагов; неполный черновик нельзя объявить успешным. failed — ошибка приложения, scenario_issue — неточность сценария, blocked — невозможность выполнения. Неточности не входят в метрики ошибок приложения и знаменатель успеха. Новый интерфейс и новые агенты используют finish_run_check.

`get_run_overview` возвращает progress {total,finished,remaining,percent}, active_checks, actions и next_action с tool/arguments. finished включает все терминальные исходы, в том числе failed/scenario_issue/blocked/skipped/cancelled. 100% не означает успех. Следующая проверка после записи результата не резервируется автоматически. Завершение всего прогона отдельно через complete_run с expected_version. Платформа сама не исполняет браузерные действия.

get_execution_bundle содержит закреплённый сценарий, вариант, спецификации, несекретные аккаунты, окружение, сборку и guide. Пароли раскрываются отдельно. Агент обязан реально выполнить шаги собственными инструментами. Отрицательный ввод с ожидаемым отказом — passed.

Доказательства: add_execution_evidence передаёт base64 файл до 2 МБ; multipart REST upload до 20 МБ доступен по пути `/api/projects/{project_id}/attachments/upload?execution_id=...`. Вложения добавляет текущий исполнитель во время активной проверки. Скачивание защищено проектным доступом.

## Отчёты и обсуждения

generate_report создаёт неизменяемый snapshot выбранных run_ids (до 30). interim=true обязателен для активных прогонов; audience=project/qa_team. get_run_report — живая сводка, get_report — сохранённый снимок, get_report_download — защищённый путь PDF/CSV/JSON. Отчёт с любым прогоном черновиков автоматически имеет аудиторию qa_team. Публичные share links не реализованы.

create_comment_thread принимает body и необязательный anchor с revision_id/field_path/step_key или variant_key/quote. Черновая привязка делает ветку частной для QA. anchor_status=current/outdated/target_removed; автоматической перепривязки нет. Упоминания: `@{user_id}`. Свои комментарии редактируются с историей, удаление оставляет tombstone. Тестировщик, менеджер и владелец модерируют с причиной и аудитом. resolve_comment_thread(resolved=false) переоткрывает обсуждение. Комментарии не создают ревизий кейса.

## Папки и вложенность

`list_folders` возвращает path [{id,name}], depth, position, use_case_count (прямые активные кейсы), archived_use_case_count, total_use_case_count (активные кейсы всей ветки), subfolder_count (прямые активные подпапки). Поиск search охватывает полный путь; parent_id выбирает прямых детей, roots_only — корень, exclude_subtree_id исключает саму папку и потомков. Пагинация limit/offset, total/next_offset. `get_folder` даёт актуальный объект, в том числе удалённый. `list_use_cases(include_subfolders=true, folder_id=...)` включает всю ветку; по умолчанию только прямые кейсы.

`create_folder(name,parent_id?)`, `rename_folder(folder_id,expected_version,name)`, `move_folder(folder_id,expected_version,parent_id?,before_folder_id?)`. null parent_id — корень. Перемещение сохраняет ветку и историю кейсов; before_folder_id задаёт место среди прямых соседей, без него папка помещается в конец. Максимум 32 уровня; циклы, перемещение в потомка и чужой проект отклоняются. update_folder остаётся совместимым полным обновлением (name,parent_id).

`delete_folder(folder_id,expected_version,destination=parent|root|folder,destination_folder_id?)` атомарно переносит прямые кейсы (включая архивные) и активные подпапки в выбранное место и помечает только папку удалённой. Без destination используется parent; корень означает кейсы без папки. destination_folder_id нужен только для folder и не может указывать на удаляемую ветку. Снимки сценариев, публикации и проверки сохраняются. `restore_folder(folder_id,expected_version,parent_id?)` восстанавливает контейнер; перенесённое содержимое остаётся на месте. Удалённые папки доступны через archived=true. `archive_folder` сохранён для совместимости: архивирует только пустую активную папку; для непустой используется delete_folder. Запись требует use_cases:write и роль tester или выше.

## Спецификации и независимые папки

`create_specification(title,description,tags,acceptance_criteria,folder_id?)` возвращает полный объект с id, folder_id, current_revision_id, version и archived. `update_specification` принимает полное содержимое и expected_version; папка сохраняется, пока не передан change_folder=true. folder_id=null с change_folder=true снимает папку. Неизменённое содержимое не создаёт новую ревизию. `move_specification` меняет только положение; текущая ревизия сохраняется.

`list_specifications` дополнительно принимает folder_id, without_folder и include_subfolders, возвращает total/next_offset/total_project. `list_specification_revisions` имеет limit/offset/total/next_offset. `get_specification_revision(specification_id,revision_id)` читает неизменяемое содержимое конкретной версии; get_specification даёт актуальное содержимое и метаданные.

`delete_specification(specification_id,expected_version)` архивирует объект, сохраняя ревизии и закреплённые связи с кейсами. `restore_specification` восстанавливает его, при необходимости снимая удалённую папку. Совместимый archive_specification продолжает принимать object_id/expected_version/archived. Новые связи с архивной спецификацией отклоняются; существующие точные пары specification_id/revision_id можно сохранять при редактировании кейса.

Деревья независимы: list_specification_folders/get_specification_folder, create_specification_folder, rename_specification_folder, move_specification_folder, delete_specification_folder, restore_specification_folder. Сигнатуры соответствуют операциям папок кейсов; запись требует specifications:write и роль tester. Папка из другого раздела отклоняется с FOLDER_KIND_MISMATCH. Общие счётчики: item_count/archived_item_count/total_item_count; специфические — specification_count/archived_specification_count/total_specification_count. В папках кейсов старые use_case_count и другие имена сохранены. Удаление папки возвращает moved_specifications/moved_folders/destination_id и переносит также архивные спецификации.

`set_use_case_specifications(use_case_id,expected_version,base_revision_id,specifications,message?)` заменяет только список связей, сохраняя остальные поля кейса. Пустой список снимает все связи; без revision_id закрепляется текущая ревизия спецификации. Обновление спецификации не меняет ранее закреплённые ссылки. Ответ — полный кейс с content.specifications и revision_id. Требуются use_cases:write и роль tester.

## Подготовка предложений QA

`prepare_proposal(proposal_id,expected_version,items)` требует proposals:review и роль tester. QA может подготовить открытое предложение другого автора, сохраняя автора, описание, target и источник изменения кода. Полный список items заменяется атомарно, создаётся неизменяемая ревизия предложения с автором подготовки. Сами кейсы не меняются. update_proposal остаётся доступен только автору. После подготовки preview_proposal показывает diff и conflicts; accept_proposal применяет пункты в черновики и возвращает decision.applied_items с use_case_id/revision_id. Публикация отдельная; note и принятие идеи без подготовленных пунктов не создают кейсы.

## Инструменты

Точный JSON Schema экспортирован в API_SCHEMA.json. Ниже — действующий каталог.

| Инструмент | Scope | Минимальная роль | Запись |
| --- | --- | --- | --- |
| `accept_proposal` | `proposals:review` | tester | Да |
| `add_execution_annotation` | `runs:write` | tester | Да |
| `add_execution_evidence` | `runs:write` | tester | Да |
| `archive_case_plan` | `plans:write` | tester | Да |
| `archive_environment` | `environments:write` | manager | Да |
| `archive_folder` | `use_cases:write` | tester | Да |
| `archive_project` | `projects:archive` | owner | Да |
| `archive_specification` | `specifications:write` | tester | Да |
| `archive_test_account` | `accounts:write` | tester | Да |
| `archive_use_case` | `use_cases:write` | tester | Да |
| `assign_run_item` | `runs:write` | tester | Да |
| `begin_run_check` | `runs:write` | tester | Да |
| `cancel_run` | `runs:write` | tester | Да |
| `check_change_proposals` | `projects:read` | developer | Нет |
| `compare_use_case_revisions` | `projects:read` | developer | Нет |
| `complete_run` | `runs:write` | tester | Да |
| `confirm_run_readiness` | `runs:write` | tester | Да |
| `copy_case_plan` | `plans:write` | tester | Да |
| `copy_use_case` | `use_cases:write` | tester | Да |
| `create_case_plan` | `plans:write` | tester | Да |
| `create_comment` | `comments:write` | developer | Да |
| `create_comment_thread` | `comments:write` | developer | Да |
| `create_environment` | `environments:write` | manager | Да |
| `create_folder` | `use_cases:write` | tester | Да |
| `create_project` | `projects:create` | developer | Да |
| `create_run` | `runs:write` | tester | Да |
| `create_specification` | `specifications:write` | tester | Да |
| `create_specification_folder` | `specifications:write` | tester | Да |
| `create_test_account` | `accounts:write` | tester | Да |
| `create_use_case` | `use_cases:write` | tester | Да |
| `delete_comment` | `comments:write` | developer | Да |
| `delete_proposal` | `proposals:write` | developer | Да |
| `delete_folder` | `use_cases:write` | tester | Да |
| `delete_specification` | `specifications:write` | tester | Да |
| `delete_specification_folder` | `specifications:write` | tester | Да |
| `export_project` | `exports:read` | tester | Нет |
| `finish_run_check` | `runs:write` | tester | Да |
| `generate_report` | `reports:write` | tester | Да |
| `get_attachment_download` | `projects:read` | developer | Нет |
| `get_case_plan` | `projects:read` | developer | Нет |
| `get_comment_thread` | `projects:read` | developer | Нет |
| `get_coverage` | `projects:read` | developer | Нет |
| `get_execution_bundle` | `projects:read` | developer | Нет |
| `get_folder` | `projects:read` | developer | Нет |
| `get_me` | `projects:read` | developer | Нет |
| `get_notification_preferences` | `notifications:read` | developer | Нет |
| `get_project_context` | `projects:read` | developer | Нет |
| `get_project_guide` | `projects:read` | developer | Нет |
| `get_proposal` | `projects:read` | developer | Нет |
| `get_report` | `projects:read` | developer | Нет |
| `get_report_download` | `projects:read` | developer | Нет |
| `get_run` | `projects:read` | developer | Нет |
| `get_run_check` | `projects:read` | developer | Нет |
| `get_run_overview` | `projects:read` | developer | Нет |
| `get_run_readiness` | `runs:write` | tester | Нет |
| `get_run_report` | `projects:read` | developer | Нет |
| `get_skill` | `projects:read` | developer | Нет |
| `get_specification` | `projects:read` | developer | Нет |
| `get_specification_folder` | `projects:read` | developer | Нет |
| `get_specification_revision` | `projects:read` | developer | Нет |
| `get_test_account` | `projects:read` | developer | Нет |
| `get_use_case` | `projects:read` | developer | Нет |
| `get_use_case_revision` | `projects:read` | developer | Нет |
| `invite_project_member` | `members:write` | manager | Да |
| `list_audit_events` | `audit:read` | manager | Нет |
| `list_case_plan_revisions` | `projects:read` | developer | Нет |
| `list_case_plans` | `projects:read` | developer | Нет |
| `list_comment_threads` | `projects:read` | developer | Нет |
| `list_environments` | `projects:read` | developer | Нет |
| `list_folders` | `projects:read` | developer | Нет |
| `list_my_subscriptions` | `notifications:read` | developer | Нет |
| `list_activity` | `notifications:read` | developer | Нет |
| `list_notifications` | `notifications:read` | developer | Нет |
| `list_project_invitations` | `members:write` | manager | Нет |
| `list_project_members` | `projects:read` | developer | Нет |
| `list_projects` | `projects:read` | developer | Нет |
| `list_proposal_revisions` | `projects:read` | developer | Нет |
| `list_proposals` | `projects:read` | developer | Нет |
| `list_reports` | `projects:read` | developer | Нет |
| `list_run_checks` | `projects:read` | developer | Нет |
| `list_runs` | `projects:read` | developer | Нет |
| `list_skills` | `projects:read` | developer | Нет |
| `list_specification_folders` | `projects:read` | developer | Нет |
| `list_specification_revisions` | `projects:read` | developer | Нет |
| `list_specifications` | `projects:read` | developer | Нет |
| `list_tags` | `projects:read` | developer | Нет |
| `list_test_accounts` | `projects:read` | developer | Нет |
| `list_use_case_executions` | `projects:read` | developer | Нет |
| `list_use_case_history` | `projects:read` | developer | Нет |
| `list_use_cases` | `projects:read` | developer | Нет |
| `mark_activity_read` | `notifications:write` | developer | Да |
| `mark_notifications_read` | `notifications:write` | developer | Да |
| `moderate_comment` | `comments:moderate` | tester | Да |
| `move_folder` | `use_cases:write` | tester | Да |
| `move_specification` | `specifications:write` | tester | Да |
| `move_specification_folder` | `specifications:write` | tester | Да |
| `move_use_case` | `use_cases:write` | tester | Да |
| `prepare_proposal` | `proposals:review` | tester | Да |
| `preview_case_plan` | `runs:write` | tester | Нет |
| `preview_proposal` | `proposals:review` | tester | Нет |
| `preview_run` | `runs:write` | tester | Нет |
| `publish_use_case` | `use_cases:publish` | tester | Да |
| `record_execution_result` | `runs:write` | tester | Да |
| `record_step_result` | `runs:write` | tester | Да |
| `reject_proposal` | `proposals:review` | tester | Да |
| `remove_project_member` | `members:write` | manager | Да |
| `rename_folder` | `use_cases:write` | tester | Да |
| `rename_specification_folder` | `specifications:write` | tester | Да |
| `resolve_comment_thread` | `comments:write` | developer | Да |
| `restore_folder` | `use_cases:write` | tester | Да |
| `restore_specification` | `specifications:write` | tester | Да |
| `restore_specification_folder` | `specifications:write` | tester | Да |
| `restore_use_case_revision` | `use_cases:write` | tester | Да |
| `retry_execution` | `runs:write` | tester | Да |
| `reveal_test_account_secret` | `secrets:read` | developer | Да |
| `revoke_project_invitation` | `members:write` | manager | Да |
| `save_use_case_draft` | `use_cases:write` | tester | Да |
| `search_project` | `projects:read` | developer | Нет |
| `set_test_account_secret` | `secrets:write` | tester | Да |
| `set_use_case_specifications` | `use_cases:write` | tester | Да |
| `start_execution` | `runs:write` | tester | Да |
| `start_run` | `runs:write` | tester | Да |
| `submit_proposal` | `proposals:write` | developer | Да |
| `subscribe` | `notifications:write` | developer | Да |
| `transfer_project_management` | `members:write` | owner | Да |
| `unsubscribe` | `notifications:write` | developer | Да |
| `update_case_plan` | `plans:write` | tester | Да |
| `update_comment` | `comments:write` | developer | Да |
| `update_environment` | `environments:write` | manager | Да |
| `update_folder` | `use_cases:write` | tester | Да |
| `update_notification_preferences` | `notifications:write` | developer | Да |
| `update_project` | `projects:write` | manager | Да |
| `update_project_guide` | `projects:write` | manager | Да |
| `update_project_member` | `members:write` | manager | Да |
| `update_proposal` | `proposals:write` | developer | Да |
| `update_specification` | `specifications:write` | tester | Да |
| `update_test_account` | `accounts:write` | tester | Да |
| `withdraw_proposal` | `proposals:write` | developer | Да |

Экспорт export_project сохраняет формат ucaselab-project/1 и добавляет specification_folders и specification_revisions. Он проходит все страницы каталогов, включает текущие и закреплённые ревизии требований и метаданные связанных архивных спецификаций. Раздел folders содержит только папки кейсов.

## Внимание и уведомления (1.9)

`get_project_attention` (`notifications:read`) возвращает точное число личных непрочитанных событий, число открытых предложений для QA, назначенных незавершённых прогонов и `sections` для навигации. Счётчики разделов объединяют задачи и непрочитанные события без повторного учёта одного объекта. `mark_notifications_read` не закрывает предложение и не завершает назначенную проверку. События скрытых, удалённых или чужих ресурсов не возвращаются; роль учитывается до ограничения страницы уведомлений. Интерфейс обновляет счётчики после записи, при переходах, возврате фокуса и каждые 30 секунд видимой страницы. Это polling, не push-доставка.

| `get_project_attention` | notifications:read | developer | Чтение личных счётчиков внимания проекта |

## Исправления границ 1.9.1

- Отсутствующий, истёкший или отозванный Bearer получает HTTP 401, `WWW-Authenticate: Bearer` и JSON-RPC error с `code=-32001`, `message=UNAUTHENTICATED`, `data.code=UNAUTHENTICATED`. Доступ прекращается на следующем запросе; официальный SDK сохраняет этот код вместо общей внутренней ошибки. Ответ не содержит токен.
- Ошибки аргументов, включая неизвестные поля и вложенные данные, возвращаются как `isError=true` с JSON `{"error":{"code":"VALIDATION_ERROR","message":"…"},"status":422}` в текстовом блоке. SDK может добавить префикс `Error executing tool …:`. Значения входных данных в ошибку не включаются. REST сохраняет свой конверт `detail` и HTTP 422.
- `reveal_test_account_secret.reason` обрезает крайние пробелы и требует от 3 до 300 символов после обрезки. Пустая причина не раскрывает секрет и не создаёт событие раскрытия.
- `moderate_comment` доступен от роли tester с отдельным scope `comments:moderate`; сохраняет исходный текст, причину и автора модерации.
- Активный план требует хотя бы одного сценария. Явный набор вариантов должен быть непустым, без повторов, с существующими включёнными ключами выбранной публикации. Неполный состав можно хранить в черновике. Перед запуском состав проверяется повторно, поскольку последняя публикация могла измениться.


### Обсуждения и личная история

`create_comment_thread` и `list_comment_threads`: совместимый `use_case_id` либо `target_type`/`target_id` (`use_case`, `proposal`, `specification`, `report`, `execution`). Привязка anchor только для кейса. Проверка обсуждается на уровне конкретной попытки выполнения. Все операции с веткой наследуют текущие права объекта, включая QA-аудиторию и собственные предложения разработчика; архивные цели доступны для чтения. Результат ветки включает `path` для прямого перехода. Участники для упоминаний ограничены `eligible_member_ids` из списка веток. Формат body — безопасный Markdown без HTML и изображений, ссылки только HTTP(S). Сохраняются исходный текст, UUID упоминаний и история правок; уведомления на правке создаются только для добавленных упоминаний.

`list_activity` (`notifications:read`) читает существующий аудит бизнес-изменений без служебных metadata: кейсы, предложения, спецификации, прогоны, результаты попыток, отчёты, создание/ответ/правка/удаление/модерация/завершение обсуждений. Административные изменения и секреты остаются в отдельном аудите менеджера. Фильтры: `all_projects`, `entity_type`, `event_type`, `actor_id`, `since`, `until`, `unread`, `limit` (1–100), `before`. Порядок created_at/id убывающий, `next_cursor` стабилен при новых событиях. Видимость применяется до пагинации и счётчиков. `mark_activity_read` (`notifications:write`) принимает до 100 конкретных event_ids и all_projects; повтор безопасен. Открытие панели/списка ничего не отмечает. Открытие события или явная команда чтения показанных отмечают только переданные ID. У каждого пользователя свой статус. Собственные действия, включая прежние события без отметок чтения, считаются прочитанными: они остаются в истории и фильтре прочитанных, но не входят в `unread_count` и `get_project_attention.unread_activity`. Новые и непоказанные чужие события остаются непрочитанными.
