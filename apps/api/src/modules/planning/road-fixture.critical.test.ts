/**
 * Дорожный набор пилота: свойства, от которых зависит смысл замера.
 *
 * Первый настоящий пилот получил 20 недостижимых пар на 11 точках и 60 на 31.
 * Причина была не в маршрутизаторе: точки брались равномерно случайно из
 * прямоугольника вокруг Москвы и регулярно попадали в парки, в воду и в куски
 * сети, отрезанные от остального города. Ворота честно закрывались, но
 * измеряли они генератор.
 *
 * Набор заменён на дорожный. Достижимость его точек доказывается не здесь —
 * её доказывает настоящий маршрутизатор при сборке набора и при каждой
 * выкатке. Здесь проверяется то, что должно быть верно всегда и без сети:
 * набор ровно того размера, точки различны, случайного прямоугольника
 * в генераторе не осталось, а две формы набора не разошлись.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROAD_FIXTURE_POINTS } from './road-fixture.js';
import { buildSyntheticDay, PILOT_MAX_POINTS } from './pilot.js';
import { MAX_MATRIX_POINTS } from '../geo/limits.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relative), 'utf8');
}

/** Вытаскивает координаты из любой из двух форм набора: они пишутся одинаково. */
function extractPoints(source: string, after: string): { latMicro: number; lonMicro: number }[] {
  const from = source.indexOf(after);
  expect(from).toBeGreaterThanOrEqual(0);
  const tail = source.slice(from);
  const block = tail.slice(0, tail.indexOf('];'));
  return [...block.matchAll(/latMicro: (\d+), lonMicro: (\d+)/g)].map((match) => ({
    latMicro: Number(match[1]),
    lonMicro: Number(match[2]),
  }));
}

describe('дорожный набор пилота', () => {
  it('содержит ровно предельное число различных точек', () => {
    expect(ROAD_FIXTURE_POINTS).toHaveLength(MAX_MATRIX_POINTS);

    const unique = new Set(ROAD_FIXTURE_POINTS.map((p) => `${p.latMicro}:${p.lonMicro}`));
    // Повтор координаты превратил бы два разных заказа в один адрес: матрица
    // стала бы меньше заявленной, а замер — неверным.
    expect(unique.size).toBe(MAX_MATRIX_POINTS);
  });

  it('координаты записаны целыми микроградусами в пределах собранного региона', () => {
    for (const point of ROAD_FIXTURE_POINTS) {
      expect(Number.isInteger(point.latMicro)).toBe(true);
      expect(Number.isInteger(point.lonMicro)).toBe(true);
      // Границы широкие намеренно: это проверка «набор не уехал в другой мир»,
      // а не попытка описать город рамкой.
      expect(point.latMicro).toBeGreaterThan(54_000_000);
      expect(point.latMicro).toBeLessThan(57_000_000);
      expect(point.lonMicro).toBeGreaterThan(36_000_000);
      expect(point.lonMicro).toBeLessThan(39_000_000);
    }
  });

  it('префиксы дают ровно те размеры, которыми пользуются пилот и выкатка', () => {
    for (const [orderCount, expected] of [
      [10, 11],
      [30, 31],
      [PILOT_MAX_POINTS - 1, PILOT_MAX_POINTS],
    ] as const) {
      const day = buildSyntheticDay({ orderCount });
      expect(day.points).toHaveLength(expected);

      // Точки дня — это именно префикс набора, а не выборка из него.
      expect(day.points.map((p) => `${p.latMicro}:${p.lonMicro}`)).toEqual(
        ROAD_FIXTURE_POINTS.slice(0, expected).map((p) => `${p.latMicro}:${p.lonMicro}`),
      );
    }
  });

  it('день на 11 точек — начало того же дня, что и на 60', () => {
    const small = buildSyntheticDay({ orderCount: 10 });
    const large = buildSyntheticDay({ orderCount: PILOT_MAX_POINTS - 1 });

    // Иначе «10, 30 и 59 заказов» были бы тремя разными днями, и сравнивать
    // их времена между собой было бы нельзя.
    expect(large.points.slice(0, small.points.length)).toEqual(small.points);
  });

  it('разные зёрна дают одни и те же координаты и разные окна', () => {
    const first = buildSyntheticDay({ orderCount: 10, seed: 1 });
    const second = buildSyntheticDay({ orderCount: 10, seed: 999_999 });

    // Это честная потеря, и она задумана: набор, который меняется от прогона
    // к прогону, сравнивать не с чем.
    expect(second.points).toEqual(first.points);

    // А вот форму дня зерно задаёт по-прежнему: раскладка жёстких окон
    // перемешивается им. Иначе разные зёрна давали бы буквально один день.
    expect(second.orders.map((o) => o.windowStartMinute)).not.toEqual(
      first.orders.map((o) => o.windowStartMinute),
    );
    // Состав раскладки при этом тот же: дни разных зёрен сравнимы по сложности.
    const count = (day: typeof first) =>
      day.orders.filter((o) => o.windowStartMinute !== null).length;
    expect(count(second)).toBe(count(first));
  });

  it('день больше набора не собирается молча', () => {
    // Молчаливое повторение точек дало бы «день на 80 заказов» с 60 адресами.
    expect(() => buildSyntheticDay({ orderCount: PILOT_MAX_POINTS })).toThrow(/TOO_MANY_POINTS/);
  });

  it('в генераторе не осталось случайного прямоугольника', async () => {
    const pilot = await readSource('apps/api/src/modules/planning/pilot.ts');

    expect(pilot).not.toContain('MOSCOW_BBOX');
    expect(pilot).toContain('ROAD_FIXTURE_POINTS');
    // Координаты не должны зависеть от генератора псевдослучайных чисел ни
    // в каком виде: `random()` рядом с широтой — это и есть прежний дефект.
    expect(pilot).not.toMatch(/lat\w*\s*=\s*[^;]*random\(\)/);
    expect(pilot).not.toMatch(/lon\w*\s*=\s*[^;]*random\(\)/);
  });
});

describe('две формы набора не расходятся', () => {
  it('verifier повторяет дорожный набор точка в точку', async () => {
    const verifier = await readSource('deploy/scripts/verify-geo.mjs');
    const copy = extractPoints(verifier, 'const ROAD_FIXTURE_POINTS = [');

    // Verifier обязан оставаться одним самодостаточным файлом: на сервере
    // рядом с ним нет ни репозитория, ни пакетов. Поэтому набор в нём —
    // копия, и единственная защита от расхождения — эта сверка.
    expect(copy).toEqual(ROAD_FIXTURE_POINTS.map((p) => ({ ...p })));
  });

  it('verifier повторяет набор FOOT-регрессии точка в точку', async () => {
    const declared = JSON.parse(await readSource('tools/geo/foot-regression.json')) as {
      format: string;
      costing: string;
      points: { latMicro: number; lonMicro: number }[];
    };
    const verifier = await readSource('deploy/scripts/verify-geo.mjs');
    const copy = extractPoints(verifier, 'const FOOT_REGRESSION_POINTS = [');

    expect(declared.format).toBe('flowers-logistics/foot-regression@1');
    expect(declared.costing).toBe('pedestrian');
    expect(copy).toEqual(declared.points);

    // Набор нельзя сокращать: ни одна пара из этих точек отказ не давала,
    // он проявлялся только на широком поиске по всем шести.
    expect(declared.points).toHaveLength(6);
  });
});
