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
 * Три режима:
 *   basemap  — манифест подложки и SHA-256 каждого её файла;
 *   graph    — манифест графа, SHA-256 tiles.tar и заявленная ревизия;
 *   routing  — фактический ответ /status маршрутизатора и совпадение ревизии.
 *
 * Fail closed: любое несовпадение — ненулевой код возврата с понятной причиной.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BASEMAP_FORMAT = 'flowers-logistics/basemap-manifest@1';
const GRAPH_FORMAT = 'flowers-logistics/valhalla-manifest@1';

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

async function verifyGraph(root, expectedRevision) {
  const manifest = await readManifest(root, GRAPH_FORMAT);

  if (String(manifest.revision) !== String(expectedRevision)) {
    fail(
      `ревизия графа в манифесте «${String(manifest.revision)}» не совпадает с конфигурацией «${expectedRevision}»`,
    );
  }

  const extract = manifest.extract;
  if (extract === undefined || typeof extract.path !== 'string') {
    fail('манифест графа не описывает набор тайлов');
  }

  const file = path.join(root, extract.path);
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    fail(`набор тайлов отсутствует: ${extract.path}`);
  }

  if (size !== extract.bytes) {
    fail(`размер набора тайлов не совпал: ${extract.path}`);
  }
  if ((await sha256(file)) !== extract.sha256) {
    fail(`контрольная сумма набора тайлов не совпала: ${extract.path}`);
  }

  console.error(`граф проверен: ревизия ${manifest.revision}`);
}

/**
 * Спрашивает сам маршрутизатор.
 *
 * Манифест говорит, что мы собрали; `/status` — что сервис действительно
 * загрузил. Совпасть обязаны оба: иначе выкатка объявит успех при работающем
 * приложении и неработающем расчёте.
 */
async function verifyRouting(url, expectedRevision) {
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

  let body;
  try {
    body = await response.json();
  } catch {
    fail('ответ маршрутизатора не разобран');
  }

  const actual = body.tileset_last_modified;
  if (actual === undefined || actual === null) {
    fail('маршрутизатор не сообщил ревизию набора тайлов');
  }

  if (String(actual) !== String(expectedRevision)) {
    fail(`маршрутизатор работает на графе «${String(actual)}», ожидался «${expectedRevision}»`);
  }

  console.error(
    `маршрутизатор проверен: версия ${String(body.version)}, ревизия ${String(actual)}`,
  );
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
    await verifyRouting(first, second);
    break;
  default:
    console.error('Использование: verify-geo.mjs basemap|graph|routing <путь|url> [ревизия]');
    process.exit(2);
}
