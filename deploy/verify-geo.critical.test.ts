/**
 * Идентичность дорожного графа определяется содержимым.
 *
 * Эти проверки существуют из-за конкретного случая: набор графа скопировали
 * на сервер, содержимое совпало байт в байт, а выкатка остановилась — потому
 * что идентичностью считалось время изменения файла, и копирование его
 * изменило. Обратный случай страшнее и тем же способом не ловился: подмена
 * содержимого с сохранённым временем выглядела бы как тот же самый граф.
 *
 * Поэтому здесь проверяется ровно одно свойство и с обеих сторон:
 *   — другой mtime при том же содержимом принимается;
 *   — тот же mtime при изменённом байте отклоняется.
 *
 * Работа идёт на временных копиях. Настоящий установленный набор и его время
 * изменения не трогаются ничем в этом файле.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile, readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const VERIFIER = fileURLToPath(new URL('./scripts/verify-geo.mjs', import.meta.url));

/** Фиксированное время «сборки»: тесты не зависят от часов машины. */
const BUILD_TIME = new Date('2026-08-06T10:00:00Z');
/** «Время копирования на сервер»: другое время, то же содержимое. */
const COPY_TIME = new Date('2026-08-10T14:48:00Z');

const GRAPH_FORMAT = 'flowers-logistics/valhalla-manifest@1';

interface RunResult {
  code: number;
  stderr: string;
}

function runVerifier(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFIER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('идентичность дорожного графа определяется содержимым', () => {
  let root: string;
  let tilesPath: string;
  let tilesSha: string;
  let tilesBytes: Buffer;

  async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
    const manifest = {
      format: GRAPH_FORMAT,
      extract: {
        path: 'tiles.tar',
        bytes: tilesBytes.length,
        sha256: tilesSha,
      },
      ...overrides,
    };
    await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'graph-set-'));
    tilesPath = path.join(root, 'tiles.tar');
    // Содержимое произвольное: проверяется способ установления идентичности,
    // а не формат тайлов Valhalla.
    tilesBytes = Buffer.from('дорожный граф: набор тайлов', 'utf8');
    tilesSha = sha256(tilesBytes);
    await writeFile(tilesPath, tilesBytes);
    await utimes(tilesPath, BUILD_TIME, BUILD_TIME);
    await writeManifest();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('принимает тот же набор с другим временем изменения', async () => {
    // Ровно то, что происходит при копировании набора на сервер.
    await utimes(tilesPath, COPY_TIME, COPY_TIME);
    const changed = await stat(tilesPath);
    expect(Math.round(changed.mtimeMs / 1000)).toBe(Math.round(COPY_TIME.getTime() / 1000));

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(tilesSha);
  });

  it('отклоняет изменённый байт при сохранённом времени изменения', async () => {
    const tampered = Buffer.from(tilesBytes);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(tampered.length).toBe(tilesBytes.length);

    await writeFile(tilesPath, tampered);
    // Время возвращается к исходному: снаружи файл выглядит нетронутым.
    await utimes(tilesPath, BUILD_TIME, BUILD_TIME);

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('содержимое набора тайлов не совпало');
  });

  it('отклоняет несовпадение фактического файла с манифестом', async () => {
    // Манифест описывает один файл, на диске лежит другой — и размер тоже
    // другой, чтобы отличить эту ветку от подмены равной длины.
    const other = Buffer.from('другой набор тайлов, заметно длиннее прежнего', 'utf8');
    await writeFile(tilesPath, other);

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /размер набора тайлов не совпал|содержимое набора тайлов не совпало/,
    );
  });

  it('отклоняет несовпадение манифеста с конфигурацией', async () => {
    const otherSha = sha256(Buffer.from('совсем другой граф', 'utf8'));

    const result = await runVerifier(['graph', root, otherSha]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('не совпадает с конфигурацией');
  });

  it('отклоняет некорректный формат ожидаемой ревизии', async () => {
    // Именно так выглядело прежнее значение: Unix-время изменения файла.
    for (const wrong of ['1786349243', '', 'ABCDEF', `${tilesSha}0`, tilesSha.toUpperCase()]) {
      const result = await runVerifier(['graph', root, wrong]);

      expect(result.code, `значение «${wrong}» должно быть отклонено`).toBe(1);
      expect(result.stderr).toContain('ожидаемая ревизия графа задана неверно');
    }
  });

  it('отклоняет манифест без корректной суммы набора тайлов', async () => {
    await writeManifest({
      extract: { path: 'tiles.tar', bytes: tilesBytes.length, sha256: '1786349243' },
    });

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('корректного SHA-256');
  });

  it('не трогает проверяемый набор', async () => {
    const before = await stat(tilesPath);

    await runVerifier(['graph', root, tilesSha]);

    const after = await stat(tilesPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(sha256(await readFile(tilesPath))).toBe(tilesSha);
  });
});

describe('готовность маршрутизатора проверяется отдельно от идентичности', () => {
  let server: Server;
  let url: string;
  let statusBody: unknown;
  let matrixHandler: (costing: string) => { code: number; body: unknown };

  beforeEach(async () => {
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674 };
    matrixHandler = () => ({
      code: 200,
      body: {
        sources_to_targets: [
          [
            { from_index: 0, to_index: 0, time: 0, distance: 0 },
            { from_index: 0, to_index: 1, time: 120, distance: 1.2 },
          ],
          [
            { from_index: 1, to_index: 0, time: 130, distance: 1.3 },
            { from_index: 1, to_index: 1, time: 0, distance: 0 },
          ],
        ],
      },
    });

    server = createServer((request, response) => {
      if (request.url === '/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(statusBody));
        return;
      }

      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        const costing = (JSON.parse(raw) as { costing: string }).costing;
        const answer = matrixHandler(costing);
        response.writeHead(answer.code, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('принимает произвольную метку времени и не сравнивает её с ревизией', async () => {
    // Метка меняется при каждом копировании набора. Любое её значение,
    // не равное ревизии, обязано проходить: она не идентичность.
    for (const marker of [1, 1786349243, 1786365674, 4102444800]) {
      statusBody = { version: '3.8.3', tileset_last_modified: marker };

      const result = await runVerifier(['routing', url]);

      expect(result.code, `метка ${marker} должна приниматься`).toBe(0);
      expect(result.stderr).toContain('маршрутизатор готов');
    }
  });

  it('отказывает, если набор тайлов не загружен', async () => {
    statusBody = { version: '3.8.3' };

    const result = await runVerifier(['routing', url]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('не сообщил, что набор тайлов загружен');
  });

  it('отказывает при has_tiles = false', async () => {
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674, has_tiles: false };

    const result = await runVerifier(['routing', url]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('набор тайлов недоступен');
  });

  it('считает пробную матрицу обоими профилями', async () => {
    const asked: string[] = [];
    const original = matrixHandler;
    matrixHandler = (costing) => {
      asked.push(costing);
      return original(costing);
    };

    const result = await runVerifier(['matrix', url]);

    expect(result.code, result.stderr).toBe(0);
    expect(asked).toEqual(['auto', 'pedestrian']);
  });

  it('отказывает, если пеший профиль не находит пути', async () => {
    // Набор загружен, автомобильный профиль считает — а пешего в тайлах нет.
    // Загруженность набора этот случай не ловит, потому и нужен пробный расчёт.
    const original = matrixHandler;
    matrixHandler = (costing) =>
      costing === 'pedestrian'
        ? {
            code: 200,
            body: {
              sources_to_targets: [
                [
                  { from_index: 0, to_index: 0, time: 0, distance: 0 },
                  { from_index: 0, to_index: 1, time: null, distance: null },
                ],
                [
                  { from_index: 1, to_index: 0, time: null, distance: null },
                  { from_index: 1, to_index: 1, time: 0, distance: 0 },
                ],
              ],
            },
          }
        : original(costing);

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('не нашёл ни одного пути');
  });

  it('не принимает ревизию как аргумент проверки готовности', async () => {
    // Лишний аргумент игнорируется, но результат обязан остаться прежним:
    // сравнения метки времени с чем бы то ни было в этом режиме нет.
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674 };

    const result = await runVerifier(['routing', url, 'a'.repeat(64)]);

    expect(result.code, result.stderr).toBe(0);
  });
});
