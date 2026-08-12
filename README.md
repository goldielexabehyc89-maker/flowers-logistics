# Логистика цветочного интернет-магазина

Модульный монолит на TypeScript: Fastify + React, PostgreSQL 16, Prisma.
Один репозиторий, одно разворачиваемое приложение — в production один Node-процесс
обслуживает и API, и собранный web-клиент.

**Текущее состояние: этап 1, ветка `feat/stage1-ui-shell`.** Реализованы фундамент, схема базы,
health/readiness, структурированные логи, авторизация, управление сотрудниками и курьерами,
роли, аудит и общий интерфейс приложения. Realtime, outbox-воркер и каркас деплоя идут
следующей веткой — см. [ROADMAP.md](ROADMAP.md).

Документы: [PROJECT_RULES.md](PROJECT_RULES.md) · [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DEPLOY.md](docs/DEPLOY.md) ·
[docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/DOMAIN_STATES.md](docs/DOMAIN_STATES.md) ·
[docs/INTEGRATION_MOYSKLAD.md](docs/INTEGRATION_MOYSKLAD.md)

## Требования

- Docker и Docker Compose — обязательны.
- Node.js **24.19.0** — только если вы хотите запускать команды без Docker.
  Версия зафиксирована в `.nvmrc`, `engines`, Docker-образах и CI; `engine-strict=true`
  не даст установить зависимости другой версией.

Все команды ниже выполняются в контейнере с зафиксированной версией Node, поэтому
исправное локальное окружение не требуется.

## Запуск с нуля

```bash
# 0. Включить git-хуки проекта (один раз после клонирования).
#    pre-push запрещает прямой push в main: работа только через pull request.
./scripts/install-hooks.sh

# 1. Поднять PostgreSQL 16
docker compose up -d db

# 2. Установить зависимости (node_modules живут в томе Docker, не в рабочей папке)
docker compose run --rm app npm ci

# 3. Сгенерировать клиент Prisma и применить миграции
docker compose run --rm app npx prisma generate
docker compose run --rm app npx prisma migrate deploy

# 4. Собрать и запустить приложение
docker compose run --rm app npm run build
docker compose run --rm --service-ports app npm start
```

Приложение доступно на <http://localhost:3000>:

- `GET /health` — liveness;
- `GET /ready` — readiness (проверяет базу, ограничение 5 с);
- `GET /api/status` — состояние интеграций для индикатора интерфейса;
- `/` — интерфейс приложения.

Маршруты интерфейса: `/login`, `/first-login`, `/deals`, `/routing`, `/route-sheets`,
`/active`, `/history`, `/reports`, `/couriers` (Сотрудники и курьеры), `/settings` (только
`ADMIN`). Разделы логистики пока заглушки: они прямо сообщают, на каком этапе появятся.
Рабочие экраны — вход, первый вход и управление сотрудниками и курьерами.

Порт PostgreSQL на хосте — `55432` (внутри compose-сети `db:5432`). Переопределяется
переменной `DB_HOST_PORT`.

## Режим разработки

```bash
docker compose up -d db
docker compose run --rm --service-ports app npm run dev
```

API поднимается на 3000, Vite — на 5173 с проксированием `/api`, `/health` и `/ready`.

## Команды проверок

```bash
docker compose run --rm app npm run typecheck      # tsc по всем workspace
docker compose run --rm app npm run lint           # ESLint
docker compose run --rm app npm run build          # production-сборка
docker compose run --rm app npm run test           # все тесты
docker compose run --rm app npm run test:critical  # только критические проверки
docker compose run --rm app npm run format         # проверка форматирования
```

Часть критических проверок работает с реальной PostgreSQL и **разрушает** базу: они создают
пользователей и записи аудита, которые невозможно удалить. Поэтому такие тесты допускаются
только к одноразовой базе `fl_test` (локально) или `fl_ci` (в CI). Перед запуском её нужно
пересоздать:

```bash
./scripts/reset-test-db.sh                          # пересоздаёт fl_test и применяет миграции
docker compose run --rm app npm run test:critical
```

Попытка запустить эти тесты против `fl_dev`, staging или production завершается отказом
с объяснением — молчаливого пропуска нет, потому что пропущенная проверка выглядит
как пройденная.

Браузерные проверки выполняются в отдельном зафиксированном образе Playwright и никогда
хостовым Node:

```bash
docker compose --profile e2e run --rm playwright npx playwright test
```

## Первый вход в систему

Пароля по умолчанию не существует. Первый администратор создаётся одноразовой командой,
которая печатает код активации ровно один раз:

```bash
docker compose run --rm app npm run bootstrap:admin:dev -- \
  --phone +79161234567 --name "Иван Иванов"
```

Суффикс `:dev` здесь не опечатка. Каноническое имя `npm run bootstrap:admin`
запускает собранный файл — так эта команда работает на сервере, внутри
production-образа, где нет ни исходников, ни `tsx`. В контейнере разработки
собранного файла может не быть, поэтому локально запускается вариант
из исходников. Скрытого выбора по окружению нет: это две разные команды.

Повторный запуск безопасен: второго администратора он не создаёт и прежний код не показывает.
Если администратор не успел активироваться за 30 минут, код перевыпускается флагом `--reissue`
для того же телефона — и только пока в системе нет ни одного активного администратора.

Дальше администратор активируется через API: телефон + код + собственный четырёхзначный PIN.

| Метод            | Путь                   | Назначение                          |
| ---------------- | ---------------------- | ----------------------------------- |
| `POST`           | `/api/auth/activate`   | первый вход: код → установка PIN    |
| `POST`           | `/api/auth/login`      | вход по телефону и PIN              |
| `POST`           | `/api/auth/refresh`    | обновление сессии (refresh-cookie)  |
| `GET`            | `/api/auth/me`         | текущий пользователь и роли         |
| `POST`           | `/api/auth/logout`     | выход с текущего устройства         |
| `POST`           | `/api/auth/logout-all` | выход со всех устройств             |
| `GET/POST/PATCH` | `/api/users…`          | управление сотрудниками и курьерами |

Метода `DELETE` для пользователей, профилей курьеров и ролей не существует: сотрудники
не удаляются, только замораживаются и размораживаются.

## Ветки и pull request

Ветка `main` **не защищена средствами GitHub**: branch protection для приватного репозитория
требует платного тарифа, который решено не подключать. Вместо этого в репозитории есть
версионируемый хук `.githooks/pre-push`, запрещающий прямой push в `main`.

Порядок работы: отдельная ветка → проверки → pull request → отчёт → отдельное разрешение
владельца → merge выполняет владелец → следующая ветка от обновлённой `main`.

Хук — организационная мера: он защищает от случайной ошибки и обходится флагом `--no-verify`.
Обход без прямого разрешения владельца запрещён правилами проекта.

## Миграции

Только forward-only. Применённая миграция не редактируется — исправление оформляется новой.

```bash
docker compose run --rm app npx prisma migrate dev --name <имя>   # создать и применить
docker compose run --rm app npx prisma migrate deploy             # применить существующие
docker compose run --rm app npx prisma migrate status             # состояние
```

`prisma migrate reset` на общей и боевой базе запрещён (см. `PROJECT_RULES.md`).

## Переменные окружения

Список безопасных имён — в `.env.example`. Значения секретов в репозиторий не попадают.
В docker compose переменные для локальной разработки заданы прямо в `docker-compose.yml`;
пароль в нём — локальный, к staging и production отношения не имеет.

Prisma 7 не загружает `.env` автоматически: при запуске команд вне compose переменные
окружения нужно задать явно.

## Структура

```
apps/api          Fastify-приложение: platform/ (конфиг, логи, БД, HTTP) и modules/
apps/web          React + Vite
packages/shared   общие типы, коды ошибок и русские сообщения
prisma            схема и forward-only миграции
docker            dev-образ с зафиксированной версией Node
docs              архитектура, деплой, эксплуатация, состояния домена, интеграция
```

Каталоги модулей будущих этапов содержат `README.md` с честной пометкой «не реализован»
и не содержат заглушечного кода и выдуманных полей.
