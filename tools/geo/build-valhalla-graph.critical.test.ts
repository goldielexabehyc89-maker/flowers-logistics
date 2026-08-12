/**
 * Бюджет матрицы проставляется сборкой графа, а не рукой на сервере.
 *
 * `valhalla_build_config` выдаёт обоим профилям 2500 пар — это матрица 50×50.
 * Приложение считает день из 60 точек, то есть 3600 маршрутов, и первый
 * настоящий пилот получил `400 Exceeded max locations: 2500` ещё до расчёта.
 *
 * Поправить число в `/srv/.../valhalla.json` руками означало бы починить ровно
 * один каталог: следующая сборка вернула бы 2500, и никто бы не заметил. Здесь
 * проверяется, что чинит именно pipeline и что он проверяет себя по файлу.
 *
 * Настоящая Valhalla для этого не нужна: проверяется ровно тот файл, который
 * вызывает сборка. Ради этого логика бюджета и вынесена из строки внутри
 * `docker run` в отдельный скрипт — строку нельзя прогнать тестом.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'build-valhalla-graph.sh');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

const LIMITS_SCRIPT = path.join(HERE, 'set-graph-limits.mjs');

describe('бюджет матрицы в сборке графа', () => {
  let root: string;
  let configPath: string;

  /** Конфигурация в том виде, в каком её выдаёт valhalla_build_config. */
  function defaultConfig(pairs = 2500): string {
    return `${JSON.stringify(
      {
        mjolnir: { tile_dir: '/custom_files/tiles' },
        service_limits: {
          auto: { max_distance: 5000000, max_locations: 20, max_matrix_location_pairs: pairs },
          pedestrian: {
            max_distance: 250000,
            max_locations: 50,
            max_matrix_location_pairs: pairs,
          },
          bicycle: { max_matrix_location_pairs: pairs },
          max_radius: 200,
        },
      },
      null,
      2,
    )}\n`;
  }

  function patch(): Promise<RunResult> {
    return run(process.execPath, [LIMITS_SCRIPT, '--config', configPath, '--pairs', '3600']);
  }

  function verify(): Promise<RunResult> {
    return run(process.execPath, [
      LIMITS_SCRIPT,
      '--config',
      configPath,
      '--pairs',
      '3600',
      '--verify',
    ]);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'graph-build-'));
    configPath = path.join(root, 'valhalla.json');
    await writeFile(configPath, defaultConfig());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('поднимает бюджет обоих профилей до 3600', async () => {
    const patched = await patch();
    expect(patched.code, patched.stderr).toBe(0);

    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      service_limits: Record<string, { max_matrix_location_pairs?: number }>;
    };

    expect(config.service_limits['auto']?.max_matrix_location_pairs).toBe(3600);
    expect(config.service_limits['pedestrian']?.max_matrix_location_pairs).toBe(3600);
  });

  it('не трогает остальные пределы', async () => {
    const before = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, never>;
    await patch();
    const after = JSON.parse(await readFile(configPath, 'utf8')) as typeof before;

    // Ослаблять distance/location/security limits без измеренного основания
    // значило бы открыть маршрутизатор на запросы, которых продукт не делает.
    const limits = after['service_limits'] as unknown as Record<string, unknown>;
    expect((limits['auto'] as Record<string, number>)['max_distance']).toBe(5_000_000);
    expect((limits['auto'] as Record<string, number>)['max_locations']).toBe(20);
    expect((limits['pedestrian'] as Record<string, number>)['max_distance']).toBe(250_000);
    expect(limits['max_radius']).toBe(200);
    // Профили, которыми приложение не пользуется, остаются как были.
    expect((limits['bicycle'] as Record<string, number>)['max_matrix_location_pairs']).toBe(2500);
    expect(after['mjolnir']).toEqual(before['mjolnir']);
  });

  it('уже достаточный бюджет не понижается', async () => {
    await writeFile(configPath, defaultConfig(10_000));
    const patched = await patch();

    expect(patched.code).toBe(0);
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      service_limits: Record<string, { max_matrix_location_pairs?: number }>;
    };
    expect(config.service_limits['auto']?.max_matrix_location_pairs).toBe(10_000);
    expect(patched.stderr).toContain('уже достаточен');
  });

  it('перечитывание подтверждает бюджет по файлу', async () => {
    await patch();
    const verified = await verify();

    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stderr).toContain('бюджет подтверждён по файлу');
  });

  it('перечитывание отказывает, если бюджет в файле недостаточен', async () => {
    // Правка не применялась: файл остался таким, каким его выдал
    // valhalla_build_config. Сборка обязана остановиться здесь — до тайлов.
    const verified = await verify();

    expect(verified.code).toBe(1);
    expect(verified.stderr).toContain('ОТКАЗ: бюджет профиля');
  });

  it('перечитывание отказывает на пропавшем профиле', async () => {
    await patch();
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      service_limits: Record<string, unknown>;
    };
    delete config.service_limits['pedestrian'];
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const verified = await verify();

    expect(verified.code).toBe(1);
    expect(verified.stderr).toContain('pedestrian');
  });
});

describe('порядок шагов сборки графа', () => {
  it('бюджет проверяется до тайлов, а манифест пишется после extract', async () => {
    const script = await readFile(SCRIPT, 'utf8');

    const budget = script.indexOf('--verify');
    const tiles = script.indexOf('valhalla_build_tiles');
    const extract = script.indexOf('valhalla_build_extract');
    const manifest = script.indexOf('write-graph-manifest.mjs');

    // Отказ по бюджету обязан случиться до того, как машина потратит
    // сорок минут на тайлы, и до публикации артефакта.
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(tiles);
    expect(tiles).toBeLessThan(extract);
    expect(extract).toBeLessThan(manifest);
  });

  it('манифест графа описывает и набор тайлов, и конфигурацию', async () => {
    const writer = await readFile(path.join(HERE, 'write-graph-manifest.mjs'), 'utf8');

    // Граф, у которого защищено содержимое и не защищена конфигурация,
    // неизменяемым не является: пределы подменяются без следа.
    expect(writer).toContain("extract: { path: 'tiles.tar'");
    expect(writer).toContain("config: { path: 'valhalla.json'");
    expect(writer).toContain('Файл valhalla.json не найден');
  });
});
