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
docker run --rm \
  --network none \
  -v "$(cd "$(dirname "$input")" && pwd):/input:ro" \
  -v "${output}:/output" \
  --entrypoint /bin/bash \
  "${VALHALLA_IMAGE}@${VALHALLA_DIGEST}" \
  -lc '
    set -euo pipefail
    valhalla_build_config \
      --mjolnir-tile-dir /output/tiles \
      --mjolnir-tile-extract /output/tiles.tar \
      --mjolnir-timezone /output/timezones.sqlite \
      --mjolnir-admin /output/admins.sqlite > /output/valhalla.json
    valhalla_build_tiles -c /output/valhalla.json "/input/'"$(basename "$input")"'"
    valhalla_build_extract -c /output/valhalla.json -v
  '

# Ревизия — время сборки набора тайлов. Именно его сервис отдаёт в /status,
# поэтому конфигурацию приложения и фактический граф можно сверить.
revision="$(date -u +%s)"
printf '%s\n' "$revision" > "${output}/GRAPH_REVISION"

node "${here}/write-graph-manifest.mjs" \
  --root "$output" \
  --revision "$revision" \
  --source-file "$input" \
  --tool "valhalla=${VALHALLA_IMAGE}@${VALHALLA_DIGEST}"

echo "Готово: ${output}, ревизия ${revision}" >&2
