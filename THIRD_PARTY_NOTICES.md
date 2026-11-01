# Сторонние компоненты

Собственный код UCaseLab распространяется по [MIT](LICENSE). Эта лицензия не заменяет условия сторонних компонентов.

## Шрифты

- DejaVu для PDF: [исходный файл лицензий и авторских уведомлений](apps/api/app/fonts/LICENSE). В нём сохранены отдельные условия Bitstream Vera (Copyright (c) 2003 Bitstream, Inc.) и Arev (Copyright (c) 2006 Tavmjong Bah), а также уведомления остальных включённых шрифтовых компонентов. Изменения DejaVu указаны как public domain; это не отменяет условий для исходных компонентов.
- Manrope для интерфейса: [SIL Open Font License 1.1](apps/web/public/licenses/Manrope-OFL.txt), Copyright 2019 The Manrope Project Authors.

Оригинальные тексты лицензий и уведомления правообладателей сохранены в указанных файлах без перевода и изменений.

## Зависимости

Python-зависимости перечислены в [pyproject.toml](pyproject.toml) и закреплены в [uv.lock](uv.lock); зависимости интерфейса — в [package.json](apps/web/package.json) и [package-lock.json](apps/web/package-lock.json). У каждого пакета свои условия: проверяйте лицензию соответствующей версии в его дистрибутиве. Перечень выше описывает включённые шрифты и не является полным реестром лицензий всех зависимостей.
