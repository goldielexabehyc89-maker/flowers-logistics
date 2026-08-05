/**
 * Критические проверки команд выкатки.
 *
 * Скрипты обязаны отказывать, пока серверы не настроены, и не выполнять
 * сетевых действий в сухом прогоне. Проверяется поведение самих файлов,
 * а не их описание в документации.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
    const common = await readFile(path.join(REPO_ROOT, 'deploy/scripts/lib/common.sh'), 'utf8');

    expect(common).toContain('StrictHostKeyChecking=yes');
    expect(common).not.toContain('accept-new');
    expect(common).toContain('UserKnownHostsFile');
    // Развёрнутая версия сверяется по метке образа, а не по тегу.
    expect(common).toContain('org.opencontainers.image.revision');
  });

  it('универсальной команды deploy ENV=... не существует', async () => {
    const makefile = await readFile(path.join(REPO_ROOT, 'Makefile'), 'utf8');

    expect(makefile).toContain('deploy-staging');
    expect(makefile).toContain('deploy-production');
    expect(makefile).not.toMatch(/^deploy:/m);
    expect(makefile).not.toContain('ENV=');
  });
});
