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
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BASEMAP_FORMAT = 'flowers-logistics/basemap-manifest@1';
const GRAPH_FORMAT = 'flowers-logistics/valhalla-manifest@1';

/** Ревизия графа — это SHA-256 и ничто другое: ровно 64 шестнадцатеричных символа. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function fail(message) {
  console.error(`ОТКАЗ: ${message}`);
  process.exit(1);
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
    const file = path.join(root, artifact.path);

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

const [mode, first, second] = process.argv.slice(2);

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
    process.exit(2);
}
