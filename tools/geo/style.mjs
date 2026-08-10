#!/usr/bin/env node
/**
 * Стиль подложки MapLibre.
 *
 * Живёт отдельным модулем, потому что нужен двум операциям: полной сборке
 * набора и обновлению одного лишь стиля у уже собранного набора. Две копии
 * одного стиля разошлись бы при первой же правке, и карта на сервере
 * перестала бы соответствовать тому, что собирает сборщик.
 *
 * Подписи обязательны: логист сверяет заказ с адресом, и карта без названий
 * улиц для этого бесполезна.
 *
 * Всё рисуется одним семейством «Noto Sans Regular» — другого в наборе нет,
 * и ссылка на отсутствующий шрифт означала бы пустые подписи вместо текста.
 *
 * Названия берутся русские с откатом на общее имя: `name:ru` есть не у каждого
 * объекта, и без отката часть подписей просто исчезла бы.
 *
 * Ни одного абсолютного адреса: стиль не может увести браузер наружу.
 */

import { pathToFileURL } from 'node:url';

/** Единственное семейство шрифтов в наборе. */
export const FONT_STACK = ['Noto Sans Regular'];

/** Зум, с которого в наборе появляются номера домов. */
export const HOUSENUMBER_MIN_ZOOM = 14;

/** Название объекта: русское, иначе общее. */
const localName = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

/**
 * Собирает стиль для набора.
 *
 * @param tilesName   имя файла архива внутри набора;
 * @param attribution подпись правообладателя.
 */
export function buildStyle({ tilesName, attribution }) {
  if (typeof tilesName !== 'string' || tilesName === '') {
    throw new Error('не задано имя архива тайлов');
  }
  if (typeof attribution !== 'string' || attribution === '') {
    throw new Error('не задана подпись правообладателя');
  }

  return {
    version: 8,
    name: 'flowers-logistics-basemap',
    sources: {
      basemap: {
        type: 'vector',
        // Только относительный путь: абсолютный адрес чужого сервера означал бы,
        // что карта работает, пока работает он.
        url: `pmtiles://./${tilesName}`,
        attribution,
      },
    },
    sprite: './sprite/sprite',
    glyphs: './fonts/{fontstack}/{range}.pbf',
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f5f6f8' } },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': '#c9d9e8' },
      },
      {
        // Здания появляются там же, где они есть в наборе, — с тринадцатого зума.
        id: 'buildings',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': '#e4e8ee', 'fill-outline-color': '#d2d8e1' },
      },
      {
        // Дороги приглушены намеренно: подпись поверх контрастной заливки
        // нечитаема, а карта нужна для чтения адресов.
        id: 'roads',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#cdd4de',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.6, 16, 4],
        },
      },
      {
        id: 'housenumbers',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'housenumber',
        minzoom: HOUSENUMBER_MIN_ZOOM,
        layout: {
          'text-field': ['get', 'housenumber'],
          'text-font': FONT_STACK,
          'text-size': 10,
          'text-padding': 4,
        },
        paint: { 'text-color': '#8a93a2', 'text-halo-color': '#ffffff', 'text-halo-width': 1 },
      },
      {
        id: 'street-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'transportation_name',
        minzoom: 12,
        layout: {
          // Подпись идёт вдоль улицы, иначе на повороте она перестаёт
          // относиться к тому, что подписывает.
          'symbol-placement': 'line',
          'text-field': localName,
          'text-font': FONT_STACK,
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
          'text-max-angle': 30,
          'symbol-spacing': 250,
        },
        paint: { 'text-color': '#5c6473', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      {
        // Названия населённых пунктов уходят с крупных зумов: в городе они
        // только мешают названиям улиц.
        id: 'place-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'place',
        maxzoom: 15,
        layout: {
          'text-field': localName,
          'text-font': FONT_STACK,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 14, 14, 16],
          'text-max-width': 8,
          'text-padding': 6,
        },
        paint: { 'text-color': '#2f3744', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      },
    ],
  };
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

// Прямой запуск: печатает стиль в stdout. Так его использует сборщик набора.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  if (args.tiles === undefined || args.attribution === undefined) {
    console.error('Использование: style.mjs --tiles <файл.pmtiles> --attribution <подпись>');
    process.exit(2);
  }
  process.stdout.write(
    `${JSON.stringify(buildStyle({ tilesName: args.tiles, attribution: args.attribution }), null, 2)}\n`,
  );
}
