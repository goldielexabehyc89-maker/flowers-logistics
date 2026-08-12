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
 *
 * ЧТО ОПРЕДЕЛЯЕТ ВНЕШНИЙ ВИД.
 *
 * Архив собран профилем OpenMapTiles и объявляет шестнадцать слоёв. Прежний
 * стиль читал шесть из них и рисовал все дороги одной серой линией: карта
 * получалась технически исправной и нечитаемой. Здесь раскрыты природные зоны,
 * землепользование, вода, иерархия дорог, железные дороги и границы — то, что
 * в архиве уже лежит. Пересборка тайлов для этого не нужна.
 *
 * ПОРЯДОК СЛОЁВ ЗАДАН ЯВНО.
 *
 * Площадные заливки перекрывают друг друга, и «как получилось» здесь означает
 * случайный результат при каждой правке. Порядок такой: городское
 * землепользование → природный покров → охраняемые территории → вода →
 * здания → дороги → железные дороги → границы → подписи. Природа ложится
 * поверх жилой застройки намеренно: парк внутри квартала обязан остаться
 * видимым.
 *
 * ПОДЛОЖКА НЕ СОРЕВНУЕТСЯ С РАБОЧИМИ ДАННЫМИ.
 *
 * Маркеры заказов и будущая линия маршрута рисуются поверх канвы и обязаны
 * оставаться самым контрастным на экране. Поэтому палитра светлая
 * и приглушённая: цвет здесь различает объекты, а не привлекает внимание.
 */

import { pathToFileURL } from 'node:url';

/** Единственное семейство шрифтов в наборе. */
export const FONT_STACK = ['Noto Sans Regular'];

/** Зум, с которого в наборе появляются здания. */
export const BUILDING_MIN_ZOOM = 13;

/** Зум, с которого в наборе появляются номера домов. */
export const HOUSENUMBER_MIN_ZOOM = 14;

/**
 * Классы дорог по фактическим значениям `class` слоя `transportation`.
 *
 * Разбиение сделано по значениям профиля OpenMapTiles, а не по догадкам:
 * `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `minor`, `service`.
 * Списки перечислены явно, поэтому рельсовые классы в дорожные правила
 * попасть не могут: они не перечислены ни в одном из них.
 */
export const ROAD_CLASSES = {
  motorway: ['motorway', 'trunk'],
  primary: ['primary'],
  secondary: ['secondary', 'tertiary'],
  minor: ['minor', 'service'],
};

/**
 * Рельсовый транспорт того же слоя `transportation`.
 * В OpenMapTiles железные дороги лежат рядом с автомобильными, и без явного
 * разделения они получили бы ширину и цвет магистрали.
 */
export const RAIL_CLASSES = ['rail', 'transit'];

/** Название объекта: русское, иначе общее. */
const localName = ['coalesce', ['get', 'name:ru'], ['get', 'name']];

/** Приоритет подписи: меньше `rank` — важнее объект, значит рисуется первым. */
const byRank = ['coalesce', ['get', 'rank'], 100];

const inClasses = (classes) => ['in', ['get', 'class'], ['literal', classes]];

/**
 * Пара «обводка + заливка» для класса дорог.
 *
 * Обводки всех классов рисуются раньше всех заливок — иначе обводка старшей
 * дороги перечеркнула бы уже нарисованную младшую на каждом перекрёстке.
 */
function roadWidth(stops) {
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}

const ROAD_STYLE = {
  motorway: {
    minzoom: 4,
    casing: { color: '#dcae74', width: roadWidth([5, 1.2, 10, 4, 14, 9.5, 18, 28]) },
    fill: { color: '#f8d3a0', width: roadWidth([5, 0.6, 10, 2.4, 14, 7, 18, 23]) },
  },
  primary: {
    minzoom: 7,
    casing: { color: '#dcc79a', width: roadWidth([8, 1, 12, 3.4, 16, 10, 18, 19]) },
    fill: { color: '#fdeac4', width: roadWidth([8, 0.5, 12, 2, 16, 7.5, 18, 15]) },
  },
  secondary: {
    minzoom: 9,
    casing: { color: '#d3d8e0', width: roadWidth([10, 0.8, 13, 2.8, 16, 7.5, 18, 14]) },
    fill: { color: '#ffffff', width: roadWidth([10, 0.4, 13, 1.6, 16, 5.5, 18, 11]) },
  },
  minor: {
    minzoom: 12,
    casing: { color: '#dfe3e9', width: roadWidth([12, 0.8, 15, 3.2, 18, 10]) },
    fill: { color: '#ffffff', width: roadWidth([12, 0.4, 15, 2, 18, 8]) },
  },
};

const ROAD_ORDER = ['minor', 'secondary', 'primary', 'motorway'];

function roadCasingLayer(group) {
  const style = ROAD_STYLE[group];
  return {
    id: `road-${group}-casing`,
    type: 'line',
    source: 'basemap',
    'source-layer': 'transportation',
    minzoom: style.minzoom,
    filter: inClasses(ROAD_CLASSES[group]),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': style.casing.color, 'line-width': style.casing.width },
  };
}

function roadFillLayer(group) {
  const style = ROAD_STYLE[group];
  return {
    id: `road-${group}`,
    type: 'line',
    source: 'basemap',
    'source-layer': 'transportation',
    minzoom: style.minzoom,
    filter: inClasses(ROAD_CLASSES[group]),
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': style.fill.color, 'line-width': style.fill.width },
  };
}

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
      { id: 'background', type: 'background', paint: { 'background-color': '#f6f5f2' } },
      {
        // Городское землепользование. Перечислены только те классы профиля,
        // которые действительно различают территорию для логиста: жильё,
        // производство, торговля, кладбища и военные зоны. Неизвестный класс
        // сюда не попадает вовсе — лучше нейтральный фон, чем случайный цвет.
        id: 'landuse-urban',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landuse',
        minzoom: 6,
        filter: inClasses([
          'residential',
          'suburb',
          'quarter',
          'neighbourhood',
          'commercial',
          'retail',
          'industrial',
          'railway',
          'cemetery',
          'military',
          'quarry',
        ]),
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            'residential',
            '#efeeea',
            'suburb',
            '#efeeea',
            'quarter',
            '#efeeea',
            'neighbourhood',
            '#efeeea',
            'commercial',
            '#f2ece9',
            'retail',
            '#f4ebe6',
            'industrial',
            '#eae9e6',
            'railway',
            '#e8e6e4',
            'cemetery',
            '#dfe5da',
            'military',
            '#ebe7e0',
            'quarry',
            '#e6e3de',
            '#efeeea',
          ],
          // Прозрачность намеренная: под землепользованием остаётся фон,
          // и наложение двух площадей не даёт грязного пятна.
          'fill-opacity': 0.85,
        },
      },
      {
        // Природный покров профиля: лес, трава, пашня, песок, камень, лёд,
        // болото. Ложится поверх городского землепользования: парк внутри
        // жилого квартала обязан остаться видимым.
        id: 'landcover-natural',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'landcover',
        minzoom: 4,
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            'wood',
            '#d5e5cb',
            'grass',
            '#e3eeda',
            'farmland',
            '#eff0e1',
            'wetland',
            '#dde9e2',
            'sand',
            '#f2ecda',
            'rock',
            '#e9e7e3',
            'ice',
            '#eef3f7',
            '#e3eeda',
          ],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.55, 10, 0.85],
        },
      },
      {
        // Охраняемые территории и парки профиля. Только заливка — граница
        // отдельным слоем ниже, иначе на стыке двух парков линия удваивается.
        id: 'park-fill',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'park',
        minzoom: 5,
        paint: { 'fill-color': '#d3e6c7', 'fill-opacity': 0.45 },
      },
      {
        id: 'park-outline',
        type: 'line',
        source: 'basemap',
        'source-layer': 'park',
        minzoom: 9,
        paint: {
          'line-color': '#b9d3a8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 14, 1.2],
        },
      },
      {
        // Водотоки рисуются ПОД водными полигонами: иначе линия русла
        // перечёркивала бы поверхность широкой реки.
        id: 'waterway',
        type: 'line',
        source: 'basemap',
        'source-layer': 'waterway',
        minzoom: 8,
        paint: {
          'line-color': '#a9c8e0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 1.1, 16, 2.8],
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'fill-color': '#bcd6ea' },
      },
      {
        // Здания появляются там же, где они есть в наборе, — с тринадцатого зума.
        // Остаются фоном: по ним читают адрес, а не рассматривают их.
        id: 'buildings',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'building',
        minzoom: BUILDING_MIN_ZOOM,
        paint: {
          'fill-color': '#e6e3de',
          'fill-outline-color': '#d7d3cd',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 15, 0.9],
        },
      },
      // Сначала все обводки, затем все заливки. Иначе обводка магистрали
      // перечеркнула бы уже нарисованную местную улицу на каждом перекрёстке.
      ...ROAD_ORDER.map(roadCasingLayer),
      ...ROAD_ORDER.map(roadFillLayer),
      {
        // Железные дороги отличаются штриховкой, а не яркостью: они ориентир,
        // но ездит по ним не курьер.
        id: 'railways',
        type: 'line',
        source: 'basemap',
        'source-layer': 'transportation',
        minzoom: 9,
        filter: inClasses(RAIL_CLASSES),
        paint: {
          'line-color': '#b0b6c1',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.4, 18, 2.6],
          'line-dasharray': [3, 2],
        },
      },
      {
        // Районы и округа: тонкая пунктирная линия и только с тех зумов,
        // где она объясняет город, а не расчерчивает его.
        id: 'boundary-local',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundary',
        minzoom: 8,
        filter: ['>=', ['get', 'admin_level'], 5],
        paint: {
          'line-color': '#c3c7cf',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 1],
          'line-dasharray': [2, 2],
        },
      },
      {
        // Страны и регионы. Отдельным слоем поверх местных границ: иначе
        // государственная граница терялась бы среди районных.
        id: 'boundary-region',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundary',
        filter: ['<=', ['get', 'admin_level'], 4],
        paint: {
          'line-color': '#a3a8b2',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 8, 1.2, 14, 2],
          'line-dasharray': [4, 2],
        },
      },
      {
        // Названия водоёмов. Данные для них в наборе есть, а без них
        // крупная вода на обзорном зуме остаётся безымянным пятном.
        id: 'water-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'water_name',
        minzoom: 9,
        layout: {
          'text-field': localName,
          'text-font': FONT_STACK,
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13],
          'text-max-width': 8,
          'text-padding': 6,
        },
        paint: { 'text-color': '#4f748f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 },
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
        // Районы и микрорайоны. Отдельный слой от городов: на городском зуме
        // подпись района полезна ровно тогда, когда название города уже ушло.
        id: 'place-district-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'place',
        minzoom: 11,
        filter: inClasses(['suburb', 'quarter', 'neighbourhood']),
        layout: {
          'text-field': localName,
          'text-font': FONT_STACK,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13],
          'text-max-width': 8,
          'text-padding': 8,
          // Приоритет по рангу: при нехватке места исчезает наименее значимое
          // название, а не весь класс разом.
          'symbol-sort-key': byRank,
        },
        paint: { 'text-color': '#6b7382', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      {
        // Названия населённых пунктов уходят с крупных зумов: в городе они
        // только мешают названиям улиц.
        id: 'place-labels',
        type: 'symbol',
        source: 'basemap',
        'source-layer': 'place',
        maxzoom: 15,
        filter: inClasses(['city', 'town', 'village', 'hamlet']),
        layout: {
          'text-field': localName,
          'text-font': FONT_STACK,
          // Размер по классу, а не один на всех: иначе деревня спорит
          // с городом за одно и то же место на экране.
          'text-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4,
            ['match', ['get', 'class'], 'city', 12, 'town', 10, 9],
            10,
            ['match', ['get', 'class'], 'city', 16, 'town', 13, 11],
            14,
            ['match', ['get', 'class'], 'city', 18, 'town', 15, 13],
          ],
          'text-max-width': 8,
          'text-padding': 6,
          'symbol-sort-key': byRank,
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
