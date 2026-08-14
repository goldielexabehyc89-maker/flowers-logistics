/**
 * Хранение токена устройства на диске.
 *
 * ТОКЕН РАВНОСИЛЕН ПРАВУ ПЕЧАТАТЬ ЧУЖИЕ БЛАНКИ. Сервер выдаёт его один раз и
 * повторно не показывает, так что положить его рядом с настройкой открытым
 * текстом означало бы: любой, кто получил доступ к профилю пользователя или
 * к резервной копии каталога, забирает задания вместо этой машины.
 *
 * Поэтому в Windows — DPAPI с областью CurrentUser: расшифровать сможет
 * только та же учётная запись на той же машине. Файл, унесённый на другой
 * компьютер, бесполезен.
 *
 * СЕКРЕТ НЕ ПЕРЕДАЁТСЯ АРГУМЕНТОМ КОМАНДНОЙ СТРОКИ. Аргументы видны любому
 * процессу в системе (диспетчер задач, `Get-CimInstance Win32_Process`,
 * журналы аудита процессов) — это ровно тот способ утечки, ради которого
 * шифрование и заводится. Данные идут через stdin в base64.
 *
 * Ни одна ошибка этого модуля не содержит ни открытого, ни зашифрованного
 * значения: сообщение об ошибке — самое частое место, где секрет оказывается
 * в журнале.
 */

import { execFile } from 'node:child_process';
import { chmod, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE, writeFileAtomic } from './atomic-file.js';

export interface SecretStore {
  /** Токен устройства либо `null`, если машина не привязана. */
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Зашифрованный DPAPI токен. Расширение отражает способ, а не формат. */
const DPAPI_FILE = 'device-token.dpapi';

/** Файл запасного хранилища. Имя намеренно кричит, что это не для работы. */
const PLAIN_FILE = 'device-token.test-only';

/** Сколько ждём PowerShell. Дольше — значит, что-то не так с самой системой. */
const POWERSHELL_TIMEOUT_MS = 20_000;

/**
 * Скрипт шифрования. Константа, а не строка со вставленными значениями.
 *
 * Данные скрипт получает из stdin. Склейка команды со значением превратила бы
 * токен в часть командной строки — см. заголовок файла.
 */
const PROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$plain = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');

const UNPROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, $scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');

/**
 * Запускает PowerShell со скриптом-константой и данными в stdin.
 *
 * `execFile` с массивом аргументов, без `shell`: оболочка здесь не нужна, а её
 * присутствие означало бы разбор строки и все связанные с этим сюрпризы.
 */
function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          // Ни stdout, ни stderr в сообщение не попадают: в stdout лежит
          // сам секрет, а в stderr — путь к файлу и имя пользователя.
          reject(new Error('Средство защиты Windows (DPAPI) не выполнило операцию.'));
          return;
        }
        resolve(stdout);
      },
    );

    if (child.stdin === null) {
      reject(new Error('Не удалось передать данные средству защиты Windows.'));
      return;
    }
    child.stdin.end(input, 'utf8');
  });
}

function dpapiSecretStore(home: string): SecretStore {
  const filePath = join(home, DPAPI_FILE);

  return {
    async read(): Promise<string | null> {
      let stored: string;
      try {
        stored = await readFile(filePath, 'utf8');
      } catch {
        return null;
      }
      if (stored.trim() === '') {
        return null;
      }

      const decoded = await runPowerShell(UNPROTECT_SCRIPT, stored.trim());
      return Buffer.from(decoded.trim(), 'base64').toString('utf8');
    },

    async write(token: string): Promise<void> {
      const protectedValue = await runPowerShell(
        PROTECT_SCRIPT,
        Buffer.from(token, 'utf8').toString('base64'),
      );
      await writeFileAtomic(filePath, protectedValue.trim());
    },

    async clear(): Promise<void> {
      await unlink(filePath).catch(() => undefined);
    },
  };
}

/**
 * Запасное хранилище: файл с правами 0600.
 *
 * ТОЛЬКО ДЛЯ ПРОВЕРОК И РАЗРАБОТКИ ВНЕ WINDOWS. DPAPI существует только в
 * Windows, а критические проверки идут в Linux-контейнере, и без этой ветки
 * они не смогли бы завести обработчик вовсе. На рабочем месте эта ветка
 * недостижима: выбор делается по `process.platform`, а не по настройке, —
 * настройку можно было бы выставить по ошибке и остаться без шифрования.
 */
function plainSecretStore(home: string): SecretStore {
  const filePath = join(home, PLAIN_FILE);

  return {
    async read(): Promise<string | null> {
      try {
        const stored = (await readFile(filePath, 'utf8')).trim();
        return stored === '' ? null : stored;
      } catch {
        return null;
      }
    },

    async write(token: string): Promise<void> {
      await writeFileAtomic(filePath, token, PRIVATE_FILE_MODE);
      // Файл мог существовать до нас с другими правами: `rename` их сохраняет.
      await chmod(filePath, PRIVATE_FILE_MODE).catch(() => undefined);
    },

    async clear(): Promise<void> {
      await unlink(filePath).catch(() => undefined);
    },
  };
}

export function createSecretStore(
  home: string,
  platform: NodeJS.Platform = process.platform,
): SecretStore {
  return platform === 'win32' ? dpapiSecretStore(home) : plainSecretStore(home);
}
