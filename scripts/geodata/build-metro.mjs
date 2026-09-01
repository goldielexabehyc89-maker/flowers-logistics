/**
 * Сборка точек станций метро из датированного снимка OpenStreetMap.
 *
 * Слой станций метро на картах «Сделки» и «Маршрутизация» — только визуальный,
 * но его положение обязано совпадать с настоящими станциями, а не «где-то
 * рядом» и не в искусственной точке между платформами.
 *
 * ПОЭТОМУ УСРЕДНЕНИЯ НЕТ. Каждый узел OSM `railway=station` + `station=subway`
 * переносится КАК ЕСТЬ: своя координата, свой устойчивый идентификатор (id
 * узла OSM) и свой цвет линии (тег `colour`). Пересадочный узел — это
 * несколько станций разных линий рядом; в OSM это отдельные узлы, и мы
 * оставляем их отдельными точками, а не сводим по одинаковому названию в
 * выдуманную середину. Близость точек пересадки — забота отрисовки, а не
 * повод пересчитывать координату.
 *
 * Источник — HeadHunter (`api.hh.ru/metro`) использовать нельзя: его
 * пользовательское соглашение (п. 4.3, 4.6) запрещает извлекать данные для
 * формирования другой базы и передавать их сторонним сервисам, то есть
 * складывать снимок в бандл приложения. Остаётся OpenStreetMap под ODbL:
 * снимок датирован, у него есть контрольная сумма и атрибуция.
 *
 * Результат детерминирован: один и тот же снимок всегда даёт побайтово
 * одинаковый файл. Координаты не округляются и не вычисляются — что в снимке,
 * то и в наборе.
 *
 * Запуск (операторская команда обновления, НЕ при открытии карты):
 *   node scripts/geodata/build-metro.mjs \
 *     --pbf <путь к снимку .osm.pbf> \
 *     --snapshot-url <точный URL датированного снимка> \
 *     --snapshot-md5 <опубликованная контрольная сумма снимка> \
 *     --data-date <дата данных, YYYY-MM-DD> \
 *     --out apps/web/src/lib/metro-stations
 */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scan } from './osm-pbf.mjs';

/** Отпечаток самого скрипта: по нему видно, чем именно собран файл. */
const SCRIPT_VERSION = '2.0.0';

/**
 * Границы отбора — Москва и ближайшие пригороды с метро.
 *
 * Снимок «Центральный ФО» содержит метро только Москвы, но рамка страхует от
 * случайной станции с тем же тегом за пределами города. Значения фиксированы
 * и попадают в манифест как есть.
 */
const BBOX = { minLon: 36.7, minLat: 55.1, maxLon: 38.2, maxLat: 56.1 };

/**
 * Ожидаемые пределы результата.
 *
 * Не подгонка под алгоритм, а страховка от молчаливой чепухи: пустой набор или
 * десяток точек означают сломанный снимок или неверный тег. Без усреднения
 * точек больше, чем станций (пересадки — по узлу на линию).
 */
const EXPECTED = { minPoints: 200, maxPoints: 400 };

/**
 * Разрешённые имена цветов линий (валидный CSS). Всё остальное — либо hex,
 * либо заменяется нейтральным серым, чтобы отрисовка не получила негодный цвет.
 */
const NAMED_COLOURS = new Set([
  'red',
  'orange',
  'green',
  'blue',
  'violet',
  'yellow',
  'lightblue',
  'brown',
  'grey',
  'gray',
]);

/** Нейтральный цвет для узла без распознанного цвета линии. */
const DEFAULT_COLOUR = '#8a8d91';

function args() {
  const parsed = {};
  const list = process.argv.slice(2);
  for (let index = 0; index < list.length; index += 2) {
    const key = (list[index] ?? '').replace(/^--/, '');
    parsed[key] = list[index + 1] ?? '';
  }
  return parsed;
}

function fail(message, details) {
  process.stderr.write(`\nОШИБКА: ${message}\n`);
  if (details !== undefined) {
    process.stderr.write(`${details}\n`);
  }
  process.exit(1);
}

async function digests(filePath) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      sha256.update(chunk);
      md5.update(chunk);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}

/**
 * Приводит тег `colour` к безопасному для отрисовки значению.
 *
 * Берётся первый токен (в OSM встречается «green;#82C0C0»). Hex — как есть в
 * нижнем регистре; известное имя — как есть; иначе нейтральный серый. Значение
 * не «вычисляется» из координат, это перенос исходного цвета линии.
 */
function normalizeColour(raw) {
  const first = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^#[0-9a-f]{3,8}$/.test(first)) {
    return first;
  }
  if (NAMED_COLOURS.has(first)) {
    return first;
  }
  return DEFAULT_COLOUR;
}

async function main() {
  const options = args();

  const pbf = options.pbf ?? '';
  if (pbf === '') {
    fail('не указан снимок: --pbf <путь к .osm.pbf>');
  }
  const dataDate = options['data-date'] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) {
    fail('не указана дата данных: --data-date <ГГГГ-ММ-ДД>');
  }
  const snapshotUrl = options['snapshot-url'] ?? '';
  if (snapshotUrl === '') {
    fail('не указан источник: --snapshot-url <URL датированного снимка>');
  }
  const outDir = options.out ?? '';
  if (outDir === '') {
    fail('не указан каталог результата: --out <каталог>');
  }

  process.stdout.write(`Снимок: ${pbf}\nСчитаю контрольные суммы снимка…\n`);
  const sums = await digests(pbf);
  process.stdout.write(`  sha256: ${sums.sha256}\n  md5:    ${sums.md5}\n`);

  const expectedMd5 = options['snapshot-md5'] ?? '';
  if (expectedMd5 !== '' && expectedMd5 !== sums.md5) {
    fail(
      'контрольная сумма снимка не совпала',
      `ожидалось ${expectedMd5}, получено ${sums.md5}. Снимок не тот — сборка остановлена.`,
    );
  }

  process.stdout.write('Читаю узлы станций метро…\n');
  const stations = [];
  const seenIds = new Set();
  await scan(
    pbf,
    { nodes: true, nodeTags: true },
    {
      node(id, lat, lon, tags) {
        if (tags === undefined) {
          return;
        }
        // Станция метро — узел `railway=station` + `station=subway`. Входы
        // (`railway=subway_entrance`) и обычные ж/д станции сюда не попадают.
        if (tags.railway !== 'station' || tags.station !== 'subway') {
          return;
        }
        if (lon < BBOX.minLon || lon > BBOX.maxLon || lat < BBOX.minLat || lat > BBOX.maxLat) {
          return;
        }
        const name = (tags.name ?? '').trim();
        if (name === '') {
          fail('станция метро без названия', `узел ${id} на ${lat},${lon}`);
        }
        const stationId = String(id);
        if (seenIds.has(stationId)) {
          fail('повтор идентификатора узла OSM', stationId);
        }
        seenIds.add(stationId);
        // Координаты переносятся как есть: ни округления, ни пересчёта.
        stations.push({ id: stationId, name, colour: normalizeColour(tags.colour), lat, lon });
      },
    },
  );

  process.stdout.write(`  узлов станций (без усреднения): ${stations.length}\n`);

  if (stations.length < EXPECTED.minPoints || stations.length > EXPECTED.maxPoints) {
    fail(
      `неправдоподобное число точек: ${stations.length}`,
      `ожидалось от ${EXPECTED.minPoints} до ${EXPECTED.maxPoints}. Снимок или тег не те.`,
    );
  }

  // Порядок детерминированный: по названию, затем по устойчивому id. Локаль
  // задана явно, чтобы результат не зависел от окружения.
  stations.sort(
    (a, b) => a.name.localeCompare(b.name, 'ru') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const features = stations.map((station) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
    properties: { id: station.id, name: station.name, colour: station.colour },
  }));

  const collection = { type: 'FeatureCollection', features };
  // Перевод строки в конце — как у прочих текстовых артефактов репозитория.
  const geojson = `${JSON.stringify(collection, null, 2)}\n`;
  const geoName = `moscow-metro-${dataDate}.geo.json`;

  const geoSha256 = createHash('sha256').update(geojson).digest('hex');

  const manifest = {
    geometry: geoName,
    geometryVersion: dataDate,
    geometrySha256: geoSha256,
    pointCount: stations.length,
    stationNameCount: new Set(stations.map((s) => s.name)).size,
    bbox: BBOX,
    scriptVersion: SCRIPT_VERSION,
    filter: 'railway=station AND station=subway',
    averaging: 'none — каждый узел линии сохранён отдельной точкой',
    dataDate,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    source: snapshotUrl,
    snapshotSha256: sums.sha256,
  };

  mkdirSync(outDir, { recursive: true });
  const geoPath = path.join(outDir, geoName);
  const manifestPath = path.join(outDir, 'manifest.json');
  writeFileSync(geoPath, geojson, 'utf8');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\nГотово: ${stations.length} точек (${manifest.stationNameCount} названий)\n  ${geoPath}\n  sha256 набора: ${geoSha256}\n  ${manifestPath}\n`,
  );
}

main().catch((error) => fail('непредвиденный сбой', error?.stack ?? String(error)));
