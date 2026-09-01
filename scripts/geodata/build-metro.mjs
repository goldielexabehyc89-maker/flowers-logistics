/**
 * Сборка точек станций метро из датированного снимка OpenStreetMap.
 *
 * Слой станций метро на картах «Сделки» и «Маршрутизация» — только визуальный,
 * но его положение обязано совпадать с настоящими станциями, а не «где-то
 * рядом». Прежде метки брались из слоя `poi` подложки, где станций 273, а
 * ВХОДОВ в метро — 1273: пять входов на станцию давали пять меток вокруг
 * настоящего места. Поэтому источник здесь один и явный: узлы OSM
 * `railway=station` + `station=subway` — это сами станции, а не их входы.
 *
 * Результат детерминирован: один и тот же снимок всегда даёт побайтово
 * одинаковый файл. Станции упорядочены, координаты округлены до микроградусов,
 * одноимённые узлы пересадочных узлов сведены в одну точку — как их показывает
 * визуальный ориентир (Яндекс Карты): один пункт на одну названную станцию.
 *
 * Данные ниоткуда не додумываются: если у снимка нет станций или их
 * подозрительно мало — скрипт останавливается, а не выдумывает точки.
 *
 * Запуск:
 *   node scripts/geodata/build-metro.mjs \
 *     --pbf <путь к снимку .osm.pbf> \
 *     --snapshot-url <точный URL датированного снимка> \
 *     --snapshot-md5 <опубликованная контрольная сумма снимка> \
 *     --data-date <дата данных, YYYY-MM-DD> \
 *     --out apps/web/src/lib/generated/metro
 */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scan } from './osm-pbf.mjs';

/** Отпечаток самого скрипта: по нему видно, чем именно собран файл. */
const SCRIPT_VERSION = '1.0.0';

/** Микроградусы: в этой точности координаты живут в наборе и считается отпечаток. */
const MICRO = 1_000_000;

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
 * десяток станций означают сломанный снимок или неверный тег, и по такому
 * набору карту рисовать нельзя.
 */
const EXPECTED = { minStations: 180, maxStations: 400 };

/**
 * Одноимённые станции сводятся в одну точку только вблизи друг друга.
 *
 * Пересадочный узел в OSM — это несколько узлов с одним названием (по одному
 * на линию), стоящих рядом. Их и сводим. Если два одинаковых имени окажутся
 * дальше этого предела — это не пересадка, а совпадение названий, и скрипт
 * остановится: сводить далёкие точки в одну — это выдумка.
 */
const SAME_NAME_MERGE_METERS = 1500;

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

/** Приблизительное расстояние между точками в метрах (для местного масштаба). */
function metersBetween(a, b) {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos(meanLat);
  return Math.hypot(dLat, dLon);
}

/** Округление до микроградуса: одно и то же значение при каждом запуске. */
function roundMicro(value) {
  return Math.round(value * MICRO) / MICRO;
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
  const nodes = [];
  await scan(
    pbf,
    { nodes: true, nodeTags: true },
    {
      node(_id, lat, lon, tags) {
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
          // Станция без названия подписать нечем — это дефект снимка, а не точка
          // на карту. Останавливаемся, чтобы не рисовать безымянный кружок.
          fail('станция метро без названия', `узел на ${lat},${lon}`);
        }
        nodes.push({ name, lat, lon });
      },
    },
  );

  process.stdout.write(`  узлов станций: ${nodes.length}\n`);

  // Сводим одноимённые узлы пересадочного узла в одну точку — их центр.
  const byName = new Map();
  for (const node of nodes) {
    const list = byName.get(node.name) ?? [];
    list.push(node);
    byName.set(node.name, list);
  }

  const stations = [];
  for (const [name, group] of byName) {
    // Все узлы одного имени обязаны стоять рядом: иначе это не пересадка.
    for (const node of group) {
      const far = group.find((other) => metersBetween(node, other) > SAME_NAME_MERGE_METERS);
      if (far !== undefined) {
        fail(
          `одноимённые станции «${name}» слишком далеко друг от друга`,
          `${node.lat},${node.lon} и ${far.lat},${far.lon} — сводить их в одну точку нельзя.`,
        );
      }
    }
    const lat = roundMicro(group.reduce((sum, n) => sum + n.lat, 0) / group.length);
    const lon = roundMicro(group.reduce((sum, n) => sum + n.lon, 0) / group.length);
    stations.push({ name, lat, lon });
  }

  if (stations.length < EXPECTED.minStations || stations.length > EXPECTED.maxStations) {
    fail(
      `неправдоподобное число станций: ${stations.length}`,
      `ожидалось от ${EXPECTED.minStations} до ${EXPECTED.maxStations}. Снимок или тег не те.`,
    );
  }

  // Порядок детерминированный: по названию, затем по координатам. Локаль для
  // сортировки задаём явно, чтобы результат не зависел от окружения.
  stations.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.lon - b.lon || a.lat - b.lat);

  const features = stations.map((station) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
    properties: { name: station.name },
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
    stationCount: stations.length,
    bbox: BBOX,
    scriptVersion: SCRIPT_VERSION,
    filter: 'railway=station AND station=subway',
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
    `\nГотово: ${stations.length} станций\n  ${geoPath}\n  sha256 набора: ${geoSha256}\n  ${manifestPath}\n`,
  );
}

main().catch((error) => fail('непредвиденный сбой', error?.stack ?? String(error)));
