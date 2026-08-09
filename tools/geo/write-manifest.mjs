#!/usr/bin/env node
/**
 * Составляет манифест набора картографических артефактов.
 *
 * Манифест — единственный способ приложения убедиться, что смонтированные файлы
 * именно те, которые собирали. Он перечисляет каждый файл с размером и SHA-256,
 * а также регион, границы, дату исходных данных, версии инструментов и сумму
 * входного `.osm.pbf`: по ним сборку можно повторить и сверить результат.
 *
 * Скрипт не обращается в сеть и ничего не скачивает.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_FORMAT = 'flowers-logistics/basemap-manifest@1';

/** Тип содержимого по расширению. Список закрытый: чужой тип не подставляется. */
const CONTENT_TYPES = new Map([
  ['.pmtiles', 'application/octet-stream'],
  ['.json', 'application/json'],
  ['.pbf', 'application/x-protobuf'],
  ['.png', 'image/png'],
]);

function parseArgs(argv) {
  const args = { tool: [] };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined || value === undefined) {
      continue;
    }
    if (key === 'tool') {
      args.tool.push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Обходит каталог, пропуская сам манифест. */
async function collect(root, current = '') {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = current === '' ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collect(root, relative)));
      continue;
    }
    if (relative === 'manifest.json') {
      continue;
    }
    files.push(relative);
  }

  return files;
}

const args = parseArgs(process.argv);
const required = ['root', 'revision', 'region', 'source-date', 'source-file', 'style'];
for (const key of required) {
  if (args[key] === undefined) {
    console.error(`Не задан --${key}`);
    process.exit(2);
  }
}

const root = args.root;
const files = await collect(root);

const artifacts = [];
for (const relative of files) {
  const filePath = path.join(root, relative);
  const info = await stat(filePath);
  const extension = path.extname(relative).toLowerCase();
  const contentType = CONTENT_TYPES.get(extension);

  if (contentType === undefined) {
    // Незнакомый файл в наборе — повод остановиться, а не гадать о его типе:
    // приложение отдаёт наружу только то, что перечислено здесь.
    console.error(`Неизвестный тип файла в наборе: ${relative}`);
    process.exit(1);
  }

  artifacts.push({
    path: relative,
    bytes: info.size,
    sha256: await sha256(filePath),
    contentType,
  });
}

if (!artifacts.some((artifact) => artifact.path === args.style)) {
  console.error(`Файл стиля ${args.style} отсутствует в наборе`);
  process.exit(1);
}

const tools = {};
for (const entry of args.tool) {
  const index = entry.indexOf('=');
  if (index > 0) {
    tools[entry.slice(0, index)] = entry.slice(index + 1);
  }
}

const manifest = {
  format: MANIFEST_FORMAT,
  revision: args.revision,
  region: args.region,
  // Границы Москвы и области с запасом. Уточняются при сборке конкретного
  // набора: манифест описывает то, что действительно лежит в архиве.
  bbox: (args.bbox ?? '36.5,54.8,39.0,56.5').split(',').map(Number),
  sourceDate: args['source-date'],
  sourceSha256: await sha256(args['source-file']),
  tools,
  attribution: args.attribution ?? '© OpenStreetMap contributors',
  style: args.style,
  artifacts,
};

await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.error(`Манифест записан: ${artifacts.length} файлов`);
