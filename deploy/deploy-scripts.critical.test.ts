/**
 * Критические проверки команд выкатки.
 *
 * Staging и production могут стоять на одном физическом сервере. Это допустимо
 * только при полной изоляции ресурсов, поэтому здесь проверяется настоящий код
 * из common.sh: что изоляция требуется, что подтверждение прохождения staging
 * читается из staging-каталога и что без реальной конфигурации команда
 * отказывает, не дойдя до SSH.
 *
 * ssh подменяется заглушкой, которая записывает каждый вызов и отвечает заранее
 * заданным текстом. Реальных подключений тесты не выполняют.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/deploy-staging.sh');
const PRODUCTION_SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/deploy-production.sh');
const COMMON_LIB = path.join(REPO_ROOT, 'deploy/scripts/lib/common.sh');
const COMPOSE_FILE = path.join(REPO_ROOT, 'deploy/docker-compose.deploy.yml');

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';

/** Один сервер на оба окружения: именно этот случай и разрешается. */
const SHARED_HOST = 'server.invalid';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Убирает строки-комментарии: в них запрещённые конструкции упоминаются намеренно. */
function withoutComments(content: string): string {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

async function run(script: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(script, args, {
      cwd: REPO_ROOT,
      ...(env === undefined ? {} : { env }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

// --- Песочница с подменённым ssh -----------------------------------------

/**
 * Заглушка ssh.
 *
 * Отвечает по содержимому команды: маркер окружения зависит от каталога,
 * подтверждение версии выдаётся только для файла в staging-каталоге.
 *
 * Дополнительно ведёт себя как настоящий ssh в одном важном месте: значение
 * `UserKnownHostsFile` — это список файлов, разделённых пробелами. Путь
 * с пробелами без буквальных внутренних кавычек настоящий ssh разобрал бы
 * как несколько путей и не нашёл бы ключ хоста, поэтому заглушка такой вызов
 * отвергает. Каждое переданное значение записывается отдельным журналом,
 * чтобы тест мог проверить кавычки явно, а не только по коду возврата.
 */
const FAKE_SSH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SSH_LOG"

# Крошечная имитация файловой системы сервера.
#
# Безопасные файловые команды выкатки выполняются по-настоящему, но с путями,
# перенесёнными в отдельный каталог. Без этого проверка сверки и замены
# ничего бы не проверяла: файлов, о которых идёт речь, просто не было бы.
sandbox_run() {
  local rewritten="\${1//\\/srv\\//$SSH_FS_DIR\\/srv\\/}"
  eval "$rewritten"
}

for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*)
      value="\${arg#UserKnownHostsFile=}"
      printf '%s\\n' "$value" >> "\${KNOWN_HOSTS_ARG_LOG:-/dev/null}"
      case "$value" in
        *" "*)
          case "$value" in
            '"'*'"') ;;
            *)
              printf 'ssh: путь known_hosts с пробелами передан без внутренних кавычек: %s\\n' "$value" >&2
              exit 2
              ;;
          esac
          ;;
      esac
      ;;
  esac
done

cmd="\${*: -1}"

# Каждая проверка может быть настроена на отказ по отдельности: так
# проверяется, что провалившаяся проверка останавливает выкатку ДО миграций
# и до запуска приложения — схема и работающая версия остаются прежними.
case "$cmd" in
  *"verify-geo.mjs 'graph'"*)
    if [ "\${GRAPH_FAILS:-0}" = "1" ]; then
      printf 'ОТКАЗ: содержимое набора тайлов не совпало\\n' >&2
      exit 1
    fi
    ;;
  *'verify-geo.mjs routing'*)
    if [ "\${ROUTING_FAILS:-0}" = "1" ]; then
      printf 'ОТКАЗ: маршрутизатор не сообщил, что набор тайлов загружен\\n' >&2
      exit 1
    fi
    ;;
  *'verify-geo.mjs matrix'*)
    if [ -n "\${MATRIX_FAILS:-}" ]; then
      printf 'ОТКАЗ: пробный расчёт «%s» не нашёл ни одного пути\\n' "\${MATRIX_FAILS}" >&2
      exit 1
    fi
    ;;
esac

case "$cmd" in
  printf*'base64 -d >'*|sha256sum*|"mv "*|"rm -f "*)
    if [ -n "\${DELIVERY_SHA_REPLY:-}" ] && [ "\${cmd#sha256sum}" != "$cmd" ]; then
      # Подменённый ответ моделирует повреждение передачи.
      printf '%s  подменённая-сумма\\n' "\${DELIVERY_SHA_REPLY}"
    else
      sandbox_run "$cmd"
    fi
    exit 0
    ;;
  *"$STAGING_DIR/ENVIRONMENT"*)   printf '%s\\n' "\${STAGING_MARKER_REPLY:-staging}" ;;
  *"$PRODUCTION_DIR/ENVIRONMENT"*) printf '%s\\n' "\${PRODUCTION_MARKER_REPLY:-production}" ;;
  *'docker image inspect'*) printf '%s\\n' "$VERSION_UNDER_TEST" ;;
  *"$STAGING_DIR/state/verified-versions"*)
    if [ "\${STAGING_HAS_VERSION:-0}" = "1" ]; then printf '%s\\n' "$VERSION_UNDER_TEST"; fi
    ;;
esac
exit 0
`;

/**
 * Идентичность графа в песочнице: SHA-256 из 64 шестнадцатеричных символов.
 *
 * Числовое время сюда подставить нельзя — проверка формата отвергнет его
 * ещё до обращения к серверу, и это отдельно проверяется ниже.
 */
const GRAPH_SHA = '0f'.repeat(32);

interface EnvironmentValues {
  ENVIRONMENT_MARKER: string;
  SSH_HOST: string;
  REMOTE_DIR: string;
  APP_HOST_PORT: string;
  COMPOSE_PROJECT: string;
  ENV_FILE: string;
  DB_VOLUME: string;
  IMAGE_REPOSITORY: string;
  MAP_ARTIFACTS_DIR: string;
  VALHALLA_GRAPH_DIR: string;
  VALHALLA_GRAPH_SHA256: string;
  VALHALLA_IMAGE: string;
}

const STAGING_DEFAULTS: EnvironmentValues = {
  ENVIRONMENT_MARKER: 'staging',
  SSH_HOST: SHARED_HOST,
  REMOTE_DIR: '/srv/flowers-logistics-staging',
  APP_HOST_PORT: '3001',
  COMPOSE_PROJECT: 'fl-staging',
  ENV_FILE: 'staging.env',
  DB_VOLUME: 'fl-staging-db',
  IMAGE_REPOSITORY: 'ghcr.io/example/app',
  MAP_ARTIFACTS_DIR: '/srv/geo/basemap/20260801',
  VALHALLA_GRAPH_DIR: '/srv/geo/valhalla/20260801',
  VALHALLA_GRAPH_SHA256: GRAPH_SHA,
  VALHALLA_IMAGE: 'ghcr.io/valhalla/valhalla:3.8.3@sha256:aaaa',
};

const PRODUCTION_DEFAULTS: EnvironmentValues = {
  ENVIRONMENT_MARKER: 'production',
  SSH_HOST: SHARED_HOST,
  REMOTE_DIR: '/srv/flowers-logistics-production',
  APP_HOST_PORT: '3000',
  COMPOSE_PROJECT: 'fl-production',
  ENV_FILE: 'production.env',
  DB_VOLUME: 'fl-production-db',
  IMAGE_REPOSITORY: 'ghcr.io/example/app',
  MAP_ARTIFACTS_DIR: '/srv/geo/basemap/20260801',
  VALHALLA_GRAPH_DIR: '/srv/geo/valhalla/20260801',
  VALHALLA_GRAPH_SHA256: GRAPH_SHA,
  VALHALLA_IMAGE: 'ghcr.io/valhalla/valhalla:3.8.3@sha256:aaaa',
};

function configContent(values: EnvironmentValues, name: string): string {
  return [
    `ENVIRONMENT_MARKER="${values.ENVIRONMENT_MARKER}"`,
    `SSH_HOST="${values.SSH_HOST}"`,
    `SSH_USER="deploy-${name}"`,
    'SSH_PORT="22"',
    `HOST_FINGERPRINT="${values.SSH_HOST} ssh-ed25519 AAAATEST"`,
    `REMOTE_DIR="${values.REMOTE_DIR}"`,
    `APP_DOMAIN="${name}.invalid"`,
    `APP_HOST_PORT="${values.APP_HOST_PORT}"`,
    `IMAGE_REPOSITORY="${values.IMAGE_REPOSITORY}"`,
    `COMPOSE_PROJECT="${values.COMPOSE_PROJECT}"`,
    'COMPOSE_FILE="docker-compose.deploy.yml"',
    `ENV_FILE="${values.ENV_FILE}"`,
    `DB_VOLUME="${values.DB_VOLUME}"`,
    `MAP_ARTIFACTS_DIR="${values.MAP_ARTIFACTS_DIR}"`,
    `VALHALLA_GRAPH_DIR="${values.VALHALLA_GRAPH_DIR}"`,
    `VALHALLA_GRAPH_SHA256="${values.VALHALLA_GRAPH_SHA256}"`,
    `VALHALLA_IMAGE="${values.VALHALLA_IMAGE}"`,
    '',
  ].join('\n');
}

interface SandboxOptions {
  staging?: Partial<EnvironmentValues>;
  production?: Partial<EnvironmentValues>;
  /** Какие конфигурации создать. По умолчанию обе. */
  configs?: 'both' | 'none';
  stagingHasVersion?: boolean;
  stagingMarkerReply?: string;
  productionMarkerReply?: string;
  /** Заставляет проверку маршрутизатора отвечать отказом. */
  routingFails?: boolean;
  /** Заставляет проверку содержимого графа отвечать отказом. */
  graphFails?: boolean;
  /** Заставляет пробный расчёт отвечать отказом. Значение — имя профиля. */
  matrixFails?: 'auto' | 'pedestrian';
  /** Подменённый ответ сервера на sha256sum: моделирует повреждение передачи. */
  deliveryShaReply?: string;
  /** Версия, которую «выкатывают». По умолчанию — фиксированный SHA. */
  version?: string;
  /**
   * Создать в песочнице настоящий репозиторий с двумя версиями файлов.
   * Возвращает SHA первой версии — им и подменяется VERSION.
   */
  withGitHistory?: boolean;
  /** Строки, выполняемые после загрузки конфигураций. */
  body: string;
}

/**
 * Выполняет фрагмент на настоящем common.sh с подменённым ssh.
 * Возвращает результат, журнал обращений к ssh и переданные пути known_hosts.
 *
 * Каталог песочницы намеренно содержит пробел: рабочая папка проекта тоже
 * содержит пробелы, и путь без пробелов скрыл бы ошибки цитирования.
 */
async function runInSandbox(options: SandboxOptions): Promise<
  RunResult & {
    ssh: string;
    knownHostsArgs: string[];
    oldVersionSha: string;
    dir: string;
    remoteFile: (remotePath: string) => Promise<string | null>;
  }
> {
  const staging = { ...STAGING_DEFAULTS, ...options.staging };
  const production = { ...PRODUCTION_DEFAULTS, ...options.production };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl deploy '));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const sshPath = path.join(binDir, 'ssh');
  await writeFile(sshPath, FAKE_SSH, 'utf8');
  await chmod(sshPath, 0o755);

  const sshLog = path.join(dir, 'ssh.log');
  await writeFile(sshLog, '', 'utf8');

  const knownHostsLog = path.join(dir, 'known-hosts-args.log');
  await writeFile(knownHostsLog, '', 'utf8');

  // Имитация файлов сервера. В неё заранее кладётся действующий Compose-файл:
  // проверка обязана доказать, что испорченная передача его не тронула.
  const fsDir = path.join(dir, 'server-fs');
  await mkdir(path.join(fsDir, staging.REMOTE_DIR.replace(/^\//, '')), { recursive: true });
  await mkdir(path.join(fsDir, production.REMOTE_DIR.replace(/^\//, '')), { recursive: true });
  await writeFile(
    path.join(fsDir, `${staging.REMOTE_DIR}/docker-compose.deploy.yml`),
    EXISTING_REMOTE_COMPOSE,
    'utf8',
  );

  // Настоящий Compose-файл кладётся в песочницу: команда выкатки берёт его
  // из дерева версии, и без репозитория проверка доставки была бы фикцией.
  await mkdir(path.join(dir, 'deploy/scripts'), { recursive: true });
  await writeFile(
    path.join(dir, 'deploy/docker-compose.deploy.yml'),
    await readFile(COMPOSE_FILE, 'utf8'),
    'utf8',
  );
  await writeFile(
    path.join(dir, 'deploy/scripts/verify-geo.mjs'),
    await readFile(path.join(REPO_ROOT, 'deploy/scripts/verify-geo.mjs'), 'utf8'),
    'utf8',
  );

  // История из двух версий: доставляться обязано содержимое VERSION,
  // а не то, что лежит в рабочем дереве прямо сейчас.
  let oldVersionSha = '';
  if (options.withGitHistory === true) {
    const git = async (...args: string[]): Promise<string> =>
      (await execFileAsync('git', ['-C', dir, ...args])).stdout.trim();

    await git('init', '-q');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Проверка');

    await writeFile(
      path.join(dir, 'deploy/docker-compose.deploy.yml'),
      'СТАРАЯ ВЕРСИЯ COMPOSE\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'deploy/scripts/verify-geo.mjs'),
      '// СТАРАЯ ВЕРСИЯ ПРОВЕРЯЮЩЕГО СКРИПТА\n',
      'utf8',
    );
    await git('add', '-A');
    await git('commit', '-q', '-m', 'старая версия');
    oldVersionSha = await git('rev-parse', 'HEAD');

    // Рабочее дерево уходит вперёд: именно его брала прежняя реализация.
    await writeFile(
      path.join(dir, 'deploy/docker-compose.deploy.yml'),
      'НОВАЯ ВЕРСИЯ COMPOSE\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'deploy/scripts/verify-geo.mjs'),
      '// НОВАЯ ВЕРСИЯ ПРОВЕРЯЮЩЕГО СКРИПТА\n',
      'utf8',
    );
    await git('add', '-A');
    await git('commit', '-q', '-m', 'новая версия');
  }

  if (options.configs !== 'none') {
    await mkdir(path.join(dir, 'deploy/private'), { recursive: true });
    await writeFile(
      path.join(dir, 'deploy/private/staging.conf'),
      configContent(staging, 'staging'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'deploy/private/production.conf'),
      configContent(production, 'production'),
      'utf8',
    );
  }

  const harnessPath = path.join(dir, 'harness.sh');
  await writeFile(
    harnessPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `source "${COMMON_LIB}"`,
      `REPO_ROOT="${dir}"`,
      `VERSION="${options.version ?? (oldVersionSha === '' ? VALID_SHA : oldVersionSha)}"`,
      options.body,
      "printf 'проверки пройдены\\n'",
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(harnessPath, 0o755);

  const result = await run(harnessPath, [], {
    ...process.env,
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    SSH_LOG: sshLog,
    KNOWN_HOSTS_ARG_LOG: knownHostsLog,
    SSH_FS_DIR: fsDir,
    VERSION_UNDER_TEST: VALID_SHA,
    STAGING_DIR: staging.REMOTE_DIR,
    PRODUCTION_DIR: production.REMOTE_DIR,
    STAGING_HAS_VERSION: options.stagingHasVersion === false ? '0' : '1',
    ROUTING_FAILS: options.routingFails === true ? '1' : '0',
    GRAPH_FAILS: options.graphFails === true ? '1' : '0',
    ...(options.matrixFails === undefined ? {} : { MATRIX_FAILS: options.matrixFails }),
    // Проверке незачем ждать загрузку графа: она проверяет поведение при
    // отказе, а не терпение команды выкатки.
    ROUTING_CHECK_ATTEMPTS: '2',
    ROUTING_CHECK_DELAY: '0',
    ...(options.deliveryShaReply === undefined
      ? {}
      : { DELIVERY_SHA_REPLY: options.deliveryShaReply }),
    ...(options.stagingMarkerReply === undefined
      ? {}
      : { STAGING_MARKER_REPLY: options.stagingMarkerReply }),
    ...(options.productionMarkerReply === undefined
      ? {}
      : { PRODUCTION_MARKER_REPLY: options.productionMarkerReply }),
  });

  return {
    ...result,
    ssh: await readFile(sshLog, 'utf8'),
    knownHostsArgs: (await readFile(knownHostsLog, 'utf8')).split('\n').filter((v) => v !== ''),
    oldVersionSha,
    dir,
    /** Содержимое файла в имитации серверной файловой системы. */
    remoteFile: async (remotePath: string): Promise<string | null> => {
      try {
        return await readFile(path.join(fsDir, remotePath), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** Что лежит на сервере до выкатки: старый Compose-файл. */
const EXISTING_REMOTE_COMPOSE = 'ДЕЙСТВУЮЩИЙ COMPOSE НА СЕРВЕРЕ\n';

/** Достаёт полезную нагрузку доставки из журнала ssh и раскодирует её. */
function deliveredContent(sshLog: string, remoteSuffix: string): string | null {
  for (const line of sshLog.split('\n')) {
    if (!line.includes('base64 -d') || !line.includes(remoteSuffix)) {
      continue;
    }
    const match = /printf '%s' '([A-Za-z0-9+/=]*)'/.exec(line);
    if (match?.[1] !== undefined) {
      return Buffer.from(match[1], 'base64').toString('utf8');
    }
  }
  return null;
}

/** Загрузка обеих конфигураций и проверка изоляции — общее начало сценариев. */
const LOAD_BOTH = [
  'load_environment_config STAGING "$(staging_config_file)"',
  'load_environment_config PRODUCTION "$(production_config_file)"',
  'require_isolated_environments',
].join('\n');

describe('сухой прогон', () => {
  it('staging показывает план и не выполняет изменений', async () => {
    const result = await run(STAGING_SCRIPT, ['--version', VALID_SHA, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('План выкатки на staging');
    expect(result.stdout).toContain('Изменений не выполнено');
    expect(result.stdout).toContain(VALID_SHA);
  });

  it('production показывает план с обязательными шагами', async () => {
    const result = await run(PRODUCTION_SCRIPT, ['--version', VALID_SHA, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('План выкатки на production');
    // Обязательные шаги production перечислены в плане.
    expect(result.stdout).toContain('успешно проверена на staging');
    expect(result.stdout).toContain('резервного копирования');
    expect(result.stdout).toContain('PRODUCTION');
    expect(result.stdout).toContain('Изменений не выполнено');
  });

  it('сухой прогон не обращается к сети даже с доступным ssh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-dry-'));
    const binDir = path.join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const sshLog = path.join(dir, 'ssh.log');
    await writeFile(sshLog, '', 'utf8');
    await writeFile(path.join(binDir, 'ssh'), FAKE_SSH, 'utf8');
    await chmod(path.join(binDir, 'ssh'), 0o755);

    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const result = await run(script, ['--version', VALID_SHA, '--dry-run'], {
        ...process.env,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        SSH_LOG: sshLog,
        STAGING_DIR: '/srv/x',
        PRODUCTION_DIR: '/srv/y',
      });
      expect(result.code).toBe(0);
    }

    // Ни одного обращения к ssh: план печатается локально.
    expect(await readFile(sshLog, 'utf8')).toBe('');
  });
});

describe('отказ до обращения к серверу', () => {
  it('без версии команда не выполняется', async () => {
    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const result = await run(script, []);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('ОТКАЗ');
    }
  });

  it('короткий SHA, ветка и тег отвергаются', async () => {
    for (const version of ['abc1234', 'main', 'v1.0.0', 'HEAD']) {
      const result = await run(STAGING_SCRIPT, ['--version', version, '--dry-run']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('полным 40-символьным SHA');
    }
  });

  it('без реальной конфигурации команда отказывает и не идёт в ssh', async () => {
    const result = await runInSandbox({
      configs: 'none',
      body: 'load_environment_config STAGING "$(staging_config_file)"',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('не найдена конфигурация');
    expect(result.stderr).toContain('deploy/private/');
    expect(result.ssh).toBe('');
  });
});

describe('staging и production на одном сервере', () => {
  it('один SSH-хост разрешён, когда ресурсы изолированы', async () => {
    const result = await runInSandbox({ body: LOAD_BOTH });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('на одном сервере');
    expect(result.stdout).toContain('проверки пройдены');
    // Проверка выполняется до сети.
    expect(result.ssh).toBe('');
  });

  const collisions: { field: keyof EnvironmentValues; expected: string }[] = [
    { field: 'REMOTE_DIR', expected: 'каталог развёртывания' },
    { field: 'COMPOSE_PROJECT', expected: 'имя Compose-проекта' },
    { field: 'APP_HOST_PORT', expected: 'внешний порт приложения' },
    { field: 'DB_VOLUME', expected: 'том базы данных' },
    { field: 'ENV_FILE', expected: 'файл окружения' },
    { field: 'ENVIRONMENT_MARKER', expected: 'маркер окружения' },
  ];

  for (const collision of collisions) {
    it(`совпадение ${collision.field} останавливает выкатку`, async () => {
      const production: Partial<EnvironmentValues> = {};
      production[collision.field] = STAGING_DEFAULTS[collision.field];

      const result = await runInSandbox({ production, body: LOAD_BOTH });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(collision.expected);
      expect(result.stdout).not.toContain('проверки пройдены');
      // Отказ произошёл до любого обращения к серверу.
      expect(result.ssh).toBe('');
    });
  }
});

/**
 * Регрессия: рабочая папка проекта содержит пробелы, и путь к known_hosts
 * обязан доходить до ssh закавыченным. Без внутренних кавычек ssh считает
 * значение списком файлов, не находит ключ хоста и отказывает — выкатка
 * останавливалась на проверке маркера окружения.
 */
describe('путь known_hosts с пробелами', () => {
  it('оба окружения передают путь в ssh закавыченным', async () => {
    const result = await runInSandbox({
      body: [
        LOAD_BOTH,
        'activate_environment PRODUCTION',
        'prepare_known_hosts',
        // Обращается к staging через remote_on.
        'require_staging_verification',
        // Обращается к production через тот же remote_on.
        'require_environment_marker',
      ].join('\n'),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('проверки пройдены');

    // Обращались к обоим окружениям, и каждое передало свой файл known_hosts.
    expect(result.knownHostsArgs.length).toBeGreaterThanOrEqual(2);
    expect(result.knownHostsArgs.some((value) => value.includes('known_hosts.staging'))).toBe(true);
    expect(result.knownHostsArgs.some((value) => value.includes('known_hosts.production'))).toBe(
      true,
    );

    for (const value of result.knownHostsArgs) {
      // Путь песочницы содержит пробел — иначе проверка ничего не значила бы.
      expect(value).toContain(' ');
      // Буквальные кавычки внутри значения опции: их разбирает сам ssh.
      expect(value.startsWith('"')).toBe(true);
      expect(value.endsWith('"')).toBe(true);
    }
  });
});

describe('подтверждение версии на staging', () => {
  const CONFIRM = [
    LOAD_BOTH,
    'activate_environment PRODUCTION',
    'prepare_known_hosts',
    'require_staging_verification',
    'require_environment_marker',
  ].join('\n');

  it('подтверждение читается из staging-каталога, маркер production проверяется отдельно', async () => {
    const result = await runInSandbox({ body: CONFIRM });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const verified = lines.find((line) => line.includes('verified-versions'));
    expect(verified).toBeDefined();
    // Список проверенных версий берётся только из staging-каталога.
    expect(verified).toContain(STAGING_DEFAULTS.REMOTE_DIR);
    expect(verified).not.toContain(PRODUCTION_DEFAULTS.REMOTE_DIR);

    // Маркер каждого окружения проверяется в его собственном каталоге.
    expect(
      lines.some(
        (line) =>
          line.includes(`${STAGING_DEFAULTS.REMOTE_DIR}/ENVIRONMENT`) &&
          !line.includes(PRODUCTION_DEFAULTS.REMOTE_DIR),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.includes(`${PRODUCTION_DEFAULTS.REMOTE_DIR}/ENVIRONMENT`)),
    ).toBe(true);

    // Отдельные known_hosts у каждого окружения и никакого accept-new.
    expect(result.ssh).toContain('known_hosts.staging');
    expect(result.ssh).toContain('known_hosts.production');
    for (const line of lines) {
      expect(line).toContain('StrictHostKeyChecking=yes');
    }
  });

  it('без записи в verified-versions выкатка останавливается', async () => {
    const result = await runInSandbox({ stagingHasVersion: false, body: CONFIRM });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('не была успешно проверена на staging');
    expect(result.stdout).not.toContain('проверки пройдены');
  });

  it('чужой маркер в staging-каталоге останавливает выкатку', async () => {
    const result = await runInSandbox({ stagingMarkerReply: 'production', body: CONFIRM });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('маркер окружения не совпал');
    // До чтения подтверждения дело не дошло.
    expect(result.ssh).not.toContain('verified-versions');
  });

  it('чужой маркер в production-каталоге останавливает выкатку', async () => {
    const result = await runInSandbox({ productionMarkerReply: 'staging', body: CONFIRM });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('маркер окружения не совпал');
    expect(result.stdout).not.toContain('проверки пройдены');
  });
});

describe('адрес образа', () => {
  /** Заведомо нестандартный репозиторий: значение по умолчанию его не подменит. */
  const CUSTOM_REPOSITORY = 'registry.example.invalid/team/custom-app';
  const CUSTOM_REFERENCE = `${CUSTOM_REPOSITORY}:${VALID_SHA}`;

  it('загрузка, сверка метки и запуск используют один и тот же образ', async () => {
    const result = await runInSandbox({
      production: { IMAGE_REPOSITORY: CUSTOM_REPOSITORY },
      body: [
        LOAD_BOTH,
        'activate_environment PRODUCTION',
        'prepare_known_hosts',
        `remote "docker pull '$(image_reference)'"`,
        'require_image_revision',
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const pull = lines.find((line) => line.includes('docker pull'));
    const inspect = lines.find((line) => line.includes('docker image inspect'));
    const compose = lines.find((line) => line.includes('docker compose'));

    // Все три шага работают с одной и той же полной ссылкой на образ.
    expect(pull).toContain(CUSTOM_REFERENCE);
    expect(inspect).toContain(CUSTOM_REFERENCE);
    expect(compose).toContain(`IMAGE_REPOSITORY='${CUSTOM_REPOSITORY}'`);
    expect(compose).toContain(`IMAGE_TAG='${VALID_SHA}'`);

    // Ни один шаг не подставил репозиторий по умолчанию.
    expect(result.ssh).not.toContain(STAGING_DEFAULTS.IMAGE_REPOSITORY);
  });

  it('адрес образа задан только конфигурацией', async () => {
    const compose = await readFile(COMPOSE_FILE, 'utf8');

    expect(compose).toContain('image: ${IMAGE_REPOSITORY}:${IMAGE_TAG}');

    // Второго, зашитого адреса нет ни в Compose, ни в скриптах: иначе скрипт
    // проверил бы OCI-метку одного образа, а Compose запустил бы другой.
    for (const file of [COMPOSE_FILE, COMMON_LIB, STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const content = withoutComments(await readFile(file, 'utf8'));
      expect(content).not.toMatch(/[\w.-]+\.[a-z]{2,}\/[\w./-]+:\$\{IMAGE_TAG\}/);
      expect(content).not.toContain('ghcr.io/');
    }
  });
});

describe('геостек в командах выкатки', () => {
  it('compose_command передаёт все переменные из YAML при пустом окружении сервера', async () => {
    // Compose разбирает файл ЦЕЛИКОМ даже для `run app`. Пропущенная переменная
    // становится пустой строкой: получается сервис без образа и bind mount
    // из пустого пути. Поэтому команда обязана быть самодостаточной.
    const result = await runInSandbox({
      body: [LOAD_BOTH, 'activate_environment STAGING', 'compose_command', "printf '\n'"].join(
        '\n',
      ),
    });

    expect(result.code).toBe(0);

    for (const variable of [
      "MAP_ARTIFACTS_DIR='/srv/geo/basemap/20260801'",
      "VALHALLA_GRAPH_DIR='/srv/geo/valhalla/20260801'",
      `VALHALLA_GRAPH_SHA256='${GRAPH_SHA}'`,
      'VALHALLA_IMAGE=',
      "IMAGE_REPOSITORY='ghcr.io/example/app'",
      "ENV_FILE='staging.env'",
      "DB_VOLUME='fl-staging-db'",
      "APP_HOST_PORT='3001'",
    ]) {
      expect(result.stdout, variable).toContain(variable);
    }

    // Ни одна переменная YAML не осталась незаданной.
    const compose = await readFile(COMPOSE_FILE, 'utf8');
    const referenced = [...compose.matchAll(/\$\{([A-Z_]+)\}/g)].map((match) => match[1] ?? '');
    for (const name of new Set(referenced)) {
      expect(result.stdout, `переменная ${name} не передана Compose`).toContain(`${name}=`);
    }
  });

  it('Compose внедряет приложению внутренние пути, адрес маршрутизатора и ревизию', async () => {
    const compose = withoutComments(await readFile(COMPOSE_FILE, 'utf8'));

    // Приложение обязано получить их само: иначе подложка окажется
    // «не настроена», а расчёт времени не заработает вовсе.
    expect(compose).toContain('MAP_ARTIFACTS_PATH: /srv/basemap');
    expect(compose).toContain('VALHALLA_URL: http://valhalla:8002');
    expect(compose).toContain('VALHALLA_GRAPH_SHA256: ${VALHALLA_GRAPH_SHA256}');

    // Каталоги монтируются только на чтение.
    expect(compose).toMatch(/source: \$\{MAP_ARTIFACTS_DIR\}[\s\S]*?read_only: true/);
    expect(compose).toMatch(/source: \$\{VALHALLA_GRAPH_DIR\}[\s\S]*?read_only: true/);
  });

  it('маршрутизатор получает явную команду запуска', async () => {
    const compose = withoutComments(await readFile(COMPOSE_FILE, 'utf8'));
    const valhalla = compose.slice(compose.indexOf('  valhalla:'));

    // У официального образа нет ни entrypoint, ни cmd: без команды контейнер
    // просто не запустится, а `up` отчитается об успехе.
    expect(valhalla).toContain('command:');
    expect(valhalla).toContain('valhalla_service');
    expect(valhalla).toContain('/custom_files/valhalla.json');
  });

  it('в описании маршрутизатора нет переменных чужого образа', async () => {
    const compose = withoutComments(await readFile(COMPOSE_FILE, 'utf8'));

    // Эти переменные понимает сторонний образ docker-valhalla, а не официальный.
    // Их присутствие создавало бы ложное впечатление настройки, которой нет.
    for (const foreign of ['use_tiles_ignore_pbf', 'build_tar', 'force_rebuild', 'serve_tiles']) {
      expect(compose, foreign).not.toContain(foreign);
    }
  });

  it('маршрутизатор наружу не публикуется ни одним портом', async () => {
    const compose = withoutComments(await readFile(COMPOSE_FILE, 'utf8'));

    const valhallaBlock = compose.slice(compose.indexOf('  valhalla:'));
    expect(valhallaBlock).not.toContain('ports:');
    // У приложения порт есть, но только на петлевом интерфейсе.
    expect(compose).toContain("- '127.0.0.1:${APP_HOST_PORT}:3000'");
  });

  it('обе команды соблюдают порядок: valhalla → её проверка → app → готовность', async () => {
    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const content = withoutComments(await readFile(script, 'utf8'));

      // Одновременный запуск выглядит быстрее, но приложение опрашивает /status
      // сразу при старте и успевает записать DEGRADED, пока граф загружается.
      // Это состояние осталось бы в базе даже после успешной проверки.
      expect(content, script).not.toContain('up -d --no-build valhalla app');

      const valhallaUp = content.indexOf('up -d --no-build valhalla"');
      const routingCheck = content.indexOf('require_routing_ready');
      const appUp = content.indexOf('up -d --no-build app"');
      const readyCheck = content.indexOf('require_ready');

      expect(valhallaUp, script).toBeGreaterThan(-1);
      expect(routingCheck, script).toBeGreaterThan(valhallaUp);
      expect(appUp, script).toBeGreaterThan(routingCheck);
      expect(readyCheck, script).toBeGreaterThan(appUp);

      expect(content, script).toContain('require_geo_artifacts');
    }
  });

  it('сверка выполняется до замены: сначала .new, потом mv', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'sync_compose_file',
        `remote "$(compose_command) up -d --no-build valhalla"`,
      ].join('\n'),
    });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const upload = lines.findIndex((line) => line.includes('base64 -d'));
    const verify = lines.findIndex((line) => line.includes('sha256sum'));
    const move = lines.findIndex((line) => line.startsWith('mv ') || line.includes(' mv '));
    const compose = lines.findIndex((line) => line.includes('docker compose'));

    expect(upload).toBeGreaterThan(-1);
    // Порядок обязателен: сверяется временная копия, и только потом
    // выполняется замена. Обратный порядок лишал бы сервер рабочего файла
    // ещё до того, как выяснится, что передача испорчена.
    expect(verify).toBeGreaterThan(upload);
    expect(move).toBeGreaterThan(verify);
    expect(compose).toBeGreaterThan(move);

    // Сверяется именно временная копия, а не уже заменённый файл.
    expect(lines[verify]).toContain('.new');

    // И замена действительно произошла: на сервере лежит версия из Git.
    const staging = STAGING_DEFAULTS.REMOTE_DIR;
    expect(await result.remoteFile(`${staging}/docker-compose.deploy.yml`)).toBe(
      'СТАРАЯ ВЕРСИЯ COMPOSE\n',
    );
    expect(await result.remoteFile(`${staging}/docker-compose.deploy.yml.new`)).toBeNull();
  });

  it('несовпадение суммы не выполняет замену и не трогает действующий файл', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      deliveryShaReply: 'f'.repeat(64),
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'sync_compose_file',
        `remote "$(compose_command) up -d --no-build valhalla"`,
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('не совпал с версией');

    // Действующий Compose на сервере остался прежним — это главное.
    const staging = STAGING_DEFAULTS.REMOTE_DIR;
    expect(await result.remoteFile(`${staging}/docker-compose.deploy.yml`)).toBe(
      'ДЕЙСТВУЮЩИЙ COMPOSE НА СЕРВЕРЕ\n',
    );
    // Временная копия убрана.
    expect(await result.remoteFile(`${staging}/docker-compose.deploy.yml.new`)).toBeNull();
    expect(result.ssh).not.toMatch(/(^|\s)mv /m);
    // Убрана только временная копия.
    expect(result.ssh).toMatch(/rm -f '[^']*\.new'/);
    // Ни одной команды Compose: состав окружения не подтверждён.
    expect(result.ssh).not.toContain('docker compose');
  });

  it('доставляется содержимое VERSION, а не рабочего дерева', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'sync_compose_file',
      ].join('\n'),
    });

    expect(result.code).toBe(0);
    // Рабочее дерево ушло вперёд, но выкатывается более старая версия:
    // именно её файл обязан оказаться на сервере.
    const delivered = deliveredContent(result.ssh, 'docker-compose.deploy.yml.new');
    expect(delivered).toBe('СТАРАЯ ВЕРСИЯ COMPOSE\n');
    expect(delivered).not.toContain('НОВАЯ ВЕРСИЯ');
  });

  it('проверяющий скрипт тоже берётся из дерева VERSION', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'upload_verifier',
      ].join('\n'),
    });

    expect(result.code).toBe(0);
    const delivered = deliveredContent(result.ssh, 'verify-geo.mjs.new');
    expect(delivered).toBe('// СТАРАЯ ВЕРСИЯ ПРОВЕРЯЮЩЕГО СКРИПТА\n');
  });

  it('более старый проверенный SHA выкатывать по-прежнему можно', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'sync_compose_file',
      ].join('\n'),
    });

    // Никакого запрета на старую версию: она проверена и лежит в origin/main.
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('нет файла');
  });

  it('отсутствие файла в дереве версии останавливает выкатку', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'deliver_versioned_file "deploy/не-существует.yml" "/srv/цель.yml"',
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('нет файла');
    // До сервера дело не дошло вовсе.
    expect(result.ssh).not.toContain('base64 -d');
  });

  it('сухой прогон не доставляет файлы и не создаёт временных копий', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'DRY_RUN=1',
        'sync_compose_file',
        'upload_verifier',
      ].join('\n'),
    });

    expect(result.code).toBe(0);
    expect(result.ssh.trim()).toBe('');
    expect(result.ssh).not.toContain('.new');
  });

  it('обе команды доставляют Compose-файл до первого обращения к Compose', async () => {
    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const content = withoutComments(await readFile(script, 'utf8'));

      const sync = content.indexOf('sync_compose_file');
      const firstCompose = content.indexOf('compose_command');

      expect(sync, script).toBeGreaterThan(-1);
      expect(firstCompose, script).toBeGreaterThan(sync);
    }
  });

  it('порядок команд на сервере: маршрутизатор поднят и проверен раньше приложения', async () => {
    const result = await runInSandbox({
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        `remote "$(compose_command) up -d --no-build valhalla"`,
        'require_routing_ready',
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const valhallaUp = lines.findIndex((line) => line.includes('up -d --no-build valhalla'));
    const routingCheck = lines.findIndex((line) => line.includes('verify-geo.mjs routing'));
    const appUp = lines.findIndex((line) => line.includes('up -d --no-build app'));

    expect(valhallaUp).toBeGreaterThan(-1);
    expect(routingCheck).toBeGreaterThan(valhallaUp);
    expect(appUp).toBeGreaterThan(routingCheck);
  });

  it('провал проверки маршрутизатора не даёт запустить новое приложение', async () => {
    const result = await runInSandbox({
      routingFails: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        `remote "$(compose_command) up -d --no-build valhalla"`,
        'require_routing_ready',
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('маршрутизатор не подтвердил готовность');

    // Маршрутизатор подняли, но приложение не трогали: прежняя версия
    // продолжает работать, а не сменяется на новую с неработающим расчётом.
    expect(result.ssh).toContain('up -d --no-build valhalla');
    expect(result.ssh).not.toContain('up -d --no-build app');
    expect(result.stdout).not.toContain('проверки пройдены');
  });

  it('маршрутизатор не запускается раньше проверки содержимого графа', async () => {
    const result = await runInSandbox({
      // Проверяющий скрипт доставляется из дерева VERSION, поэтому песочнице
      // нужна история репозитория.
      withGitHistory: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'require_geo_artifacts',
        `remote "$(compose_command) up -d --no-build valhalla"`,
      ].join('\n'),
    });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    // Режим передаётся закавыченным аргументом: `verify-geo.mjs 'graph' …`.
    const graphCheck = lines.findIndex((line) => /verify-geo\.mjs '?graph/.test(line));
    const valhallaUp = lines.findIndex((line) => line.includes('up -d --no-build valhalla'));

    // Сервис не должен подниматься на непроверенном наборе: иначе он
    // отрапортует о готовности по тому, что нашёл, каким бы оно ни было.
    expect(graphCheck).toBeGreaterThan(-1);
    expect(valhallaUp).toBeGreaterThan(graphCheck);

    // Проверка идёт по содержимому: SHA-256 передаётся аргументом.
    expect(lines[graphCheck]).toContain(GRAPH_SHA);
  });

  it('приложение не запускается раньше пробной матрицы', async () => {
    const result = await runInSandbox({
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'require_routing_ready',
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const routing = lines.findIndex((line) => line.includes('verify-geo.mjs routing'));
    const matrix = lines.findIndex((line) => line.includes('verify-geo.mjs matrix'));
    const appUp = lines.findIndex((line) => line.includes('up -d --no-build app'));

    // Загруженный набор ещё не означает работающий расчёт: пробная матрица
    // отвечает на вопрос, ради которого весь стек и существует.
    expect(routing).toBeGreaterThan(-1);
    expect(matrix).toBeGreaterThan(routing);
    expect(appUp).toBeGreaterThan(matrix);
  });

  it('числовое время в роли идентичности отвергается до обращения к серверу', async () => {
    const result = await runInSandbox({
      staging: { VALHALLA_GRAPH_SHA256: '1786349243' },
      body: [LOAD_BOTH, 'activate_environment STAGING', 'require_geo_artifacts'].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('VALHALLA_GRAPH_SHA256 задан неверно');
    // Ни одного обращения к серверу: значение отвергнуто по форме.
    expect(result.ssh.trim()).toBe('');
  });

  it('миграции идут после обеих матриц и до запуска приложения', async () => {
    // Схема меняется последней из того, что может отказать. Выкатка сохраняет
    // прежнюю версию при неудаче, и менять базу под работающим приложением
    // ради версии, которая может не запуститься, нельзя.
    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const whole = withoutComments(await readFile(script, 'utf8'));
      // Текст плана сухого прогона перечисляет те же шаги словами и стоит выше
      // исполняемой части: искать порядок нужно после него.
      const planEnd = whole.indexOf('\nPLAN\n');
      expect(planEnd, script).toBeGreaterThan(-1);
      const content = whole.slice(planEnd);

      const geo = content.indexOf('require_geo_artifacts');
      const valhallaUp = content.indexOf('up -d --no-build valhalla');
      const routing = content.indexOf('require_routing_ready');
      const migrate = content.indexOf('prisma migrate deploy');
      const appUp = content.indexOf('up -d --no-build app');
      const ready = content.indexOf('require_ready');

      for (const [name, index] of Object.entries({
        geo,
        valhallaUp,
        routing,
        migrate,
        appUp,
        ready,
      })) {
        expect(index, `${name} отсутствует в ${script}`).toBeGreaterThan(-1);
      }

      expect(valhallaUp, script).toBeGreaterThan(geo);
      expect(routing, script).toBeGreaterThan(valhallaUp);
      expect(migrate, script).toBeGreaterThan(routing);
      expect(appUp, script).toBeGreaterThan(migrate);
      expect(ready, script).toBeGreaterThan(appUp);
    }
  });

  it('план сухого прогона описывает фактический порядок', async () => {
    for (const script of [STAGING_SCRIPT, PRODUCTION_SCRIPT]) {
      const whole = await readFile(script, 'utf8');
      const plan = whole.slice(whole.indexOf('cat <<PLAN'), whole.indexOf('\nPLAN\n'));

      const routing = plan.indexOf('маршрутизатор');
      const matrix = plan.indexOf('матриц');
      const migrate = plan.indexOf('миграци');
      const app = plan.lastIndexOf('приложение');

      // План — то, что читает человек перед настоящей выкаткой. Разойдясь
      // с кодом, он вводит в заблуждение ровно в тот момент, когда его читают.
      expect(matrix, script).toBeGreaterThan(routing);
      expect(migrate, script).toBeGreaterThan(matrix);
      expect(app, script).toBeGreaterThan(migrate);
    }
  });

  it('отказ проверки содержимого не доводит до миграций', async () => {
    const result = await runInSandbox({
      withGitHistory: true,
      graphFails: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'require_geo_artifacts',
        `remote "$(compose_command) up -d --no-build valhalla"`,
        'require_routing_ready',
        `remote "$(compose_command) run --rm app npx prisma migrate deploy"`,
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    // Ни схема, ни работающая версия не тронуты.
    expect(result.ssh).not.toContain('prisma migrate deploy');
    expect(result.ssh).not.toContain('up -d --no-build app');
    expect(result.ssh).not.toContain('up -d --no-build valhalla');
  });

  it('отказ /status не доводит до миграций', async () => {
    const result = await runInSandbox({
      routingFails: true,
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        `remote "$(compose_command) up -d --no-build valhalla"`,
        'require_routing_ready',
        `remote "$(compose_command) run --rm app npx prisma migrate deploy"`,
        `remote "$(compose_command) up -d --no-build app"`,
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.ssh).toContain('up -d --no-build valhalla');
    expect(result.ssh).not.toContain('prisma migrate deploy');
    expect(result.ssh).not.toContain('up -d --no-build app');
  });

  it('отказ любой из двух матриц не доводит до миграций', async () => {
    for (const profile of ['auto', 'pedestrian'] as const) {
      const result = await runInSandbox({
        matrixFails: profile,
        body: [
          LOAD_BOTH,
          'activate_environment STAGING',
          'prepare_known_hosts',
          `remote "$(compose_command) up -d --no-build valhalla"`,
          'require_routing_ready',
          `remote "$(compose_command) run --rm app npx prisma migrate deploy"`,
          `remote "$(compose_command) up -d --no-build app"`,
        ].join('\n'),
      });

      expect(result.code, profile).not.toBe(0);
      expect(result.stderr, profile).toContain('пробный расчёт');
      // Набор загружен, но профиль не считается — схему трогать нельзя.
      expect(result.ssh, profile).toContain('verify-geo.mjs routing');
      expect(result.ssh, profile).not.toContain('prisma migrate deploy');
      expect(result.ssh, profile).not.toContain('up -d --no-build app');
    }
  });

  it('проверка артефактов не зависит от Node на сервере', async () => {
    const common = withoutComments(await readFile(COMMON_LIB, 'utf8'));

    // Скрипт доставляется с машины выкатки и выполняется внутри закреплённого
    // образа приложения: полагаться на установленный на сервере Node нельзя.
    expect(common).toContain('verify-geo.mjs');
    expect(common).toContain('docker run --rm --network none');
    expect(common).toContain('node /verify-geo.mjs');

    // Прямого вызова node по ssh не осталось.
    const remoteNodeCalls = common
      .split('\n')
      .filter((line) => line.includes('remote "') && /\bnode -e\b/.test(line));
    expect(remoteNodeCalls).toEqual([]);
  });

  it('сухой прогон не проверяет артефакты и не идёт в сеть', async () => {
    const result = await runInSandbox({
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'DRY_RUN=1',
        'require_geo_artifacts',
        'require_routing_ready',
      ].join('\n'),
    });

    expect(result.code).toBe(0);
    // Ни одного обращения к серверу: сухой прогон обязан обходиться
    // без сети и без секретов.
    expect(result.ssh.trim()).toBe('');
  });

  it('конфигурация графа собирается под рабочий путь /custom_files', async () => {
    const script = withoutComments(
      await readFile(path.join(REPO_ROOT, 'tools/geo/build-valhalla-graph.sh'), 'utf8'),
    );

    // Пути в valhalla.json обязаны совпадать с тем, куда каталог монтируется
    // в рабочем контейнере. Записанный /output означал бы конфигурацию,
    // работающую только на машине сборки: сервис искал бы тайлы по
    // несуществующему пути и молча поднялся бы без графа.
    expect(script).toContain('--mjolnir-tile-dir /custom_files/tiles');
    expect(script).toContain('--mjolnir-tile-extract /custom_files/tiles.tar');
    expect(script).toContain('/custom_files/valhalla.json');
    expect(script).not.toContain('/output/valhalla.json');
    expect(script).not.toContain('--mjolnir-tile-dir /output');

    const compose = withoutComments(await readFile(COMPOSE_FILE, 'utf8'));
    expect(compose).toContain('target: /custom_files');
  });

  it('сборка подложки требует вспомогательные источники и не ходит в сеть', async () => {
    const script = withoutComments(
      await readFile(path.join(REPO_ROOT, 'tools/geo/build-basemap.sh'), 'utf8'),
    );

    // Профиль подложки не запускается без этих наборов, а сборка идёт offline:
    // раньше она падала исключением Java через минуту после старта.
    expect(script).toContain('--sources');
    expect(script).toContain('lake_centerline.shp.zip');
    expect(script).toContain('water-polygons-split-3857.zip');
    expect(script).toContain('natural_earth_vector.sqlite.zip');

    // Каталог монтируется только на чтение и именно туда, где его ищет профиль.
    expect(script).toContain('/data/sources:ro');
    // Сеть по-прежнему отключена, автоматическая загрузка не включается.
    expect(script).toContain('--network none');
    expect(script).not.toContain('--download=true');

    // Суммы вспомогательных наборов попадают в манифест: другая их версия
    // даёт другие тайлы, и без сумм сборку нельзя повторить и сверить.
    expect(script).toContain('--input');
  });

  it('ревизия графа берётся из фактического ответа сервиса, а не из часов', async () => {
    const script = withoutComments(
      await readFile(path.join(REPO_ROOT, 'tools/geo/build-valhalla-graph.sh'), 'utf8'),
    );

    // Ревизия обязана совпасть с тем, что сервис ответит на сервере: взятая
    // из текущего времени, она заставила бы выкатку вечно отвергать
    // собственный же граф.
    expect(script).not.toMatch(/revision="\$\(date/);
    expect(script).toContain('/status');
    expect(script).toContain('tileset_last_modified');
    // Пробный запуск идёт без внешней сети и доказывает, что граф работает.
    expect(script).toContain('--network none');
    expect(script).toContain('valhalla_service');
    expect(script).toContain('GRAPH_REVISION');
  });

  it('проверка при выкатке считает содержимое, а не читает объявление', async () => {
    const verifier = await readFile(path.join(REPO_ROOT, 'deploy/scripts/verify-geo.mjs'), 'utf8');

    expect(verifier).toContain('flowers-logistics/valhalla-manifest@1');
    expect(verifier).toContain('tiles.tar');
    // Сумма пересчитывается по лежащему на сервере файлу: манифест только
    // объявляет, а доказывает пересчёт.
    expect(verifier).toContain('const actual = await sha256(file)');
    // И отдельно — фактический ответ самого маршрутизатора.
    expect(verifier).toContain('/status');
  });

  it('в проверке нет сравнения метки времени с идентичностью графа', async () => {
    const verifier = await readFile(path.join(REPO_ROOT, 'deploy/scripts/verify-geo.mjs'), 'utf8');
    const common = withoutComments(await readFile(COMMON_LIB, 'utf8'));

    // Режим готовности вызывается без ревизии: сравнивать её там нечем и незачем.
    expect(common).toContain("verify-geo.mjs routing 'http://valhalla:8002'");
    expect(common).not.toMatch(/verify-geo\.mjs routing[^"]*VALHALLA_GRAPH/);

    // Метка времени остаётся диагностикой: она попадает в вывод, но ни с чем
    // не сравнивается. Сравнение с ней однажды остановило исправную выкатку
    // после обычного копирования набора — и не остановило бы подменённый файл.
    const body = verifier.slice(verifier.indexOf('async function verifyRouting'));
    const routingBody = body.slice(0, body.indexOf('async function verifyMatrix'));
    expect(routingBody).toContain('tileset_last_modified');
    expect(routingBody).not.toContain('expectedRevision');
    expect(routingBody).not.toContain('expectedSha');
  });

  it('миграция смены идентичности только расширяет схему', async () => {
    const file = path.join(
      REPO_ROOT,
      'prisma/migrations/20260815090000_graph_content_revision/migration.sql',
    );
    const sql = withoutComments(await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    // Выкатка сохраняет прежнюю версию при отказе запуска новой. Переименование
    // или удаление колонки превратило бы этот запасной путь в ловушку: старый
    // контейнер получал бы «column does not exist» на каждом расчёте.
    expect(sql).not.toMatch(/RENAME\s+COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);

    // Добавляется новая колонка, допускающая NULL: строки предыдущей версии
    // её не содержат.
    expect(sql).toMatch(/ADD COLUMN "graphSha256"/);
    expect(sql).toMatch(/"graphSha256" IS NULL OR/);
    expect(sql).toContain('^[0-9a-f]{64}$');
  });

  it('новая версия не ищет по graphRevision', async () => {
    const service = await readFile(
      path.join(REPO_ROOT, 'apps/api/src/modules/geo/matrix/service.ts'),
      'utf8',
    );
    const code = withoutComments(service)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');

    // Старая колонка заполняется ради работающей прежней версии, но ни искать,
    // ни выбирать по ней новая версия не может: источник истины — graphSha256.
    const mentions = code.split('\n').filter((line) => line.includes('graphRevision'));
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toContain('"graphRevision"');
    expect(mentions[1]).toContain('graphRevision: input.graphSha256');

    // Выборка идёт по идентичности содержимого.
    expect(code).toContain('where: { keyHash, graphSha256 }');
  });

  it('шаблоны конфигураций описывают каталоги артефактов и ревизию графа', async () => {
    for (const template of ['deploy/staging.conf.example', 'deploy/production.conf.example']) {
      const content = await readFile(path.join(REPO_ROOT, template), 'utf8');

      expect(content, template).toContain('MAP_ARTIFACTS_DIR=');
      expect(content, template).toContain('VALHALLA_GRAPH_DIR=');
      expect(content, template).toContain('VALHALLA_GRAPH_SHA256=');
      // Образ закреплён digest, а не тегом latest.
      expect(content, template).toContain('VALHALLA_IMAGE=');
      expect(content, template).toContain('@sha256:');
      expect(content, template).not.toContain(':latest');
    }
  });
});

describe('хранение конфигураций', () => {
  it('в Git лежат только шаблоны, а реальные конфигурации игнорируются', async () => {
    const tracked = await run('git', ['ls-files', 'deploy']);
    expect(tracked.stdout).toContain('deploy/staging.conf.example');
    expect(tracked.stdout).toContain('deploy/production.conf.example');
    // Отслеживаемых рабочих конфигураций больше нет: их заполнение делало бы
    // рабочее дерево грязным, а выкатка запрещает грязное дерево.
    expect(tracked.stdout).not.toMatch(/^deploy\/staging\.conf$/m);
    expect(tracked.stdout).not.toMatch(/^deploy\/production\.conf$/m);
    expect(tracked.stdout).not.toContain('deploy/private/');

    for (const candidate of ['deploy/private/staging.conf', 'deploy/private/production.conf']) {
      const ignored = await run('git', ['check-ignore', candidate]);
      expect(ignored.code).toBe(0);
    }
  });

  it('в шаблонах нет реальных адресов, отпечатков и секретов', async () => {
    for (const file of ['deploy/staging.conf.example', 'deploy/production.conf.example']) {
      const content = await readFile(path.join(REPO_ROOT, file), 'utf8');

      expect(content).toContain('CHANGE_ME');
      // Ни IP-адресов, ни приватных ключей, ни паролей.
      expect(content).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(content).not.toMatch(/password\s*=\s*\S+/i);
    }
  });

  it('шаблоны описывают изолированные окружения', async () => {
    const staging = await readFile(path.join(REPO_ROOT, 'deploy/staging.conf.example'), 'utf8');
    const production = await readFile(
      path.join(REPO_ROOT, 'deploy/production.conf.example'),
      'utf8',
    );

    expect(staging).toContain('ENVIRONMENT_MARKER="staging"');
    expect(production).toContain('ENVIRONMENT_MARKER="production"');

    // Порты, тома, файлы окружения, каталоги и Compose-проекты не совпадают.
    for (const key of ['APP_HOST_PORT', 'DB_VOLUME', 'ENV_FILE', 'REMOTE_DIR', 'COMPOSE_PROJECT']) {
      const pattern = new RegExp(`^${key}="([^"]+)"`, 'm');
      const stagingValue = pattern.exec(staging)?.[1];
      const productionValue = pattern.exec(production)?.[1];

      expect(stagingValue).toBeDefined();
      expect(productionValue).toBeDefined();
      expect(stagingValue).not.toBe(productionValue);
    }
  });
});

describe('содержимое скриптов и Compose', () => {
  it('скрипты не принимают accept-new и требуют известный отпечаток', async () => {
    const common = withoutComments(await readFile(COMMON_LIB, 'utf8'));

    expect(common).toContain('StrictHostKeyChecking=yes');
    expect(common).not.toContain('accept-new');
    expect(common).toContain('UserKnownHostsFile');
    // Развёрнутая версия сверяется по метке образа, а не по тегу.
    expect(common).toContain('org.opencontainers.image.revision');
    // Безусловного запрета одинакового хоста больше нет: его заменила
    // проверка изоляции критических ресурсов.
    expect(common).toContain('require_isolated_environments');
  });

  it('production читает подтверждение из staging-каталога', async () => {
    const script = withoutComments(await readFile(PRODUCTION_SCRIPT, 'utf8'));

    expect(script).toContain('require_staging_verification');
    // Production-каталог доказательством прохождения staging служить не может.
    expect(script).not.toMatch(/remote[^\n]*verified-versions/);

    const common = withoutComments(await readFile(COMMON_LIB, 'utf8'));
    expect(common).toMatch(/STAGING_REMOTE_DIR\}\/state\/verified-versions/);
  });

  it('окружения получают отдельные deploy lock', async () => {
    const staging = withoutComments(await readFile(STAGING_SCRIPT, 'utf8'));
    const production = withoutComments(await readFile(PRODUCTION_SCRIPT, 'utf8'));
    const common = withoutComments(await readFile(COMMON_LIB, 'utf8'));

    expect(staging).toContain('acquire_local_lock "staging"');
    expect(production).toContain('acquire_local_lock "production"');
    // Удалённый lock лежит в каталоге окружения, поэтому на общем сервере
    // он тоже остаётся отдельным.
    expect(common).toContain('${REMOTE_DIR}/deploy.lock.d');
  });

  it('Compose берёт порт, том и файл окружения из конфигурации', async () => {
    const compose = await readFile(COMPOSE_FILE, 'utf8');

    expect(compose).toContain('127.0.0.1:${APP_HOST_PORT}:3000');
    expect(compose).toContain('${DB_VOLUME}');
    expect(compose).toContain('${ENV_FILE}');
    expect(compose).toContain('${COMPOSE_PROJECT}');

    // Значения не зашиты в файл: иначе они разъехались бы с конфигурацией.
    expect(compose).not.toMatch(/127\.0\.0\.1:\d+:\d+/);
    expect(compose).not.toContain('staging.env');
    expect(compose).not.toContain('production.env');

    // Обратный прокси, DNS и TLS в этой ветке не добавляются.
    expect(compose).not.toContain('nginx');
    expect(compose).not.toContain('traefik');
  });

  it('универсальной команды deploy ENV=... не существует', async () => {
    const makefile = withoutComments(await readFile(path.join(REPO_ROOT, 'Makefile'), 'utf8'));

    expect(makefile).toContain('deploy-staging');
    expect(makefile).toContain('deploy-production');
    expect(makefile).not.toMatch(/^deploy:/m);
    expect(makefile).not.toContain('ENV=');
  });
});
