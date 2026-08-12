#!/usr/bin/env node
/**
 * Проверка геоданных при выкатке.
 *
 * Выполняется ВНУТРИ закреплённого образа приложения, а не на самом сервере:
 * полагаться на установленный там Node нельзя — его может не быть, а версия
 * может отличаться от той, на которой всё проверялось.
 *
 * Скрипт доставляется на сервер вместе с командой выкатки, поэтому источник
 * правды один — этот файл в репозитории.
 *
 * ИДЕНТИЧНОСТЬ ГРАФА ОПРЕДЕЛЯЕТСЯ СОДЕРЖИМЫМ.
 *
 * Единственный признак того, какой именно дорожный граф установлен, —
 * полный SHA-256 файла `tiles.tar`. Ни время изменения файла, ни поле
 * `tileset_last_modified` из `/status` идентичностью не являются: это
 * метки файловой системы. Они меняются при любом копировании, восстановлении
 * из резервной копии или пересоздании контейнера, оставляя содержимое тем же,
 * — и не меняются, если подменить содержимое, сохранив время. Ни в ту, ни
 * в другую сторону они ничего не доказывают.
 *
 * Режимы:
 *   basemap  — манифест подложки и SHA-256 каждой её файла;
 *   graph    — фактический SHA-256 tiles.tar И valhalla.json, их записи
 *              в манифесте и ожидаемое значение из конфигурации; плюс
 *              бюджет матрицы обоих профилей;
 *   routing  — маршрутизатор ответил, набор загружен, сервис готов;
 *   matrix   — сервис действительно считает: ПРЕДЕЛЬНАЯ матрица на
 *              утверждённом дорожном наборе обоими профилями;
 *   solver   — решатель учитывает время обслуживания по типу машины.
 *
 * Fail closed: любое несовпадение — ненулевой код возврата с понятной причиной.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASEMAP_FORMAT = 'flowers-logistics/basemap-manifest@1';
const GRAPH_FORMAT = 'flowers-logistics/valhalla-manifest@1';

/** Ревизия графа — это SHA-256 и ничто другое: ровно 64 шестнадцатеричных символа. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Предел длины пути артефакта. Тот же, что в приложении. */
const MAX_ARTIFACT_PATH = 200;

/**
 * Допустим ли путь артефакта.
 *
 * Путь приходит из манифеста, который лежит рядом с файлами, и превращается
 * в чтение с диска и в адрес HTTP. Проверка здесь — единственное дешёвое место,
 * где это можно остановить.
 *
 * Внутренние пробелы РАЗРЕШЕНЫ: настоящее имя семейства шрифтов —
 * «Noto Sans Regular», и ломать его ради регулярного выражения неправильно.
 * Разрешение пробела не ослабляет защиту: опасны не пробелы, а выход за корень,
 * и он запрещён отдельно и явно.
 *
 * Одного регулярного выражения мало. `^[^/]+(/[^/]+)*$` пропускает сегменты
 * «.» и «..», из которых и собирается обход каталога. Поэтому путь разбирается
 * посегментно, а результат дополнительно сверяется с realpath корня.
 *
 * Возвращает причину отказа или null, если путь допустим.
 */
export function artifactPathProblem(value) {
  if (typeof value !== 'string' || value === '') {
    return 'пустой путь';
  }
  if (value.length > MAX_ARTIFACT_PATH) {
    return 'слишком длинный путь';
  }
  // Абсолютный путь увёл бы чтение куда угодно мимо корня набора.
  if (value.startsWith('/')) {
    return 'абсолютный путь';
  }
  if (value.includes('\\')) {
    return 'обратный слэш';
  }
  // NUL обрывает имя на уровне системного вызова, управляющие символы
  // не могут быть частью имени файла, который мы сами же и собрали.
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      return 'управляющий символ';
    }
  }
  // Percent-encoding в ИМЕНИ файла: путь уже разобран, и «%2e%2e» здесь —
  // это попытка провести обход мимо посегментной проверки.
  if (value.includes('%')) {
    return 'percent-encoding в имени';
  }

  for (const segment of value.split('/')) {
    if (segment === '') {
      return 'пустой сегмент';
    }
    if (segment === '.' || segment === '..') {
      return `сегмент «${segment}»`;
    }
    if (segment !== segment.trim()) {
      return 'пробел в начале или конце сегмента';
    }
  }

  return null;
}

/**
 * Разрешает путь артефакта внутри корня набора.
 *
 * Посегментной проверки мало: символическая ссылка проходит её целиком,
 * а ведёт наружу. Сравниваются именно realpath, то есть то, что система
 * действительно откроет.
 */
export async function resolveArtifact(root, relative) {
  const problem = artifactPathProblem(relative);
  if (problem !== null) {
    return { ok: false, problem };
  }

  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, problem: 'каталог набора недоступен' };
  }

  const candidate = path.join(rootReal, relative);
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    // Файла нет — это отдельный случай, и путь сам по себе допустим.
    return { ok: true, file: candidate, missing: true };
  }

  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return { ok: false, problem: 'путь выходит за пределы каталога набора' };
  }

  return { ok: true, file: real, missing: false };
}

/**
 * Предел одного расчёта матрицы.
 *
 * Значение повторяет `tools/geo/graph-limits.json` — единственный именованный
 * источник. Повторяет, а не читает: этот файл уезжает на сервер один и целиком,
 * и там рядом с ним нет ни репозитория, ни пакетов. Разойтись копии не дают
 * направленные проверки, которые сверяют её с источником.
 */
const MAX_MATRIX_POINTS = 60;
const MAX_MATRIX_LOCATION_PAIRS = MAX_MATRIX_POINTS * MAX_MATRIX_POINTS;

/** Профили, которыми пользуется приложение. Оба обязаны считаться. */
const PROBE_COSTINGS = ['auto', 'pedestrian'];

/**
 * Утверждённый дорожный набор: те же точки, на которых считает пилот.
 *
 * Прежняя проверка брала две городские координаты и спрашивала, отвечает ли
 * сервис вообще. Этого оказалось мало: первый настоящий пилот получил
 * `400 Exceeded max locations` на 60 точках и внутреннюю ошибку пешеходного
 * профиля на 11 — обе после того, как выкатка объявила маршрутизатор исправным.
 * Поэтому проверяется предельный размер и ровно тот набор, которым потом
 * пользуются.
 *
 * Копия набора из `apps/api/src/modules/planning/road-fixture.ts`. Сверяет
 * их направленная проверка: этот файл обязан оставаться самодостаточным.
 *
 * --- НАЧАЛО ДОРОЖНОГО НАБОРА ---
 */
const ROAD_FIXTURE_POINTS = [
  { latMicro: 55751224, lonMicro: 37618351 },
  { latMicro: 55757476, lonMicro: 37629791 },
  { latMicro: 55757369, lonMicro: 37618725 },
  { latMicro: 55757490, lonMicro: 37607460 },
  { latMicro: 55751142, lonMicro: 37607275 },
  { latMicro: 55745338, lonMicro: 37607594 },
  { latMicro: 55744884, lonMicro: 37618495 },
  { latMicro: 55745056, lonMicro: 37629524 },
  { latMicro: 55745003, lonMicro: 37640796 },
  { latMicro: 55751321, lonMicro: 37640555 },
  { latMicro: 55757766, lonMicro: 37640614 },
  { latMicro: 55764051, lonMicro: 37640924 },
  { latMicro: 55763901, lonMicro: 37629294 },
  { latMicro: 55764069, lonMicro: 37618393 },
  { latMicro: 55763835, lonMicro: 37607645 },
  { latMicro: 55763868, lonMicro: 37596283 },
  { latMicro: 55757623, lonMicro: 37596050 },
  { latMicro: 55751290, lonMicro: 37596094 },
  { latMicro: 55744948, lonMicro: 37596314 },
  { latMicro: 55738596, lonMicro: 37596110 },
  { latMicro: 55738645, lonMicro: 37607309 },
  { latMicro: 55738751, lonMicro: 37618341 },
  { latMicro: 55738675, lonMicro: 37629471 },
  { latMicro: 55738920, lonMicro: 37640828 },
  { latMicro: 55738593, lonMicro: 37651585 },
  { latMicro: 55744969, lonMicro: 37651665 },
  { latMicro: 55751044, lonMicro: 37651577 },
  { latMicro: 55757468, lonMicro: 37651820 },
  { latMicro: 55763878, lonMicro: 37651806 },
  { latMicro: 55770024, lonMicro: 37651629 },
  { latMicro: 55770129, lonMicro: 37640600 },
  { latMicro: 55770110, lonMicro: 37629451 },
  { latMicro: 55770145, lonMicro: 37618280 },
  { latMicro: 55769979, lonMicro: 37606893 },
  { latMicro: 55770069, lonMicro: 37596059 },
  { latMicro: 55770180, lonMicro: 37585151 },
  { latMicro: 55763937, lonMicro: 37585992 },
  { latMicro: 55757529, lonMicro: 37585340 },
  { latMicro: 55751239, lonMicro: 37585301 },
  { latMicro: 55744943, lonMicro: 37585068 },
  { latMicro: 55738749, lonMicro: 37585101 },
  { latMicro: 55732341, lonMicro: 37585157 },
  { latMicro: 55732335, lonMicro: 37596009 },
  { latMicro: 55731771, lonMicro: 37606735 },
  { latMicro: 55732395, lonMicro: 37618389 },
  { latMicro: 55732353, lonMicro: 37629492 },
  { latMicro: 55732270, lonMicro: 37640752 },
  { latMicro: 55732188, lonMicro: 37651255 },
  { latMicro: 55732277, lonMicro: 37662861 },
  { latMicro: 55738632, lonMicro: 37662798 },
  { latMicro: 55744956, lonMicro: 37662818 },
  { latMicro: 55751345, lonMicro: 37662738 },
  { latMicro: 55757632, lonMicro: 37664379 },
  { latMicro: 55763909, lonMicro: 37662755 },
  { latMicro: 55770106, lonMicro: 37663137 },
  { latMicro: 55776452, lonMicro: 37662811 },
  { latMicro: 55776485, lonMicro: 37640804 },
  { latMicro: 55776445, lonMicro: 37629291 },
  { latMicro: 55776454, lonMicro: 37618510 },
  { latMicro: 55776435, lonMicro: 37607270 },
];
/* --- КОНЕЦ ДОРОЖНОГО НАБОРА --- */

/**
 * Минимальный набор, воспроизводивший внутренний отказ пешеходного профиля.
 *
 * На графе 20260806 эти шесть точек давали `500 GetTags: offset exceeds size
 * of text list`, а любая пара из них — нет: отказ проявлялся только на широком
 * поиске. Набор проверяется отдельно от дорожного, потому что дорожный
 * компактен, а этот намеренно разбросан — именно так дефект и всплыл.
 *
 * Копия `tools/geo/foot-regression.json`; расхождение ловит направленная
 * проверка.
 */
const FOOT_REGRESSION_POINTS = [
  { latMicro: 55669440, lonMicro: 37459107 },
  { latMicro: 55731554, lonMicro: 37694973 },
  { latMicro: 55685722, lonMicro: 37543596 },
  { latMicro: 55805223, lonMicro: 37734689 },
  { latMicro: 55771461, lonMicro: 37430783 },
  { latMicro: 55700989, lonMicro: 37523157 },
];

/** Микроградусы набора — в градусы запроса. */
function toDegrees(points) {
  return points.map((point) => ({ lat: point.latMicro / 1e6, lon: point.lonMicro / 1e6 }));
}

function fixturePoints(count) {
  return toDegrees(ROAD_FIXTURE_POINTS.slice(0, count));
}

/**
 * Коды возврата.
 *
 * Различать их обязательно. Вызывающая сторона на основании кода пишет
 * в журнал выкатки либо «артефакты не совпали», либо «проверка не состоялась».
 * Один общий код заставлял бы обвинять артефакты в том, чего они не делали:
 * упавший verifier и упавшая проверка неотличимы от повреждённого файла.
 */
export const EXIT_MISMATCH = 10;
export const EXIT_INTERNAL = 20;
export const EXIT_USAGE = 2;

/** Проверка состоялась и установила несовпадение. */
function fail(message) {
  console.error(`ОТКАЗ: ${message}`);
  process.exit(EXIT_MISMATCH);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function readManifest(root, expectedFormat) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  } catch {
    fail(`манифест не найден или не читается: ${root}/manifest.json`);
  }
  if (manifest.format !== expectedFormat) {
    fail(`манифест другого формата: ${String(manifest.format)}`);
  }
  return manifest;
}

async function verifyBasemap(root) {
  const manifest = await readManifest(root, BASEMAP_FORMAT);

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('манифест подложки не содержит ни одного файла');
  }

  for (const artifact of manifest.artifacts) {
    // Путь проверяется ДО обращения к диску: манифест приходит вместе
    // с файлами, и его запись превращается в чтение и в адрес HTTP.
    const resolved = await resolveArtifact(root, artifact.path);
    if (!resolved.ok) {
      fail(`недопустимый путь в манифесте подложки: ${resolved.problem}`);
    }

    const file = resolved.file;

    let size;
    try {
      size = (await stat(file)).size;
    } catch {
      fail(`файл подложки отсутствует: ${artifact.path}`);
    }

    if (size !== artifact.bytes) {
      fail(`размер файла не совпал: ${artifact.path}`);
    }
    if ((await sha256(file)) !== artifact.sha256) {
      fail(`контрольная сумма не совпала: ${artifact.path}`);
    }
  }

  const styleProblem = artifactPathProblem(manifest.style);
  if (styleProblem !== null) {
    fail(`недопустимый путь стиля в манифесте: ${styleProblem}`);
  }
  if (!manifest.artifacts.some((artifact) => artifact.path === manifest.style)) {
    fail(`файл стиля ${String(manifest.style)} не перечислен в манифесте`);
  }

  console.error(
    `подложка проверена: ${manifest.artifacts.length} файлов, ревизия ${manifest.revision}`,
  );
}

/**
 * Проверяет содержимое дорожного графа.
 *
 * Сходятся три независимых значения: ожидаемое из конфигурации, записанное
 * в манифесте и вычисленное прямо сейчас по лежащему на сервере файлу.
 * Совпадение всех трёх — единственное доказательство того, что установлен
 * именно тот граф. Размер сверяется тоже, но сам по себе он не доказывает
 * ничего: файл может совпасть по длине и отличаться внутри.
 */
async function verifyGraph(root, expectedSha) {
  if (typeof expectedSha !== 'string' || !SHA256_PATTERN.test(expectedSha)) {
    // Пустое или неверно записанное ожидание — это не «проверять нечего»,
    // а неисправная конфигурация: сравнение прошло бы с чем угодно.
    fail('ожидаемая ревизия графа задана неверно: нужен SHA-256 из 64 шестнадцатеричных символов');
  }

  const manifest = await readManifest(root, GRAPH_FORMAT);

  const extract = manifest.extract;
  if (extract === undefined || extract === null || typeof extract.path !== 'string') {
    fail('манифест графа не описывает набор тайлов');
  }

  const declared = extract.sha256;
  if (typeof declared !== 'string' || !SHA256_PATTERN.test(declared)) {
    fail('манифест графа не содержит корректного SHA-256 набора тайлов');
  }

  if (declared !== expectedSha) {
    fail(`ревизия графа в манифесте «${declared}» не совпадает с конфигурацией «${expectedSha}»`);
  }

  const file = path.join(root, extract.path);
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    fail(`набор тайлов отсутствует: ${extract.path}`);
  }

  if (typeof extract.bytes === 'number' && size !== extract.bytes) {
    fail(`размер набора тайлов не совпал: ${extract.path}`);
  }

  // Пересчёт по фактическому файлу. Именно он отличает «манифест утверждает»
  // от «на сервере действительно лежит».
  const actual = await sha256(file);
  if (actual !== declared) {
    fail(`содержимое набора тайлов не совпало с манифестом: ${extract.path}`);
  }

  await verifyGraphConfig(root, manifest);

  console.error(`граф проверен по содержимому: ${extract.path}, SHA-256 ${actual}`);
}

/**
 * Проверяет конфигурацию графа как полноправный артефакт набора.
 *
 * Прежде манифест защищал только `tiles.tar`. Это означало неизменяемое
 * содержимое при подменяемых пределах: тот же набор тайлов с уменьшенным
 * `max_matrix_location_pairs` отвергал бы рабочий день целиком, и ни одна
 * проверка выкатки этого бы не заметила.
 *
 * Поле обязательно. Набор без него собран прежним pipeline и в этой проверке
 * не проходит: «старый формат» здесь означал бы ровно ту дыру, ради которой
 * поле и добавлено.
 */
async function verifyGraphConfig(root, manifest) {
  const config = manifest.config;
  if (config === undefined || config === null || typeof config.path !== 'string') {
    fail('манифест графа не описывает конфигурацию valhalla.json');
  }

  const declared = config.sha256;
  if (typeof declared !== 'string' || !SHA256_PATTERN.test(declared)) {
    fail('манифест графа не содержит корректного SHA-256 конфигурации');
  }

  // Путь приходит из манифеста и превращается в чтение с диска — та же
  // проверка, что и для файлов подложки.
  const resolved = await resolveArtifact(root, config.path);
  if (!resolved.ok) {
    fail(`недопустимый путь конфигурации в манифесте графа: ${resolved.problem}`);
  }
  if (resolved.missing) {
    fail(`конфигурация графа отсутствует: ${config.path}`);
  }

  const size = (await stat(resolved.file)).size;
  if (typeof config.bytes === 'number' && size !== config.bytes) {
    fail(`размер конфигурации графа не совпал: ${config.path}`);
  }

  const actual = await sha256(resolved.file);
  if (actual !== declared) {
    fail(`содержимое конфигурации графа не совпало с манифестом: ${config.path}`);
  }

  // Файл сверен по содержимому — только теперь его значениям можно верить.
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved.file, 'utf8'));
  } catch {
    fail(`конфигурация графа не разбирается: ${config.path}`);
  }

  const limits = parsed?.service_limits;
  if (limits === undefined || limits === null || typeof limits !== 'object') {
    fail('конфигурация графа не содержит service_limits');
  }

  for (const profile of PROBE_COSTINGS) {
    const budget = limits[profile]?.max_matrix_location_pairs;
    if (typeof budget !== 'number' || budget < MAX_MATRIX_LOCATION_PAIRS) {
      fail(
        `бюджет матрицы профиля «${profile}» равен ${String(budget)}, ` +
          `а расчёту на ${MAX_MATRIX_POINTS} точках нужно не меньше ${MAX_MATRIX_LOCATION_PAIRS}`,
      );
    }
  }

  console.error(
    `конфигурация графа проверена: ${config.path}, бюджет обоих профилей >= ${MAX_MATRIX_LOCATION_PAIRS}`,
  );
}

async function fetchStatus(url) {
  let response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/status`, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail('маршрутизатор не ответил');
  }

  if (!response.ok) {
    fail(`маршрутизатор ответил кодом ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    fail('ответ маршрутизатора не разобран');
  }
}

/**
 * Спрашивает сам маршрутизатор, загрузил ли он набор.
 *
 * Содержимое графа проверено отдельно и раньше — здесь выясняется только то,
 * чего файл на диске не говорит: сервис поднялся, набор прочитан, работать
 * можно. `tileset_last_modified` используется как признак загруженности
 * и записывается в журнал как диагностика. Сравнивать его с ревизией
 * ЗАПРЕЩЕНО: это время файла, а не идентичность содержимого.
 */
async function verifyRouting(url) {
  const body = await fetchStatus(url);

  const version = body.version;
  if (typeof version !== 'string' || version.trim() === '') {
    fail('маршрутизатор не сообщил свою версию');
  }

  const loaded = body.tileset_last_modified;
  if (loaded === undefined || loaded === null || String(loaded).trim() === '') {
    // Набор не загружен. Считать в таком состоянии нельзя — и это отказ
    // готовности, а не отсутствие необязательной диагностики.
    fail('маршрутизатор не сообщил, что набор тайлов загружен');
  }

  // Поле появляется не во всех сборках сервиса. Если оно есть, оно обязано
  // быть истинным: явное «тайлов нет» — прямой отказ.
  if (body.has_tiles !== undefined && body.has_tiles !== true) {
    fail('маршрутизатор сообщил, что набор тайлов недоступен');
  }

  console.error(
    `маршрутизатор готов: версия ${version}, метка набора ${String(loaded)} (диагностика)`,
  );
}

/**
 * Проверяет, что маршрутизатор действительно считает рабочий день целиком.
 *
 * Загруженный набор ещё не означает работоспособный расчёт: тайлы могут быть
 * прочитаны, нужного профиля в них не оказаться, а бюджет пар — не хватить.
 * Прежняя проверка спрашивала матрицу на двух точках и отвечала «сервис жив».
 * Первый настоящий пилот прошёл её и тут же получил отказ на 60 точках и
 * внутреннюю ошибку пешеходного профиля на 11.
 *
 * Поэтому здесь считается ПРЕДЕЛЬНАЯ матрица на утверждённом дорожном наборе
 * обоими профилями. Пустой элемент, 4xx и 5xx — отказ выкатки до миграций
 * и до запуска нового приложения.
 */
async function verifyMatrix(url) {
  const base = url.replace(/\/+$/, '');
  const points = fixturePoints(MAX_MATRIX_POINTS);

  if (points.length !== MAX_MATRIX_POINTS) {
    fail(
      `дорожный набор содержит ${points.length} точек вместо ${MAX_MATRIX_POINTS}: ` +
        'проверка предельного размера невозможна',
    );
  }

  for (const costing of PROBE_COSTINGS) {
    await requireSquareMatrix(base, points, costing, 'предельный расчёт');
  }

  // Известный дефект проверяется отдельно и явно. Компактный дорожный набор
  // его не ловит: отказ проявлялся на разбросанных точках и широком поиске.
  await requireSquareMatrix(
    base,
    toDegrees(FOOT_REGRESSION_POINTS),
    'pedestrian',
    'регрессия пешеходного профиля',
  );
}

/**
 * Считает квадратную матрицу и требует, чтобы она была полной.
 *
 * Fail closed по всем трём исходам: сервис не ответил, ответил не 2xx, ответил
 * матрицей с пустыми элементами. Каждый из них однажды уже случился на
 * настоящем графе, и каждый обязан остановить выкатку до миграций.
 */
async function requireSquareMatrix(base, points, costing, label) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${base}/sources_to_targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sources: points, targets: points, costing, units: 'km' }),
      // Предельная матрица считается дольше пробной пары, особенно пешком.
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    fail(`${label} «${costing}» не выполнен: сервис не ответил`);
  }

  if (!response.ok) {
    fail(`${label} «${costing}» отклонён кодом ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    fail(`ответ «${label} ${costing}» не разобран`);
  }

  const rows = body.sources_to_targets;
  if (!Array.isArray(rows)) {
    fail(`ответ «${label} ${costing}» не содержит матрицы`);
  }

  const elements = rows.flat();
  const expected = points.length * points.length;
  if (elements.length !== expected) {
    fail(`${label} «${costing}» вернул ${elements.length} элементов вместо ${expected}`);
  }

  // Ни одного пустого элемента. Недостижимая пара в утверждённом наборе
  // означает, что либо граф не тот, либо набор перестал лежать на дорогах,
  // — и то и другое обязано остановить выкатку, а не всплыть в пилоте.
  const empty = elements.filter(
    (element) =>
      element === null || typeof element !== 'object' || typeof element.time !== 'number',
  ).length;
  if (empty > 0) {
    fail(`${label} «${costing}»: ${empty} недостижимых элементов из ${expected}`);
  }

  console.error(
    `${label} «${costing}» выполнен: ${elements.length} элементов за ${Date.now() - started} мс, пустых нет`,
  );
}

/** Время обслуживания пробной задачи решателя. Любое ненулевое подходит. */
const SOLVER_PROBE_SERVICE = 600;

/**
 * Проверяет решатель — и не версию из настройки, а его фактическую возможность.
 *
 * Разное время обслуживания по типам транспорта появилось в VROOM 1.15.0.
 * Решатель более старой версии неизвестный ключ просто проигнорирует и вернёт
 * правдоподобный план с НУЛЕВЫМ временем обслуживания. Такой план выглядит
 * выполнимым и таковым не является, поэтому проверяется поведение, а не
 * объявленный номер.
 *
 * Пробная задача не содержит ни координат, ни описаний — ровно как рабочие
 * запросы: решатель работает по индексам и готовым матрицам.
 */
async function verifySolver(url) {
  const base = url.replace(/\/+$/, '');

  const problem = {
    jobs: [
      {
        id: 1,
        location_index: 1,
        service: 0,
        service_per_type: { PROBE: SOLVER_PROBE_SERVICE },
        delivery: [1],
      },
    ],
    vehicles: [
      {
        id: 1,
        profile: 'car',
        type: 'PROBE',
        start_index: 0,
        end_index: 0,
        capacity: [1],
        time_window: [0, 86400],
      },
    ],
    matrices: {
      car: {
        durations: [
          [0, 10],
          [10, 0],
        ],
        distances: [
          [0, 10],
          [10, 0],
        ],
      },
    },
  };

  let response;
  try {
    response = await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(problem),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail('решатель не ответил на пробную задачу');
  }

  if (!response.ok) {
    fail(`решатель отклонил пробную задачу кодом ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    fail('ответ решателя на пробную задачу не разобран');
  }

  if (body.code !== 0) {
    fail(`решатель вернул код ${body.code} вместо нуля`);
  }

  const unassigned = Array.isArray(body.unassigned) ? body.unassigned.length : 0;
  if (unassigned !== 0) {
    fail('решатель не разместил заказ заведомо решаемой пробной задачи');
  }

  const service = body.summary?.service ?? 0;
  if (service !== SOLVER_PROBE_SERVICE) {
    fail(
      `решатель не учитывает время обслуживания по типу машины: ${service} вместо ${SOLVER_PROBE_SERVICE}. ` +
        'Нужна версия VROOM не ниже 1.15.0',
    );
  }

  console.error('решатель подтверждён: время обслуживания по типу машины учитывается');
}

/**
 * Разбор аргументов и запуск.
 *
 * Вынесен в функцию и вызывается только при прямом запуске: иначе модуль
 * нельзя импортировать, а общий корпус контрактных проверок обязан прогонять
 * ОДИН список путей и через этот код, и через приложение.
 */
async function main() {
  const [mode, first, second] = process.argv.slice(2);

  try {
    switch (mode) {
      case 'basemap':
        await verifyBasemap(first);
        break;
      case 'graph':
        await verifyGraph(first, second);
        break;
      case 'routing':
        await verifyRouting(first);
        break;
      case 'matrix':
        await verifyMatrix(first);
        break;
      case 'solver':
        await verifySolver(first);
        break;
      default:
        console.error(
          'Использование: verify-geo.mjs basemap <путь> | graph <путь> <sha256> | routing <url> | matrix <url> | solver <url>',
        );
        process.exit(EXIT_USAGE);
    }
  } catch (error) {
    // Сюда попадает только то, чего проверка не предусмотрела: испорченная
    // структура манифеста, ошибка чтения, дефект самого скрипта. Это НЕ вывод
    // о несовпадении артефактов, и код возврата обязан отличаться — иначе
    // выкатка объявила бы файлы повреждёнными, ничего о них не установив.
    console.error(
      `ВНУТРЕННЯЯ ОШИБКА ПРОВЕРКИ: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(EXIT_INTERNAL);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
