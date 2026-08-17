/**
 * Краткий итог периода в PDF.
 *
 * Настоящий PDF-файл, а не переименованный текст: документ собирает та же
 * библиотека и тот же встроенный шрифт, что и печатный бланк флориста. Своей
 * зависимости этот модуль не добавляет.
 *
 * На бумагу уходит только сводка периода — суммы и баланс. Подробные строки
 * заказов живут в XLSX: их сотни, и печатать их значит переводить бумагу
 * на то, что всё равно смотрят на экране.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { SettlementReport } from './reports.js';
import { toRubles } from './export-xlsx.js';

const resolveFromHere = createRequire(import.meta.url);

let fontBytesCache: Uint8Array | null = null;

/** Шрифт читается один раз за процесс: файл около 750 КБ и не меняется. */
function fontBytes(): Uint8Array {
  if (fontBytesCache === null) {
    fontBytesCache = new Uint8Array(
      readFileSync(resolveFromHere.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')),
    );
  }
  return fontBytesCache;
}

/** A4 портрет в пунктах. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const TITLE_SIZE = 16;
const BODY_SIZE = 11;
const LINE = 18;

/**
 * Фиксированные метаданные документа.
 *
 * Повторная выгрузка того же периода обязана давать тот же файл: время
 * создания сделало бы каждый файл новым без единого изменения в данных.
 */
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** Деньги человеку: запятая, разряды и знак валюты — только при показе. */
export function formatRubles(minor: string): string {
  const value = toRubles(minor);
  return `${value.toFixed(2).replace('.', ',')} ₽`;
}

/**
 * Долг словами, а не только знаком.
 *
 * Плюс и минус на бумаге читаются по-разному у разных людей, а ошибка здесь
 * стоит денег: направление долга называется словами.
 */
export function debtDirection(balanceMinor: string): string {
  const value = BigInt(balanceMinor);
  if (value === 0n) {
    return 'взаиморасчёты закрыты';
  }
  return value > 0n ? 'курьер должен компании' : 'компания должна курьеру';
}

export async function buildSettlementPdfAsync(report: SettlementReport): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  document.setTitle(`Расчёты с курьерами ${report.period.from} — ${report.period.to}`);

  const font = await document.embedFont(fontBytes(), { subset: true });
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  let cursor = PAGE_HEIGHT - MARGIN;
  const write = (text: string, size = BODY_SIZE): void => {
    page.drawText(text, {
      x: MARGIN,
      y: cursor,
      size,
      font,
      color: rgb(0.12, 0.16, 0.23),
    });
    cursor -= LINE;
  };

  write('Расчёты с курьерами', TITLE_SIZE);
  cursor -= 6;
  write(`Период: ${report.period.from} — ${report.period.to}`);
  write(
    report.ledgerActiveFrom === null
      ? 'Учёт не включён: начислений за период нет.'
      : `Учёт ведётся с ${report.ledgerActiveFrom}.`,
  );
  cursor -= 6;

  const lines: [string, string][] = [
    ['Начальный баланс', formatRubles(report.totals.openingBalanceMinor)],
    ['Наличные, полученные курьером', formatRubles(report.totals.cashReceivedMinor)],
    ['Сдано логисту', formatRubles(report.totals.handedToLogistMinor)],
    ['Выдано курьеру', formatRubles(report.totals.issuedToCourierMinor)],
    ['Базовая оплата доставок', formatRubles(report.totals.deliveryFeesMinor)],
    ['Оплачиваемые попытки', formatRubles(report.totals.attemptFeesMinor)],
    ['Километры за МКАД', formatRubles(report.totals.distanceFeesMinor)],
    ['Расходы', formatRubles(report.totals.expensesMinor)],
    ['Доплаты', formatRubles(report.totals.bonusesMinor)],
    ['Обратные корректировки', formatRubles(report.totals.adjustmentsMinor)],
  ];

  for (const [name, value] of lines) {
    page.drawText(name, {
      x: MARGIN,
      y: cursor,
      size: BODY_SIZE,
      font,
      color: rgb(0.4, 0.45, 0.5),
    });
    page.drawText(value, {
      x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(value, BODY_SIZE),
      y: cursor,
      size: BODY_SIZE,
      font,
      color: rgb(0.12, 0.16, 0.23),
    });
    cursor -= LINE;
  }

  cursor -= 8;
  const closing = formatRubles(report.totals.closingBalanceMinor);
  write(`Конечный баланс: ${closing} — ${debtDirection(report.totals.closingBalanceMinor)}`, 13);

  /*
   * Групповые итоги на бумаге: день, курьер, заказы и итог.
   *
   * Подробные строки заказов остаются в XLSX: их сотни, и печатать их значит
   * переводить бумагу на то, что смотрят на экране.
   */
  if (report.days.length > 0) {
    cursor -= 10;
    write('Итоги по дням и курьерам', 13);
    for (const day of report.days) {
      for (const group of day.couriers) {
        if (cursor < MARGIN + LINE * 2) {
          break;
        }
        const left = `${day.date} · ${group.fullName}${group.phone === null ? '' : ` · ${group.phone}`}`;
        const right = `${group.orders} зак. · доп. ${formatRubles(group.extraExpensesMinor)} · сдал ${formatRubles(group.handedMinor)} · выдано ${formatRubles(group.issuedMinor)} · итог ${formatRubles(group.totalMinor)}`;
        page.drawText(left, {
          x: MARGIN,
          y: cursor,
          size: BODY_SIZE,
          font,
          color: rgb(0.4, 0.45, 0.5),
        });
        page.drawText(right, {
          x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(right, BODY_SIZE),
          y: cursor,
          size: BODY_SIZE,
          font,
          color: rgb(0.12, 0.16, 0.23),
        });
        cursor -= LINE;
      }
    }
  }

  const missing = report.rows.filter((row) => row.settlementMissing).length;
  if (missing > 0) {
    cursor -= 4;
    write(`Строк без расчёта: ${missing} (тариф на дату доставки не фиксировался).`);
  }

  write(`Всего строк заказов: ${report.rows.length}. Операций: ${report.entries.length}.`);

  return document.save();
}

/**
 * Синхронная обёртка недоступна: сборка PDF асинхронна по своей природе.
 * Экспортируется именно промис, чтобы вызывающий код не прятал ожидание.
 */
export function buildSettlementPdf(report: SettlementReport): Promise<Uint8Array> {
  return buildSettlementPdfAsync(report);
}
