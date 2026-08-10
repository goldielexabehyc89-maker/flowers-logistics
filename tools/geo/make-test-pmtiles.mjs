#!/usr/bin/env node
/**
 * Создаёт минимальный, но настоящий набор картографических артефактов.
 *
 * Нужен контрактным проверкам. Тянуть в CI гигабайты московского набора незачем:
 * проверяются не тайлы, а поведение — диапазонные запросы, отдача с нашего
 * origin, отказ при несовпадении контрольной суммы. Для этого достаточно
 * файла в несколько килобайт.
 *
 * Архив собирается по спецификации PMTiles v3: волшебная строка `PMTiles`,
 * версия 3, заголовок в 127 байт. Читать его карта не станет — тайлов внутри
 * нет, — но формат настоящий, и всё, что мы про него утверждаем, проверяемо.
 *
 * Ни одного сетевого обращения. Результат в Git не попадает.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_FORMAT = 'flowers-logistics/basemap-manifest@1';

/** Заголовок PMTiles v3: 127 байт по спецификации. */
const HEADER_BYTES = 127;

function buildPmtilesHeader() {
  const header = Buffer.alloc(HEADER_BYTES, 0);
  header.write('PMTiles', 0, 'ascii');
  // Версия спецификации.
  header.writeUInt8(3, 7);
  // Смещения и длины корневого каталога, метаданных и листьев: архив пустой,
  // поэтому все нули, кроме корня, который начинается сразу за заголовком.
  header.writeBigUInt64LE(BigInt(HEADER_BYTES), 8);
  header.writeBigUInt64LE(0n, 16);
  return header;
}

const root = process.argv[2];
if (root === undefined) {
  console.error('Использование: make-test-pmtiles.mjs <каталог>');
  process.exit(2);
}

const revision = 'test0001';
const tilesName = `tiles-${revision}.pmtiles`;
const styleName = `style-${revision}.json`;

await mkdir(path.join(root, 'sprite'), { recursive: true });
// Имя семейства шрифтов с пробелами — ровно так устроен настоящий набор
// (ресурсы protomaps дают «Noto Sans Regular»). Фикстура обязана повторять
// этот формат: иначе проверки не заметили бы, что подложка с пробелами
// в путях не принимается приложением.
await mkdir(path.join(root, 'fonts', 'Noto Sans Regular'), { recursive: true });

const header = buildPmtilesHeader();
// Немного «содержимого» после заголовка: диапазонные запросы должны иметь
// что откусывать, иначе проверка 206 ничего не проверяет.
const tiles = Buffer.concat([header, Buffer.alloc(8192, 0x2a)]);

const style = {
  version: 8,
  name: 'flowers-logistics-basemap-test',
  sources: {
    basemap: {
      type: 'vector',
      // Только относительный путь: абсолютный адрес чужого сервера означал бы,
      // что карта работает, пока работает он.
      url: `pmtiles://./${tilesName}`,
      attribution: '© OpenStreetMap contributors',
    },
  },
  sprite: './sprite/sprite',
  glyphs: './fonts/{fontstack}/{range}.pbf',
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f5f6f8' } }],
};

const sprite = { icon: { x: 0, y: 0, width: 1, height: 1, pixelRatio: 1 } };
// Однопиксельный PNG: настоящий файл нужного типа, но без содержимого.
const spritePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const glyphs = Buffer.from([0x1a, 0x00]);

const files = [
  { relative: tilesName, data: tiles, contentType: 'application/octet-stream' },
  {
    relative: styleName,
    data: Buffer.from(`${JSON.stringify(style, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  },
  {
    relative: 'sprite/sprite.json',
    data: Buffer.from(`${JSON.stringify(sprite)}\n`, 'utf8'),
    contentType: 'application/json',
  },
  { relative: 'sprite/sprite.png', data: spritePng, contentType: 'image/png' },
  {
    relative: 'fonts/Noto Sans Regular/0-255.pbf',
    data: glyphs,
    contentType: 'application/x-protobuf',
  },
];

for (const file of files) {
  await writeFile(path.join(root, file.relative), file.data);
}

const manifest = {
  format: MANIFEST_FORMAT,
  revision,
  region: 'Проверочный набор',
  bbox: [37.3, 55.5, 37.9, 56.0],
  sourceDate: '2026-08-01',
  sourceSha256: createHash('sha256').update('synthetic-source').digest('hex'),
  tools: { generator: 'make-test-pmtiles.mjs', 'pmtiles-spec': 'v3' },
  attribution: '© OpenStreetMap contributors',
  style: styleName,
  artifacts: files.map((file) => ({
    path: file.relative,
    bytes: file.data.length,
    sha256: createHash('sha256').update(file.data).digest('hex'),
    contentType: file.contentType,
  })),
};

await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.error(`Проверочный набор готов: ${root}`);
