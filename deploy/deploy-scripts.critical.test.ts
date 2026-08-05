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
 */
const FAKE_SSH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SSH_LOG"
cmd="\${*: -1}"
case "$cmd" in
  *"$STAGING_DIR/ENVIRONMENT"*)   printf '%s\\n' "\${STAGING_MARKER_REPLY:-staging}" ;;
  *"$PRODUCTION_DIR/ENVIRONMENT"*) printf '%s\\n' "\${PRODUCTION_MARKER_REPLY:-production}" ;;
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
}

const STAGING_DEFAULTS: EnvironmentValues = {
  ENVIRONMENT_MARKER: 'staging',
  SSH_HOST: SHARED_HOST,
  REMOTE_DIR: '/srv/flowers-logistics-staging',
  APP_HOST_PORT: '3001',
  COMPOSE_PROJECT: 'fl-staging',
  ENV_FILE: 'staging.env',
  DB_VOLUME: 'fl-staging-db',
};

const PRODUCTION_DEFAULTS: EnvironmentValues = {
  ENVIRONMENT_MARKER: 'production',
  SSH_HOST: SHARED_HOST,
  REMOTE_DIR: '/srv/flowers-logistics-production',
  APP_HOST_PORT: '3000',
  COMPOSE_PROJECT: 'fl-production',
  ENV_FILE: 'production.env',
  DB_VOLUME: 'fl-production-db',
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
    'IMAGE_REPOSITORY="ghcr.io/example/app"',
    `COMPOSE_PROJECT="${values.COMPOSE_PROJECT}"`,
    'COMPOSE_FILE="docker-compose.deploy.yml"',
    `ENV_FILE="${values.ENV_FILE}"`,
    `DB_VOLUME="${values.DB_VOLUME}"`,
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
  /** Строки, выполняемые после загрузки конфигураций. */
  body: string;
}

/**
 * Выполняет фрагмент на настоящем common.sh с подменённым ssh.
 * Возвращает результат и полный журнал обращений к ssh.
 */
async function runInSandbox(options: SandboxOptions): Promise<RunResult & { ssh: string }> {
  const staging = { ...STAGING_DEFAULTS, ...options.staging };
  const production = { ...PRODUCTION_DEFAULTS, ...options.production };

  const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-deploy-'));
  const binDir = path.join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const sshPath = path.join(binDir, 'ssh');
  await writeFile(sshPath, FAKE_SSH, 'utf8');
  await chmod(sshPath, 0o755);

  const sshLog = path.join(dir, 'ssh.log');
  await writeFile(sshLog, '', 'utf8');

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
    VERSION_UNDER_TEST: VALID_SHA,
    STAGING_DIR: staging.REMOTE_DIR,
    PRODUCTION_DIR: production.REMOTE_DIR,
    STAGING_HAS_VERSION: options.stagingHasVersion === false ? '0' : '1',
    ...(options.stagingMarkerReply === undefined
      ? {}
      : { STAGING_MARKER_REPLY: options.stagingMarkerReply }),
    ...(options.productionMarkerReply === undefined
      ? {}
      : { PRODUCTION_MARKER_REPLY: options.productionMarkerReply }),
  });

  return { ...result, ssh: await readFile(sshLog, 'utf8') };
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
