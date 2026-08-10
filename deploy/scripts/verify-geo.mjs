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
 * Четыре режима:
 *   basemap  — манифест подложки и SHA-256 каждой её файла;
 *   graph    — фактический SHA-256 tiles.tar, его запись в манифесте
 *              и ожидаемое значение из конфигурации; все три обязаны совпасть;
 *   routing  — маршрутизатор ответил, набор загружен, сервис готов;
 *   matrix   — сервис действительно считает: маленькая матрица на
 *              синтетических точках обоими профилями.
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
 * Синтетические точки для пробного расчёта.
 *
 * Общеизвестные городские координаты в пределах собираемого региона. Ни адресов
 * заказов, ни персональных данных здесь быть не может: проверка выполняется
 * при каждой выкатке и её аргументы попадают в журналы.
 */
const PROBE_POINTS = [
  { lat: 55.751244, lon: 37.618423 },
  { lat: 55.76024, lon: 37.61871 },
];

/** Профили, которыми пользуется приложение. Оба обязаны считаться. */
const PROBE_COSTINGS = ['auto', 'pedestrian'];

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

  console.error(`граф проверен по содержимому: ${extract.path}, SHA-256 ${actual}`);
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
 * Проверяет, что маршрутизатор действительно считает.
 *
 * Загруженный набор ещё не означает работоспособный расчёт: тайлы могут быть
 * прочитаны, а нужного профиля в них не оказаться. Матрица на двух известных
 * точках стоит доли секунды и отвечает на вопрос, ради которого весь стек
 * и существует.
 */
async function verifyMatrix(url) {
  const base = url.replace(/\/+$/, '');

  for (const costing of PROBE_COSTINGS) {
    let response;
    try {
      response = await fetch(`${base}/sources_to_targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sources: PROBE_POINTS,
          targets: PROBE_POINTS,
          costing,
          units: 'km',
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      fail(`пробный расчёт «${costing}» не выполнен: сервис не ответил`);
    }

    if (!response.ok) {
      fail(`пробный расчёт «${costing}» отклонён кодом ${response.status}`);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      fail(`ответ пробного расчёта «${costing}» не разобран`);
    }

    const rows = body.sources_to_targets;
    if (!Array.isArray(rows)) {
      fail(`ответ пробного расчёта «${costing}» не содержит матрицы`);
    }

    const elements = rows.flat();
    const expected = PROBE_POINTS.length * PROBE_POINTS.length;
    if (elements.length !== expected) {
      fail(`пробный расчёт «${costing}» вернул ${elements.length} элементов вместо ${expected}`);
    }

    // Хотя бы одна пара разных точек обязана быть достижимой. Матрица, целиком
    // состоящая из недостижимостей, означает, что дороги для профиля не нашлось.
    const reachable = elements.some(
      (element) =>
        element !== null &&
        typeof element === 'object' &&
        element.from_index !== element.to_index &&
        typeof element.time === 'number',
    );
    if (!reachable) {
      fail(`пробный расчёт «${costing}» не нашёл ни одного пути между точками`);
    }

    console.error(`пробный расчёт «${costing}» выполнен: ${elements.length} элементов`);
  }
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
      default:
        console.error(
          'Использование: verify-geo.mjs basemap <путь> | graph <путь> <sha256> | routing <url> | matrix <url>',
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
