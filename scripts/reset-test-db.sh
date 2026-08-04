#!/usr/bin/env bash
#
# Пересоздаёт одноразовую тестовую базу и применяет к ней миграции.
#
# Разрушающие критические тесты допускаются только к базам из белого списка,
# потому что оставляют записи, которые нельзя удалить (пользователи и аудит защищены
# триггерами). Обычная база разработки, staging и production сюда попасть не могут.
#
# Использование:
#   ./scripts/reset-test-db.sh            # пересоздаёт fl_test
#   ./scripts/reset-test-db.sh fl_test    # то же явно

set -euo pipefail

# Корень репозитория вычисляется от расположения скрипта: путь проекта содержит
# пробелы и кириллицу, поэтому все пути обязательно в кавычках.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd -- "${REPO_ROOT}"

DB_NAME="${1:-fl_test}"

case "${DB_NAME}" in
  fl_test | fl_ci) ;;
  *)
    echo "Отказ: «${DB_NAME}» не является одноразовой тестовой базой." >&2
    echo "Разрешены только fl_test и fl_ci." >&2
    exit 1
    ;;
esac

# Учётные данные локального окружения разработки. Секретов здесь нет:
# те же значения заданы в docker-compose.yml и к staging/production отношения не имеют.
DB_USER="fl_app"
DB_PASSWORD="fl_local_dev_password"
TEST_DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}?schema=public"

echo "Проверяем, что контейнер базы запущен…"
docker compose up -d db >/dev/null
docker compose exec -T db pg_isready -U "${DB_USER}" -d postgres >/dev/null

echo "Пересоздаём базу «${DB_NAME}»…"
docker compose exec -T db psql -U "${DB_USER}" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${DB_NAME}\" WITH (FORCE)" \
  -c "CREATE DATABASE \"${DB_NAME}\"" >/dev/null

echo "Применяем миграции…"
docker compose run --rm -e DATABASE_URL="${TEST_DATABASE_URL}" app npx prisma migrate deploy

echo
echo "База «${DB_NAME}» готова. Запуск критических тестов:"
echo "  docker compose run --rm app npm run test:critical"
