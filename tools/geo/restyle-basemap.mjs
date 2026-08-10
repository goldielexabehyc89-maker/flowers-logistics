#!/usr/bin/env node
/**
 * Обновление стиля у собранного набора.
 *
 * Стиль — это 900 байт рядом с гигабайтом тайлов. Менять оформление карты
 * пересборкой всего набора значило бы платить сутками сборки и часами передачи
 * за правку цвета или добавление подписи.
 *
 * Тайлы, спрайты, шрифты и лицензии не трогаются вовсе: пересчитывается только
 * стиль и его запись в манифесте.
 *
 * Новый стиль получает НОВОЕ ИМЯ. Имена артефактов не переиспользуются:
 * они отдаются с бессрочным кэшированием, и подмена содержимого под тем же
 * именем оставила бы у части браузеров старый стиль на год. Прежний файл
 * удаляется из набора и из манифеста — он больше никому не адресуется.
 *
 * Сетевых обращений нет.
 */

import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStyle } from './style.mjs';

const MANIFEST_FORMAT = 'flowers-logistics/basemap-manifest@1';

/** Имя стиля: ревизия набора и номер редакции стиля. */
const STYLE_NAME = /^style-([A-Za-z0-9._-]+?)(?:-r(\d+))?\.json$/;

function fail(message) {
  console.error(`ОТКАЗ: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key !== undefined && value !== undefined) {
      args[key] = value;
    }
  }
  return args;
}

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

/**
 * Следующее имя стиля.
 *
 * `style-20260806.json` → `style-20260806-r2.json` → `style-20260806-r3.json`.
 * Ревизия самого набора не меняется: тайлы те же, и переименовывать гигабайт
 * ради подписи не нужно.
 */
export function nextStyleName(current) {
  const match = STYLE_NAME.exec(current);
  if (match === null) {
    return null;
  }
  const revision = match[1];
  const edition = match[2] === undefined ? 1 : Number(match[2]);
  return `style-${revision}-r${edition + 1}.json`;
}

/**
 * Разбор аргументов и работа.
 *
 * Вынесены в функцию и вызываются только при прямом запуске: иначе модуль
 * нельзя импортировать в проверках, а `nextStyleName` проверять надо.
 */
async function main() {
  const args = parseArgs(process.argv);
  const root = args.set;

  if (root === undefined) {
    console.error('Использование: restyle-basemap.mjs --set <каталог набора>');
    process.exit(2);
  }

  const manifestPath = path.join(root, 'manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    fail(`манифест не найден или не читается: ${manifestPath}`);
  }

  if (manifest.format !== MANIFEST_FORMAT) {
    fail(`манифест другого формата: ${String(manifest.format)}`);
  }

  const currentStyle = manifest.style;
  if (typeof currentStyle !== 'string') {
    fail('манифест не указывает файл стиля');
  }

  const tiles = manifest.artifacts.find((artifact) => artifact.path.endsWith('.pmtiles'));
  if (tiles === undefined) {
    fail('в наборе нет архива тайлов');
  }

  const nextName = nextStyleName(currentStyle);
  if (nextName === null) {
    fail(`имя стиля «${currentStyle}» не разобрано`);
  }

  // Контрольная сумма архива до и после: инструмент обязан доказать, что тайлов
  // он не касался. Это гигабайт, восстановить который стоит часов передачи.
  const tilesPath = path.join(root, tiles.path);
  const tilesBefore = await sha256(tilesPath);
  if (tilesBefore !== tiles.sha256) {
    fail(`архив тайлов уже не совпадает с манифестом: ${tiles.path}`);
  }

  const style = buildStyle({ tilesName: tiles.path, attribution: manifest.attribution });
  const styleBytes = Buffer.from(`${JSON.stringify(style, null, 2)}\n`, 'utf8');

  const nextPath = path.join(root, nextName);
  try {
    await stat(nextPath);
    fail(`файл ${nextName} уже существует: набор трогать не будем`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await writeFile(nextPath, styleBytes);

  manifest.style = nextName;
  manifest.artifacts = [
    ...manifest.artifacts.filter((artifact) => artifact.path !== currentStyle),
    {
      path: nextName,
      bytes: styleBytes.length,
      sha256: createHash('sha256').update(styleBytes).digest('hex'),
      contentType: 'application/json',
    },
  ].sort((left, right) => left.path.localeCompare(right.path));

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rm(path.join(root, currentStyle), { force: true });

  const tilesAfter = await sha256(tilesPath);
  if (tilesAfter !== tilesBefore) {
    fail('архив тайлов изменился: этого не должно было произойти');
  }

  console.error(`стиль обновлён: ${currentStyle} → ${nextName}`);
  console.error(`архив тайлов не тронут: ${tilesAfter}`);
  console.error(`передать на сервер: ${nextName} и manifest.json`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
