# Общая часть команд выкатки.
#
# Файл подключается через source из deploy-staging.sh и deploy-production.sh.
# Здесь только проверки и вспомогательные функции: сами команды остаются разными,
# чтобы staging и production невозможно было перепутать.
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

# Загружает конфигурацию окружения и проверяет, что она действительно заполнена.
# Пока значения остаются шаблонными, обычная выкатка обязана отказать до SSH.
load_config() {
  local config_file="$1"
  [ -f "${config_file}" ] || fail "не найден файл конфигурации «${config_file}»"

  # shellcheck disable=SC1090
  source "${config_file}"

  local required=(ENVIRONMENT_MARKER SSH_HOST SSH_USER SSH_PORT HOST_FINGERPRINT REMOTE_DIR APP_DOMAIN IMAGE_REPOSITORY COMPOSE_PROJECT)
  for name in "${required[@]}"; do
    local value="${!name:-}"
    if [ -z "${value}" ] || [[ "${value}" == CHANGE_ME* ]]; then
      fail "конфигурация «${config_file}» не заполнена: ${name}. Серверы ещё не настроены."
    fi
  done
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
prepare_known_hosts() {
  KNOWN_HOSTS_FILE="${REPO_ROOT}/deploy/state/known_hosts.${ENVIRONMENT_MARKER}"
  mkdir -p "${REPO_ROOT}/deploy/state"
  printf '%s\n' "${HOST_FINGERPRINT}" > "${KNOWN_HOSTS_FILE}"
  chmod 600 "${KNOWN_HOSTS_FILE}"
}

remote() {
  ssh -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="${KNOWN_HOSTS_FILE}" \
      -o BatchMode=yes \
      -p "${SSH_PORT}" \
      "${SSH_USER}@${SSH_HOST}" "$@"
}

# Маркер окружения на целевом хосте должен совпадать с ожидаемым.
# Это последний рубеж против выкатки staging-версии на production и наоборот.
require_environment_marker() {
  local actual
  actual="$(remote "cat '${REMOTE_DIR}/ENVIRONMENT' 2>/dev/null || true")"
  [ -n "${actual}" ] || fail "на целевом хосте нет файла ENVIRONMENT"
  if [ "${actual}" != "${ENVIRONMENT_MARKER}" ]; then
    fail "маркер окружения не совпал: ожидался «${ENVIRONMENT_MARKER}», на хосте «${actual}»"
  fi
}

acquire_remote_lock() {
  remote "mkdir '${REMOTE_DIR}/deploy.lock.d'" \
    || fail "на целевом хосте уже выполняется выкатка"
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

require_ready() {
  local attempt=1
  while [ "${attempt}" -le 30 ]; do
    if remote "curl -fsS --max-time 5 http://127.0.0.1:${APP_PORT:-3000}/ready > /dev/null"; then
      log "readiness подтверждён"
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  fail "приложение не ответило на /ready"
}

# --- Отчёт ---------------------------------------------------------------

report_deployed_revision() {
  local actual
  actual="$(remote "docker image inspect --format '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' '$(image_reference)'")"
  printf '\nРазвёрнуто: %s\n' "${actual}"
}
