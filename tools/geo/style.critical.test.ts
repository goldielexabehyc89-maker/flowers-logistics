/**
 * Стиль подложки и обновление стиля у собранного набора.
 *
 * Проверки существуют из-за конкретного случая: набор доехал до staging,
 * карта открылась — и оказалась без единой подписи. Данные для них в наборе
 * были (`transportation_name`, `place`, `housenumber`), шрифты раздавались,
 * а стиль их не рисовал: в нём не было ни одного слоя типа `symbol`.
 *
 * Второй случай того же рода: карта была технически исправной и нечитаемой.
 * Все дороги рисовались одной серой линией, а лес, вода, границы и парки
 * из архива не использовались вовсе. Поэтому здесь проверяется СТРУКТУРА —
 * какие слои источника раскрыты, чем различаются классы дорог и в каком
 * порядке всё это ложится, — а не конкретные цвета: цвет владелец вправе
 * поменять, не ломая ни одной гарантии.
 *
 * Третий предмет проверки — цена правки. Стиль весит килобайты рядом
 * с гигабайтом тайлов, и менять оформление пересборкой всего набора значило бы
 * платить сутками сборки за подпись. Инструмент обязан доказуемо не трогать
 * тайлы и не переиспользовать имя файла: артефакты отдаются с бессрочным
 * кэшированием.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import {
  buildStyle,
  BUILDING_MIN_ZOOM,
  FONT_STACK,
  HOUSENUMBER_MIN_ZOOM,
  RAIL_CLASSES,
  ROAD_CLASSES,
} from './style.mjs';
import { nextStyleName } from './restyle-basemap.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const RESTYLE = path.join(here, 'restyle-basemap.mjs');
const VERIFIER = path.resolve(here, '../../deploy/scripts/verify-geo.mjs');

interface StyleLayer {
  id: string;
  type: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  layout?: { 'text-font'?: string[]; 'text-field'?: unknown; 'symbol-sort-key'?: unknown };
  paint?: Record<string, unknown>;
}

function layersOf(style: ReturnType<typeof buildStyle>): StyleLayer[] {
  return style.layers as unknown as StyleLayer[];
}

const NAME_FALLBACK = JSON.stringify(['coalesce', ['get', 'name:ru'], ['get', 'name']]);

describe('стиль подложки', () => {
  const style = buildStyle({
    tilesName: 'tiles-20260806.pmtiles',
    attribution: '© OpenStreetMap contributors',
  });
  const layers = layersOf(style);
  const ids = layers.map((layer) => layer.id);
  const index = (id: string): number => ids.indexOf(id);

  it('стиль принимается спецификацией MapLibre', () => {
    // Выражения фильтров и интерполяций проверяет тот же валидатор, который
    // применяет браузер. Опечатка в выражении иначе всплыла бы только
    // на сервере — пустой картой без единой ошибки в сборке.
    expect(validateStyleMin(style)).toEqual([]);
  });

  it('раскрыты природные зоны, землепользование, вода, границы и транспорт', () => {
    const used = new Set(layers.map((layer) => layer['source-layer']).filter(Boolean));

    // Прежний стиль читал шесть слоёв из шестнадцати: карта была технически
    // исправной и при этом безликой.
    for (const sourceLayer of [
      'landuse',
      'landcover',
      'park',
      'waterway',
      'water',
      'boundary',
      'transportation',
      'building',
      'water_name',
      'transportation_name',
      'housenumber',
      'place',
    ]) {
      expect(used, sourceLayer).toContain(sourceLayer);
    }
  });

  it('дороги разделены по фактическому классу, а не нарисованы одной линией', () => {
    const roadLayers = layers.filter((layer) => layer.id.startsWith('road-'));

    // Четыре группы, каждая с обводкой и заливкой.
    expect(roadLayers).toHaveLength(8);

    for (const group of Object.keys(ROAD_CLASSES)) {
      const casing = layers.find((layer) => layer.id === `road-${group}-casing`);
      const fill = layers.find((layer) => layer.id === `road-${group}`);

      expect(casing, group).toBeDefined();
      expect(fill, group).toBeDefined();
      expect(casing?.['source-layer']).toBe('transportation');
      // Обводка обязана быть шире заливки, иначе она не читается вовсе.
      expect(JSON.stringify(casing?.paint?.['line-width'])).not.toBe(
        JSON.stringify(fill?.paint?.['line-width']),
      );
    }

    // Правила разных групп различаются, а не повторяют друг друга.
    const widths = Object.keys(ROAD_CLASSES).map((group) =>
      JSON.stringify(layers.find((layer) => layer.id === `road-${group}`)?.paint?.['line-width']),
    );
    expect(new Set(widths).size).toBe(widths.length);
  });

  it('обводки рисуются раньше заливок, а магистраль — поверх местной улицы', () => {
    const order = ['minor', 'secondary', 'primary', 'motorway'];

    // Все обводки идут до всех заливок: иначе обводка магистрали перечеркнула бы
    // уже нарисованную местную улицу на каждом перекрёстке.
    const lastCasing = Math.max(...order.map((group) => index(`road-${group}-casing`)));
    const firstFill = Math.min(...order.map((group) => index(`road-${group}`)));
    expect(lastCasing).toBeLessThan(firstFill);

    // Внутри каждой пачки — по возрастанию значимости.
    for (let i = 1; i < order.length; i += 1) {
      expect(index(`road-${order[i - 1]}-casing`)).toBeLessThan(index(`road-${order[i]}-casing`));
      expect(index(`road-${order[i - 1]}`)).toBeLessThan(index(`road-${order[i]}`));
    }
  });

  it('рельсы не попадают в правило автодорог и наоборот', () => {
    const roadClasses = Object.values(ROAD_CLASSES).flat();

    for (const rail of RAIL_CLASSES) {
      expect(roadClasses, rail).not.toContain(rail);
    }

    // Проверяется не список констант, а фактические фильтры слоёв.
    for (const group of Object.keys(ROAD_CLASSES)) {
      const filter = JSON.stringify(layers.find((layer) => layer.id === `road-${group}`)?.filter);
      for (const rail of RAIL_CLASSES) {
        expect(filter, `${group}/${rail}`).not.toContain(`"${rail}"`);
      }
    }

    const railFilter = JSON.stringify(layers.find((layer) => layer.id === 'railways')?.filter);
    expect(railFilter).toBeDefined();
    for (const road of roadClasses) {
      expect(railFilter, road).not.toContain(`"${road}"`);
    }
  });

  it('площадные заливки уложены заданным порядком, а не случайным', () => {
    // Порядок определяет, что кого закрасит. «Как получилось» здесь означает
    // разный результат при каждой правке.
    expect(index('background')).toBeLessThan(index('landuse-urban'));
    // Природа поверх застройки: парк внутри квартала обязан остаться видимым.
    expect(index('landuse-urban')).toBeLessThan(index('landcover-natural'));
    expect(index('landcover-natural')).toBeLessThan(index('park-fill'));
    // Русло реки — под водной поверхностью, иначе линия перечеркнёт полигон.
    expect(index('waterway')).toBeLessThan(index('water'));
    expect(index('water')).toBeLessThan(index('buildings'));
    expect(index('buildings')).toBeLessThan(index('road-minor-casing'));
  });

  it('границы показаны тонко и только на уместных масштабах', () => {
    const local = layers.find((layer) => layer.id === 'boundary-local');
    const region = layers.find((layer) => layer.id === 'boundary-region');

    expect(local?.['source-layer']).toBe('boundary');
    expect(region?.['source-layer']).toBe('boundary');
    // Районные границы не расчерчивают обзорную карту.
    expect(local?.minzoom).toBeGreaterThanOrEqual(8);
    // Границы лежат поверх геометрии, но под подписями.
    expect(index('road-motorway')).toBeLessThan(index('boundary-local'));
    expect(index('boundary-region')).toBeLessThan(index('water-labels'));
  });

  it('железные дороги отличаются от автомобильных, но не доминируют', () => {
    const rail = layers.find((layer) => layer.id === 'railways');

    // Штриховка — то, чего нет ни у одной автодороги.
    expect(rail?.paint?.['line-dasharray']).toBeDefined();
    for (const group of Object.keys(ROAD_CLASSES)) {
      expect(
        layers.find((layer) => layer.id === `road-${group}`)?.paint?.['line-dasharray'],
      ).toBeUndefined();
    }
  });

  it('подписывает воду, населённые пункты, районы, улицы и номера домов', () => {
    const symbols = layers.filter((layer) => layer.type === 'symbol');
    const sources = symbols.map((layer) => layer['source-layer']);

    // Без единого символьного слоя карта показывает геометрию города
    // без названий — ровно то, что уехало на staging.
    expect(symbols.length).toBeGreaterThan(0);
    expect(sources).toContain('place');
    expect(sources).toContain('transportation_name');
    expect(sources).toContain('housenumber');
    expect(sources).toContain('water_name');
  });

  it('иерархия подписей уменьшает столкновения, а не прячет класс целиком', () => {
    const districts = layers.find((layer) => layer.id === 'place-district-labels');
    const places = layers.find((layer) => layer.id === 'place-labels');

    // Приоритет по рангу: при нехватке места исчезает наименее значимое
    // название, а не весь класс разом.
    expect(districts?.layout?.['symbol-sort-key']).toBeDefined();
    expect(places?.layout?.['symbol-sort-key']).toBeDefined();
    // Города и районы — разные слои: подпись района полезна там, где название
    // города уже ушло.
    expect(JSON.stringify(districts?.filter)).not.toBe(JSON.stringify(places?.filter));
    expect(districts?.minzoom).toBeGreaterThanOrEqual(11);
  });

  it('номера домов и здания появляются на том зуме, где они есть в наборе', () => {
    const housenumbers = layers.find((layer) => layer['source-layer'] === 'housenumber');
    const buildings = layers.find((layer) => layer.id === 'buildings');

    // В архиве слой `housenumber` существует только с четырнадцатого зума,
    // а здания — с тринадцатого.
    expect(housenumbers?.minzoom).toBe(HOUSENUMBER_MIN_ZOOM);
    expect(HOUSENUMBER_MIN_ZOOM).toBe(14);
    expect(buildings?.minzoom).toBe(BUILDING_MIN_ZOOM);
    expect(BUILDING_MIN_ZOOM).toBe(13);
  });

  it('используется только то семейство шрифтов, которое лежит в наборе', () => {
    // Ссылка на отсутствующий шрифт даёт пустые подписи вместо текста.
    expect(FONT_STACK).toEqual(['Noto Sans Regular']);

    for (const layer of layers.filter((item) => item.type === 'symbol')) {
      expect(layer.layout?.['text-font'], layer.id).toEqual(FONT_STACK);
    }
  });

  it('названия берутся русские с откатом на общее имя', () => {
    const named = layers.filter(
      (layer) => layer.type === 'symbol' && layer['source-layer'] !== 'housenumber',
    );

    // Номера домов — единственная подпись без имени: у неё своё поле.
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const layer of named) {
      // `name:ru` есть не у каждого объекта: без отката часть подписей исчезла бы.
      expect(JSON.stringify(layer.layout?.['text-field']), layer.id).toBe(NAME_FALLBACK);
    }
  });

  it('подписи рисуются поверх всей геометрии', () => {
    const firstSymbol = layers.findIndex((layer) => layer.type === 'symbol');
    const lastGeometry = layers.reduce(
      (last, layer, position) => (layer.type === 'symbol' ? last : position),
      0,
    );

    expect(firstSymbol).toBeGreaterThan(lastGeometry);
    expect(index('road-motorway')).toBeLessThan(index('street-labels'));
    expect(index('buildings')).toBeLessThan(index('housenumbers'));
  });

  it('значков POI в стиле нет: спрайт в репозитории не проверяем', () => {
    // Набор иконок лежит вне Git (`protomaps/basemaps-assets`), поэтому
    // гарантировать существование конкретного значка нельзя. Отсутствующий
    // значок в MapLibre даёт пустое место и предупреждение, а россыпь
    // неизвестных иконок хуже отсутствия POI.
    expect(layers.some((layer) => layer['source-layer'] === 'poi')).toBe(false);
    expect(JSON.stringify(style)).not.toContain('icon-image');
  });

  it('ни одного абсолютного адреса: стиль не уводит браузер наружу', () => {
    expect(JSON.stringify(style)).not.toMatch(/https?:\/\//);
    expect(style.sprite).toBe('./sprite/sprite');
    expect(style.glyphs).toBe('./fonts/{fontstack}/{range}.pbf');
    expect(style.sources.basemap.url).toBe('pmtiles://./tiles-20260806.pmtiles');
    expect(style.sources.basemap.attribution).toBe('© OpenStreetMap contributors');
  });

  it('без имени архива или подписи стиль не собирается', () => {
    expect(() => buildStyle({ tilesName: '', attribution: 'x' })).toThrow();
    expect(() => buildStyle({ tilesName: 'tiles.pmtiles', attribution: '' })).toThrow();
  });
});

describe('обновление стиля у собранного набора', () => {
  let root: string;
  let tilesSha: string;

  const TILES = 'tiles-20260806.pmtiles';

  /**
   * Собирает набор с заданным именем файла стиля.
   *
   * Имя параметризовано намеренно: на сервере уже установлена редакция `r2`,
   * и переход именно от неё обязан быть проверен, а не додуман.
   */
  async function makeSet(styleName: string): Promise<void> {
    await mkdir(path.join(root, 'sprite'), { recursive: true });
    await mkdir(path.join(root, 'fonts', 'Noto Sans Regular'), { recursive: true });

    const files: { relative: string; data: Buffer; contentType: string }[] = [
      { relative: TILES, data: Buffer.from('тайлы'), contentType: 'application/octet-stream' },
      {
        relative: 'sprite/sprite.json',
        data: Buffer.from('{}'),
        contentType: 'application/json',
      },
      {
        relative: 'fonts/Noto Sans Regular/0-255.pbf',
        data: Buffer.from([0x1a, 0x00]),
        contentType: 'application/x-protobuf',
      },
    ];

    const style = buildStyle({ tilesName: TILES, attribution: '© OpenStreetMap contributors' });
    files.push({
      relative: styleName,
      data: Buffer.from(`${JSON.stringify(style, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });

    for (const file of files) {
      await writeFile(path.join(root, file.relative), file.data);
    }

    tilesSha = createHash('sha256').update(files[0]!.data).digest('hex');

    await writeFile(
      path.join(root, 'manifest.json'),
      `${JSON.stringify(
        {
          format: 'flowers-logistics/basemap-manifest@1',
          revision: '20260806',
          region: 'Проверка',
          bbox: [37, 55, 38, 56],
          sourceDate: '2026-08-06',
          sourceSha256: 'a'.repeat(64),
          tools: { planetiler: 'test' },
          attribution: '© OpenStreetMap contributors',
          style: styleName,
          artifacts: files.map((file) => ({
            path: file.relative,
            bytes: file.data.length,
            sha256: createHash('sha256').update(file.data).digest('hex'),
            contentType: file.contentType,
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'restyle-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('имя стиля не переиспользуется', () => {
    // Артефакты отдаются с бессрочным кэшированием: подмена содержимого
    // под тем же именем оставила бы у части браузеров старый стиль на год.
    expect(nextStyleName('style-20260806.json')).toBe('style-20260806-r2.json');
    expect(nextStyleName('style-20260806-r2.json')).toBe('style-20260806-r3.json');
    expect(nextStyleName('не-стиль.json')).toBeNull();
  });

  it('обновляет стиль и манифест, не касаясь тайлов', async () => {
    await makeSet('style-20260806.json');
    const before = await readFile(path.join(root, TILES));

    await run(process.execPath, [RESTYLE, '--set', root]);

    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
      style: string;
      artifacts: { path: string; sha256: string }[];
    };

    expect(manifest.style).toBe('style-20260806-r2.json');
    await expect(stat(path.join(root, 'style-20260806-r2.json'))).resolves.toBeTruthy();
    // Прежний файл никому не адресуется и в наборе не остаётся.
    await expect(stat(path.join(root, 'style-20260806.json'))).rejects.toThrow();
    expect(manifest.artifacts.some((item) => item.path === 'style-20260806.json')).toBe(false);

    // Гигабайт тайлов не тронут — это главное свойство инструмента.
    const after = await readFile(path.join(root, TILES));
    expect(after.equals(before)).toBe(true);
    expect(manifest.artifacts.find((item) => item.path === TILES)?.sha256).toBe(tilesSha);
  });

  it('установленная редакция r2 обновляется до r3 и не переиспользует имя', async () => {
    // Ровно тот переход, который предстоит на сервере: там уже лежит
    // `style-20260806-r2.json`.
    await makeSet('style-20260806-r2.json');
    const before = await readFile(path.join(root, TILES));

    await run(process.execPath, [RESTYLE, '--set', root]);

    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
      style: string;
      artifacts: { path: string; sha256: string }[];
    };

    expect(manifest.style).toBe('style-20260806-r3.json');
    await expect(stat(path.join(root, 'style-20260806-r3.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(root, 'style-20260806-r2.json'))).rejects.toThrow();
    expect(manifest.artifacts.some((item) => item.path === 'style-20260806-r2.json')).toBe(false);

    const after = await readFile(path.join(root, TILES));
    expect(after.equals(before)).toBe(true);
    expect(manifest.artifacts.find((item) => item.path === TILES)?.sha256).toBe(tilesSha);

    // Выпущенный файл — это ровно текущий стиль, а не копия прежнего.
    const released = JSON.parse(
      await readFile(path.join(root, 'style-20260806-r3.json'), 'utf8'),
    ) as ReturnType<typeof buildStyle>;
    expect(released.layers.map((layer) => (layer as StyleLayer).id)).toContain('road-motorway');
  });

  it('обновлённый набор проходит штатную проверку выкатки', async () => {
    await makeSet('style-20260806-r2.json');
    await run(process.execPath, [RESTYLE, '--set', root]);

    // Та же проверка, что выполняется на сервере перед запуском.
    await expect(run(process.execPath, [VERIFIER, 'basemap', root])).resolves.toBeTruthy();
  });

  it('повторный запуск даёт следующую редакцию, а не ломает набор', async () => {
    await makeSet('style-20260806.json');
    await run(process.execPath, [RESTYLE, '--set', root]);
    await run(process.execPath, [RESTYLE, '--set', root]);

    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
      style: string;
    };

    expect(manifest.style).toBe('style-20260806-r3.json');
    await expect(run(process.execPath, [VERIFIER, 'basemap', root])).resolves.toBeTruthy();
  });

  it('несовпадение архива с манифестом останавливает обновление', async () => {
    await makeSet('style-20260806.json');
    await writeFile(path.join(root, TILES), Buffer.from('подменённые тайлы'));

    // Инструмент не станет чинить манифест под изменившийся файл: расхождение
    // означает, что с набором уже что-то не так.
    await expect(run(process.execPath, [RESTYLE, '--set', root])).rejects.toThrow();
  });
});
