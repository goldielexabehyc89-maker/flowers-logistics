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
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile, readFile, stat } from 'node:fs/promises';
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

/**
 * Коды возврата. Различать их обязательно: вызывающая сторона по коду решает,
 * сказать «артефакты не совпали» или «проверка не состоялась». Один общий код
 * заставлял бы обвинять файлы в том, чего они не делали.
 */
const EXIT_MISMATCH = 10;
const EXIT_INTERNAL = 20;

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
  let configPath: string;
  let configBytes: Buffer;

  /** Конфигурация с достаточным бюджетом обоих профилей. */
  function configWithBudget(pairs: number, pedestrianPairs = pairs): Buffer {
    return Buffer.from(
      `${JSON.stringify(
        {
          mjolnir: { tile_extract: '/custom_files/tiles.tar' },
          service_limits: {
            auto: { max_matrix_location_pairs: pairs },
            pedestrian: { max_matrix_location_pairs: pedestrianPairs },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  async function writeConfig(bytes: Buffer): Promise<void> {
    configBytes = bytes;
    await writeFile(configPath, configBytes);
    await utimes(configPath, BUILD_TIME, BUILD_TIME);
  }

  async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
    const manifest = {
      format: GRAPH_FORMAT,
      extract: {
        path: 'tiles.tar',
        bytes: tilesBytes.length,
        sha256: tilesSha,
      },
      config: {
        path: 'valhalla.json',
        bytes: configBytes.length,
        sha256: sha256(configBytes),
      },
      ...overrides,
    };
    await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'graph-set-'));
    tilesPath = path.join(root, 'tiles.tar');
    configPath = path.join(root, 'valhalla.json');
    // Содержимое произвольное: проверяется способ установления идентичности,
    // а не формат тайлов Valhalla.
    tilesBytes = Buffer.from('дорожный граф: набор тайлов', 'utf8');
    tilesSha = sha256(tilesBytes);
    await writeFile(tilesPath, tilesBytes);
    await utimes(tilesPath, BUILD_TIME, BUILD_TIME);
    await writeConfig(configWithBudget(3600));
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

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('содержимое набора тайлов не совпало');
  });

  it('отклоняет несовпадение фактического файла с манифестом', async () => {
    // Манифест описывает один файл, на диске лежит другой — и размер тоже
    // другой, чтобы отличить эту ветку от подмены равной длины.
    const other = Buffer.from('другой набор тайлов, заметно длиннее прежнего', 'utf8');
    await writeFile(tilesPath, other);

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toMatch(
      /размер набора тайлов не совпал|содержимое набора тайлов не совпало/,
    );
  });

  it('отклоняет несовпадение манифеста с конфигурацией', async () => {
    const otherSha = sha256(Buffer.from('совсем другой граф', 'utf8'));

    const result = await runVerifier(['graph', root, otherSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('не совпадает с конфигурацией');
  });

  it('отклоняет некорректный формат ожидаемой ревизии', async () => {
    // Именно так выглядело прежнее значение: Unix-время изменения файла.
    for (const wrong of ['1786349243', '', 'ABCDEF', `${tilesSha}0`, tilesSha.toUpperCase()]) {
      const result = await runVerifier(['graph', root, wrong]);

      expect(result.code, `значение «${wrong}» должно быть отклонено`).toBe(EXIT_MISMATCH);
      expect(result.stderr).toContain('ожидаемая ревизия графа задана неверно');
    }
  });

  it('отклоняет манифест без корректной суммы набора тайлов', async () => {
    await writeManifest({
      extract: { path: 'tiles.tar', bytes: tilesBytes.length, sha256: '1786349243' },
    });

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('корректного SHA-256');
  });

  it('внутренняя ошибка отличима от несовпадения по коду возврата', async () => {
    // Манифест синтаксически верен, но испорчен по структуре: проверка падает,
    // ничего не установив о файлах. Это НЕ вывод о несовпадении.
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ format: 'flowers-logistics/basemap-manifest@1', artifacts: [null] }),
    );

    const result = await runVerifier(['basemap', root]);

    expect(result.code).toBe(EXIT_INTERNAL);
    expect(result.code).not.toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('ВНУТРЕННЯЯ ОШИБКА ПРОВЕРКИ');
  });

  it('отклоняет набор, чей манифест не описывает конфигурацию', async () => {
    // Набор прежнего формата: тайлы защищены, конфигурация — нет. Именно так
    // выглядел граф, на котором пилот получил 400 по бюджету пар. «Старый
    // формат» здесь означал бы ровно ту дыру, ради которой поле и добавлено.
    await writeManifest({ config: undefined });

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('не описывает конфигурацию');
  });

  it('отклоняет подменённую конфигурацию при неизменных тайлах', async () => {
    // Тайлы те же, а пределы другие: расчёт того же дня стал бы отказом
    // маршрутизатора. Идентичность набора обязана это ловить.
    await writeFile(configPath, configWithBudget(2500));
    await utimes(configPath, BUILD_TIME, BUILD_TIME);

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('содержимое конфигурации графа не совпало');
  });

  it('отклоняет отсутствующую конфигурацию', async () => {
    await rm(configPath);

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('конфигурация графа отсутствует');
  });

  it('отклоняет конфигурацию, уводящую за пределы каталога набора', async () => {
    await writeManifest({
      config: { path: '../снаружи.json', bytes: configBytes.length, sha256: sha256(configBytes) },
    });

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('недопустимый путь конфигурации');
  });

  it('отклоняет недостаточный бюджет матрицы у любого из профилей', async () => {
    for (const [auto, pedestrian] of [
      [2500, 3600],
      [3600, 2500],
    ] as const) {
      await writeConfig(configWithBudget(auto, pedestrian));
      await writeManifest();

      const result = await runVerifier(['graph', root, tilesSha]);

      expect(result.code, `бюджет ${auto}/${pedestrian}`).toBe(EXIT_MISMATCH);
      expect(result.stderr).toContain('бюджет матрицы профиля');
      expect(result.stderr).toContain('3600');
    }
  });

  it('принимает бюджет больше необходимого', async () => {
    // Требование — «не меньше»: запас не является ошибкой.
    await writeConfig(configWithBudget(10_000));
    await writeManifest();

    const result = await runVerifier(['graph', root, tilesSha]);

    expect(result.code, result.stderr).toBe(0);
  });

  it('не трогает проверяемый набор', async () => {
    const before = await stat(tilesPath);

    await runVerifier(['graph', root, tilesSha]);

    const after = await stat(tilesPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(sha256(await readFile(tilesPath))).toBe(tilesSha);
  });
});

describe('проверка выкатки судит о путях так же, как приложение', () => {
  let root: string;

  async function writeBasemapManifest(artifactPath: string): Promise<void> {
    const data = Buffer.from('содержимое', 'utf8');
    const file = path.join(root, artifactPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);

    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        format: 'flowers-logistics/basemap-manifest@1',
        revision: 'test0001',
        style: artifactPath,
        artifacts: [
          {
            path: artifactPath,
            bytes: data.length,
            sha256: sha256(data),
            contentType: 'application/x-protobuf',
          },
        ],
      }),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'basemap-paths-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('каталог шрифтов с пробелами принимается', async () => {
    // Формат настоящего набора: 256 файлов глифов лежат в «Noto Sans Regular».
    await writeBasemapManifest('fonts/Noto Sans Regular/0-255.pbf');

    const result = await runVerifier(['basemap', root]);

    expect(result.code, result.stderr).toBe(0);
  });

  it('обход каталога в манифесте отклоняется как несовпадение', async () => {
    await writeBasemapManifest('ok.pbf');
    const manifestPath = path.join(root, 'manifest.json');

    for (const bad of ['../outside.pbf', 'a/../../outside.pbf', '/etc/passwd', 'a//b.pbf', '.']) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        style: string;
        artifacts: { path: string }[];
      };
      manifest.artifacts[0]!.path = bad;
      manifest.style = bad;
      await writeFile(manifestPath, JSON.stringify(manifest));

      const result = await runVerifier(['basemap', root]);

      expect(result.code, `путь «${bad}» должен быть отклонён`).toBe(EXIT_MISMATCH);
      expect(result.stderr).toContain('недопустимый путь');
    }
  });

  it('символическая ссылка за пределы набора отклоняется', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'basemap-outside-'));
    try {
      const secret = path.join(outside, 'secret.pbf');
      const data = Buffer.from('посторонний файл', 'utf8');
      await writeFile(secret, data);

      await symlink(secret, path.join(root, 'escape.pbf'));
      await writeFile(
        path.join(root, 'manifest.json'),
        JSON.stringify({
          format: 'flowers-logistics/basemap-manifest@1',
          revision: 'test0001',
          style: 'escape.pbf',
          artifacts: [
            {
              path: 'escape.pbf',
              bytes: data.length,
              sha256: sha256(data),
              contentType: 'application/x-protobuf',
            },
          ],
        }),
      );

      const result = await runVerifier(['basemap', root]);

      expect(result.code).toBe(EXIT_MISMATCH);
      expect(result.stderr).toContain('выходит за пределы каталога набора');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('стиль обязан быть перечислен и иметь допустимый путь', async () => {
    await writeBasemapManifest('ok.pbf');
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { style: string };
    manifest.style = 'нет-такого.json';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await runVerifier(['basemap', root]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('не перечислен в манифесте');
  });
});

describe('готовность маршрутизатора проверяется отдельно от идентичности', () => {
  let server: Server;
  let url: string;
  let statusBody: unknown;
  let matrixHandler: (costing: string, size: number) => { code: number; body: unknown };
  /** Размеры матриц, которые проверка фактически запросила. */
  let asked: { costing: string; size: number }[];

  /** Полная матрица запрошенного размера: все элементы заполнены. */
  function fullMatrix(size: number): unknown {
    return {
      sources_to_targets: Array.from({ length: size }, (_, from) =>
        Array.from({ length: size }, (_, to) => ({
          from_index: from,
          to_index: to,
          time: from === to ? 0 : 60 + Math.abs(from - to),
          distance: from === to ? 0 : 0.5 * Math.abs(from - to),
        })),
      ),
    };
  }

  beforeEach(async () => {
    asked = [];
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674 };
    matrixHandler = (_costing, size) => ({ code: 200, body: fullMatrix(size) });

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
        const parsed = JSON.parse(raw) as { costing: string; sources: unknown[] };
        asked.push({ costing: parsed.costing, size: parsed.sources.length });
        const answer = matrixHandler(parsed.costing, parsed.sources.length);
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

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('не сообщил, что набор тайлов загружен');
  });

  it('отказывает при has_tiles = false', async () => {
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674, has_tiles: false };

    const result = await runVerifier(['routing', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('набор тайлов недоступен');
  });

  it('считает ПРЕДЕЛЬНУЮ матрицу обоими профилями и отдельно регрессию FOOT', async () => {
    const result = await runVerifier(['matrix', url]);

    expect(result.code, result.stderr).toBe(0);
    // Прежняя проверка спрашивала две точки и объявляла маршрутизатор
    // исправным. Именно её прошёл граф, на котором пилот тут же получил
    // отказ на 60 точках. Теперь спрашивается предельный размер.
    expect(asked).toEqual([
      { costing: 'auto', size: 60 },
      { costing: 'pedestrian', size: 60 },
      { costing: 'pedestrian', size: 6 },
    ]);
  });

  it('отказывает, если пеший профиль не находит пути', async () => {
    // Набор загружен, автомобильный профиль считает — а пешего в тайлах нет.
    // Загруженность набора этот случай не ловит, потому и нужен расчёт.
    matrixHandler = (costing, size) =>
      costing === 'pedestrian'
        ? {
            code: 200,
            body: {
              sources_to_targets: Array.from({ length: size }, (_, from) =>
                Array.from({ length: size }, (_, to) => ({
                  from_index: from,
                  to_index: to,
                  time: from === to ? 0 : null,
                  distance: from === to ? 0 : null,
                })),
              ),
            },
          }
        : { code: 200, body: fullMatrix(size) };

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('недостижимых элементов');
  });

  it('отказывает на единственной недостижимой паре', async () => {
    // Одна пустая пара — это уже не «почти полная матрица»: пилот на ней
    // закрывает ворота, и выкатка обязана останавливаться раньше.
    matrixHandler = (_costing, size) => {
      const body = fullMatrix(size) as {
        sources_to_targets: { time: number | null }[][];
      };
      body.sources_to_targets[0]![1]!.time = null;
      return { code: 200, body };
    };

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('недостижимых элементов');
  });

  it('отказывает на 4xx: именно так выглядел недостаточный бюджет пар', async () => {
    matrixHandler = () => ({ code: 400, body: { error: 'Exceeded max locations' } });

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('отклонён кодом 400');
  });

  it('отказывает на 5xx: именно так выглядел внутренний отказ FOOT', async () => {
    matrixHandler = (costing, size) =>
      costing === 'pedestrian'
        ? { code: 500, body: { error: 'GetTags: offset exceeds size of text list' } }
        : { code: 200, body: fullMatrix(size) };

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('отклонён кодом 500');
    // Текст чужой ошибки наружу не переносится: наружу идёт код.
    expect(result.stderr).not.toContain('GetTags');
  });

  it('отказывает, если матрица вернулась не того размера', async () => {
    matrixHandler = (_costing, size) => ({ code: 200, body: fullMatrix(size - 1) });

    const result = await runVerifier(['matrix', url]);

    expect(result.code).toBe(EXIT_MISMATCH);
    expect(result.stderr).toContain('элементов вместо');
  });

  it('не принимает ревизию как аргумент проверки готовности', async () => {
    // Лишний аргумент игнорируется, но результат обязан остаться прежним:
    // сравнения метки времени с чем бы то ни было в этом режиме нет.
    statusBody = { version: '3.8.3', tileset_last_modified: 1786365674 };

    const result = await runVerifier(['routing', url, 'a'.repeat(64)]);

    expect(result.code, result.stderr).toBe(0);
  });
});
