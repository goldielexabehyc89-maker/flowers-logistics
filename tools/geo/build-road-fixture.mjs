#!/usr/bin/env node
/**
 * Дорожный набор пилота: 60 синтетических точек, лежащих на дорожной сети.
 *
 * ЗАЧЕМ ОН ПОЯВИЛСЯ.
 *
 * Пилот раньше брал координаты равномерно случайно из прямоугольника вокруг
 * Москвы. Такой набор регулярно попадает в парки, в воду и в изолированные
 * куски сети: первый настоящий прогон дал 20 недостижимых пар на 11 точках
 * и 60 на 31. Ворота сработали правильно, но измеряли они генератор, а не
 * маршрутизацию.
 *
 * ЧТО ЭТОТ СКРИПТ ДЕЛАЕТ.
 *
 * Берёт детерминированную решётку координат вокруг общеизвестной городской
 * точки, «примагничивает» каждую к дорожной сети через `/locate` ОБОИМИ
 * профилями и оставляет только те, которые оба профиля признали дорогой.
 * Затем считает полную матрицу на отобранных точках и требует, чтобы ни один
 * из направленных элементов не оказался пустым.
 *
 * ПОЧЕМУ ЭТО НЕ ПЕРСОНАЛЬНЫЕ ДАННЫЕ.
 *
 * Координаты не приходят ни из заказов, ни из адресов, ни из базы, ни из
 * МоегоСклада. Они вычисляются из решётки и из ответа маршрутизатора о том,
 * где проходит дорога. Ни адреса, ни названия, ни подписи в набор не попадают.
 *
 *   node tools/geo/build-road-fixture.mjs --url http://127.0.0.1:8002 \
 *     --out apps/api/src/modules/planning/road-fixture.ts
 */

import { readFile, writeFile } from 'node:fs/promises';

/** Общеизвестный городской центр. Используется как начало решётки, не как адрес. */
const ORIGIN = { lat: 55.751244, lon: 37.618423 };

/** Шаг решётки в градусах: примерно 700 м по широте. */
const STEP_LAT = 0.0063;
const STEP_LON = 0.0111;

/** Профили, которыми пользуется приложение. Точка обязана подойти обоим. */
const PROFILES = ['auto', 'pedestrian'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key !== undefined && value !== undefined) args[key] = value;
  }
  return args;
}

/**
 * Детерминированная спираль вокруг начала координат.
 *
 * Спираль, а не случайные точки: порядок обхода фиксирован, поэтому один и тот
 * же граф всегда даёт один и тот же набор, а префиксы 11 и 31 остаются
 * компактными и осмысленными как «часть того же дня».
 */
function* spiral(limit) {
  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;
  for (let i = 0; i < limit; i += 1) {
    yield { lat: ORIGIN.lat + y * STEP_LAT, lon: ORIGIN.lon + x * STEP_LON };
    if (x === y || (x < 0 && x === -y) || (x > 0 && x === 1 - y)) {
      [dx, dy] = [-dy, dx];
    }
    x += dx;
    y += dy;
  }
}

async function post(base, path, body) {
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    throw new Error(`${path} ответил кодом ${response.status}`);
  }
  return response.json();
}

/**
 * Примагничивает точку к дорожной сети.
 *
 * Берётся именно координата ребра, а не исходной точки: иначе набор снова
 * оказался бы «рядом с дорогой», а маршрутизатор искал бы вход в сеть сам
 * и на каждой сборке графа мог бы найти другой.
 */
async function snap(base, point, costing) {
  const body = await post(base, '/locate', {
    locations: [point],
    costing,
    verbose: false,
  });
  const edges = body?.[0]?.edges;
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const lat = edges[0]?.correlated_lat;
  const lon = edges[0]?.correlated_lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return { lat, lon };
}

/** Микроградусы: та же единица, в которой точки живут в снимке планирования. */
function micro(value) {
  return Math.round(value * 1e6);
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.url ?? 'http://127.0.0.1:8002';
  const target = Number.parseInt(args.count ?? '60', 10);
  const scan = Number.parseInt(args.scan ?? '900', 10);
  const reserve = Number.parseInt(args.reserve ?? '40', 10);

  // Запас нужен, потому что примагничивание доказывает только «точка лежит
  // на дороге». Оно не доказывает, что из этой дороги можно выехать: точка
  // может оказаться на служебном проезде, на односторонней петле или в куске
  // сети, отрезанном от остального города. Такие точки отсеивает уже матрица,
  // и на их место берутся следующие из запаса.
  const pool = [];
  const seen = new Set();

  for (const candidate of spiral(scan)) {
    if (pool.length >= target + reserve) break;

    // Точка принимается, только если ОБА профиля нашли для неё дорогу.
    // Координата берётся автомобильная: пешеход почти всегда доходит
    // до проезжей улицы, обратное неверно.
    const driving = await snap(base, candidate, 'auto');
    if (driving === null) continue;
    if ((await snap(base, candidate, 'pedestrian')) === null) continue;

    const key = `${micro(driving.lat)}:${micro(driving.lon)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(driving);
  }

  if (pool.length < target) {
    console.error(`найдено только ${pool.length} дорожных точек из ${target}`);
    process.exit(1);
  }

  /**
   * Считает, сколько пустых элементов приходится на каждую точку.
   *
   * Помечать обе стороны каждой пустой пары нельзя: одна отрезанная точка даёт
   * целую пустую строку, и по такому признаку «виноватыми» оказываются все
   * остальные. Виновата та точка, у которой пустых много: у отрезанной их
   * порядка двух длин набора, у обычной — ровно столько, сколько отрезанных
   * точек в наборе.
   */
  async function emptyPerPoint(points, costing) {
    const body = await post(base, '/sources_to_targets', {
      sources: points,
      targets: points,
      costing,
      units: 'km',
    });
    const rows = body.sources_to_targets;
    if (!Array.isArray(rows)) throw new Error(`матрица «${costing}» не получена`);
    const elements = rows.flat();
    if (elements.length !== points.length * points.length) {
      throw new Error(`матрица «${costing}» неполная: ${elements.length}`);
    }
    const counts = new Array(points.length).fill(0);
    let total = 0;
    for (let from = 0; from < points.length; from += 1) {
      for (let to = 0; to < points.length; to += 1) {
        const element = elements[from * points.length + to];
        if (element === null || typeof element?.time !== 'number') {
          counts[from] += 1;
          counts[to] += 1;
          total += 1;
        }
      }
    }
    return { counts, total };
  }

  let chosen = pool.slice(0, target);
  let spare = pool.slice(target);

  for (let round = 1; ; round += 1) {
    const counts = new Array(chosen.length).fill(0);
    let total = 0;
    for (const costing of PROFILES) {
      const result = await emptyPerPoint(chosen, costing);
      result.counts.forEach((value, index) => {
        counts[index] += value;
      });
      total += result.total;
    }

    if (total === 0) {
      console.error(`набор сошёлся за ${round} раунд(ов): все ${target} точек взаимно достижимы`);
      break;
    }

    // Отрезанная точка набирает порядка двух длин набора, обычная — единицы.
    // Половина длины разделяет эти два случая с большим запасом.
    const threshold = Math.max(2, Math.floor(chosen.length / 2));
    const bad = counts.flatMap((value, index) => (value >= threshold ? [index] : []));
    if (bad.length === 0) {
      console.error(`осталось ${total} пустых элементов, но ни одна точка не выделяется`);
      process.exit(1);
    }
    if (spare.length < bad.length) {
      console.error(`запаса не хватило: отсеяно ${bad.length}, в запасе ${spare.length}`);
      process.exit(1);
    }

    console.error(`раунд ${round}: пустых ${total}, отсеяно ${bad.length} точек, берём замену`);
    const drop = new Set(bad);
    chosen = chosen.filter((_, index) => !drop.has(index)).concat(spare.slice(0, bad.length));
    spare = spare.slice(bad.length);
  }

  for (const costing of PROFILES) {
    console.error(`матрица «${costing}» полная: ${target * target} элементов, пустых нет`);
  }

  const rows = chosen
    .map((point) => `  { latMicro: ${micro(point.lat)}, lonMicro: ${micro(point.lon)} },`)
    .join('\n');

  const source = `/**
 * Дорожный набор пилота: ${target} синтетических точек на дорожной сети.
 *
 * ФАЙЛ СГЕНЕРИРОВАН. Источник — \`tools/geo/build-road-fixture.mjs\`, который
 * примагничивает детерминированную решётку к дорогам собранного графа обоими
 * профилями и требует полной матрицы без единого пустого элемента.
 *
 * Координаты не получены из заказов, адресов, базы staging или МоегоСклада:
 * они вычислены из решётки вокруг общеизвестной городской точки и уточнены
 * ответом маршрутизатора о том, где проходит дорога. Подписей, названий
 * и адресов здесь нет.
 *
 * Нулевая точка — склад: маршрут начинается и заканчивается на ней. Префиксы
 * набора дают размеры 11, 31 и ${target}, поэтому одна и та же fixture служит
 * и генератору дня, и предельной проверке при выкатке.
 */

export interface RoadFixturePoint {
  readonly latMicro: number;
  readonly lonMicro: number;
}

export const ROAD_FIXTURE_POINTS: readonly RoadFixturePoint[] = [
${rows}
];
`;

  if (args.out === undefined) {
    process.stdout.write(source);
  } else {
    await writeFile(args.out, source, 'utf8');
    console.error(`записано ${chosen.length} точек: ${args.out}`);
  }

  // Вторая форма набора — внутри самодостаточного deploy verifier.
  //
  // Verifier уезжает на сервер одним файлом: рядом с ним нет ни репозитория,
  // ни пакетов, поэтому импортировать первую форму он не может. Копия
  // записывается тем же прогоном, а разойтись ей потом не даёт направленная
  // проверка, сверяющая обе формы по координатам.
  if (args.verifier !== undefined) {
    const START = ' * --- НАЧАЛО ДОРОЖНОГО НАБОРА ---';
    const END = '/* --- КОНЕЦ ДОРОЖНОГО НАБОРА --- */';
    const text = await readFile(args.verifier, 'utf8');
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    if (from < 0 || to < 0) {
      console.error(`в ${args.verifier} не найдены границы дорожного набора`);
      process.exit(1);
    }
    const block = chosen
      .map((point) => `  { latMicro: ${micro(point.lat)}, lonMicro: ${micro(point.lon)} },`)
      .join('\n');
    const replaced = `${text.slice(0, from)}${START}
 */
const ROAD_FIXTURE_POINTS = [
${block}
];
${END}${text.slice(to + END.length)}`;
    await writeFile(args.verifier, replaced, 'utf8');
    console.error(`вторая форма набора обновлена: ${args.verifier}`);
  }
}

await main();
