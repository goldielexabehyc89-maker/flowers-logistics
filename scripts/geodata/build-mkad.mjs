/**
 * Сборка кольца МКАД из датированного снимка OpenStreetMap.
 *
 * От этой геометрии зависят деньги: она решает, выезжал ли курьер за МКАД
 * и на сколько километров. Поэтому здесь нет ни одного догаданного числа.
 * Кольцо собирается ТОПОЛОГИЧЕСКИ — по общим узлам линий отношения, — а не
 * угловыми секторами, радиусом от центра, сглаживанием или дорисовыванием.
 * Если связать линии в замкнутый контур однозначно нельзя, скрипт
 * останавливается и печатает структуру отношения: догадка о том, «как оно,
 * наверное, должно идти», в деньгах недопустима.
 *
 * Результат детерминирован: один и тот же снимок всегда даёт побайтово
 * одинаковый файл. Ориентация, начальная точка и округление координат
 * приведены к одному виду, поэтому повторная сборка ничего не меняет.
 *
 * Запуск:
 *   node scripts/geodata/build-mkad.mjs \
 *     --pbf <путь к снимку .osm.pbf> \
 *     --snapshot-url <точный URL датированного снимка> \
 *     --snapshot-md5 <опубликованная контрольная сумма снимка> \
 *     --data-date <дата данных, YYYY-MM-DD> \
 *     --out apps/api/assets/mkad
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scan } from './osm-pbf.mjs';

/** Отношение МКАД в OpenStreetMap. Другого источника у геометрии нет. */
const RELATION_ID = 2094222n;

/** Отпечаток самого скрипта: по нему видно, чем именно собран файл. */
const SCRIPT_VERSION = '1.0.0';

/**
 * Ожидаемые пределы результата.
 *
 * Это не подгонка под алгоритм, а страховка от молчаливой чепухи: кольцо
 * длиной 12 км или прямоугольник вокруг области обязаны быть отвергнуты
 * до того, как по ним начнут считать деньги.
 */
const EXPECTED = {
  bbox: { minLon: 36.9, minLat: 55.4, maxLon: 38.1, maxLat: 56.1 },
  lengthKm: { min: 100, max: 120 },
  minPoints: 1000,
};

/** Микроградусы: в этой точности геометрия живёт в базе и считается отпечаток. */
const MICRO = 1_000_000;

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

// --- Топология ---------------------------------------------------------------

/**
 * Сборка замкнутых контуров из линий отношения.
 *
 * Линии соединяются ТОЛЬКО по совпадающим идентификаторам узлов OSM. Ветвление
 * (у одного конца больше одного продолжения) не разрешается никаким правилом
 * «выбрать похожее»: это ровно тот случай, когда честнее остановиться.
 */
function assembleRings(ways) {
  const byId = new Map(ways.map((way) => [way.id, way]));
  const unused = new Set(byId.keys());
  const ends = new Map();

  const remember = (nodeId, wayId) => {
    const list = ends.get(nodeId) ?? [];
    list.push(wayId);
    ends.set(nodeId, list);
  };

  for (const way of ways) {
    const first = way.nodes[0];
    const last = way.nodes[way.nodes.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }
    remember(first, way.id);
    if (last !== first) {
      remember(last, way.id);
    }
  }

  const rings = [];
  const open = [];

  // Порядок обхода задан идентификаторами: сборка не должна зависеть от того,
  // в каком порядке снимок отдал линии.
  const order = [...unused].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  for (const startId of order) {
    if (!unused.has(startId)) {
      continue;
    }

    const start = byId.get(startId);
    unused.delete(startId);
    const chain = [...start.nodes];
    const members = [start.id];

    for (;;) {
      const tail = chain[chain.length - 1];
      if (tail === chain[0] && chain.length > 2) {
        break;
      }

      const candidates = (ends.get(tail) ?? []).filter((id) => unused.has(id));
      if (candidates.length === 0) {
        break;
      }
      if (candidates.length > 1) {
        fail(
          'связать линии отношения в кольцо однозначно нельзя',
          `Узел OSM ${tail} продолжается сразу несколькими линиями: ${candidates.join(', ')}.\n` +
            'Это развилка, а не кольцо. Догадываться, какая из линий «настоящая», нельзя:\n' +
            'проверьте структуру отношения в OSM и состав ролей.',
        );
      }

      const nextId = candidates[0];
      const next = byId.get(nextId);
      unused.delete(nextId);
      members.push(nextId);

      const nextNodes =
        next.nodes[0] === tail ? next.nodes.slice(1) : [...next.nodes].reverse().slice(1);
      chain.push(...nextNodes);
    }

    const closed = chain.length > 3 && chain[0] === chain[chain.length - 1];
    (closed ? rings : open).push({ nodes: chain, ways: members });
  }

  return { rings, open };
}

// --- Геометрия ---------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;

function haversine(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function ringLengthMeters(ring) {
  let total = 0;
  for (let index = 1; index < ring.length; index += 1) {
    total += haversine(ring[index - 1], ring[index]);
  }
  return total;
}

/** Знаковая площадь: знак задаёт направление обхода, величина — размер контура. */
function signedArea(ring) {
  let sum = 0;
  for (let index = 1; index < ring.length; index += 1) {
    const [x1, y1] = ring[index - 1];
    const [x2, y2] = ring[index];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function pointInRing(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    const crosses = a[1] > point[1] !== b[1] > point[1];
    if (!crosses) {
      continue;
    }
    const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (point[0] < x) {
      inside = !inside;
    }
  }
  return inside;
}

function bboxOf(ring) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Самопересечения.
 *
 * Отрезки разложены по сетке: полный перебор пар на десяти тысячах точек —
 * сотни миллионов сравнений, и проверка стала бы той, которую однажды выключат.
 */
function selfIntersections(ring) {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(ring);
  const cells = 200;
  const stepLon = (maxLon - minLon) / cells || 1;
  const stepLat = (maxLat - minLat) / cells || 1;
  const buckets = new Map();

  const segments = [];
  for (let index = 1; index < ring.length; index += 1) {
    segments.push([ring[index - 1], ring[index]]);
  }

  segments.forEach((segment, index) => {
    const [a, b] = segment;
    const x0 = Math.floor((Math.min(a[0], b[0]) - minLon) / stepLon);
    const x1 = Math.floor((Math.max(a[0], b[0]) - minLon) / stepLon);
    const y0 = Math.floor((Math.min(a[1], b[1]) - minLat) / stepLat);
    const y1 = Math.floor((Math.max(a[1], b[1]) - minLat) / stepLat);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        const list = buckets.get(key) ?? [];
        list.push(index);
        buckets.set(key, list);
      }
    }
  });

  const orientation = (p, q, r) => {
    const value = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
    return value === 0 ? 0 : value > 0 ? 1 : 2;
  };

  const crosses = (p1, q1, p2, q2) => {
    const o1 = orientation(p1, q1, p2);
    const o2 = orientation(p1, q1, q2);
    const o3 = orientation(p2, q2, p1);
    const o4 = orientation(p2, q2, q1);
    return o1 !== o2 && o3 !== o4;
  };

  const found = [];
  const last = segments.length - 1;
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const left = list[i];
        const right = list[j];
        // Соседние отрезки делят точку по построению; первый и последний — тоже.
        if (Math.abs(left - right) <= 1) {
          continue;
        }
        if ((left === 0 && right === last) || (right === 0 && left === last)) {
          continue;
        }
        const [p1, q1] = segments[left];
        const [p2, q2] = segments[right];
        if (crosses(p1, q1, p2, q2)) {
          found.push([left, right]);
        }
      }
    }
  }
  return found;
}

/**
 * Приведение кольца к каноническому виду.
 *
 * Округление до микроградуса — та же точность, в которой геометрия живёт
 * в базе: файл на GitHub и рабочая геометрия обязаны быть одним и тем же.
 * Начальная точка и направление обхода заданы жёстко, поэтому повторная
 * сборка того же снимка даёт побайтово тот же файл.
 */
function canonical(points) {
  const rounded = points.map(([lon, lat]) => [
    Math.round(lon * MICRO) / MICRO,
    Math.round(lat * MICRO) / MICRO,
  ]);

  const deduped = [];
  for (const point of rounded) {
    const previous = deduped[deduped.length - 1];
    if (previous === undefined || previous[0] !== point[0] || previous[1] !== point[1]) {
      deduped.push(point);
    }
  }
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      deduped.pop();
    }
  }

  // Внешнее кольцо GeoJSON обходится против часовой стрелки (RFC 7946).
  const closedForArea = [...deduped, deduped[0]];
  const ordered = signedArea(closedForArea) < 0 ? [...deduped].reverse() : deduped;

  let startIndex = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    const best = ordered[startIndex];
    if (candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] < best[1])) {
      startIndex = index;
    }
  }

  const rotated = [...ordered.slice(startIndex), ...ordered.slice(0, startIndex)];
  return [...rotated, rotated[0]];
}

/** Отпечаток рабочей геометрии. Та же формула, что и в приложении. */
function geometrySha256(ring) {
  const canonicalText = ring
    .map(([lon, lat]) => `${Math.round(lon * MICRO)},${Math.round(lat * MICRO)}`)
    .join(';');
  return createHash('sha256').update(canonicalText).digest('hex');
}

/**
 * Запись файла.
 *
 * Пары координат остаются на одной строке: тысяча точек по три строки каждая
 * превращает файл в нечитаемую простыню, а diff новой версии — в бесполезный.
 * Формат совпадает с тем, к которому файл привёл бы Prettier, поэтому
 * повторная сборка не спорит с форматированием репозитория.
 */
function serialize(value) {
  const text = JSON.stringify(value, null, 2);
  const collapsed = text.replace(
    /\[\s*\n\s*(-?\d+(?:\.\d+)?),\s*\n\s*(-?\d+(?:\.\d+)?)\s*\n\s*\]/g,
    '[$1, $2]',
  );
  const withBbox = collapsed.replace(
    /"bbox": \[\s*\n\s*(-?[\d.]+),\s*\n\s*(-?[\d.]+),\s*\n\s*(-?[\d.]+),\s*\n\s*(-?[\d.]+)\s*\n\s*\]/g,
    '"bbox": [$1, $2, $3, $4]',
  );
  return `${withBbox}\n`;
}

// --- Сборка ------------------------------------------------------------------

async function main() {
  const options = args();
  const pbf = options.pbf ?? '';
  if (pbf === '') {
    fail('не указан снимок: --pbf <путь к .osm.pbf>');
  }

  const snapshotUrl = options['snapshot-url'] ?? '';
  const snapshotMd5 = (options['snapshot-md5'] ?? '').toLowerCase();
  const dataDate = options['data-date'] ?? '';
  const outDir = options.out ?? 'apps/api/assets/mkad';
  if (snapshotUrl === '' || snapshotMd5 === '' || dataDate === '') {
    fail('нужны --snapshot-url, --snapshot-md5 и --data-date: источник обязан быть назван');
  }
  if (snapshotUrl.includes('latest')) {
    fail('«latest» источником быть не может: снимок обязан быть датированным и неизменяемым');
  }

  process.stdout.write(`Снимок: ${pbf}\nСчитаю контрольные суммы снимка…\n`);
  const sums = await digests(pbf);
  if (sums.md5 !== snapshotMd5) {
    fail(
      'контрольная сумма снимка не совпадает с опубликованной',
      `ожидалось ${snapshotMd5}, получено ${sums.md5}`,
    );
  }
  process.stdout.write(`  md5 сходится: ${sums.md5}\n  sha256: ${sums.sha256}\n`);

  // Проход 1: отношение и его состав.
  process.stdout.write('Проход 1: ищу отношение…\n');
  let relation = null;
  await scan(
    pbf,
    { relations: true },
    {
      relation: (id, members, tags) => {
        if (id === RELATION_ID) {
          relation = { id, members, tags };
        }
      },
    },
  );
  if (relation === null) {
    fail(`отношение ${RELATION_ID} в снимке не найдено`);
  }

  const wayMembers = relation.members.filter((member) => member.type === 'WAY');
  const roles = new Map();
  for (const member of relation.members) {
    const key = `${member.type}:${member.role === '' ? '(без роли)' : member.role}`;
    roles.set(key, (roles.get(key) ?? 0) + 1);
  }
  process.stdout.write(
    `  отношение ${RELATION_ID}: «${relation.tags.name ?? ''}», ` +
      `${relation.members.length} членов\n` +
      [...roles].map(([key, count]) => `    ${key}: ${count}`).join('\n') +
      '\n',
  );

  // Проход 2: линии отношения.
  process.stdout.write('Проход 2: читаю линии…\n');
  const wanted = new Set(wayMembers.map((member) => member.ref));
  const ways = [];
  await scan(
    pbf,
    { ways: true },
    {
      way: (id, nodes, tags) => {
        if (wanted.has(id)) {
          ways.push({ id, nodes, tags });
        }
      },
    },
  );
  if (ways.length !== wanted.size) {
    fail(
      'в снимке нет части линий отношения',
      `ожидалось ${wanted.size}, найдено ${ways.length}: снимок обрезан по границе региона`,
    );
  }
  process.stdout.write(`  линий: ${ways.length}\n`);

  // Проход 3: координаты узлов.
  process.stdout.write('Проход 3: читаю узлы…\n');
  const neededNodes = new Set();
  for (const way of ways) {
    for (const node of way.nodes) {
      neededNodes.add(node);
    }
  }
  const coordinates = new Map();
  await scan(
    pbf,
    { nodes: true },
    {
      node: (id, lat, lon) => {
        if (neededNodes.has(id)) {
          coordinates.set(id, [lon, lat]);
        }
      },
    },
  );
  if (coordinates.size !== neededNodes.size) {
    fail(
      'в снимке нет части узлов линий',
      `нужно ${neededNodes.size}, найдено ${coordinates.size}`,
    );
  }
  process.stdout.write(`  узлов: ${coordinates.size}\n`);

  // Топологическая сборка.
  process.stdout.write('Собираю замкнутые контуры по общим узлам…\n');
  const { rings, open } = assembleRings(ways);
  process.stdout.write(
    `  замкнутых контуров: ${rings.length}, незамкнутых цепочек: ${open.length}\n`,
  );
  if (rings.length === 0) {
    fail(
      'ни одного замкнутого контура из отношения не собралось',
      open
        .map(
          (chain) =>
            `  цепочка из ${chain.ways.length} линий: узлы ${chain.nodes[0]} → ${chain.nodes[chain.nodes.length - 1]}`,
        )
        .join('\n'),
    );
  }

  const shaped = rings.map((ring) => {
    const points = ring.nodes.map((node) => coordinates.get(node));
    return { ...ring, points, area: Math.abs(signedArea(points)) };
  });
  shaped.sort((left, right) => right.area - left.area);

  const outer = shaped[0];
  for (const other of shaped.slice(1)) {
    const sample = other.points[Math.floor(other.points.length / 2)];
    if (!pointInRing(outer.points, sample)) {
      fail(
        'внешний контур не накрывает остальные: отношение распалось на несвязанные кольца',
        shaped
          .map((ring, index) => `  контур ${index + 1}: ${ring.points.length} точек`)
          .join('\n'),
      );
    }
  }
  process.stdout.write(
    `  внешний контур: ${outer.points.length} точек из ${outer.ways.length} линий\n`,
  );

  const ring = canonical(outer.points);

  // Проверки результата.
  const lengthMeters = ringLengthMeters(ring);
  const lengthKm = lengthMeters / 1000;
  const bbox = bboxOf(ring);
  const crossings = selfIntersections(ring);

  const problems = [];
  if (ring.length < EXPECTED.minPoints) {
    problems.push(`точек всего ${ring.length}, ожидалось не меньше ${EXPECTED.minPoints}`);
  }
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
    problems.push('кольцо не замкнуто');
  }
  if (crossings.length > 0) {
    problems.push(`самопересечений: ${crossings.length} (первое между отрезками ${crossings[0]})`);
  }
  if (lengthKm < EXPECTED.lengthKm.min || lengthKm > EXPECTED.lengthKm.max) {
    problems.push(
      `длина ${lengthKm.toFixed(3)} км вне ожидаемого диапазона ` +
        `${EXPECTED.lengthKm.min}–${EXPECTED.lengthKm.max} км`,
    );
  }
  if (
    bbox[0] < EXPECTED.bbox.minLon ||
    bbox[1] < EXPECTED.bbox.minLat ||
    bbox[2] > EXPECTED.bbox.maxLon ||
    bbox[3] > EXPECTED.bbox.maxLat
  ) {
    problems.push(`рамка ${bbox.join(', ')} выходит за ожидаемые пределы Москвы`);
  }
  if (problems.length > 0) {
    fail('собранное кольцо не прошло проверки', problems.map((item) => `  · ${item}`).join('\n'));
  }

  const sha256 = geometrySha256(ring);
  const version = dataDate;

  const feature = {
    type: 'FeatureCollection',
    name: 'mkad-ring',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Московская кольцевая автомобильная дорога',
          geometryVersion: version,
          osmRelationId: Number(RELATION_ID),
          snapshotUrl,
          snapshotMd5,
          snapshotSha256: sums.sha256,
          dataDate,
          derivation:
            'Топологическая сборка: линии отношения соединены по общим идентификаторам узлов OSM, ' +
            'выбран внешний замкнутый контур. Угловые секторы, радиус от центра, сглаживание ' +
            'и интерполяция не применялись.',
          builder: `scripts/geodata/build-mkad.mjs@${SCRIPT_VERSION}`,
          pointCount: ring.length,
          lengthMeters: Math.round(lengthMeters),
          bbox,
          geometrySha256: sha256,
          license: 'ODbL-1.0',
          attribution: '© OpenStreetMap contributors',
        },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ],
  };

  const manifest = {
    geometry: `mkad-${version}.geojson`,
    geometryVersion: version,
    geometrySha256: sha256,
    osmRelationId: Number(RELATION_ID),
    dataDate,
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    source: snapshotUrl,
  };

  mkdirSync(outDir, { recursive: true });
  const geoPath = path.join(outDir, manifest.geometry);
  writeFileSync(geoPath, serialize(feature), 'utf8');
  writeFileSync(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  process.stdout.write(
    `\nГотово.\n` +
      `  файл: ${geoPath}\n` +
      `  точек: ${ring.length}\n` +
      `  длина: ${lengthKm.toFixed(3)} км\n` +
      `  рамка: ${bbox.join(', ')}\n` +
      `  отпечаток геометрии: ${sha256}\n`,
  );
}

await main();
