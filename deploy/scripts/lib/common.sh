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
  MAP_ARTIFACTS_DIR VALHALLA_GRAPH_DIR VALHALLA_GRAPH_SHA256 VALHALLA_IMAGE
)

# Идентичность дорожного графа — это SHA-256 файла tiles.tar и ничто другое.
#
# Прежняя переменная VALHALLA_GRAPH_REVISION хранила Unix-время изменения файла.
# Оно менялось при обычном копировании набора на сервер и не менялось при
# подмене содержимого с сохранением времени, то есть не доказывало ничего.
# Имя изменено намеренно: молчаливое чтение старого ключа вернуло бы время
# в роль источника правды.
GRAPH_SHA256_PATTERN='^[0-9a-f]{64}$'

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

  # Путь закавычен ВНУТРИ значения опции: UserKnownHostsFile принимает список
  # файлов через пробел, а путь репозитория пробелы содержит. Без внутренних
  # кавычек ssh дробит его на несколько несуществующих путей, не находит ключ
  # хоста и отказывает. Кавычек на уровне shell недостаточно — значение
  # разбирает собственный парсер ssh.
  ssh -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="\"${!hosts_var}\"" \
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
# Доставляет на сервер файл ВЫКАТЫВАЕМОЙ версии и сверяет его.
#
# Содержимое берётся из дерева `VERSION`, а не из рабочего дерева. Разница
# принципиальна: выкатка допускает более старый проверенный SHA из origin/main,
# и файл рабочего дерева достался бы старому образу — получилось бы окружение,
# которого не существовало ни в одной проверенной версии.
#
# Сверка выполняется ДО замены. Испорченная передача не должна лишать сервер
# рабочего файла: при несовпадении удаляется только временная копия,
# а действующий файл остаётся нетронутым.
#
# Передача через base64 избавляет от зависимости от scp и rsync и от
# экранирования кавычек внутри SSH-команды: JavaScript и shell делят слишком
# много спецсимволов, чтобы полагаться на ручное цитирование.
deliver_versioned_file() {
  local repo_path="$1" remote_path="$2"

  if is_dry_run; then
    log "сухой прогон: ${repo_path} не доставляется (нужен доступ к серверу)"
    return 0
  fi

  local staged
  staged="$(mktemp)"

  if ! git -C "${REPO_ROOT}" show "${VERSION}:${repo_path}" > "${staged}" 2>/dev/null; then
    rm -f "${staged}"
    fail "в версии ${VERSION} нет файла ${repo_path}"
  fi

  local expected encoded
  expected="$(sha256_of "${staged}")"
  encoded="$(base64 < "${staged}" | tr -d '\n')"
  rm -f "${staged}"

  # Сначала временная копия рядом с целевым файлом.
  remote "printf '%s' '${encoded}' | base64 -d > '${remote_path}.new'"

  local actual
  actual="$(remote "sha256sum '${remote_path}.new'" | awk '{print $1}')"

  if [ "${actual}" != "${expected}" ]; then
    # Убирается только временная копия. Действующий файл остаётся прежним:
    # испорченная передача не повод оставить сервер без рабочего файла.
    remote "rm -f '${remote_path}.new'"
    fail "переданный файл ${repo_path} не совпал с версией ${VERSION}: ${actual} вместо ${expected}"
  fi

  # Замена — только после успешной сверки и одним движением.
  remote "mv '${remote_path}.new' '${remote_path}'"

  log "доставлен ${repo_path} версии ${VERSION:0:12}: ${expected:0:16}…"
}

# Compose-файл описывает состав окружения: какие сервисы существуют, что куда
# монтируется, какие переменные получает приложение. Он версионируется вместе
# с кодом, но попадал на сервер только руками при первоначальной настройке.
# Получалось, что выкатка придирчиво сверяет OCI-метку образа — и тут же
# запускает его файлом произвольного возраста.
#
# Последствия не теоретические: сервис, добавленный в репозитории, на сервере
# просто отсутствует, и команда `up … <сервис>` отказывает уже после миграций.
sync_compose_file() {
  deliver_versioned_file "deploy/${COMPOSE_FILE}" "${REMOTE_DIR}/${COMPOSE_FILE}"
}

# SHA-256 локального файла. На macOS нет sha256sum, на Linux нет shasum —
# поэтому используется тот инструмент, который есть.
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Доставляет проверочный скрипт выкатываемой версии.
#
# Скрипт лежит в репозитории — это единственный источник правды. На сервер он
# попадает вместе с командой выкатки, а не устанавливается заранее: иначе
# на разных серверах оказались бы разные его версии.
upload_verifier() {
  deliver_versioned_file "deploy/scripts/verify-geo.mjs" "${REMOTE_DIR}/verify-geo.mjs"
}

# Запускает проверку внутри закреплённого образа приложения.
#
# Именно внутри образа, а не на сервере: полагаться на установленный там Node
# нельзя — его может не быть вовсе, а версия может отличаться от проверенной.
run_verifier_with_mount() {
  local mount="$1" mode="$2" argument="$3" revision="$4"
  remote "docker run --rm --network none \
    -v '${REMOTE_DIR}/verify-geo.mjs:/verify-geo.mjs:ro' \
    -v '${mount}:${mount}:ro' \
    '$(image_reference)' node /verify-geo.mjs '${mode}' '${argument}' '${revision}'"
}

# Проверяет картографические артефакты на сервере.
#
# Fail closed. Отсутствующий манифест, несовпавшая контрольная сумма или другая
# ревизия графа означают, что на сервере лежит НЕ то, что собирали. Выкатка
# в таком состоянии дала бы либо пустую карту, либо расчёт по чужим дорожным
# данным, попавший в кэш под нашим ключом.
#
# При DRY_RUN проверка не выполняется: она требует обращения к серверу,
# а сухой прогон обязан обходиться без сети и без секретов.
require_geo_artifacts() {
  if is_dry_run; then
    log "сухой прогон: проверка картографических артефактов пропущена (нужен доступ к серверу)"
    return 0
  fi

  # Формат проверяется до обращения к серверу: пустое или произвольное значение
  # сравнилось бы с чем угодно, а числовое время означало бы возврат к прежнему,
  # неработающему определению идентичности.
  if ! printf '%s' "${VALHALLA_GRAPH_SHA256}" | grep -Eq "${GRAPH_SHA256_PATTERN}"; then
    fail "VALHALLA_GRAPH_SHA256 задан неверно: нужен SHA-256 набора тайлов из 64 шестнадцатеричных символов"
  fi

  upload_verifier

  run_verifier_with_mount "${MAP_ARTIFACTS_DIR}" basemap "${MAP_ARTIFACTS_DIR}" "" \
    || fail "подложка на сервере не совпадает с манифестом: ${MAP_ARTIFACTS_DIR}"

  # Считает фактический SHA-256 лежащего на сервере tiles.tar и сводит его
  # с манифестом и конфигурацией. Время изменения файла в проверке не участвует.
  run_verifier_with_mount "${VALHALLA_GRAPH_DIR}" graph "${VALHALLA_GRAPH_DIR}" "${VALHALLA_GRAPH_SHA256}" \
    || fail "содержимое дорожного графа на сервере не совпало с ${VALHALLA_GRAPH_SHA256}"

  log "картографические артефакты проверены: подложка и граф с содержимым ${VALHALLA_GRAPH_SHA256}"
}

# Спрашивает сам маршрутизатор, готов ли он работать.
#
# Что именно установлено, уже доказано: содержимое tiles.tar пересчитано
# и сведено с манифестом и конфигурацией ДО запуска сервиса. Здесь выясняется
# то, чего файл на диске не говорит, — сервис поднялся, набор прочитан
# и расчёт действительно выполняется.
#
# `tileset_last_modified` с ревизией НЕ сравнивается. Это время файла: оно
# меняется от копирования набора и не меняется от подмены его содержимого.
# Сравнение с ним однажды уже остановило исправную выкатку и при этом
# не остановило бы неисправную.
#
# Маршрутизатор намеренно не входит в /ready: его отказ не должен снимать
# приложение с балансировки. Но выкатка без него не продолжается — иначе она
# объявила бы успех при работающем приложении и неработающем расчёте.
require_routing_ready() {
  if is_dry_run; then
    log "сухой прогон: проверка маршрутизатора пропущена (нужен доступ к серверу)"
    return 0
  fi

  # Граф загружается не мгновенно, поэтому проверка повторяется. Значения
  # переопределяются только проверками: ждать две с половиной минуты в тесте
  # незачем, а на сервере это разумный срок загрузки набора тайлов.
  local attempts="${ROUTING_CHECK_ATTEMPTS:-30}"
  local delay="${ROUTING_CHECK_DELAY:-5}"

  local ready=0 attempt
  for attempt in $(seq 1 "${attempts}"); do
    if remote "$(compose_command) run --rm --no-deps -T \
        -v '${REMOTE_DIR}/verify-geo.mjs:/verify-geo.mjs:ro' \
        app node /verify-geo.mjs routing 'http://valhalla:8002'"; then
      ready=1
      break
    fi
    sleep "${delay}"
  done

  [ "${ready}" -eq 1 ] || fail "маршрутизатор не подтвердил готовность набора тайлов"
  log "маршрутизатор готов: набор тайлов загружен"

  # Загруженный набор ещё не означает работающий расчёт. Пробная матрица
  # на синтетических точках проверяет оба профиля до того, как приложение
  # получит право запуститься.
  remote "$(compose_command) run --rm --no-deps -T \
      -v '${REMOTE_DIR}/verify-geo.mjs:/verify-geo.mjs:ro' \
      app node /verify-geo.mjs matrix 'http://valhalla:8002'" \
    || fail "маршрутизатор не выполнил пробный расчёт матрицы"

  log "пробная матрица посчитана обоими профилями"
}

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
# Команда Compose со ВСЕМИ переменными, которые встречаются в YAML.
#
# Передавать только «нужные для этой команды» нельзя: Compose разбирает файл
# целиком даже для `run app`. Пропущенная переменная превращается в пустую
# строку — и получается сервис без образа и bind mount из пустого пути,
# то есть отказ на ровном месте или, хуже, монтирование не того каталога.
compose_command() {
  printf "cd '%s' && IMAGE_REPOSITORY='%s' IMAGE_TAG='%s' APP_HOST_PORT='%s' APP_ENV_NAME='%s' ENV_FILE='%s' DB_VOLUME='%s' COMPOSE_PROJECT='%s' MAP_ARTIFACTS_DIR='%s' VALHALLA_GRAPH_DIR='%s' VALHALLA_GRAPH_SHA256='%s' VALHALLA_IMAGE='%s' docker compose -f '%s' -p '%s'" \
    "${REMOTE_DIR}" "${IMAGE_REPOSITORY}" "${VERSION}" "${APP_HOST_PORT}" "${ENVIRONMENT_MARKER}" \
    "${ENV_FILE}" "${DB_VOLUME}" "${COMPOSE_PROJECT}" \
    "${MAP_ARTIFACTS_DIR}" "${VALHALLA_GRAPH_DIR}" "${VALHALLA_GRAPH_SHA256}" "${VALHALLA_IMAGE}" \
    "${COMPOSE_FILE}" "${COMPOSE_PROJECT}"
}

# --- Отчёт ---------------------------------------------------------------

report_deployed_revision() {
  local actual
  actual="$(remote "docker image inspect --format '{{ index .Config.Labels \"org.opencontainers.image.revision\" }}' '$(image_reference)'")"
  printf '\nРазвёрнуто: %s\n' "${actual}"
}
