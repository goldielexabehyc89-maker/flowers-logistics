#!/usr/bin/env bash
#
# Выкатка на production.
#
# Отдельная команда с дополнительными обязательными проверками. Сервер может
# быть тем же, что у staging, но подтверждение прохождения staging читается
# только из staging-каталога, а маркер production проверяется отдельно.
# Выполняется только по прямому распоряжению владельца.
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

CONFIG_FILE="$(production_config_file)"
STAGING_CONFIG_FILE="$(staging_config_file)"

if is_dry_run; then
  # Сухой прогон ничего не читает и никуда не ходит: он только печатает план.
  step "Сухой прогон"
  log "режим DRY_RUN: конфигурация не читается, сеть и изменения не выполняются"
  cat <<PLAN

План выкатки на production:
  1. прочитать ${CONFIG_FILE} и ${STAGING_CONFIG_FILE}
  2. отказать, если окружения делят каталог, Compose-проект, внешний порт,
     том базы или файл окружения
  3. убедиться, что версия ${VERSION} успешно проверена на staging: маркер
     и state/verified-versions читаются из staging-каталога
  4. проверить маркер окружения цели (ожидается «${EXPECTED_MARKER}»)
  5. занять локальный и удалённый deploy lock production
  6. проверить свободное место (не меньше ${MIN_FREE_MB} МБ)
  7. выполнить обязательную серверную команду резервного копирования
  8. показать домен и хост, запросить ручной ввод слова PRODUCTION
  9. загрузить образ ${VERSION} и сверить OCI-метку
 10. применить миграции и перезапустить сервис
 11. дождаться /ready на внешнем порту production и отчитаться о развёрнутом SHA

Изменений не выполнено: это сухой прогон.
PLAN
  exit 0
fi

# Сухой прогон уже завершился выше: дальше идут проверки, требующие git и сети.
require_clean_worktree
require_commit_in_origin_main
log "коммит найден в origin/main, рабочее дерево чистое"

step "Конфигурация окружений"
# Production всегда читает обе конфигурации: подтверждение прохождения staging
# берётся из staging-каталога, а изоляция проверяется до обращения к серверу.
load_environment_config PRODUCTION "${CONFIG_FILE}"
require_config_values PRODUCTION "${CONFIG_FILE}" "${CONFIG_KEYS[@]}"

load_environment_config STAGING "${STAGING_CONFIG_FILE}"
require_config_values STAGING "${STAGING_CONFIG_FILE}" "${CONFIG_KEYS[@]}"

[ "${PRODUCTION_ENVIRONMENT_MARKER}" = "${EXPECTED_MARKER}" ] \
  || fail "конфигурация помечена как «${PRODUCTION_ENVIRONMENT_MARKER}», а это команда production"

require_isolated_environments

activate_environment PRODUCTION

step "Подготовка соединения"
prepare_known_hosts
acquire_local_lock "production"

step "Проверка версии на staging"
require_staging_verification

step "Проверка цели"
require_environment_marker
log "маркер окружения совпал в каталоге ${REMOTE_DIR}"

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
printf '  Домен:   %s\n' "${APP_DOMAIN}"
printf '  Хост:    %s@%s:%s\n' "${SSH_USER}" "${SSH_HOST}" "${SSH_PORT}"
printf '  Каталог: %s\n' "${REMOTE_DIR}"
printf '  Порт:    %s\n' "${APP_HOST_PORT}"
printf '  Версия:  %s\n\n' "${VERSION}"
printf 'Для продолжения введите слово PRODUCTION: '
read -r CONFIRMATION
[ "${CONFIRMATION}" = "PRODUCTION" ] || fail "подтверждение не получено"

step "Загрузка образа"
remote "docker pull '$(image_reference)'"
require_image_revision
log "метка образа соответствует ${VERSION}"

step "Картографические артефакты"
# Fail closed: приложение стартует с подложкой и графом, смонтированными
# на чтение, и обязано получить именно те файлы, которые собирали.
require_geo_artifacts

step "Миграции и запуск"
remote "$(compose_command) run --rm app npx prisma migrate deploy"
remote "$(compose_command) up -d --no-build app"

step "Проверка готовности"
require_ready

report_deployed_revision
