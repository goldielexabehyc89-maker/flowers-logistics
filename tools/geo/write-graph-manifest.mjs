#!/usr/bin/env node
/**
 * Манифест дорожного графа.
 *
 * Отдельный от подложки: это разные наборы, они собираются независимо и могут
 * обновляться в разное время. Общий манифест заставил бы пересобирать оба
 * ради изменения одного.
 *
 * Граф целиком не хешируется: это гигабайты и десятки минут. Проверяются
 * ключевые файлы и записывается ревизия, которую сервис подтверждает в /status.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { tool: [] };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === undefined || value === undefined) continue;
    if (key === 'tool') args.tool.push(value);
    else args[key] = value;
  }
  return args;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const args = parseArgs(process.argv);
for (const key of ['root', 'revision', 'source-file']) {
  if (args[key] === undefined) {
    console.error(`Не задан --${key}`);
    process.exit(2);
  }
}

const tools = {};
for (const entry of args.tool) {
  const index = entry.indexOf('=');
  if (index > 0) tools[entry.slice(0, index)] = entry.slice(index + 1);
}

const extract = path.join(args.root, 'tiles.tar');
let extractInfo = null;
try {
  const info = await stat(extract);
  extractInfo = { bytes: info.size, sha256: await sha256(extract) };
} catch {
  console.error('Файл tiles.tar не найден: граф собран не полностью');
  process.exit(1);
}

/**
 * Конфигурация — такая же часть идентичности графа, как и тайлы.
 *
 * Раньше манифест защищал `tiles.tar` и молчал про `valhalla.json`. Значит,
 * набор с неизменяемыми тайлами имел подменяемые пределы: те самые
 * `max_matrix_location_pairs`, из-за которых пилот получил 400 на дне из
 * 60 точек. Граф, у которого защищено содержимое и не защищена конфигурация,
 * неизменяемым не является.
 *
 * Поле добавлено совместимо: прежний deploy-код его просто не читает, а новый
 * verifier обязан его требовать.
 */
const configFile = path.join(args.root, 'valhalla.json');
let configInfo = null;
try {
  const info = await stat(configFile);
  configInfo = { bytes: info.size, sha256: await sha256(configFile) };
} catch {
  console.error('Файл valhalla.json не найден: граф собран не полностью');
  process.exit(1);
}

await writeFile(
  path.join(args.root, 'manifest.json'),
  `${JSON.stringify(
    {
      format: 'flowers-logistics/valhalla-manifest@1',
      revision: args.revision,
      sourceSha256: await sha256(args['source-file']),
      tools,
      extract: { path: 'tiles.tar', ...extractInfo },
      config: { path: 'valhalla.json', ...configInfo },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.error('Манифест графа записан');
