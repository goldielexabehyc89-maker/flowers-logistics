/**
 * Критические проверки команд выкатки.
 *
 * Скрипты обязаны отказывать, пока серверы не настроены, и не выполнять
 * сетевых действий в сухом прогоне. Проверяется поведение самих файлов,
 * а не их описание в документации.
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

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';

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

async function run(script: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(script, args, { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

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

  it('обычная выкатка отказывает, пока конфигурация не заполнена', async () => {
    // Конфигурации содержат только шаблоны, поэтому команда обязана остановиться
    // до любого обращения к серверу.
    const result = await run(STAGING_SCRIPT, ['--version', VALID_SHA]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ОТКАЗ');
  });
});

/**
 * Проверка подтверждения версии на staging.
 *
 * ssh подменяется заглушкой: она записывает, к какому хосту обращались и с какой
 * командой, и отвечает заранее заданным текстом. Реальных подключений нет,
 * проверяется настоящий код из common.sh, а не его пересказ.
 */
describe('подтверждение проверки на staging', () => {
  const PRODUCTION_TARGET = 'produser@production.invalid';
  const STAGING_TARGET = 'stguser@staging.invalid';

  const FAKE_SSH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SSH_LOG"
target=""
for arg in "$@"; do
  case "$arg" in *@*) target="$arg" ;; esac
done
cmd="\${*: -1}"
case "$cmd" in
  *ENVIRONMENT*)
    case "$target" in
      *staging*) printf 'staging\\n' ;;
      *) printf 'production\\n' ;;
    esac
    ;;
  *verified-versions*)
    if [ "\${STAGING_HAS_VERSION:-0}" = "1" ]; then printf '%s\\n' "$VERSION_UNDER_TEST"; fi
    ;;
esac
exit 0
`;

  const HARNESS = `#!/usr/bin/env bash
set -euo pipefail
source "$1/deploy/scripts/lib/common.sh"

REPO_ROOT="$2"
VERSION="$3"

ENVIRONMENT_MARKER="production"
SSH_HOST="production.invalid"
SSH_USER="produser"
SSH_PORT="22"
HOST_FINGERPRINT="production.invalid ssh-ed25519 AAAAPROD"
REMOTE_DIR="/srv/flowers-logistics-production"

STAGING_SSH_HOST="staging.invalid"
STAGING_SSH_USER="stguser"
STAGING_SSH_PORT="2222"
STAGING_HOST_FINGERPRINT="staging.invalid ssh-ed25519 AAAASTG"
STAGING_REMOTE_DIR="/srv/flowers-logistics-staging"
STAGING_VERIFIED_FILE="/srv/flowers-logistics-staging/state/verified-versions"

prepare_known_hosts
require_staging_verification "тестовая-конфигурация"
require_environment_marker
printf 'проверки пройдены\\n'
`;

  async function runVerification(hasVersion: boolean): Promise<RunResult & { ssh: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fl-deploy-'));
    const binDir = path.join(dir, 'bin');
    await mkdir(binDir, { recursive: true });

    const sshPath = path.join(binDir, 'ssh');
    await writeFile(sshPath, FAKE_SSH, 'utf8');
    await chmod(sshPath, 0o755);

    const harnessPath = path.join(dir, 'harness.sh');
    await writeFile(harnessPath, HARNESS, 'utf8');
    await chmod(harnessPath, 0o755);

    const sshLog = path.join(dir, 'ssh.log');
    await writeFile(sshLog, '', 'utf8');

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      SSH_LOG: sshLog,
      VERSION_UNDER_TEST: VALID_SHA,
      STAGING_HAS_VERSION: hasVersion ? '1' : '0',
    };

    let result: RunResult;
    try {
      const { stdout, stderr } = await execFileAsync(harnessPath, [REPO_ROOT, dir, VALID_SHA], {
        env,
      });
      result = { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      result = {
        code: failure.code ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }

    return { ...result, ssh: await readFile(sshLog, 'utf8') };
  }

  it('список проверенных версий читается со staging, а не с production', async () => {
    const result = await runVerification(true);

    expect(result.code).toBe(0);

    const lines = result.ssh.split('\n').filter((line) => line !== '');
    const verifiedCall = lines.find((line) => line.includes('verified-versions'));
    expect(verifiedCall).toBeDefined();
    // Подтверждение спрашивается у staging-хоста и только у него.
    expect(verifiedCall).toContain(STAGING_TARGET);
    expect(verifiedCall).not.toContain(PRODUCTION_TARGET);

    // Контакт с production тоже был — отдельным соединением.
    expect(lines.some((line) => line.includes(PRODUCTION_TARGET))).toBe(true);

    // Отпечатки хостов не смешиваются: у каждого окружения свой known_hosts.
    expect(result.ssh).toContain('known_hosts.staging-verification');
    expect(result.ssh).toContain('known_hosts.production');
    // Ни одно соединение не принимает неизвестный ключ.
    for (const line of lines) {
      expect(line).toContain('StrictHostKeyChecking=yes');
    }
  });

  it('без подтверждения на staging выкатка останавливается', async () => {
    const result = await runVerification(false);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('не была успешно проверена на staging');
    // До проверки цели production дело не дошло.
    expect(result.stdout).not.toContain('проверки пройдены');
  });
});

describe('содержимое конфигураций и скриптов', () => {
  it('в шаблонах нет реальных адресов, отпечатков и секретов', async () => {
    for (const file of ['deploy/staging.conf', 'deploy/production.conf']) {
      const content = await readFile(path.join(REPO_ROOT, file), 'utf8');

      expect(content).toContain('CHANGE_ME');
      // Ни IP-адресов, ни приватных ключей, ни паролей.
      expect(content).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(content).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(content).not.toMatch(/password\s*=\s*\S+/i);
    }
  });

  it('окружения полностью разделены', async () => {
    const staging = await readFile(path.join(REPO_ROOT, 'deploy/staging.conf'), 'utf8');
    const production = await readFile(path.join(REPO_ROOT, 'deploy/production.conf'), 'utf8');

    expect(staging).toContain('ENVIRONMENT_MARKER="staging"');
    expect(production).toContain('ENVIRONMENT_MARKER="production"');
    expect(staging).toContain('COMPOSE_PROJECT="fl-staging"');
    expect(production).toContain('COMPOSE_PROJECT="fl-production"');
  });

  it('скрипты не принимают accept-new и требуют известный отпечаток', async () => {
    const common = withoutComments(
      await readFile(path.join(REPO_ROOT, 'deploy/scripts/lib/common.sh'), 'utf8'),
    );

    expect(common).toContain('StrictHostKeyChecking=yes');
    expect(common).not.toContain('accept-new');
    expect(common).toContain('UserKnownHostsFile');
    // Развёрнутая версия сверяется по метке образа, а не по тегу.
    expect(common).toContain('org.opencontainers.image.revision');
  });

  it('production читает подтверждение отдельным соединением со staging', async () => {
    const script = withoutComments(await readFile(PRODUCTION_SCRIPT, 'utf8'));

    expect(script).toContain('require_staging_verification');
    // Файл со списком версий не должен читаться соединением с production.
    expect(script).not.toMatch(/remote\s+"[^"]*STAGING_VERIFIED_FILE/);

    const common = withoutComments(
      await readFile(path.join(REPO_ROOT, 'deploy/scripts/lib/common.sh'), 'utf8'),
    );
    expect(common).toContain('STAGING_KNOWN_HOSTS_FILE');
    expect(common).toContain('remote_staging');
  });

  it('универсальной команды deploy ENV=... не существует', async () => {
    const makefile = withoutComments(await readFile(path.join(REPO_ROOT, 'Makefile'), 'utf8'));

    expect(makefile).toContain('deploy-staging');
    expect(makefile).toContain('deploy-production');
    expect(makefile).not.toMatch(/^deploy:/m);
    expect(makefile).not.toContain('ENV=');
  });
});
