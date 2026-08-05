#!/usr/bin/env bash
#
# Выкатка на staging.
#
# Отдельная команда, отдельная конфигурация, отдельный SSH-target. Работать
# с production-хостом эта команда отказывается.
#
#   ./deploy/scripts/deploy-staging.sh --version <полный-sha> [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd -- "${REPO_ROOT}"

# shellcheck source=deploy/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

EXPECTED_MARKER="staging"

parse_args "$@"

step "Проверка версии"
require_full_sha
log "версия: ${VERSION}"

step "Конфигурация окружения"
CONFIG_FILE="${REPO_ROOT}/deploy/staging.conf"

if is_dry_run; then
  # Сухой прогон не обращается к сети и не меняет ничего — только показывает план.
  log "режим DRY_RUN: сеть и изменения не выполняются"
  if [ -f "${CONFIG_FILE}" ]; then
    log "конфигурация: ${CONFIG_FILE}"
  fi
  cat <<PLAN

План выкатки на staging:
  1. проверить маркер окружения цели (ожидается «${EXPECTED_MARKER}»)
  2. занять локальный и удалённый deploy lock
  3. загрузить образ ${VERSION} из приватного реестра
  4. сверить OCI-метку org.opencontainers.image.revision с ${VERSION}
  5. применить миграции (prisma migrate deploy)
  6. перезапустить сервис из точной версии образа
  7. дождаться /ready
  8. отчитаться о фактически развёрнутом SHA

Изменений не выполнено: это сухой прогон.
PLAN
  exit 0
fi

# Сухой прогон уже завершился выше: дальше идут проверки, требующие git и сети.
require_clean_worktree
require_commit_in_origin_main
log "коммит найден в origin/main, рабочее дерево чистое"

load_config "${CONFIG_FILE}"

# Ошибка в конфигурации не должна привести к выкатке staging-версии на production.
[ "${ENVIRONMENT_MARKER}" = "${EXPECTED_MARKER}" ] \
  || fail "конфигурация помечена как «${ENVIRONMENT_MARKER}», а это команда staging"
[ "${ENVIRONMENT_MARKER}" != "production" ] \
  || fail "staging-команда не работает с production-целью"

step "Подготовка соединения"
prepare_known_hosts
acquire_local_lock "staging"

step "Проверка цели"
require_environment_marker
log "маркер окружения совпал: ${ENVIRONMENT_MARKER}"

acquire_remote_lock
trap 'release_remote_lock; release_local_lock' EXIT

step "Загрузка образа"
remote "docker pull '$(image_reference)'"
require_image_revision
log "метка образа соответствует ${VERSION}"

step "Миграции и запуск"
# Секреты лежат в файле окружения на сервере и не передаются аргументами команды.
remote "cd '${REMOTE_DIR}' && IMAGE_TAG='${VERSION}' docker compose -p '${COMPOSE_PROJECT}' run --rm app npx prisma migrate deploy"
remote "cd '${REMOTE_DIR}' && IMAGE_TAG='${VERSION}' docker compose -p '${COMPOSE_PROJECT}' up -d --no-build app"

step "Проверка готовности"
require_ready

# Отметка о проверенной версии: production принимает только то, что прошло staging.
remote "mkdir -p '${REMOTE_DIR}/state' && echo '${VERSION}' >> '${REMOTE_DIR}/state/verified-versions'"

report_deployed_revision
