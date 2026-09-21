/**
 * Разбор Excel-выписки ПланФакта.
 *
 * Выписка — книга `.xlsx` с одним листом: служебная строка «ПланФакт», строка
 * заголовков, дальше операции. Столбцы находятся ПО ЗАГОЛОВКАМ, а не по
 * номерам: ПланФакт вправе переставить или добавить столбец, и разбор по
 * позициям молча читал бы сумму из соседней колонки.
 *
 * Здесь только чтение файла и восстановление его структуры — какие строки
 * есть, что в них написано и как выплата разбита на части. Кому платить и
 * можно ли проводить, решает `payout-import.ts`: разбор не знает ни курьеров,
 * ни журнала.
 *
 * ДЕНЬГИ И ДАТЫ. Сумма приводится к целым копейкам без потери: Excel хранит
 * число с плавающей точкой, и «28 944,01» приходит как 28944.01 — округление
 * до копейки восстанавливает точное значение, а полкопейки отвергаются как
 * нераспознанная сумма. Дата берётся календарным днём БЕЗ сдвига часового
 * пояса: ExcelJS отдаёт даты полуночью UTC, и локальное время превратило бы
 * 16 сентября в 15-е.
 */

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { AppError } from '../../platform/errors.js';
import { isCalendarDate } from '../integrations/moysklad/delivery-date.js';

/** Одна строка выписки с распознанными полями. */
export interface StatementLine {
  /** Номер строки в файле — так, как его видит человек в Excel. */
  rowNo: number;
  paymentDate: string | null;
  /** В ячейке даты что-то есть, но датой это не является. */
  paymentDateInvalid: boolean;
  paymentStatus: string | null;
  accrualDate: string | null;
  accrualStatus: string | null;
  counterparty: string | null;
  type: string | null;
  article: string | null;
  /** Копейки со знаком файла: у выплаты минус. `null` — ячейка пуста. */
  amountMinor: bigint | null;
  /** В ячейке суммы что-то есть, но числом до копейки это не является. */
  amountInvalid: boolean;
  currency: string | null;
  purpose: string | null;
}

/**
 * Кандидат в выплату: отдельная строка или часть разбитой выплаты.
 *
 * У части нет своей даты и статуса оплаты — они наследуются от родительской
 * строки, а сумма и контрагент у части свои.
 */
export interface StatementPayout {
  rowNo: number;
  /** Родительская выплата, если строка — её часть. */
  parentRowNo: number | null;
  counterparty: string | null;
  /** Тип операции. У части — тип родительской выплаты: часть поступления выплатой не становится. */
  type: string | null;
  article: string | null;
  currency: string | null;
  paymentDate: string | null;
  paymentDateInvalid: boolean;
  /** Оплата подтверждена, и начисление (если у строки оно есть) тоже. */
  confirmed: boolean;
  /** Статус, который помешал считать строку подтверждённой. */
  unconfirmedStatus: string | null;
  amountMinor: bigint | null;
  amountInvalid: boolean;
  /** Ошибка структуры группы частей: ни одна часть группы не проводится. */
  groupError: string | null;
}

export interface StatementContainer {
  rowNo: number;
  amountMinor: bigint | null;
  partRowNos: number[];
}

export interface ParsedStatement {
  sheetName: string;
  headerRowNo: number;
  /** Сколько строк с данными прочитано после заголовков. */
  lineCount: number;
  lines: StatementLine[];
  payouts: StatementPayout[];
  /** Родительские строки, разбитые на части: сами не проводятся. */
  containers: StatementContainer[];
}

/** Заголовки, без которых выписку читать нельзя. */
const REQUIRED_HEADERS = {
  paymentDate: 'дата оплаты',
  paymentStatus: 'статус оплаты',
  counterparty: 'контрагент',
  type: 'тип',
  article: 'статья',
  amount: 'сумма',
  currency: 'валюта',
} as const;

const OPTIONAL_HEADERS = {
  accrualDate: 'дата начисления',
  accrualStatus: 'статус начисления',
  purpose: 'назначение платежа',
} as const;

type HeaderKey = keyof typeof REQUIRED_HEADERS | keyof typeof OPTIONAL_HEADERS;

/** В скольких первых строках искать заголовки. */
const HEADER_SEARCH_ROWS = 30;

/** Статус, при котором операция считается проведённой в ПланФакте. */
const CONFIRMED_STATUS = 'подтверждена';
const PART_TYPE = 'часть';

function invalidFile(publicMessage: string): AppError {
  return new AppError('VALIDATION_FAILED', { publicMessage });
}

/**
 * Книга Excel из содержимого файла.
 *
 * ПланФакт пишет XML с префиксом пространства имён `x:` (`<x:worksheet>`,
 * `<x:sheetData>`), что по стандарту допустимо, но ExcelJS такие книги не
 * читает и падает ещё на списке листов. Префикс снимается на уровне ZIP до
 * разбора; книги без префикса проходят как есть.
 */
async function loadWorkbook(content: Buffer): Promise<ExcelJS.Workbook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(content);
  } catch {
    throw invalidFile('Файл не является книгой Excel (.xlsx).');
  }
  if (zip.file('xl/workbook.xml') === null) {
    throw invalidFile('В файле нет книги Excel: ожидается выписка в формате .xlsx.');
  }

  let rewritten = false;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/i.test(entry.name)) {
      continue;
    }
    const xml = await entry.async('string');
    if (!/<x:[A-Za-z]/.test(xml)) {
      continue;
    }
    // Если у корня уже есть пространство имён по умолчанию, объявление `x:`
    // просто убирается — второе `xmlns` сделало бы XML некорректным.
    const hasDefaultNamespace = /<[A-Za-z][^>]*\sxmlns="/.test(xml);
    zip.file(
      entry.name,
      xml
        .replace(/<x:/g, '<')
        .replace(/<\/x:/g, '</')
        .replace(/\sxmlns:x="([^"]*)"/g, (_match, uri: string) =>
          hasDefaultNamespace ? '' : ` xmlns="${uri}"`,
        ),
    );
    rewritten = true;
  }

  const source = rewritten ? await zip.generateAsync({ type: 'nodebuffer' }) : content;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(source as unknown as ExcelJS.Buffer);
  } catch {
    throw invalidFile(
      'Не удалось прочитать книгу Excel: файл повреждён или имеет неожиданный формат.',
    );
  }
  return workbook;
}

/** Текст ячейки: строка, число, дата, формула, гиперссылка, форматированный текст. */
export function cellText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record['richText'])) {
      const joined = (record['richText'] as { text?: unknown }[])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      return joined === '' ? null : joined;
    }
    if ('text' in record) {
      return cellText(record['text']);
    }
    if ('result' in record) {
      return cellText(record['result']);
    }
  }
  return null;
}

/** Календарный день из ячейки: дата, порядковый номер Excel или текст. */
export function cellDay(value: unknown): { day: string | null; invalid: boolean } {
  if (value === null || value === undefined || value === '') {
    return { day: null, invalid: false };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { day: null, invalid: true };
    }
    // Полночь UTC — так ExcelJS отдаёт даты; берём день по UTC, без сдвига.
    return checkedDay(value.toISOString().slice(0, 10));
  }
  if (typeof value === 'number') {
    // Порядковый номер Excel: дни от 30.12.1899. Диапазон отсекает суммы,
    // случайно попавшие в столбец даты.
    if (value < 20_000 || value > 80_000) {
      return { day: null, invalid: true };
    }
    const millis = Math.round((value - 25_569) * 86_400_000);
    return checkedDay(new Date(millis).toISOString().slice(0, 10));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const dotted = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s|$)/.exec(text);
    if (dotted !== null) {
      return checkedDay(`${dotted[3]}-${dotted[2]}-${dotted[1]}`);
    }
    const iso = /^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/.exec(text);
    if (iso !== null) {
      return checkedDay(iso[1] as string);
    }
    return { day: null, invalid: true };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('result' in record) {
      return cellDay(record['result']);
    }
    if ('text' in record) {
      return cellDay(record['text']);
    }
  }
  return { day: null, invalid: true };
}

function checkedDay(day: string): { day: string | null; invalid: boolean } {
  return isCalendarDate(day) ? { day, invalid: false } : { day: null, invalid: true };
}

/**
 * Копейки из ячейки суммы, точно и со знаком.
 *
 * Полкопейки — не сумма: Excel хранит число с плавающей точкой, и 28944.01
 * восстанавливается округлением до копейки, а 100.005 не восстанавливается
 * ничем и отвергается.
 */
export function cellMinor(value: unknown): { minor: bigint | null; invalid: boolean } {
  if (value === null || value === undefined || value === '') {
    return { minor: null, invalid: false };
  }
  if (typeof value === 'number') {
    return numberToMinor(value);
  }
  if (typeof value === 'string') {
    // «−28 944,01», «28944.01 ₽», неразрывные пробелы — всё это одно число.
    const normalized = value
      .replace(/[\s\u00A0]/g, '')
      .replace(/\u2212/g, '-')
      .replace(',', '.')
      .replace(/[^\d.+-]/g, '');
    if (normalized === '' || !/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
      return { minor: null, invalid: true };
    }
    return numberToMinor(Number(normalized));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('result' in record) {
      return cellMinor(record['result']);
    }
  }
  return { minor: null, invalid: true };
}

function numberToMinor(value: number): { minor: bigint | null; invalid: boolean } {
  if (!Number.isFinite(value)) {
    return { minor: null, invalid: true };
  }
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  // Допуск покрывает ошибку представления, но не половину копейки.
  if (Math.abs(scaled - rounded) > 1e-3 || !Number.isSafeInteger(rounded)) {
    return { minor: null, invalid: true };
  }
  return { minor: BigInt(rounded), invalid: false };
}

function normalizedHeader(value: unknown): string | null {
  const text = cellText(value);
  return text === null ? null : text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Строка заголовков и номера столбцов по ключам. */
function findHeader(sheet: ExcelJS.Worksheet): { rowNo: number; columns: Map<HeaderKey, number> } {
  const wanted = new Map<string, HeaderKey>();
  for (const [key, label] of Object.entries(REQUIRED_HEADERS)) {
    wanted.set(label, key as HeaderKey);
  }
  for (const [key, label] of Object.entries(OPTIONAL_HEADERS)) {
    wanted.set(label, key as HeaderKey);
  }

  const last = Math.min(sheet.rowCount, HEADER_SEARCH_ROWS);
  for (let rowNo = 1; rowNo <= last; rowNo += 1) {
    const row = sheet.getRow(rowNo);
    const columns = new Map<HeaderKey, number>();
    row.eachCell({ includeEmpty: false }, (cell, columnNo) => {
      const key = wanted.get(normalizedHeader(cell.value) ?? '');
      if (key !== undefined && !columns.has(key)) {
        columns.set(key, columnNo);
      }
    });
    const complete = Object.keys(REQUIRED_HEADERS).every((key) => columns.has(key as HeaderKey));
    if (complete) {
      return { rowNo, columns };
    }
  }

  throw invalidFile(
    'В файле не найдена строка заголовков выписки ПланФакта: нужны столбцы ' +
      '«Дата оплаты», «Статус оплаты», «Контрагент», «Тип», «Статья», «Сумма», «Валюта».',
  );
}

function isConfirmed(status: string | null): boolean {
  return status !== null && status.trim().toLowerCase() === CONFIRMED_STATUS;
}

function isPartType(type: string | null): boolean {
  return type !== null && type.trim().toLowerCase() === PART_TYPE;
}

function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const value = negative ? -minor : minor;
  const rubles = (value / 100n).toString();
  const kopecks = (value % 100n).toString().padStart(2, '0');
  return `${negative ? '−' : ''}${rubles},${kopecks} ₽`;
}

/**
 * Группировка частей.
 *
 * Части идут в файле сразу за своей выплатой и не несут ни даты, ни статуса
 * оплаты. Родительская строка при этом сама выплатой не проводится — иначе
 * сумма легла бы дважды: целиком и по частям. Если части не сходятся с
 * родителем по сумме или у них не читается сумма, вся группа помечается
 * ошибкой: угадывать, какая из строк права, нельзя.
 */
function groupPayouts(lines: readonly StatementLine[]): {
  payouts: StatementPayout[];
  containers: StatementContainer[];
} {
  const payouts: StatementPayout[] = [];
  const containers: StatementContainer[] = [];

  let current: { parent: StatementLine; parts: StatementLine[] } | null = null;

  const flush = (): void => {
    if (current === null) {
      return;
    }
    const { parent, parts } = current;
    current = null;

    if (parts.length === 0) {
      payouts.push(standalone(parent));
      return;
    }

    let groupError: string | null = null;
    if (parent.amountMinor === null || parent.amountInvalid) {
      groupError = 'сумма родительской выплаты не распознана';
    } else if (parts.some((part) => part.amountMinor === null || part.amountInvalid)) {
      groupError = 'сумма одной из частей не распознана';
    } else {
      const partsSum = parts.reduce((total, part) => total + (part.amountMinor ?? 0n), 0n);
      if (partsSum !== parent.amountMinor) {
        groupError = `сумма частей (${formatMinor(partsSum)}) не равна сумме выплаты (${formatMinor(parent.amountMinor)})`;
      }
    }

    containers.push({
      rowNo: parent.rowNo,
      amountMinor: parent.amountMinor,
      partRowNos: parts.map((part) => part.rowNo),
    });

    for (const part of parts) {
      const paymentStatus = part.paymentStatus ?? parent.paymentStatus;
      const ownDate = part.paymentDate !== null || part.paymentDateInvalid;
      payouts.push({
        rowNo: part.rowNo,
        parentRowNo: parent.rowNo,
        counterparty: part.counterparty,
        type: parent.type,
        article: part.article,
        currency: part.currency ?? parent.currency,
        paymentDate: ownDate ? part.paymentDate : parent.paymentDate,
        paymentDateInvalid: ownDate ? part.paymentDateInvalid : parent.paymentDateInvalid,
        ...confirmation(paymentStatus, part.accrualStatus),
        amountMinor: part.amountMinor,
        amountInvalid: part.amountInvalid,
        groupError,
      });
    }
  };

  for (const line of lines) {
    if (isPartType(line.type)) {
      if (current === null) {
        // Часть без родительской строки: проводить её не по чему.
        payouts.push({
          ...standalone(line),
          groupError: 'часть выплаты без родительской строки',
        });
        continue;
      }
      current.parts.push(line);
      continue;
    }
    flush();
    current = { parent: line, parts: [] };
  }
  flush();

  return { payouts, containers };
}

function confirmation(
  paymentStatus: string | null,
  accrualStatus: string | null,
): { confirmed: boolean; unconfirmedStatus: string | null } {
  if (!isConfirmed(paymentStatus)) {
    return { confirmed: false, unconfirmedStatus: paymentStatus ?? '' };
  }
  if (accrualStatus !== null && !isConfirmed(accrualStatus)) {
    return { confirmed: false, unconfirmedStatus: accrualStatus };
  }
  return { confirmed: true, unconfirmedStatus: null };
}

function standalone(line: StatementLine): StatementPayout {
  return {
    rowNo: line.rowNo,
    parentRowNo: null,
    counterparty: line.counterparty,
    type: line.type,
    article: line.article,
    currency: line.currency,
    paymentDate: line.paymentDate,
    paymentDateInvalid: line.paymentDateInvalid,
    ...confirmation(line.paymentStatus, line.accrualStatus),
    amountMinor: line.amountMinor,
    amountInvalid: line.amountInvalid,
    groupError: null,
  };
}

/** Разбор файла выписки. Бросает `VALIDATION_FAILED` с понятной причиной, если это не выписка. */
export async function parsePlanFactStatement(content: Buffer): Promise<ParsedStatement> {
  const workbook = await loadWorkbook(content);
  const sheet = workbook.worksheets.find((candidate) => candidate.rowCount > 0);
  if (sheet === undefined) {
    throw invalidFile('В книге нет ни одного листа с данными.');
  }

  const header = findHeader(sheet);
  const column = (key: HeaderKey): number | undefined => header.columns.get(key);
  const read = (row: ExcelJS.Row, key: HeaderKey): unknown => {
    const columnNo = column(key);
    return columnNo === undefined ? null : row.getCell(columnNo).value;
  };

  const lines: StatementLine[] = [];
  for (let rowNo = header.rowNo + 1; rowNo <= sheet.rowCount; rowNo += 1) {
    const row = sheet.getRow(rowNo);
    let empty = true;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellText(cell.value) !== null) {
        empty = false;
      }
    });
    if (empty) {
      continue;
    }

    const paymentDate = cellDay(read(row, 'paymentDate'));
    const accrualDate = cellDay(read(row, 'accrualDate'));
    const amount = cellMinor(read(row, 'amount'));

    lines.push({
      rowNo,
      paymentDate: paymentDate.day,
      paymentDateInvalid: paymentDate.invalid,
      paymentStatus: cellText(read(row, 'paymentStatus')),
      accrualDate: accrualDate.day,
      accrualStatus: cellText(read(row, 'accrualStatus')),
      counterparty: cellText(read(row, 'counterparty')),
      type: cellText(read(row, 'type')),
      article: cellText(read(row, 'article')),
      amountMinor: amount.minor,
      amountInvalid: amount.invalid,
      currency: cellText(read(row, 'currency')),
      purpose: cellText(read(row, 'purpose')),
    });
  }

  const grouped = groupPayouts(lines);

  return {
    sheetName: sheet.name,
    headerRowNo: header.rowNo,
    lineCount: lines.length,
    lines,
    payouts: grouped.payouts,
    containers: grouped.containers,
  };
}
