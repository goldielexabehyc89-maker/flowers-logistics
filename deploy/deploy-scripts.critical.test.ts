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

# Проверка маршрутизатора может быть настроена на отказ: так проверяется,
# что провалившаяся проверка останавливает выкатку до запуска приложения.
case "$cmd" in
  *'verify-geo.mjs routing'*)
    if [ "\${ROUTING_FAILS:-0}" = "1" ]; then
      printf 'ОТКАЗ: маршрутизатор не подтвердил граф\\n' >&2
      exit 1
    fi
    ;;
esac

case "$cmd" in
  *'sha256sum'*docker-compose.deploy.yml*)
    printf '%s  %s\\n' "\${COMPOSE_SHA_REPLY:-совпадение-подставит-тест}" "compose"
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
  VALHALLA_GRAPH_REVISION: string;
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
  VALHALLA_GRAPH_REVISION: '1786000000',
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
  VALHALLA_GRAPH_REVISION: '1786000000',
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
    `VALHALLA_GRAPH_REVISION="${values.VALHALLA_GRAPH_REVISION}"`,
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
  /** Что сервер отвечает на sha256sum Compose-файла. */
  composeShaReply?: string;
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
async function runInSandbox(
  options: SandboxOptions,
): Promise<RunResult & { ssh: string; knownHostsArgs: string[] }> {
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

  // Настоящий Compose-файл кладётся в песочницу: команда выкатки берёт его
  // из корня репозитория, и без него проверка доставки была бы фикцией.
  await mkdir(path.join(dir, 'deploy'), { recursive: true });
  await writeFile(
    path.join(dir, 'deploy/docker-compose.deploy.yml'),
    await readFile(COMPOSE_FILE, 'utf8'),
    'utf8',
  );

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
      `VERSION="${VALID_SHA}"`,
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
    VERSION_UNDER_TEST: VALID_SHA,
    STAGING_DIR: staging.REMOTE_DIR,
    PRODUCTION_DIR: production.REMOTE_DIR,
    STAGING_HAS_VERSION: options.stagingHasVersion === false ? '0' : '1',
    ROUTING_FAILS: options.routingFails === true ? '1' : '0',
    // Проверке незачем ждать загрузку графа: она проверяет поведение при
    // отказе, а не терпение команды выкатки.
    ROUTING_CHECK_ATTEMPTS: '2',
    ROUTING_CHECK_DELAY: '0',
    ...(options.composeShaReply === undefined
      ? {}
      : { COMPOSE_SHA_REPLY: options.composeShaReply }),
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
  };
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
      "VALHALLA_GRAPH_REVISION='1786000000'",
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
    expect(compose).toContain('VALHALLA_GRAPH_REVISION: ${VALHALLA_GRAPH_REVISION}');

    // Каталоги монтируются только на чтение.
    expect(compose).toMatch(/source: \$\{MAP_ARTIFACTS_DIR\}[\s\S]*?read_only: true/);
    expect(compose).toMatch(/source: \$\{VALHALLA_GRAPH_DIR\}[\s\S]*?read_only: true/);
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

  it('Compose-файл доставляется на сервер и сверяется по контрольной сумме', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(await readFile(COMPOSE_FILE))
      .digest('hex');

    const result = await runInSandbox({
      composeShaReply: expected,
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
    const compose = lines.findIndex((line) => line.includes('docker compose'));

    // Файл доставлен и сверен ДО первой команды Compose: иначе выкатка
    // запустила бы окружение файлом произвольного возраста.
    expect(upload).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(upload);
    expect(compose).toBeGreaterThan(verify);

    // Передача атомарна: обрыв не оставляет обрезанный файл вместо рабочего.
    expect(result.ssh).toContain('docker-compose.deploy.yml.new');
    expect(result.ssh).toContain('mv ');
  });

  it('несовпадение Compose-файла на сервере останавливает выкатку', async () => {
    const result = await runInSandbox({
      composeShaReply: 'f'.repeat(64),
      body: [
        LOAD_BOTH,
        'activate_environment STAGING',
        'prepare_known_hosts',
        'sync_compose_file',
        `remote "$(compose_command) up -d --no-build valhalla"`,
      ].join('\n'),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('не совпал с версией из репозитория');
    // Ни одной команды Compose: состав окружения не подтверждён.
    expect(result.ssh).not.toContain('docker compose');
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

  it('сухой прогон Compose-файл не доставляет', async () => {
    const result = await runInSandbox({
      body: [LOAD_BOTH, 'activate_environment STAGING', 'DRY_RUN=1', 'sync_compose_file'].join(
        '\n',
      ),
    });

    expect(result.code).toBe(0);
    expect(result.ssh.trim()).toBe('');
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
    expect(result.stderr).toContain('маршрутизатор не подтвердил граф');

    // Маршрутизатор подняли, но приложение не трогали: прежняя версия
    // продолжает работать, а не сменяется на новую с неработающим расчётом.
    expect(result.ssh).toContain('up -d --no-build valhalla');
    expect(result.ssh).not.toContain('up -d --no-build app');
    expect(result.stdout).not.toContain('проверки пройдены');
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

  it('проверка при выкатке сверяет манифест графа и сумму набора тайлов', async () => {
    const verifier = await readFile(path.join(REPO_ROOT, 'deploy/scripts/verify-geo.mjs'), 'utf8');

    expect(verifier).toContain('flowers-logistics/valhalla-manifest@1');
    expect(verifier).toContain('tiles.tar');
    expect(verifier).toContain('sha256');
    // И отдельно — фактический ответ самого маршрутизатора.
    expect(verifier).toContain('/status');
    expect(verifier).toContain('tileset_last_modified');
  });

  it('шаблоны конфигураций описывают каталоги артефактов и ревизию графа', async () => {
    for (const template of ['deploy/staging.conf.example', 'deploy/production.conf.example']) {
      const content = await readFile(path.join(REPO_ROOT, template), 'utf8');

      expect(content, template).toContain('MAP_ARTIFACTS_DIR=');
      expect(content, template).toContain('VALHALLA_GRAPH_DIR=');
      expect(content, template).toContain('VALHALLA_GRAPH_REVISION=');
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
