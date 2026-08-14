/**
 * Разбор аргументов ограниченного backfill.
 *
 * Вынесен из скрипта отдельно, потому что это и есть тот самый предохранитель:
 * проход без явного потолка обращений запускаться не должен. Проверять его,
 * импортируя скрипт, нельзя — импорт запустил бы сам проход.
 */

/** Верхняя граница потолка. Больше — это уже не «ограниченный» проход. */
export const MAX_LIMIT = 100_000;

export interface BackfillOptions {
  /**
   * Потолок ЧИСЛА ОБРАЩЕНИЙ к геокодеру, а не числа заказов.
   *
   * Заказы, чей адрес уже есть в кэше, стоят ноль запросов, и ограничивать их
   * бессмысленно; ограничивать нужно нагрузку на свой Photon.
   */
  limit: number;
  /** Только сводка: ни одного обращения и ни одной записи. */
  reportOnly: boolean;
}

/** Строка в результате — это отказ с причиной, а не исключение. */
export function parseBackfillOptions(argv: readonly string[]): BackfillOptions | string {
  let limit = 0;
  let reportOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-only') {
      reportOnly = true;
      continue;
    }
    if (arg === '--limit') {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (
        raw === undefined ||
        raw.trim() === '' ||
        !Number.isInteger(parsed) ||
        parsed <= 0 ||
        parsed > MAX_LIMIT
      ) {
        return `--limit ожидает целое число от 1 до ${MAX_LIMIT}`;
      }
      limit = parsed;
      continue;
    }
    return `Неизвестный аргумент: ${String(arg)}`;
  }

  if (!reportOnly && limit === 0) {
    // Умолчания нет намеренно: «ограниченный» проход без явного потолка
    // ограниченным не является, а молчаливое умолчание однажды окажется не тем.
    return 'Укажите --limit <число обращений> либо --report-only';
  }

  return { limit, reportOnly };
}
