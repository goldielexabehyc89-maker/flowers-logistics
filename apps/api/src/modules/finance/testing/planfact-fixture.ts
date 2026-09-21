/**
 * Обезличенная выписка ПланФакта для проверок.
 *
 * Строится программно, той же структуры, что настоящая: служебная строка
 * «ПланФакт», строка заголовков с двадцатью столбцами в порядке выгрузки,
 * дальше операции. Настоящих выписок и персональных данных в репозитории нет
 * и быть не может: телефоны и имена задаёт сама проверка.
 *
 * Вариант с префиксом `x:` повторяет особенность файлов ПланФакта, из-за
 * которой ExcelJS не читает их напрямую: разбор обязан справляться с обоими.
 */

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface FixtureRow {
  /** День оплаты `ГГГГ-ММ-ДД`, либо готовое значение ячейки (текст, порядковый номер Excel). */
  paymentDate?: string | number | null;
  paymentStatus?: string | null;
  accrualDate?: string | null;
  accrualStatus?: string | null;
  counterparty?: string | null;
  type?: string | null;
  article?: string | null;
  /** Сумма в рублях с копейками; у выплаты — отрицательная. Текст пишется как есть. */
  amount?: number | string | null;
  currency?: string | null;
  purpose?: string | null;
}

/** Столбцы выгрузки ПланФакта в её порядке. */
export const PLANFACT_HEADERS = [
  'Дата оплаты',
  'Статус оплаты',
  'Дата начисления',
  'Статус начисления',
  'Контрагент',
  'ИНН контрагента',
  'Тип',
  'Счет',
  '№ Счета',
  'Банк',
  'Бик',
  'Юрлицо',
  'ИНН юрлица',
  'Статья',
  'Родительские статьи',
  'Вид деятельности',
  'Назначение платежа',
  'Проекты',
  'Сумма',
  'Валюта',
] as const;

export const SALARY_ARTICLE = 'Заработная плата курьеров';

function dateCell(value: string | number | null | undefined): ExcelJS.CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    // Не день, а текст: проверка хочет увидеть, как читается строка.
    return value;
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Готовая выплата зарплаты курьеру: остальные поля — как у настоящей выписки. */
export function payoutRow(
  counterparty: string | null,
  amount: number | string,
  paymentDate: string,
  overrides: Partial<FixtureRow> = {},
): FixtureRow {
  return {
    paymentDate,
    paymentStatus: 'Подтверждена',
    accrualDate: paymentDate,
    accrualStatus: 'Подтверждена',
    counterparty,
    type: 'Выплата',
    article: SALARY_ARTICLE,
    amount,
    currency: 'RUB',
    purpose: 'ЗП СМЗ',
    ...overrides,
  };
}

/** Родительская строка разбитой выплаты: без контрагента, статьи и начисления. */
export function parentRow(amount: number, paymentDate: string): FixtureRow {
  return {
    paymentDate,
    paymentStatus: 'Подтверждена',
    accrualDate: null,
    accrualStatus: null,
    counterparty: null,
    type: 'Выплата',
    article: null,
    amount,
    currency: 'RUB',
    purpose: 'ЗП СМЗ',
  };
}

/** Часть разбитой выплаты: без даты и статуса оплаты, со своим контрагентом. */
export function partRow(
  counterparty: string | null,
  amount: number,
  accrualDate: string,
  overrides: Partial<FixtureRow> = {},
): FixtureRow {
  return {
    paymentDate: null,
    paymentStatus: null,
    accrualDate,
    accrualStatus: 'Подтверждена',
    counterparty,
    type: 'Часть',
    article: SALARY_ARTICLE,
    amount,
    currency: 'RUB',
    purpose: null,
    ...overrides,
  };
}

/**
 * Книга выписки.
 *
 * `prefixed` пишет XML книги с префиксом `x:` у каждого элемента — так, как
 * это делает ПланФакт.
 */
export async function buildPlanFactStatement(
  rows: readonly FixtureRow[],
  options: { prefixed?: boolean; withoutServiceRow?: boolean } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Лист1');

  if (options.withoutServiceRow !== true) {
    sheet.getCell(1, 1).value = 'ПланФакт';
    sheet.getCell(1, 3).value = 'Создано с помощью сервиса ПланФакт';
  }
  const headerRowNo = options.withoutServiceRow === true ? 1 : 2;
  PLANFACT_HEADERS.forEach((header, index) => {
    sheet.getCell(headerRowNo, index + 1).value = header;
  });

  rows.forEach((row, index) => {
    const rowNo = headerRowNo + 1 + index;
    const values: Record<string, ExcelJS.CellValue> = {
      'Дата оплаты': dateCell(row.paymentDate),
      'Статус оплаты': row.paymentStatus ?? null,
      'Дата начисления': dateCell(row.accrualDate),
      'Статус начисления': row.accrualStatus ?? null,
      Контрагент: row.counterparty ?? null,
      Тип: row.type ?? null,
      Счет: 'Расчётный счёт',
      Юрлицо: 'Тестовое юрлицо',
      Статья: row.article ?? null,
      'Родительские статьи': row.article === undefined || row.article === null ? null : 'Расходы',
      'Вид деятельности': 'Операционная деятельность',
      'Назначение платежа': row.purpose ?? null,
      Проекты: 'Проверка',
      Сумма: row.amount ?? null,
      Валюта: row.currency ?? null,
    };
    PLANFACT_HEADERS.forEach((header, columnIndex) => {
      const value = values[header];
      if (value !== undefined && value !== null) {
        const cell = sheet.getCell(rowNo, columnIndex + 1);
        cell.value = value;
        if (value instanceof Date) {
          cell.numFmt = 'dd.mm.yyyy';
        }
      }
    });
  });

  const plain = Buffer.from(await workbook.xlsx.writeBuffer());
  return options.prefixed === true ? prefixWorkbook(plain) : plain;
}

/** Тот же файл, но каждый элемент XML книги записан с префиксом `x:`. */
async function prefixWorkbook(content: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(content);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/^xl\/.*\.xml$/.test(entry.name)) {
      continue;
    }
    const xml = await entry.async('string');
    zip.file(
      entry.name,
      xml
        .replace(/<([A-Za-z][\w.-]*)/g, '<x:$1')
        .replace(/<\/([A-Za-z][\w.-]*)/g, '</x:$1')
        .replace(/\sxmlns="/g, ' xmlns:x="'),
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
