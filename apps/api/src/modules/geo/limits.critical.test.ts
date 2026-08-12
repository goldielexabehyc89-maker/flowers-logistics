/**
 * Предел матрицы обязан быть ОДНИМ числом на весь продукт.
 *
 * Проверка появилась не из аккуратности. Приложение разрешало день из 60 точек,
 * а конфигурация дорожного графа допускала 2500 пар — это 50×50. Оба числа
 * были заданы отдельно, оба выглядели правильными, и разошлись они молча:
 * узнал об этом первый настоящий пилот, получив от Valhalla
 * `400 Exceeded max locations: 2500` на сервере.
 *
 * Здесь связываются все места, где это число живёт: единственный именованный
 * источник, runtime-константы, значение по умолчанию в конфигурации, предел
 * пилота, скрипт сборки графа и самодостаточный deploy verifier. Разойтись
 * им теперь нельзя — расхождение ломает этот файл раньше, чем сервер.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATRIX_PROFILES, MAX_MATRIX_LOCATION_PAIRS, MAX_MATRIX_POINTS } from './limits.js';
import { PILOT_MAX_POINTS } from '../planning/pilot.js';
import { loadConfig } from '../../platform/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relative), 'utf8');
}

describe('единственный источник предела матрицы', () => {
  it('runtime-константы совпадают с tools/geo/graph-limits.json', async () => {
    const limits = JSON.parse(await readSource('tools/geo/graph-limits.json')) as {
      format: string;
      maxMatrixPoints: number;
      profiles: string[];
    };

    expect(limits.format).toBe('flowers-logistics/graph-limits@1');
    expect(limits.maxMatrixPoints).toBe(MAX_MATRIX_POINTS);
    expect(limits.profiles).toEqual([...MATRIX_PROFILES]);
  });

  it('число пар — это квадрат числа точек, а не отдельное значение', () => {
    // Отдельное число пар — ровно тот способ разъехаться, из-за которого
    // проверка и написана. Матрица квадратная: связь не соглашение, а факт.
    expect(MAX_MATRIX_LOCATION_PAIRS).toBe(MAX_MATRIX_POINTS * MAX_MATRIX_POINTS);
    expect(MAX_MATRIX_LOCATION_PAIRS).toBe(3600);
  });

  it('предел пилота и значение MATRIX_MAX_POINTS по умолчанию — то же число', () => {
    expect(PILOT_MAX_POINTS).toBe(MAX_MATRIX_POINTS);

    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ENV: 'local',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
      AUTH_ACCESS_TOKEN_SECRET: 'a'.repeat(64),
      AUTH_PIN_PEPPER: 'b'.repeat(64),
      AUTH_REFRESH_REPLAY_KEY: Buffer.alloc(32, 7).toString('base64'),
    } as NodeJS.ProcessEnv);

    expect(config.MATRIX_MAX_POINTS).toBe(MAX_MATRIX_POINTS);
  });

  it('скрипт сборки графа берёт бюджет из того же файла и считает его как квадрат', async () => {
    const script = await readSource('tools/geo/build-valhalla-graph.sh');

    // Число в скрипте не пишется: оно читается из источника и возводится
    // в квадрат. Зашитый литерал здесь означал бы возврат к двум числам.
    expect(script).toContain('graph-limits.json');
    expect(script).toContain('required_pairs=$(( max_points * max_points ))');
    expect(script).not.toMatch(/max_matrix_location_pairs["' ]*[:=]\s*\d/);

    // Перечитывание файла после записи — отдельный процесс и отдельный отказ,
    // и происходит он до тайлов: сорок минут сборки не должны тратиться
    // на граф, который расчёт всё равно отвергнет.
    expect(script).toContain('set-graph-limits.mjs');
    expect(script).toContain('--verify');
    expect(script.indexOf('--verify')).toBeLessThan(script.indexOf('valhalla_build_tiles'));

    // Проставляются оба профиля и только они.
    const limitsScript = await readSource('tools/geo/set-graph-limits.mjs');
    expect(limitsScript).toContain("const PROFILES = ['auto', 'pedestrian'];");
    expect(limitsScript).toContain('ОТКАЗ: бюджет профиля');
  });

  it('самодостаточный verifier повторяет то же число', async () => {
    const verifier = await readSource('deploy/scripts/verify-geo.mjs');

    // Verifier уезжает на сервер один и целиком, поэтому число в нём —
    // копия. Копия обязана совпадать: сверяем именно её.
    expect(verifier).toContain(`const MAX_MATRIX_POINTS = ${MAX_MATRIX_POINTS};`);
    expect(verifier).toContain(
      'const MAX_MATRIX_LOCATION_PAIRS = MAX_MATRIX_POINTS * MAX_MATRIX_POINTS;',
    );
  });
});
