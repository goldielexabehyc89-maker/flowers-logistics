#!/usr/bin/env bash
#
# Выкатка на staging.
#
# Отдельная команда и отдельная конфигурация. Сервер может быть тем же, что
# у production, но каталог, Compose-проект, внешний порт, том и файл окружения
# обязаны отличаться — иначе команда откажет до обращения к серверу.
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

CONFIG_FILE="$(staging_config_file)"

if is_dry_run; then
  # Сухой прогон ничего не читает и никуда не ходит: он только печатает план.
  # Конфигурация не открывается вовсе, поэтому прогон работает и на свежем клоне.
  step "Сухой прогон"
  log "режим DRY_RUN: конфигурация не читается, сеть и изменения не выполняются"
  cat <<PLAN

План выкатки на staging:
  1. прочитать ${CONFIG_FILE}
  2. проверить изоляцию от production, если его конфигурация уже создана
  3. проверить маркер окружения в каталоге цели (ожидается «${EXPECTED_MARKER}»)
  4. занять локальный и удалённый deploy lock
  5. загрузить образ ${VERSION} из приватного реестра
  6. сверить OCI-метку org.opencontainers.image.revision с ${VERSION}
  7. проверить подложку по манифесту и пересчитать SHA-256 tiles.tar на сервере,
     сведя его с манифестом и с VALHALLA_GRAPH_SHA256
  8. доставить Compose-файл выкатываемой версии и сверить его контрольную сумму
  9. применить миграции (prisma migrate deploy)
 10. поднять маршрутизатор ОТДЕЛЬНО и дождаться загрузки набора тайлов
 11. посчитать пробную матрицу на синтетических точках обоими профилями
 12. только после этого запустить приложение из точной версии образа
 13. дождаться /ready на внешнем порту staging
 14. записать версию в state/verified-versions и отчитаться о развёрнутом SHA

Изменений не выполнено: это сухой прогон.
PLAN
  exit 0
fi

# Сухой прогон уже завершился выше: дальше идут проверки, требующие git и сети.
require_clean_worktree
require_commit_in_origin_main
log "коммит найден в origin/main, рабочее дерево чистое"

step "Конфигурация окружения"
load_environment_config STAGING "${CONFIG_FILE}"
require_config_values STAGING "${CONFIG_FILE}" "${CONFIG_KEYS[@]}"

# Ошибка в конфигурации не должна привести к выкатке staging-версии на production.
[ "${STAGING_ENVIRONMENT_MARKER}" = "${EXPECTED_MARKER}" ] \
  || fail "конфигурация помечена как «${STAGING_ENVIRONMENT_MARKER}», а это команда staging"

# Изоляция проверяется, как только появилась вторая конфигурация. Пока
# production ещё не настроен, staging разворачивается в одиночку.
PRODUCTION_CONFIG_FILE="$(production_config_file)"
if [ -f "${PRODUCTION_CONFIG_FILE}" ]; then
  load_environment_config PRODUCTION "${PRODUCTION_CONFIG_FILE}"
  require_config_values PRODUCTION "${PRODUCTION_CONFIG_FILE}" "${CONFIG_KEYS[@]}"
  require_isolated_environments
else
  log "конфигурация production ещё не создана: проверка изоляции пропущена"
fi

activate_environment STAGING

step "Подготовка соединения"
prepare_known_hosts
acquire_local_lock "staging"

step "Проверка цели"
require_environment_marker
log "маркер окружения совпал в каталоге ${REMOTE_DIR}"

acquire_remote_lock
trap 'release_remote_lock; release_local_lock' EXIT

step "Загрузка образа"
remote "docker pull '$(image_reference)'"
require_image_revision
log "метка образа соответствует ${VERSION}"

step "Картографические артефакты"
# Fail closed: приложение стартует с подложкой и графом, смонтированными
# на чтение, и обязано получить именно те файлы, которые собирали.
require_geo_artifacts

step "Состав окружения"
# Compose-файл обязан соответствовать выкатываемой версии: он описывает состав
# сервисов и монтирования, и файл произвольного возраста означал бы запуск
# не того окружения, которое проверял CI.
sync_compose_file

step "Миграции и запуск"
# Секреты лежат в файле окружения на сервере и не передаются аргументами команды.
remote "$(compose_command) run --rm app npx prisma migrate deploy"
# Маршрутизатор поднимается ПЕРВЫМ и отдельно от приложения.
#
# Одновременный запуск выглядит быстрее, но приложение опрашивает /status сразу
# при старте: пока граф загружается, оно успевает записать DEGRADED, и это
# состояние останется в базе даже после того, как выкатка убедится, что
# маршрутизатор работает. Логист увидел бы «расчёт недоступен» при исправном
# сервисе. Порядок: valhalla → её проверка → app → готовность приложения.
remote "$(compose_command) up -d --no-build valhalla"

step "Проверка маршрутизатора"
# Отказ здесь останавливает выкатку: новый app не запускается вовсе,
# и прежняя версия продолжает работать.
require_routing_ready

step "Запуск приложения"
remote "$(compose_command) up -d --no-build app"

step "Проверка готовности"
require_ready

# Отметка о проверенной версии: production принимает только то, что прошло staging.
# Файл лежит в staging-каталоге — именно он служит доказательством.
remote "mkdir -p '${REMOTE_DIR}/state' && echo '${VERSION}' >> '${REMOTE_DIR}/state/verified-versions'"

report_deployed_revision
