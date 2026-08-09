/**
 * Критические проверки сборки подложки.
 *
 * Настоящий planetiler здесь не запускается: он подменяется заглушкой `docker`,
 * которая либо изображает успех, либо падает. Проверяются свойства, нарушение
 * которых опасно, — атомарность результата, обязательность границ и лицензий,
 * закреплённость образа и правдивость манифеста.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools/geo/build-basemap.sh');

const BBOX = '30.6998,49.5045,47.6702,59.6533';
const ASSETS_REVISION = 'protomaps/basemaps-assets@028c18f713baecad011301ff7a69acc39bcc2ae7';

/**
 * Заглушка docker.
 *
 * По умолчанию изображает успешную сборку: создаёт непустой файл архива там,
 * куда planetiler писал бы результат. При `DOCKER_FAILS=1` падает — так
 * проверяется, что окончательный каталог при неудаче не появляется.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"

if [ "\${DOCKER_FAILS:-0}" = "1" ]; then
  printf 'planetiler: сборка не удалась\\n' >&2
  exit 1
fi

# Находим смонтированный каталог результата и имя выходного файла.
out_dir=""
out_name=""
for arg in "$@"; do
  case "$arg" in
    *:/output) out_dir="\${arg%%:*}" ;;
    --output=*) out_name="\${arg#--output=/output/}" ;;
  esac
done

if [ -n "$out_dir" ] && [ -n "$out_name" ]; then
  printf 'PMTiles' > "\${out_dir}/\${out_name}"
  printf '\\003' >> "\${out_dir}/\${out_name}"
  head -c 200 /dev/zero >> "\${out_dir}/\${out_name}"
fi
exit 0
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  docker: string;
}

interface Sandbox {
  dir: string;
  assets: string;
  sources: string;
  input: string;
  output: string;
}

async function makeSandbox(options: { licenses?: boolean } = {}): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl basemap '));

  const assets = path.join(dir, 'assets');
  await mkdir(path.join(assets, 'sprite'), { recursive: true });
  await mkdir(path.join(assets, 'fonts', 'Noto Sans Regular'), { recursive: true });
  await mkdir(path.join(assets, 'licenses'), { recursive: true });

  await writeFile(path.join(assets, 'sprite/sprite.json'), '{}\n', 'utf8');
  await writeFile(path.join(assets, 'sprite/sprite.png'), Buffer.from([0x89, 0x50]), 'utf8');
  await writeFile(path.join(assets, 'fonts/Noto Sans Regular/0-255.pbf'), Buffer.from([0x1a]));

  if (options.licenses !== false) {
    await writeFile(
      path.join(assets, 'licenses/fonts-OFL-1.1.txt'),
      'SIL OPEN FONT LICENSE Version 1.1\n',
      'utf8',
    );
    await writeFile(
      path.join(assets, 'licenses/sprites-MIT.txt'),
      'MIT License (Tangram icons)\n',
      'utf8',
    );
  }

  const sources = path.join(dir, 'sources');
  await mkdir(sources, { recursive: true });
  for (const name of [
    'lake_centerline.shp.zip',
    'water-polygons-split-3857.zip',
    'natural_earth_vector.sqlite.zip',
  ]) {
    await writeFile(path.join(sources, name), 'заглушка\n', 'utf8');
  }

  const input = path.join(dir, 'регион.osm.pbf');
  await writeFile(input, 'заглушка входных данных\n', 'utf8');

  return { dir, assets, sources, input, output: path.join(dir, 'artifacts/basemap-20260806') };
}

async function runBuild(
  sandbox: Sandbox,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const binDir = path.join(sandbox.dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const dockerPath = path.join(binDir, 'docker');
  await writeFile(dockerPath, FAKE_DOCKER, 'utf8');
  await chmod(dockerPath, 0o755);

  const dockerLog = path.join(sandbox.dir, 'docker.log');
  await writeFile(dockerLog, '', 'utf8');

  await mkdir(path.dirname(sandbox.output), { recursive: true });

  const args = [
    '--input',
    sandbox.input,
    '--region',
    'Центральный федеральный округ',
    '--source-date',
    '2026-08-06',
    '--bbox',
    BBOX,
    '--assets',
    sandbox.assets,
    '--assets-revision',
    ASSETS_REVISION,
    '--sources',
    sandbox.sources,
    '--output',
    sandbox.output,
    ...extra,
  ];

  try {
    const { stdout, stderr } = await execFileAsync(SCRIPT, args, {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        DOCKER_LOG: dockerLog,
        ...env,
      },
    });
    return { code: 0, stdout, stderr, docker: await readFile(dockerLog, 'utf8') };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      docker: await readFile(dockerLog, 'utf8').catch(() => ''),
    };
  }
}

/** Временные каталоги сборки рядом с целевым. Их не должно оставаться. */
async function leftovers(sandbox: Sandbox): Promise<string[]> {
  const parent = path.dirname(sandbox.output);
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(parent).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith('.basemap-build-'));
}

// ---------------------------------------------------------------------------

describe('атомарность результата', () => {
  it('успешная сборка создаёт окончательный каталог и не оставляет временных', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await runBuild(sandbox);

      expect(result.code, result.stderr).toBe(0);
      expect(existsSync(path.join(sandbox.output, 'manifest.json'))).toBe(true);
      expect(await leftovers(sandbox)).toEqual([]);
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });

  it('падение planetiler не оставляет окончательного каталога', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await runBuild(sandbox, [], { DOCKER_FAILS: '1' });

      expect(result.code).not.toBe(0);
      // Половина тайлов выглядит как целый архив ровно до того момента,
      // когда карта покажет пустоту. Поэтому окончательного пути быть не должно.
      expect(existsSync(sandbox.output)).toBe(false);
      // И собственный временный каталог тоже убран.
      expect(await leftovers(sandbox)).toEqual([]);
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });

  it('повтор с тем же путём после падения разрешён', async () => {
    const sandbox = await makeSandbox();
    try {
      const failed = await runBuild(sandbox, [], { DOCKER_FAILS: '1' });
      expect(failed.code).not.toBe(0);

      // Неудача не должна занимать имя: иначе повтор пришлось бы делать
      // под новым, а старое имя осталось бы навсегда мусором.
      const second = await runBuild(sandbox);
      expect(second.code, second.stderr).toBe(0);
      expect(existsSync(path.join(sandbox.output, 'manifest.json'))).toBe(true);
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });

  it('существующий готовый каталог не затрагивается', async () => {
    const sandbox = await makeSandbox();
    try {
      await mkdir(sandbox.output, { recursive: true });
      await writeFile(path.join(sandbox.output, 'manifest.json'), 'ДЕЙСТВУЮЩИЙ НАБОР\n', 'utf8');

      const result = await runBuild(sandbox);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('не перезаписываются');
      // Содержимое прежнего набора осталось нетронутым.
      expect(await readFile(path.join(sandbox.output, 'manifest.json'), 'utf8')).toBe(
        'ДЕЙСТВУЮЩИЙ НАБОР\n',
      );
      // И до Docker дело не дошло.
      expect(result.docker.trim()).toBe('');
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('обязательные входные данные', () => {
  it('отсутствующая лицензия останавливает сборку до Docker', async () => {
    const sandbox = await makeSandbox({ licenses: false });
    try {
      const result = await runBuild(sandbox);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('нет лицензии');
      expect(result.docker.trim()).toBe('');
      expect(existsSync(sandbox.output)).toBe(false);
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });

  it('отсутствующий вспомогательный источник останавливает сборку до Docker', async () => {
    const sandbox = await makeSandbox();
    try {
      await rm(path.join(sandbox.sources, 'water-polygons-split-3857.zip'));
      const result = await runBuild(sandbox);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('water-polygons-split-3857.zip');
      expect(result.docker.trim()).toBe('');
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });

  const BAD_BBOX: { title: string; value: string }[] = [
    { title: 'перевёрнутая долгота', value: '47.6702,49.5045,30.6998,59.6533' },
    { title: 'перевёрнутая широта', value: '30.6998,59.6533,47.6702,49.5045' },
    { title: 'вне диапазона', value: '30.6998,49.5045,200.0,59.6533' },
    { title: 'не число', value: '30.6998,49.5045,восток,59.6533' },
    { title: 'три значения', value: '30.6998,49.5045,47.6702' },
  ];

  for (const testCase of BAD_BBOX) {
    it(`границы отвергаются: ${testCase.title}`, async () => {
      const sandbox = await makeSandbox();
      try {
        const result = await runBuild(sandbox, ['--bbox', testCase.value]);

        expect(result.code, testCase.title).not.toBe(0);
        expect(result.docker.trim()).toBe('');
      } finally {
        await rm(sandbox.dir, { recursive: true, force: true });
      }
    });
  }
});

describe('манифест описывает набор правдиво', () => {
  let manifest: Record<string, unknown>;
  let artifacts: { path: string; contentType: string; bytes: number; sha256: string }[];

  beforeAll(async () => {
    const sandbox = await makeSandbox();
    const result = await runBuild(sandbox);
    expect(result.code, result.stderr).toBe(0);

    manifest = JSON.parse(
      await readFile(path.join(sandbox.output, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    artifacts = manifest['artifacts'] as typeof artifacts;

    await rm(sandbox.dir, { recursive: true, force: true });
  });

  it('границы записаны как переданы, а не значением по умолчанию', () => {
    expect(manifest['bbox']).toEqual([30.6998, 49.5045, 47.6702, 59.6533]);
  });

  it('ревизия ресурсов записана', () => {
    expect(manifest['assetsRevision']).toBe(ASSETS_REVISION);
  });

  it('обе лицензии присутствуют как text/plain с размером и суммой', () => {
    const licenses = artifacts.filter((item) => item.path.startsWith('licenses/'));

    expect(licenses.map((item) => item.path).sort()).toEqual([
      'licenses/fonts-OFL-1.1.txt',
      'licenses/sprites-MIT.txt',
    ]);

    for (const license of licenses) {
      expect(license.contentType, license.path).toBe('text/plain');
      expect(license.bytes, license.path).toBeGreaterThan(0);
      expect(license.sha256, license.path).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('суммы вспомогательных источников записаны', () => {
    const inputs = manifest['inputs'] as Record<string, string>;
    expect(Object.keys(inputs).sort()).toEqual([
      'lake_centerline.shp.zip',
      'natural_earth_vector.sqlite.zip',
      'water-polygons-split-3857.zip',
    ]);
  });
});

describe('закреплённость инструментов', () => {
  it('подсказка о загрузке источников использует тег и digest', async () => {
    const script = await readFile(SCRIPT, 'utf8');

    // Один тег можно переставить на другой образ, digest — нельзя.
    expect(script).toContain('${PLANETILER_IMAGE}@${PLANETILER_DIGEST}');
    // Голого тега в подсказке не осталось.
    expect(script).not.toMatch(/planetiler:0\.\d+\.\d+\s+--only-download/);
  });

  it('сборка запускает образ по digest и без сети', async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await runBuild(sandbox);

      expect(result.code, result.stderr).toBe(0);
      expect(result.docker).toContain('--network none');
      expect(result.docker).toMatch(/planetiler[^\s]*@sha256:[0-9a-f]{64}/);
      // Вспомогательные источники смонтированы только на чтение.
      expect(result.docker).toContain('/data/sources:ro');
    } finally {
      await rm(sandbox.dir, { recursive: true, force: true });
    }
  });
});
