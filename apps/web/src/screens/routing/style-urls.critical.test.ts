/**
 * Адрес архива PMTiles.
 *
 * Проверки существуют из-за конкретного случая. Стиль объявляет источник как
 * `pmtiles://./tiles-20260806.pmtiles`; MapLibre такой адрес относительно
 * стиля не разрешает, а библиотека PMTiles разрешает его относительно адреса
 * СТРАНИЦЫ. На `/routing` это давало запрос `/tiles-20260806.pmtiles` вместо
 * `/maps/tiles-20260806.pmtiles`, приходила оболочка приложения, и карта
 * не открывалась.
 */

import { describe, expect, it } from 'vitest';
import {
  describePmtilesProblem,
  resolvePmtilesUrl,
  resolveStyleAsset,
  resolveStyleUrls,
} from './style-urls';

const APP = 'https://logistics.example';
const STYLE = `${APP}/maps/style-20260806.json`;

describe('адрес архива тайлов', () => {
  it('относительный путь разрешается относительно стиля, а не страницы', () => {
    const result = resolvePmtilesUrl('pmtiles://./tiles-20260806.pmtiles', STYLE, APP);

    expect(result).toEqual({
      ok: true,
      url: `pmtiles://${APP}/maps/tiles-20260806.pmtiles`,
    });
  });

  it('неверный путь /tiles-… больше не возникает', () => {
    const result = resolvePmtilesUrl('pmtiles://./tiles-20260806.pmtiles', STYLE, APP);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Ровно тот адрес, который раньше уходил в браузер и отдавал оболочку SPA.
      expect(result.url).not.toContain(`${APP}/tiles-`);
      expect(result.url).toContain('/maps/tiles-');
    }
  });

  it('работает на любом домене: окружения нигде не зашиты', () => {
    for (const origin of [
      'https://staging.example',
      'https://production.example',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
    ]) {
      const result = resolvePmtilesUrl(
        'pmtiles://./tiles-20260806.pmtiles',
        `${origin}/maps/style-20260806.json`,
        origin,
      );

      expect(result, origin).toEqual({
        ok: true,
        url: `pmtiles://${origin}/maps/tiles-20260806.pmtiles`,
      });
    }
  });

  it('уже правильный полный адрес нашего origin не искажается', () => {
    const absolute = `pmtiles://${APP}/maps/tiles-20260806.pmtiles`;

    expect(resolvePmtilesUrl(absolute, STYLE, APP)).toEqual({ ok: true, url: absolute });
  });

  it('путь от корня тоже приводится к полному адресу', () => {
    expect(resolvePmtilesUrl('pmtiles:///maps/tiles-20260806.pmtiles', STYLE, APP)).toEqual({
      ok: true,
      url: `pmtiles://${APP}/maps/tiles-20260806.pmtiles`,
    });
  });

  it('посторонний origin отклоняется', () => {
    // Архив тайлов с чужого сервера — это либо подмена конфигурации, либо
    // утечка: по запрошенным тайлам видно, куда мы возим.
    for (const foreign of [
      'pmtiles://https://tiles.example.invalid/moscow.pmtiles',
      'pmtiles://http://logistics.example/maps/tiles.pmtiles',
      'pmtiles://https://logistics.example.evil/maps/tiles.pmtiles',
      'pmtiles:////tiles.example.invalid/moscow.pmtiles',
    ]) {
      expect(resolvePmtilesUrl(foreign, STYLE, APP), foreign).toEqual({
        ok: false,
        reason: 'FOREIGN_ORIGIN',
      });
    }
  });

  it('чужой протокол и пустой адрес отклоняются', () => {
    expect(resolvePmtilesUrl('https://logistics.example/maps/tiles.pmtiles', STYLE, APP)).toEqual({
      ok: false,
      reason: 'NOT_PMTILES',
    });
    expect(resolvePmtilesUrl('pmtiles://', STYLE, APP)).toEqual({
      ok: false,
      reason: 'INVALID_URL',
    });
  });

  it('у каждого отказа есть понятное объяснение без адреса', () => {
    for (const reason of ['NOT_PMTILES', 'INVALID_URL', 'FOREIGN_ORIGIN'] as const) {
      const message = describePmtilesProblem(reason);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('http');
    }
  });
});

describe('спрайты и глифы', () => {
  it('спрайт приводится к абсолютному адресу', () => {
    // MapLibre 6 отвергает относительный адрес спрайта при разборе стиля:
    // «Invalid sprite URL "./sprite/sprite", must be absolute», и стиль
    // не применяется целиком.
    expect(resolveStyleAsset('./sprite/sprite', STYLE, APP)).toEqual({
      ok: true,
      url: `${APP}/maps/sprite/sprite`,
    });
  });

  it('в адресе глифов сохраняются подстановки', () => {
    const result = resolveStyleAsset('./fonts/{fontstack}/{range}.pbf', STYLE, APP);

    expect(result).toEqual({
      ok: true,
      url: `${APP}/maps/fonts/{fontstack}/{range}.pbf`,
    });
    if (result.ok) {
      // Фигурные скобки обязаны дожить до запроса: их подставляет MapLibre.
      // `new URL` закодировал бы их в %7B/%7D, и подстановка сломалась бы.
      expect(result.url).not.toContain('%7B');
      expect(result.url).not.toContain('%7D');
      expect(result.url).toContain('{fontstack}');
      expect(result.url).toContain('{range}');
    }
  });

  it('посторонний сервер в спрайтах и глифах отклоняется', () => {
    for (const foreign of [
      'https://tiles.example.invalid/sprite',
      '//tiles.example.invalid/fonts/{fontstack}/{range}.pbf',
    ]) {
      expect(resolveStyleAsset(foreign, STYLE, APP), foreign).toEqual({
        ok: false,
        reason: 'FOREIGN_ORIGIN',
      });
    }
  });

  it('стиль целиком приводится к нашему origin', () => {
    const resolved = resolveStyleUrls(
      {
        version: 8,
        sources: {
          basemap: { type: 'vector', url: 'pmtiles://./tiles-20260806.pmtiles' },
          other: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        sprite: './sprite/sprite',
        glyphs: './fonts/{fontstack}/{range}.pbf',
      },
      STYLE,
      APP,
    );

    expect(resolved.sources?.['basemap']?.url).toBe(`pmtiles://${APP}/maps/tiles-20260806.pmtiles`);
    expect(resolved.sprite).toBe(`${APP}/maps/sprite/sprite`);
    expect(resolved.glyphs).toBe(`${APP}/maps/fonts/{fontstack}/{range}.pbf`);
    // Источники без протокола pmtiles остаются как были.
    expect(resolved.sources?.['other']).toEqual({
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  });

  it('чужой архив в стиле останавливает загрузку целиком', () => {
    expect(() =>
      resolveStyleUrls(
        {
          sources: {
            basemap: { type: 'vector', url: 'pmtiles://https://tiles.example.invalid/x.pmtiles' },
          },
        },
        STYLE,
        APP,
      ),
    ).toThrow(/посторонний сервер/);
  });

  it('стиль без спрайтов и глифов не ломается', () => {
    const resolved = resolveStyleUrls({ version: 8, layers: [] }, STYLE, APP);

    expect(resolved.sprite).toBeUndefined();
    expect(resolved.glyphs).toBeUndefined();
  });
});
