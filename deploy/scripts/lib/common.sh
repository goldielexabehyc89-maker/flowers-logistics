# Общая часть команд выкатки.
#
# Файл подключается через source из deploy-staging.sh и deploy-production.sh.
# Здесь только проверки и вспомогательные функции: сами команды остаются разными,
# чтобы staging и production невозможно было перепутать.
#
# Оба окружения могут жить на одном физическом сервере. Изоляция в этом случае
# держится не на разных хостах, а на разных каталогах, Compose-проектах, внешних
# портах, томах и файлах окружения — и проверяется до любого обращения к серверу.
#
# Путь проекта содержит пробелы и кириллицу — все пути обязательно в кавычках.

set -euo pipefail

# --- Вывод ---------------------------------------------------------------

log()  { printf '  %s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
fail() { printf '\nОТКАЗ: %s\n' "$*" >&2; exit 1; }

DRY_RUN="0"
VERSION=""

# --- Разбор аргументов ---------------------------------------------------

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || fail "флаг --version требует значение"
        VERSION="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN="1"
        shift
        ;;
      *)
        fail "неизвестный аргумент: $1"
        ;;
    esac
  done
}

is_dry_run() { [ "${DRY_RUN}" = "1" ]; }

# --- Конфигурация --------------------------------------------------------

# Реальные конфигурации лежат вне Git: иначе их заполнение делало бы рабочее
# дерево грязным, а выкатка запрещает грязное дерево — команда блокировала бы
# сама себя. Каталог вычисляется от расположения скрипта, а не от абсолютного
# пути конкретной машины.
private_config_dir() { printf '%s/deploy/private' "${REPO_ROOT}"; }

staging_config_file()    { printf '%s/staging.conf' "$(private_config_dir)"; }
production_config_file() { printf '%s/production.conf' "$(private_config_dir)"; }

# Значения, описывающие окружение. Каждое задаётся ровно в одном файле;
# в скриптах и Compose они не дублируются.
CONFIG_KEYS=(
  ENVIRONMENT_MARKER
  SSH_HOST SSH_USER SSH_PORT HOST_FINGERPRINT
  REMOTE_DIR APP_DOMAIN APP_HOST_PORT
  IMAGE_REPOSITORY COMPOSE_PROJECT COMPOSE_FILE ENV_FILE DB_VOLUME
)

# Читает конфигурацию окружения в переменные с префиксом.
#
# Файл выполняется в субоболочке: значения одного окружения не могут протечь
# в другое, даже если файл забыл задать часть ключей. Наружу выходят только
# известные ключи и только в экранированном виде.
load_environment_config() {
  local prefix="$1" file="$2"

  [ -f "${file}" ] || fail \
    "не найдена конфигурация «${file}». Реальные конфигурации хранятся в deploy/private/ и в Git не попадают: скопируйте нужный *.conf.example и заполните его."

  local dump
  dump="$(
    set -euo pipefail
    # shellcheck disable=SC1090
    source "${file}"
    for __key in "${CONFIG_KEYS[@]}"; do
      printf '%s_%s=%q\n' "${prefix}" "${__key}" "${!__key:-}"
    done
  )"

  eval "${dump}"
}

# Проверяет, что перечисленные значения заполнены, а не остались шаблонами.
require_config_values() {
  local prefix="$1" file="$2"
  shift 2
  local key name value
  for key in "$@"; do
    name="${prefix}_${key}"
    value="${!name:-}"
    if [ -z "${value}" ] || [[ "${value}" == CHANGE_ME* ]]; then
      fail "конфигурация «${file}» не заполнена: ${key}. Серверы ещё не настроены."
    fi
  done
}

# Переносит значения окружения в обычные имена: дальше команда работает
# со «своим» окружением, не помня о префиксах.
activate_environment() {
  local prefix="$1" key name
  ACTIVE_PREFIX="${prefix}"
  for key in "${CONFIG_KEYS[@]}"; do
    name="${prefix}_${key}"
    printf -v "${key}" '%s' "${!name:-}"
  done
}

# --- Изоляция окружений на одном сервере ---------------------------------

# Один физический сервер для staging и production разрешён, но только при полной
# изоляции ресурсов. Совпадение любого из них означает, что окружения делят
# состояние: выкатка staging могла бы остановить контейнер production, занять его
# порт или переписать его базу. Проверка выполняется до первого обращения к серверу.
require_isolated_environments() {
  local critical=(
    'REMOTE_DIR:каталог развёртывания'
    'COMPOSE_PROJECT:имя Compose-проекта'
    'APP_HOST_PORT:внешний порт приложения'
    'DB_VOLUME:том базы данных'
    'ENV_FILE:файл окружения'
    'ENVIRONMENT_MARKER:маркер окружения'
  )

  local pair key label staging_var production_var
  for pair in "${critical[@]}"; do
    key="${pair%%:*}"
    label="${pair#*:}"
    staging_var="STAGING_${key}"
    production_var="PRODUCTION_${key}"
    if [ "${!staging_var}" = "${!production_var}" ]; then
      fail "staging и production делят общий ресурс — ${label}: «${!staging_var}». Окружения обязаны быть изолированы, даже когда сервер один."
    fi
  done

  [ "${STAGING_ENVIRONMENT_MARKER}" = "staging" ] \
    || fail "конфигурация staging помечена как «${STAGING_ENVIRONMENT_MARKER}», а должна быть staging"
  [ "${PRODUCTION_ENVIRONMENT_MARKER}" = "production" ] \
    || fail "конфигурация production помечена как «${PRODUCTION_ENVIRONMENT_MARKER}», а должна быть production"

  if [ "${STAGING_SSH_HOST}" = "${PRODUCTION_SSH_HOST}" ]; then
    log "staging и production на одном сервере; критические ресурсы изолированы"
  fi
}

# --- Проверки версии -----------------------------------------------------

# Только полный 40-символьный SHA: короткий может стать неоднозначным,
# а ветка или тег — переехать на другой коммит.
require_full_sha() {
  [ -n "${VERSION}" ] || fail "не указан VERSION"
  [[ "${VERSION}" =~ ^[0-9a-f]{40}$ ]] || fail "VERSION должен быть полным 40-символьным SHA"
}

require_commit_in_origin_main() {
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "${VERSION}" origin/main 2>/dev/null; then
    fail "коммит ${VERSION} отсутствует в origin/main"
  fi
}

require_clean_worktree() {
  if [ -n "$(git status --porcelain)" ]; then
    fail "рабочее дерево не чистое: выкатка возможна только из зафиксированного состояния"
  fi
}

# --- Блокировки ----------------------------------------------------------

LOCAL_LOCK_DIR=""

acquire_local_lock() {
  local name="$1"
  LOCAL_LOCK_DIR="${REPO_ROOT}/deploy/state/${name}.lock.d"
  mkdir -p "${REPO_ROOT}/deploy/state"
  if ! mkdir "${LOCAL_LOCK_DIR}" 2>/dev/null; then
    fail "выкатка ${name} уже выполняется на этой машине (${LOCAL_LOCK_DIR})"
  fi
  trap 'release_local_lock' EXIT
}

release_local_lock() {
  [ -n "${LOCAL_LOCK_DIR}" ] && rmdir "${LOCAL_LOCK_DIR}" 2>/dev/null || true
}

# --- SSH -----------------------------------------------------------------

# Отпечаток хоста проверяется по заранее известному значению.
# StrictHostKeyChecking=accept-new не используется: он принял бы подменённый хост.
# Файл known_hosts отдельный для каждого окружения, даже если хост один: так
# разделение конфигураций сохраняется при переезде окружений на разные серверы.
prepare_known_hosts_for() {
  local prefix="$1"
  local fingerprint_var="${prefix}_HOST_FINGERPRINT"
  local file="${REPO_ROOT}/deploy/state/known_hosts.$(printf '%s' "${prefix}" | tr '[:upper:]' '[:lower:]')"

  mkdir -p "${REPO_ROOT}/deploy/state"
  printf '%s\n' "${!fingerprint_var}" > "${file}"
  chmod 600 "${file}"
  printf -v "${prefix}_KNOWN_HOSTS_FILE" '%s' "${file}"
}

prepare_known_hosts() { prepare_known_hosts_for "${ACTIVE_PREFIX}"; }

# Выполняет команду на сервере указанного окружения.
remote_on() {
  local prefix="$1"
  shift
  local host_var="${prefix}_SSH_HOST" user_var="${prefix}_SSH_USER"
  local port_var="${prefix}_SSH_PORT" hosts_var="${prefix}_KNOWN_HOSTS_FILE"

  ssh -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="${!hosts_var}" \
      -o BatchMode=yes \
      -p "${!port_var}" \
      "${!user_var}@${!host_var}" "$@"
}

remote() { remote_on "${ACTIVE_PREFIX}" "$@"; }

# --- Маркеры окружения ---------------------------------------------------

# Маркер лежит в каталоге окружения, а не «на сервере вообще»: когда окружения
# делят хост, доказательством служит именно каталог.
require_environment_marker_in() {
  local prefix="$1" expected="$2"
  local dir_var="${prefix}_REMOTE_DIR"
  local actual
  actual="$(remote_on "${prefix}" "cat '${!dir_var}/ENVIRONMENT' 2>/dev/null || true")"

  [ -n "${actual}" ] || fail "в каталоге «${!dir_var}» нет файла ENVIRONMENT"
  if [ "${actual}" != "${expected}" ]; then
    fail "маркер окружения не совпал: в каталоге «${!dir_var}» ожидался «${expected}», найден «${actual}»"
  fi
}

require_environment_marker() { require_environment_marker_in "${ACTIVE_PREFIX}" "${ENVIRONMENT_MARKER}"; }

# --- Подтверждение проверки на staging ------------------------------------

# Подтверждение читается из staging-каталога отдельным соединением со
# staging-конфигурацией. Production-каталог доказательством прохождения staging
# служить не может — даже когда оба окружения стоят на одном сервере.
require_staging_verification() {
  local file
  file="$(staging_config_file)"

  require_config_values STAGING "${file}" \
    SSH_HOST SSH_USER SSH_PORT HOST_FINGERPRINT REMOTE_DIR

  prepare_known_hosts_for STAGING
  require_environment_marker_in STAGING "staging"

  local verified
  verified="$(remote_on STAGING "grep -Fx '${VERSION}' '${STAGING_REMOTE_DIR}/state/verified-versions' 2>/dev/null || true")"
  [ -n "${verified}" ] \
    || fail "версия ${VERSION} не была успешно проверена на staging"

  log "версия подтверждена staging-каталогом ${STAGING_REMOTE_DIR}"
}

acquire_remote_lock() {
  remote "mkdir '${REMOTE_DIR}/deploy.lock.d'" \
    || fail "в каталоге ${REMOTE_DIR} уже выполняется выкатка"
}

release_remote_lock() {
  remote "rmdir '${REMOTE_DIR}/deploy.lock.d' 2>/dev/null || true" || true
}

# --- Образ ---------------------------------------------------------------

image_reference() {
  printf '%s:%s' "${IMAGE_REPOSITORY}" "${VERSION}"
}

# Развёрнутый образ проверяется по OCI-label: тег можно перевесить,
# а метка внутри образа соответствует конкретному коммиту.
require_image_revision() {
  local actual
  actual="$(remote "docker image inspect --format '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' '$(image_reference)'")"
  if [ "${actual}" != "${VERSION}" ]; then
    fail "метка образа не совпала: ожидался ${VERSION}, в образе «${actual}»"
  fi
}

# Порт свой у каждого окружения: значение по умолчанию здесь было бы опасно —
# на общем сервере оно привело бы к проверке чужого приложения.
require_ready() {
  local attempt=1
  while [ "${attempt}" -le 30 ]; do
    if remote "curl -fsS --max-time 5 http://127.0.0.1:${APP_HOST_PORT}/ready > /dev/null"; then
      log "readiness подтверждён на порту ${APP_HOST_PORT}"
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  fail "приложение не ответило на /ready"
}

# Команда запуска Compose: файл, project name и переменные — из конфигурации.
#
# IMAGE_REPOSITORY передаётся вместе с остальными: Compose обязан поднять ровно
# тот образ, который скрипт загрузил и у которого сверил OCI-метку. Зашитый
# в Compose адрес позволил бы проверить один образ, а запустить другой.
compose_command() {
  printf "cd '%s' && IMAGE_REPOSITORY='%s' IMAGE_TAG='%s' APP_HOST_PORT='%s' APP_ENV_NAME='%s' ENV_FILE='%s' DB_VOLUME='%s' COMPOSE_PROJECT='%s' docker compose -f '%s' -p '%s'" \
    "${REMOTE_DIR}" "${IMAGE_REPOSITORY}" "${VERSION}" "${APP_HOST_PORT}" "${ENVIRONMENT_MARKER}" \
    "${ENV_FILE}" "${DB_VOLUME}" "${COMPOSE_PROJECT}" "${COMPOSE_FILE}" "${COMPOSE_PROJECT}"
}

# --- Отчёт ---------------------------------------------------------------

report_deployed_revision() {
  local actual
  actual="$(remote "docker image inspect --format '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' '$(image_reference)'")"
  printf '\nРазвёрнуто: %s\n' "${actual}"
}
