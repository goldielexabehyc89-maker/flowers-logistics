#!/usr/bin/env bash
#
# Выкатка на production.
#
# Отдельная команда с дополнительными обязательными проверками. Работать
# со staging-хостом эта команда отказывается. Выполняется только по прямому
# распоряжению владельца.
#
#   ./deploy/scripts/deploy-production.sh --version <полный-sha> [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd -- "${REPO_ROOT}"

# shellcheck source=deploy/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

EXPECTED_MARKER="production"
MIN_FREE_MB=2048

parse_args "$@"

step "Проверка версии"
require_full_sha
log "версия: ${VERSION}"

step "Конфигурация окружения"
CONFIG_FILE="${REPO_ROOT}/deploy/production.conf"

if is_dry_run; then
  log "режим DRY_RUN: сеть и изменения не выполняются"
  cat <<PLAN

План выкатки на production:
  1. проверить маркер окружения цели (ожидается «${EXPECTED_MARKER}»)
  2. убедиться, что версия ${VERSION} успешно проверена на staging
  3. занять локальный и удалённый deploy lock
  4. проверить свободное место (не меньше ${MIN_FREE_MB} МБ)
  5. выполнить обязательную серверную команду резервного копирования
  6. показать домен и хост, запросить ручной ввод слова PRODUCTION
  7. загрузить образ ${VERSION} и сверить OCI-метку
  8. применить миграции и перезапустить сервис
  9. дождаться /ready и отчитаться о развёрнутом SHA

Изменений не выполнено: это сухой прогон.
PLAN
  exit 0
fi

# Сухой прогон уже завершился выше: дальше идут проверки, требующие git и сети.
require_clean_worktree
require_commit_in_origin_main
log "коммит найден в origin/main, рабочее дерево чистое"

load_config "${CONFIG_FILE}"

[ "${ENVIRONMENT_MARKER}" = "${EXPECTED_MARKER}" ] \
  || fail "конфигурация помечена как «${ENVIRONMENT_MARKER}», а это команда production"
[ "${ENVIRONMENT_MARKER}" != "staging" ] \
  || fail "production-команда не работает со staging-целью"

step "Подготовка соединения"
prepare_known_hosts
acquire_local_lock "production"

step "Проверка цели"
require_environment_marker
log "маркер окружения совпал: ${ENVIRONMENT_MARKER}"

step "Проверка версии на staging"
# На production попадает только то, что уже работало на staging.
STAGING_VERIFIED="$(remote "grep -Fx '${VERSION}' '${STAGING_VERIFIED_FILE}' 2>/dev/null || true")"
[ -n "${STAGING_VERIFIED}" ] \
  || fail "версия ${VERSION} не была успешно проверена на staging"
log "версия подтверждена staging"

acquire_remote_lock
trap 'release_remote_lock; release_local_lock' EXIT

step "Свободное место"
FREE_MB="$(remote "df -Pm '${REMOTE_DIR}' | awk 'NR==2 {print \$4}'")"
[ "${FREE_MB}" -ge "${MIN_FREE_MB}" ] \
  || fail "на целевом хосте свободно ${FREE_MB} МБ, требуется не меньше ${MIN_FREE_MB} МБ"
log "свободно ${FREE_MB} МБ"

step "Резервная копия"
# Команда выполняется на сервере: дамп не покидает production и не проходит
# через машину разработчика.
remote "cd '${REMOTE_DIR}' && ./backup.sh" \
  || fail "резервное копирование завершилось ошибкой, выкатка остановлена"
log "резервная копия создана"

step "Подтверждение"
printf '\n'
printf '  Домен: %s\n' "${APP_DOMAIN}"
printf '  Хост:  %s@%s:%s\n' "${SSH_USER}" "${SSH_HOST}" "${SSH_PORT}"
printf '  Версия: %s\n\n' "${VERSION}"
printf 'Для продолжения введите слово PRODUCTION: '
read -r CONFIRMATION
[ "${CONFIRMATION}" = "PRODUCTION" ] || fail "подтверждение не получено"

step "Загрузка образа"
remote "docker pull '$(image_reference)'"
require_image_revision
log "метка образа соответствует ${VERSION}"

step "Миграции и запуск"
remote "cd '${REMOTE_DIR}' && IMAGE_TAG='${VERSION}' docker compose -p '${COMPOSE_PROJECT}' run --rm app npx prisma migrate deploy"
remote "cd '${REMOTE_DIR}' && IMAGE_TAG='${VERSION}' docker compose -p '${COMPOSE_PROJECT}' up -d --no-build app"

step "Проверка готовности"
require_ready

report_deployed_revision
