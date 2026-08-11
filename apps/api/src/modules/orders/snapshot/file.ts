/**
 * Чтение файла снимка для команд staging.
 *
 * Один явный путь и ничего больше. Ни масок, ни каталогов, ни «взять последний
 * файл»: команда, сама выбирающая, что импортировать, однажды импортирует не то,
 * а отвечать за это будет некому.
 *
 * Содержимое наружу не выносится ни при каких обстоятельствах — ни в отчёте,
 * ни в тексте ошибки. Снимок состоит из псевдонимов, координат и сумм, и вывод
 * даже одной строки в журнал развернул бы всю работу по обезличиванию назад.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OrdersSnapshot } from '../snapshot-export.js';

/** Символы подстановки. Их наличие означает, что путь задан не одним файлом. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

export class SnapshotFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFileError';
  }
}

/**
 * Проверяет путь, не обращаясь к диску.
 *
 * Вынесено отдельно, чтобы правило доказывалось тестом напрямую: «маска вместо
 * файла отвергается» — это обещание, а не деталь реализации.
 */
export function assertExplicitPath(value: string): void {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw new SnapshotFileError('Не указан файл снимка: --file <путь>');
  }
  if (GLOB_CHARACTERS.test(trimmed)) {
    throw new SnapshotFileError('Путь к снимку задаётся одним файлом, без масок');
  }
  if (!path.isAbsolute(trimmed)) {
    // Относительный путь зависит от того, откуда запущена команда. На сервере
    // это разные каталоги у разных людей — и разные файлы под одним именем.
    throw new SnapshotFileError('Путь к снимку должен быть абсолютным');
  }
}

/**
 * Читает и разбирает снимок.
 *
 * Ошибка разбора не несёт наружу ни фрагмента файла: сообщение JSON-парсера
 * цитирует место ошибки, а вместе с ним — данные снимка.
 */
export async function readSnapshotFile(value: string): Promise<OrdersSnapshot> {
  assertExplicitPath(value);
  const file = value.trim();

  const info = await stat(file).catch(() => null);
  if (info === null) {
    throw new SnapshotFileError('Файл снимка не найден');
  }
  if (!info.isFile()) {
    throw new SnapshotFileError('Путь к снимку указывает не на файл');
  }

  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    throw new SnapshotFileError('Файл снимка не прочитан');
  }

  try {
    return JSON.parse(raw) as OrdersSnapshot;
  } catch {
    throw new SnapshotFileError('Файл снимка не является корректным JSON');
  }
}

/** Разбирает `--file <путь>`. Других аргументов у команд нет намеренно. */
export function fileArgument(argv: readonly string[]): string {
  const index = argv.indexOf('--file');
  const value = index === -1 ? undefined : argv[index + 1];

  if (value === undefined) {
    throw new SnapshotFileError('Не указан файл снимка: --file <путь>');
  }
  return value;
}

/**
 * Что можно показать человеку, не показав содержимого снимка.
 *
 * Наши собственные исключения безопасны: в них только причина, код и, для
 * заблокированного вывода, номера маршрутов. Всё остальное сводится к общему
 * сообщению — чужая ошибка вправе процитировать место разбора, а вместе
 * с ним и данные файла.
 *
 * Вынесено в функцию, чтобы правило проверялось тестом, а не повторялось
 * в двух командах по памяти.
 */
const REPORTABLE_ERRORS = [
  'SnapshotFileError',
  'SnapshotSafetyError',
  'SnapshotImportError',
  'RetireBlockedError',
];

export function describeSnapshotFailure(error: unknown): string {
  if (!(error instanceof Error) || !REPORTABLE_ERRORS.includes(error.name)) {
    return 'ошибка выполнения';
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `[${code}] ${error.message}` : error.message;
}
