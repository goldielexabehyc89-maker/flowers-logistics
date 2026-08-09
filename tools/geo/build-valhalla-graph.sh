#!/usr/bin/env bash
#
# Сборка дорожного графа Valhalla из локального файла OpenStreetMap.
#
# Как и подложка, граф не скачивается и не собирается в CI: это гигабайты
# и десятки минут. Сборка выполняется отдельной операцией, результат кладётся
# на сервер неизменяемым набором.
#
# Ревизия графа обязательна и участвует в ключах кэша матриц. Расчёт по другому
# графу — это другой ответ, и переиспользовать его нельзя.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${here}/versions.env"

input=""
output=""

usage() {
  echo "Использование: build-valhalla-graph.sh --input <файл.osm.pbf> --output <каталог>" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$input" ] && [ -n "$output" ] || usage
[ -f "$input" ] || { echo "Файл ${input} не найден" >&2; exit 1; }
[ -e "$output" ] && { echo "Каталог ${output} уже существует: наборы не перезаписываются" >&2; exit 1; }

mkdir -p "${output}/tiles"

echo "Сборка графа Valhalla ${VALHALLA_IMAGE}" >&2
# Сеть отключена: сборка обязана обойтись переданным файлом.
#
# Пути в конфигурации указывают на /custom_files — именно туда каталог
# монтируется в рабочем контейнере. Записать сюда /output значило бы собрать
# конфигурацию, которая работает только на машине сборки: сервис искал бы
# тайлы по несуществующему пути и молча поднялся бы без графа.
docker run --rm \
  --network none \
  -v "$(cd "$(dirname "$input")" && pwd):/input:ro" \
  -v "${output}:/custom_files" \
  --entrypoint /bin/bash \
  "${VALHALLA_IMAGE}@${VALHALLA_DIGEST}" \
  -lc '
    set -euo pipefail
    valhalla_build_config \
      --mjolnir-tile-dir /custom_files/tiles \
      --mjolnir-tile-extract /custom_files/tiles.tar \
      --mjolnir-timezone /custom_files/timezones.sqlite \
      --mjolnir-admin /custom_files/admins.sqlite > /custom_files/valhalla.json
    valhalla_build_tiles -c /custom_files/valhalla.json "/input/'"$(basename "$input")"'"
    valhalla_build_extract -c /custom_files/valhalla.json -v
  '

# Пробный запуск собранного графа.
#
# Ревизию нельзя брать из текущего времени: она обязана совпасть с тем, что
# сервис ответит в /status на сервере, иначе выкатка будет вечно отвергать
# собственный граф. Поэтому граф поднимается прямо здесь, без внешней сети,
# и ревизия читается из его же ответа. Заодно это доказывает, что граф
# вообще запускается: собранный, но неработающий набор выглядит как обычный.
probe="fl-valhalla-probe-$$"
cleanup_probe() { docker rm -f "${probe}" > /dev/null 2>&1 || true; }
trap cleanup_probe EXIT

echo "Пробный запуск графа" >&2
docker run -d --name "${probe}" \
  --network none \
  -v "${output}:/custom_files:ro" \
  --entrypoint /bin/bash \
  "${VALHALLA_IMAGE}@${VALHALLA_DIGEST}" \
  -lc 'valhalla_service /custom_files/valhalla.json 1' > /dev/null

status=""
for _ in $(seq 1 60); do
  # Опрос идёт из соседнего контейнера в том же сетевом пространстве: так
  # не приходится гадать, есть ли curl внутри образа маршрутизатора.
  if status="$(docker run --rm --network "container:${probe}" \
      "${CURL_IMAGE}@${CURL_DIGEST}" -fsS --max-time 5 http://127.0.0.1:8002/status 2>/dev/null)"; then
    [ -n "${status}" ] && break
  fi
  sleep 2
done

[ -n "${status}" ] || { echo "Собранный граф не отвечает на /status" >&2; exit 1; }

revision="$(printf '%s' "${status}" | node -e '
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const value = body.tileset_last_modified;
    if (value === undefined || value === null) {
      console.error("Сервис не сообщил ревизию набора тайлов");
      process.exit(1);
    }
    process.stdout.write(String(value));
  });
')"

[ -n "${revision}" ] || { echo "Не удалось получить ревизию графа" >&2; exit 1; }

cleanup_probe
trap - EXIT

printf '%s\n' "${revision}" > "${output}/GRAPH_REVISION"

node "${here}/write-graph-manifest.mjs" \
  --root "$output" \
  --revision "$revision" \
  --source-file "$input" \
  --tool "valhalla=${VALHALLA_IMAGE}@${VALHALLA_DIGEST}"

echo "Готово: ${output}, ревизия ${revision}" >&2
