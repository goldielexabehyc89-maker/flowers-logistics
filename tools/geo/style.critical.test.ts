/**
 * Стиль подложки и обновление стиля у собранного набора.
 *
 * Проверки существуют из-за конкретного случая: набор доехал до staging,
 * карта открылась — и оказалась без единой подписи. Данные для них в наборе
 * были (`transportation_name`, `place`, `housenumber`), шрифты раздавались,
 * а стиль их не рисовал: в нём не было ни одного слоя типа `symbol`.
 *
 * Второй предмет проверки — цена правки. Стиль весит 900 байт рядом
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
import { buildStyle, FONT_STACK, HOUSENUMBER_MIN_ZOOM } from './style.mjs';
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
  layout?: { 'text-font'?: string[]; 'text-field'?: unknown };
}

function layersOf(style: ReturnType<typeof buildStyle>): StyleLayer[] {
  return style.layers as unknown as StyleLayer[];
}

describe('стиль подложки', () => {
  const style = buildStyle({
    tilesName: 'tiles-20260806.pmtiles',
    attribution: '© OpenStreetMap contributors',
  });

  it('подписывает населённые пункты, улицы и номера домов', () => {
    const symbols = layersOf(style).filter((layer) => layer.type === 'symbol');
    const sources = symbols.map((layer) => layer['source-layer']);

    // Без единого символьного слоя карта показывает геометрию города
    // без названий — ровно то, что уехало на staging.
    expect(symbols.length).toBeGreaterThan(0);
    expect(sources).toContain('place');
    expect(sources).toContain('transportation_name');
    expect(sources).toContain('housenumber');
  });

  it('номера домов появляются на том зуме, где они есть в наборе', () => {
    const housenumbers = layersOf(style).find((layer) => layer['source-layer'] === 'housenumber');

    // В архиве слой `housenumber` существует только на четырнадцатом зуме.
    expect(housenumbers?.minzoom).toBe(HOUSENUMBER_MIN_ZOOM);
    expect(HOUSENUMBER_MIN_ZOOM).toBe(14);
  });

  it('используется только то семейство шрифтов, которое лежит в наборе', () => {
    // Ссылка на отсутствующий шрифт даёт пустые подписи вместо текста.
    expect(FONT_STACK).toEqual(['Noto Sans Regular']);

    for (const layer of layersOf(style).filter((item) => item.type === 'symbol')) {
      expect(layer.layout?.['text-font'], layer.id).toEqual(FONT_STACK);
    }
  });

  it('названия берутся русские с откатом на общее имя', () => {
    const labels = layersOf(style).filter(
      (layer) =>
        layer['source-layer'] === 'place' || layer['source-layer'] === 'transportation_name',
    );

    expect(labels.length).toBe(2);
    for (const layer of labels) {
      // `name:ru` есть не у каждого объекта: без отката часть подписей исчезла бы.
      expect(JSON.stringify(layer.layout?.['text-field']), layer.id).toBe(
        JSON.stringify(['coalesce', ['get', 'name:ru'], ['get', 'name']]),
      );
    }
  });

  it('дороги и здания остаются на карте', () => {
    const ids = layersOf(style).map((layer) => layer.id);

    expect(ids).toContain('roads');
    expect(ids).toContain('buildings');
    // Подписи рисуются поверх геометрии, иначе их закроет заливка.
    expect(ids.indexOf('roads')).toBeLessThan(ids.indexOf('street-labels'));
    expect(ids.indexOf('buildings')).toBeLessThan(ids.indexOf('housenumbers'));
  });

  it('ни одного абсолютного адреса: стиль не уводит браузер наружу', () => {
    expect(JSON.stringify(style)).not.toMatch(/https?:\/\//);
    expect(style.sprite).toBe('./sprite/sprite');
    expect(style.glyphs).toBe('./fonts/{fontstack}/{range}.pbf');
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

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'restyle-'));
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
    const styleBytes = Buffer.from(`${JSON.stringify(style, null, 2)}\n`, 'utf8');
    files.push({
      relative: 'style-20260806.json',
      data: styleBytes,
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
          style: 'style-20260806.json',
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

  it('обновлённый набор проходит штатную проверку выкатки', async () => {
    await run(process.execPath, [RESTYLE, '--set', root]);

    // Та же проверка, что выполняется на сервере перед запуском.
    await expect(run(process.execPath, [VERIFIER, 'basemap', root])).resolves.toBeTruthy();
  });

  it('повторный запуск даёт следующую редакцию, а не ломает набор', async () => {
    await run(process.execPath, [RESTYLE, '--set', root]);
    await run(process.execPath, [RESTYLE, '--set', root]);

    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
      style: string;
    };

    expect(manifest.style).toBe('style-20260806-r3.json');
    await expect(run(process.execPath, [VERIFIER, 'basemap', root])).resolves.toBeTruthy();
  });

  it('несовпадение архива с манифестом останавливает обновление', async () => {
    await writeFile(path.join(root, TILES), Buffer.from('подменённые тайлы'));

    // Инструмент не станет чинить манифест под изменившийся файл: расхождение
    // означает, что с набором уже что-то не так.
    await expect(run(process.execPath, [RESTYLE, '--set', root])).rejects.toThrow();
  });
});
