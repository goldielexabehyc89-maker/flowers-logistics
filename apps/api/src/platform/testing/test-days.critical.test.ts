/**
 * Механическая проверка договора о владении месяцами.
 *
 * Проверка читает исходники критических тестов. Она существует потому, что
 * договор, соблюдаемый по памяти, договором не является: пересечение дат
 * возвращается ровно тогда, когда автор нового сценария не знает, что дата
 * кому-то принадлежит. Тест обязан назвать нарушителя в тот же день, а не
 * через месяц редким отказом в полном наборе.
 *
 * База здесь не нужна: всё, что проверяется, — текст файлов и чистые функции.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deliveryDaysIn,
  monthConflicts,
  monthOf,
  ownershipViolations,
  RESERVED_MONTHS,
  unusedReservations,
  type DayUsage,
} from './test-days.js';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

/** Этот файл. Исключается из обхода — см. комментарий в `criticalTestFiles`. */
const CONTRACT_TEST = 'apps/api/src/platform/testing/test-days.critical.test.ts';

/** Все критические тесты приложения. Список строится обходом, а не перечнем. */
async function criticalTestFiles(): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        await walk(full);
      } else if (entry.name.endsWith('.critical.test.ts')) {
        const relative = path.relative(REPOSITORY_ROOT, full);
        // Сам договор в базу не пишет: его «даты доставки» — строки в фикстуре
        // разбора. Считать их занятием месяца значило бы, что проверка
        // конфликтует сама с собой.
        if (relative !== CONTRACT_TEST) {
          found.push(relative);
        }
      }
    }
  };

  await walk(path.join(REPOSITORY_ROOT, 'apps/api/src'));
  return found.sort();
}

async function deliveryDayUsage(): Promise<DayUsage[]> {
  const usage: DayUsage[] = [];

  for (const file of await criticalTestFiles()) {
    const source = await readFile(path.join(REPOSITORY_ROOT, file), 'utf8');
    for (const day of deliveryDaysIn(source)) {
      usage.push({ file, day });
    }
  }

  return usage;
}

describe('владение календарными месяцами в общей тестовой базе', () => {
  it('обход находит сами критические тесты и их даты доставки', async () => {
    const files = await criticalTestFiles();
    const usage = await deliveryDayUsage();

    // Если бы разбор перестал что-либо находить, проверка ниже стала бы
    // пустой формальностью и молча пропускала любое пересечение.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('apps/api/src/modules/planning/planning.critical.test.ts');
    expect(usage.length).toBeGreaterThan(20);

    for (const file of Object.keys(RESERVED_MONTHS)) {
      expect(files).toContain(file);
    }
  });

  it('один месяц принадлежит ровно одному файлу', () => {
    expect(monthConflicts(RESERVED_MONTHS)).toEqual([]);
  });

  it('ни один файл не создаёт заказ в чужом месяце', async () => {
    const violations = ownershipViolations(await deliveryDayUsage(), RESERVED_MONTHS);

    // Сообщение перечисляет нарушителей: молчаливый «false» не подсказал бы,
    // какую именно дату переносить.
    expect(
      violations.map((v) => `${v.file} использует ${v.day}, месяц принадлежит ${v.owner}`),
    ).toEqual([]);
  });

  it('каждая броня действительно используется владельцем', async () => {
    expect(unusedReservations(await deliveryDayUsage(), RESERVED_MONTHS)).toEqual([]);
  });

  it('планирование и жизненный цикл маршрута больше не делят день', async () => {
    const usage = await deliveryDayUsage();
    const daysOf = (file: string): Set<string> =>
      new Set(usage.filter((item) => item.file === file).map((item) => item.day));

    const planning = daysOf('apps/api/src/modules/planning/planning.critical.test.ts');
    const lifecycle = daysOf('apps/api/src/modules/routing/lifecycle.critical.test.ts');
    const routing = daysOf('apps/api/src/modules/routing/routing.critical.test.ts');
    const geo = daysOf('apps/api/src/modules/orders/geo.critical.test.ts');

    expect(planning.size).toBeGreaterThan(0);
    expect(lifecycle.size).toBeGreaterThan(0);

    // Именно это пересечение роняло сценарий брошенной аренды.
    expect([...planning].filter((day) => lifecycle.has(day))).toEqual([]);
    // И то же самое между маршрутизацией и геосценариями.
    expect([...routing].filter((day) => geo.has(day))).toEqual([]);
  });
});

describe('сама проверка договора', () => {
  it('пересечение броней обнаруживается', () => {
    const broken = {
      'a.critical.test.ts': ['2026-12'],
      'b.critical.test.ts': ['2026-12', '2027-05'],
    };

    expect(monthConflicts(broken)).toEqual([
      { month: '2026-12', owners: ['a.critical.test.ts', 'b.critical.test.ts'] },
    ]);
  });

  it('заказ в чужом месяце обнаруживается', () => {
    const reserved = { 'owner.critical.test.ts': ['2026-12'] };

    expect(
      ownershipViolations([{ file: 'stranger.critical.test.ts', day: '2026-12-10' }], reserved),
    ).toEqual([
      { file: 'stranger.critical.test.ts', day: '2026-12-10', owner: 'owner.critical.test.ts' },
    ]);
    // Собственный день владельца нарушением не является.
    expect(
      ownershipViolations([{ file: 'owner.critical.test.ts', day: '2026-12-10' }], reserved),
    ).toEqual([]);
    // Как и чужой день в незабронированном месяце.
    expect(
      ownershipViolations([{ file: 'stranger.critical.test.ts', day: '2026-08-10' }], reserved),
    ).toEqual([]);
  });

  it('брошенная броня обнаруживается', () => {
    const reserved = { 'owner.critical.test.ts': ['2026-12', '2027-07'] };

    expect(
      unusedReservations([{ file: 'owner.critical.test.ts', day: '2026-12-10' }], reserved),
    ).toEqual([{ file: 'owner.critical.test.ts', month: '2027-07' }]);
  });

  it('разбор берёт даты доставки и не берёт прочие', () => {
    const source = [
      "const NOW = new Date('2026-08-10T09:00:00.000Z');",
      "const DAY = '2026-12-01';",
      "const day = '2026-12-02';",
      "  deliveryPlannedMoment: '2026-12-03 12:00:00.000',",
      "  deliveryDate: '2026-12-04',",
      "  updated: '2026-08-11 10:00:00.000',",
      '  deliveryPlannedMoment: `${DAY} 12:00:00.000`,',
    ].join('\n');

    expect(deliveryDaysIn(source)).toEqual([
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
    ]);
    expect(monthOf('2026-12-04')).toBe('2026-12');
  });
});
