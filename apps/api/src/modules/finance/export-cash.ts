/**
 * Выгрузки «Кассы логистов».
 *
 * Файл повторяет иерархию экрана: дневная строка логиста с остатками на начало
 * и конец, затем подробный журнал её операций. Столбец «Уровень» позволяет
 * оставить в Excel либо только итоги, либо только детализацию — без него две
 * разные сущности в одной таблице не различить.
 */

import ExcelJS from 'exceljs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { CashReport } from './cash-report.js';
import { toRubles } from './export-xlsx.js';

const resolveFromHere = createRequire(import.meta.url);
let fontCache: Uint8Array | null = null;

function fontBytes(): Uint8Array {
  if (fontCache === null) {
    fontCache = new Uint8Array(
      readFileSync(resolveFromHere.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf')),
    );
  }
  return fontCache;
}

const KIND_LABELS: Record<string, string> = {
  RECEIVED_FROM_COURIER: 'Получено от курьера',
  ISSUED_TO_COURIER: 'Выдано курьеру',
  TAKEN_FROM_COMPANY: 'Взято из компании',
  HANDED_TO_COMPANY: 'Сдано в компанию',
  ADJUSTMENT: 'Обратная корректировка',
};

export async function buildCashWorkbook(report: CashReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Логистика';
  // Повторная выгрузка того же периода обязана давать тот же файл.
  workbook.created = new Date(`${report.period.from}T00:00:00.000Z`);
  workbook.modified = workbook.created;

  const summary = workbook.addWorksheet('Итоги');
  summary.columns = [
    { header: 'Показатель', key: 'name', width: 34 },
    { header: 'Сумма, ₽', key: 'value', width: 16, style: { numFmt: '#,##0.00' } },
  ];
  summary.addRows([
    { name: 'Период', value: `${report.period.from} — ${report.period.to}` },
    { name: 'Наличные в кассах', value: toRubles(report.summary.cashOnHandMinor) },
    { name: 'Ожидается к сдаче', value: toRubles(report.summary.expectedFromCouriersMinor) },
    { name: 'Получено от курьеров', value: toRubles(report.summary.receivedMinor) },
    { name: 'Взято из компании', value: toRubles(report.summary.takenMinor) },
    { name: 'Выдано курьерам', value: toRubles(report.summary.issuedMinor) },
    { name: 'Сдано в компанию', value: toRubles(report.summary.handedMinor) },
    { name: 'Остаток на конец', value: toRubles(report.summary.closingMinor) },
  ]);
  summary.getRow(1).font = { bold: true };

  const rows = workbook.addWorksheet('Касса');
  rows.columns = [
    { header: 'Уровень', key: 'level', width: 12 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Логист', key: 'logist', width: 26 },
    { header: 'Телефон', key: 'phone', width: 16 },
    { header: 'Время', key: 'time', width: 20 },
    { header: 'Операция', key: 'kind', width: 26 },
    { header: 'Курьер', key: 'courier', width: 24 },
    { header: 'Остаток на начало, ₽', key: 'opening', width: 20, style: { numFmt: '#,##0.00' } },
    { header: 'Получено, ₽', key: 'received', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Взято, ₽', key: 'taken', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Выдано, ₽', key: 'issued', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Сдано, ₽', key: 'handed', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Сумма, ₽', key: 'amount', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Остаток на конец, ₽', key: 'closing', width: 20, style: { numFmt: '#,##0.00' } },
    { header: 'Автор', key: 'author', width: 24 },
    { header: 'Отменена', key: 'reversed', width: 12 },
  ];

  for (const day of report.days) {
    for (const group of day.logists) {
      rows.addRow({
        level: 'Итог дня',
        date: day.date,
        logist: group.fullName,
        phone: group.phone ?? '',
        opening: toRubles(group.openingMinor),
        received: toRubles(group.receivedMinor),
        taken: toRubles(group.takenMinor),
        issued: toRubles(group.issuedMinor),
        handed: toRubles(group.handedMinor),
        closing: toRubles(group.closingMinor),
      }).font = { bold: true };

      for (const entry of group.entries) {
        rows.addRow({
          level: 'Операция',
          date: entry.operationDate,
          logist: group.fullName,
          phone: group.phone ?? '',
          time: entry.occurredAt,
          kind: KIND_LABELS[entry.kind] ?? entry.kind,
          courier: entry.courierName ?? '',
          amount: toRubles(entry.amountMinor),
          author: entry.actorName ?? '',
          reversed: entry.reversed ? 'да' : '',
        });
      }
    }
  }
  rows.getRow(1).font = { bold: true };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const BODY = 11;
const LINE = 18;
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/**
 * Деньги на бумагу — СО ЗНАКОМ.
 *
 * Модуль здесь применять нельзя: форматтер денег, теряющий знак, превращает
 * долг в приход молча. Сегодня все показатели кассы неотрицательны по
 * построению, но это свойство агрегата, а не форматирования, и держаться на
 * нём формат не должен.
 */
function rubles(minor: string): string {
  return `${(Number(BigInt(minor)) / 100).toFixed(2).replace('.', ',')} ₽`;
}

export async function buildCashPdf(report: CashReport): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  document.setTitle(`Касса логистов ${report.period.from} — ${report.period.to}`);

  const font = await document.embedFont(fontBytes(), { subset: true });
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursor = PAGE_HEIGHT - MARGIN;

  /**
   * Продолжение на новой странице.
   *
   * Документ состоял ровно из одной страницы: всё, что на неё не помещалось,
   * молча не печаталось — и отчёт выглядел полным. За период в несколько дней
   * половина групп «день + логист» просто исчезала.
   */
  const ensureRoom = (): void => {
    if (cursor < MARGIN + LINE * 2) {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor = PAGE_HEIGHT - MARGIN;
    }
  };

  const line = (text: string, size = BODY): void => {
    ensureRoom();
    page.drawText(text, { x: MARGIN, y: cursor, size, font, color: rgb(0.12, 0.16, 0.23) });
    cursor -= LINE;
  };

  line('Касса логистов', 16);
  cursor -= 6;
  line(`Период: ${report.period.from} — ${report.period.to}`);
  cursor -= 6;

  for (const [name, value] of [
    ['Наличные в кассах', report.summary.cashOnHandMinor],
    ['Ожидается к сдаче', report.summary.expectedFromCouriersMinor],
    ['Получено от курьеров', report.summary.receivedMinor],
    ['Взято из компании', report.summary.takenMinor],
    ['Выдано курьерам', report.summary.issuedMinor],
    ['Сдано в компанию', report.summary.handedMinor],
    ['Остаток на конец', report.summary.closingMinor],
  ] as [string, string][]) {
    ensureRoom();
    page.drawText(name, { x: MARGIN, y: cursor, size: BODY, font, color: rgb(0.4, 0.45, 0.5) });
    const text = rubles(value);
    page.drawText(text, {
      x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(text, BODY),
      y: cursor,
      size: BODY,
      font,
      color: rgb(0.12, 0.16, 0.23),
    });
    cursor -= LINE;
  }

  cursor -= 8;
  line('Дни и логисты', 13);
  for (const day of report.days) {
    for (const group of day.logists) {
      ensureRoom();
      const left = `${day.date} · ${group.fullName}`;
      const right = `начало ${rubles(group.openingMinor)} · конец ${rubles(group.closingMinor)}`;
      page.drawText(left, { x: MARGIN, y: cursor, size: BODY, font, color: rgb(0.4, 0.45, 0.5) });
      page.drawText(right, {
        x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(right, BODY),
        y: cursor,
        size: BODY,
        font,
        color: rgb(0.12, 0.16, 0.23),
      });
      cursor -= LINE;
    }
  }

  return document.save();
}
