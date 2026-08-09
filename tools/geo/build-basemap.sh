#!/usr/bin/env bash
#
# Сборка собственной подложки из локального файла OpenStreetMap.
#
# Скрипт НИЧЕГО не скачивает. Ни .osm.pbf, ни шрифты, ни спрайты: и то и другое
# весит слишком много, чтобы тянуть это на каждой сборке, а молчаливая загрузка
# из интернета сделала бы результат зависящим от чужой доступности. Всё входное
# готовит человек заранее и передаёт путями.
#
# Результат — каталог с PMTiles, стилем, спрайтами, шрифтами и манифестом.
# Каталог неизменяемый: повторная сборка делает новый каталог, а не переписывает
# существующий. Приложение может читать текущий набор прямо сейчас, и подмена
# файла под ним дала бы обрывок вместо тайла.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${here}/versions.env"

input=""
region=""
source_date=""
assets=""
output=""
attribution="© OpenStreetMap contributors"

usage() {
  cat >&2 <<'USAGE'
Использование:
  build-basemap.sh --input <файл.osm.pbf> --region <название> --source-date <ГГГГ-ММ-ДД>
                   --assets <каталог со спрайтами и шрифтами> --output <каталог результата>
                   [--attribution "© OpenStreetMap contributors"]

Каталог --assets готовится один раз и содержит:
  sprite/sprite.json, sprite/sprite.png (и @2x при наличии)
  fonts/<Семейство>/<диапазон>.pbf
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --source-date) source_date="${2:-}"; shift 2 ;;
    --assets) assets="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --attribution) attribution="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$input" ] && [ -n "$region" ] && [ -n "$source_date" ] || usage
[ -n "$assets" ] && [ -n "$output" ] || usage

[ -f "$input" ] || { echo "Файл ${input} не найден" >&2; exit 1; }
[ -d "$assets" ] || { echo "Каталог ресурсов ${assets} не найден" >&2; exit 1; }
printf '%s' "$source_date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
  || { echo "Дата источника должна быть в формате ГГГГ-ММ-ДД" >&2; exit 1; }

# Существующий каталог не перезаписывается: неизменяемость набора — не пожелание,
# а условие безопасной работы приложения с уже смонтированными файлами.
[ -e "$output" ] && { echo "Каталог ${output} уже существует: наборы не перезаписываются" >&2; exit 1; }

revision="$(printf '%s' "$source_date" | tr -d '-')"
mkdir -p "${output}/sprite" "${output}/fonts"

tiles_name="tiles-${revision}.pmtiles"

echo "Сборка тайлов planetiler ${PLANETILER_IMAGE}" >&2
docker run --rm \
  --network none \
  -v "$(cd "$(dirname "$input")" && pwd):/input:ro" \
  -v "${output}:/output" \
  "${PLANETILER_IMAGE}@${PLANETILER_DIGEST}" \
  --osm-path="/input/$(basename "$input")" \
  --output="/output/${tiles_name}" \
  --force \
  --download=false \
  --nodemap-type=sparsearray

# Спрайты и шрифты копируются из подготовленного каталога: браузер обязан
# получать их с нашего origin, а не с чужого CDN.
cp -R "${assets}/sprite/." "${output}/sprite/"
cp -R "${assets}/fonts/." "${output}/fonts/"

# Стиль собирается здесь и ссылается только на относительные пути.
# Абсолютный адрес чужого сервера в стиле означал бы, что карта работает,
# пока работает он, — и что о наших доставках знает посторонний.
cat > "${output}/style-${revision}.json" <<STYLE
{
  "version": 8,
  "name": "flowers-logistics-basemap",
  "sources": {
    "basemap": {
      "type": "vector",
      "url": "pmtiles://./${tiles_name}",
      "attribution": "${attribution}"
    }
  },
  "sprite": "./sprite/sprite",
  "glyphs": "./fonts/{fontstack}/{range}.pbf",
  "layers": [
    { "id": "background", "type": "background", "paint": { "background-color": "#f5f6f8" } },
    {
      "id": "water",
      "type": "fill",
      "source": "basemap",
      "source-layer": "water",
      "paint": { "fill-color": "#c9d9e8" }
    },
    {
      "id": "roads",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "paint": { "line-color": "#d5dae1", "line-width": 1.2 }
    },
    {
      "id": "buildings",
      "type": "fill",
      "source": "basemap",
      "source-layer": "building",
      "paint": { "fill-color": "#e9edf2" }
    }
  ]
}
STYLE

node "${here}/write-manifest.mjs" \
  --root "$output" \
  --revision "$revision" \
  --region "$region" \
  --source-date "$source_date" \
  --source-file "$input" \
  --style "style-${revision}.json" \
  --attribution "$attribution" \
  --tool "planetiler=${PLANETILER_IMAGE}@${PLANETILER_DIGEST}" \
  --tool "pmtiles-spec=v${PMTILES_SPEC_VERSION}"

echo "Готово: ${output}" >&2
