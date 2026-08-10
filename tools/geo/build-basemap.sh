#!/usr/bin/env bash
#
# Сборка собственной подложки из локального файла OpenStreetMap.
#
# Скрипт НИЧЕГО не скачивает. Ни .osm.pbf, ни вспомогательные наборы, ни шрифты
# со спрайтами: всё это весит слишком много, чтобы тянуть на каждой сборке,
# а молчаливая загрузка из интернета сделала бы результат зависящим от чужой
# доступности. Всё входное готовит человек заранее и передаёт путями.
#
# Сборка атомарна. Работа идёт во временном каталоге рядом с целевым, и только
# после успешной сборки, записи манифеста и его проверки каталог переименовывается
# в окончательный. Прерванная сборка не оставляет ничего, что можно принять
# за готовый набор: половина тайлов выглядит как целый архив ровно до того
# момента, когда карта покажет пустоту.
#
# Результат неизменяем: повторная сборка делает новый каталог, а не переписывает
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
assets_revision=""
sources=""
output=""
bbox=""
attribution="© OpenStreetMap contributors"

# Вспомогательные наборы профиля. Их нет в выгрузке OSM, и без них
# сборка не начинается вовсе.
AUXILIARY_SOURCES=(
  lake_centerline.shp.zip
  water-polygons-split-3857.zip
  natural_earth_vector.sqlite.zip
)

# Лицензии распространяемых ресурсов. Мы отдаём глифы и спрайты браузеру
# со своего origin, то есть распространяем их, — а обе лицензии этого требуют.
REQUIRED_LICENSES=(
  fonts-OFL-1.1.txt
  sprites-MIT.txt
)

usage() {
  cat >&2 <<USAGE
Использование:
  build-basemap.sh --input <файл.osm.pbf> --region <название> --source-date <ГГГГ-ММ-ДД>
                   --bbox <запад,юг,восток,север>
                   --assets <каталог ресурсов> --assets-revision <источник@коммит>
                   --sources <каталог вспомогательных источников>
                   --output <каталог результата>
                   [--attribution "© OpenStreetMap contributors"]

Каталог --assets готовится один раз и содержит:
  sprite/sprite.json, sprite/sprite.png (и @2x при наличии)
  fonts/<Семейство>/<диапазон>.pbf
  licenses/fonts-OFL-1.1.txt   — лицензия шрифтов
  licenses/sprites-MIT.txt     — лицензия спрайтов

Каталог --sources содержит вспомогательные наборы профиля:
  lake_centerline.shp.zip
  water-polygons-split-3857.zip
  natural_earth_vector.sqlite.zip

Подготовить их можно самим planetiler — единственный шаг, которому нужна сеть:
  docker run --rm -v "<каталог>:/data/sources" \\
    "\${PLANETILER_IMAGE}@\${PLANETILER_DIGEST}" --only-download --download

Границы --bbox обязательны и попадают в манифест как есть. Значения по умолчанию
здесь недопустимы: манифест обязан описывать то, что действительно лежит
в архиве, а не то, что когда-то собирали в прошлый раз.
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --source-date) source_date="${2:-}"; shift 2 ;;
    --bbox) bbox="${2:-}"; shift 2 ;;
    --assets) assets="${2:-}"; shift 2 ;;
    --assets-revision) assets_revision="${2:-}"; shift 2 ;;
    --sources) sources="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --attribution) attribution="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$input" ] && [ -n "$region" ] && [ -n "$source_date" ] || usage
[ -n "$assets" ] && [ -n "$assets_revision" ] && [ -n "$sources" ] || usage
[ -n "$output" ] && [ -n "$bbox" ] || usage

[ -f "$input" ] || { echo "Файл ${input} не найден" >&2; exit 1; }
[ -d "$assets" ] || { echo "Каталог ресурсов ${assets} не найден" >&2; exit 1; }
[ -d "$sources" ] || { echo "Каталог вспомогательных источников ${sources} не найден" >&2; exit 1; }
printf '%s' "$source_date" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' \
  || { echo "Дата источника должна быть в формате ГГГГ-ММ-ДД" >&2; exit 1; }

# Границы проверяются здесь и полностью: перевёрнутый bbox молча описал бы
# другой регион, и манифест начал бы врать о содержимом архива.
IFS=',' read -r bb_w bb_s bb_e bb_n <<< "$bbox"
[ -n "${bb_n:-}" ] || { echo "Границы задаются как запад,юг,восток,север" >&2; exit 1; }
for value in "$bb_w" "$bb_s" "$bb_e" "$bb_n"; do
  printf '%s' "$value" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$' \
    || { echo "Граница «${value}» не является числом" >&2; exit 1; }
done
awk -v w="$bb_w" -v s="$bb_s" -v e="$bb_e" -v n="$bb_n" 'BEGIN {
  if (w < -180 || e > 180 || s < -90 || n > 90) { print "вне допустимого диапазона"; exit 1 }
  if (w >= e) { print "запад должен быть меньше востока"; exit 1 }
  if (s >= n) { print "юг должен быть меньше севера"; exit 1 }
}' || { echo "Границы заданы неверно: ${bbox}" >&2; exit 1; }

# Отсутствие входного набора выясняется ДО запуска контейнера: понятный отказ
# лучше исключения на чужом языке через минуту после старта.
for required in "${AUXILIARY_SOURCES[@]}"; do
  [ -f "${sources}/${required}" ] || {
    echo "В каталоге ${sources} нет вспомогательного источника ${required}." >&2
    echo "Подготовьте набор один раз:" >&2
    echo "  docker run --rm -v '${sources}:/data/sources' \\" >&2
    echo "    '${PLANETILER_IMAGE}@${PLANETILER_DIGEST}' --only-download --download" >&2
    exit 1
  }
done

for required in "${REQUIRED_LICENSES[@]}"; do
  [ -f "${assets}/licenses/${required}" ] || {
    echo "В каталоге ${assets}/licenses нет лицензии ${required}." >&2
    echo "Шрифты и спрайты распространяются вместе с подложкой, и обе лицензии" >&2
    echo "требуют, чтобы их текст сопровождал распространяемые файлы." >&2
    exit 1
  }
done

# Существующий каталог не перезаписывается: неизменяемость набора — не пожелание,
# а условие безопасной работы приложения с уже смонтированными файлами.
[ -e "$output" ] && { echo "Каталог ${output} уже существует: наборы не перезаписываются" >&2; exit 1; }

revision="$(printf '%s' "$source_date" | tr -d '-')"
tiles_name="tiles-${revision}.pmtiles"

# Временный каталог создаётся рядом с целевым: переименование в пределах одной
# файловой системы атомарно, а копирование между разными — нет.
parent="$(cd "$(dirname "$output")" && pwd)"
work="$(mktemp -d "${parent}/.basemap-build-XXXXXX")"
# Удаляется ТОЛЬКО собственный временный каталог. Чужие наборы, лежащие рядом,
# скрипт не трогает ни при каком исходе.
cleanup() { [ -n "${work:-}" ] && [ -d "${work}" ] && rm -rf "${work}"; }
trap cleanup EXIT

mkdir -p "${work}/sprite" "${work}/fonts" "${work}/licenses"

echo "Сборка тайлов planetiler ${PLANETILER_IMAGE}" >&2
docker run --rm \
  --network none \
  -v "$(cd "$(dirname "$input")" && pwd):/input:ro" \
  -v "$(cd "$sources" && pwd):/data/sources:ro" \
  -v "${work}:/output" \
  "${PLANETILER_IMAGE}@${PLANETILER_DIGEST}" \
  --osm-path="/input/$(basename "$input")" \
  --output="/output/${tiles_name}" \
  --force \
  --download=false \
  --nodemap-type=sparsearray

# Спрайты, шрифты и лицензии копируются из подготовленного каталога: браузер
# обязан получать их с нашего origin, а не с чужого CDN.
cp -R "${assets}/sprite/." "${work}/sprite/"
cp -R "${assets}/fonts/." "${work}/fonts/"
for required in "${REQUIRED_LICENSES[@]}"; do
  cp "${assets}/licenses/${required}" "${work}/licenses/${required}"
done

# Стиль собирается здесь и ссылается только на относительные пути.
# Абсолютный адрес чужого сервера в стиле означал бы, что карта работает,
# пока работает он, — и что о наших доставках знает посторонний.
# Стиль подложки собирается общим модулем.
#
# Тот же модуль используется при обновлении одного лишь стиля у собранного
# набора. Две копии стиля разошлись бы при первой правке, и карта на сервере
# перестала бы соответствовать тому, что собирает сборщик.
node "${here}/style.mjs" --tiles "${tiles_name}" --attribution "${attribution}" \
  > "${work}/style-${revision}.json"

aux_args=()
for required in "${AUXILIARY_SOURCES[@]}"; do
  aux_args+=(--input "${required}=${sources}/${required}")
done

node "${here}/write-manifest.mjs" \
  --root "$work" \
  "${aux_args[@]}" \
  --revision "$revision" \
  --region "$region" \
  --bbox "$bbox" \
  --source-date "$source_date" \
  --source-file "$input" \
  --assets-revision "$assets_revision" \
  --style "style-${revision}.json" \
  --attribution "$attribution" \
  --tool "planetiler=${PLANETILER_IMAGE}@${PLANETILER_DIGEST}" \
  --tool "pmtiles-spec=v${PMTILES_SPEC_VERSION}"

# Манифест проверяется до переименования: набор, объявленный готовым, обязан
# сойтись сам с собой ещё до того, как его увидит кто-то ещё.
"${here}/verify-manifest.sh" "$work"

# Единственный момент, когда окончательный путь появляется вообще.
mv "$work" "$output"
work=""
trap - EXIT

echo "Готово: ${output}" >&2
