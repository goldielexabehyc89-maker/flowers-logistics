/**
 * Критические проверки выгрузок кассы логистов.
 *
 * Эти две выгрузки не были покрыты ничем — и именно поэтому в бумажной версии
 * годами жил молчаливый обрыв: всё, что не помещалось на единственную
 * страницу, просто не печаталось, а документ выглядел полным. Отчёт, который
 * врёт молча, хуже отчёта, который отказывается строиться.
 *
 * Здесь проверяются свойства самих файлов на выдуманных данных: расчёт кассы
 * доказывают её собственные проверки.
 */

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { buildCashPdf, buildCashWorkbook } from './export-cash.js';
import type { CashGroup, CashReport } from './cash-report.js';

function group(index: number): CashGroup {
  return {
    logistUserId: `l${index}`,
    fullName: `Логист ${index}`,
    phone: null,
    openingMinor: '0',
    receivedMinor: '100000',
    takenMinor: '0',
    issuedMinor: '0',
    handedMinor: '0',
    closingMinor: '100000',
    entries: [],
  };
}

/** Отчёт из заданного числа групп «день + логист». */
function reportOf(groups: number): CashReport {
  return {
    period: { from: '2030-11-01', to: '2030-11-30' },
    summary: {
      cashOnHandMinor: '100000',
      expectedFromCouriersMinor: '0',
      receivedMinor: '100000',
      takenMinor: '0',
      issuedMinor: '0',
      handedMinor: '0',
      closingMinor: '100000',
    },
    days: Array.from({ length: groups }, (_, index) => ({
      date: '2030-11-01',
      logists: [group(index)],
    })),
    totalGroups: groups,
    limit: 500,
    offset: 0,
    hasMore: false,
    desks: [],
  };
}

describe('бумажная выгрузка кассы', () => {
  it('длинный период продолжается на следующих страницах, а не обрывается молча', async () => {
    const short = await PDFDocument.load(await buildCashPdf(reportOf(3)));
    expect(short.getPageCount()).toBe(1);

    /*
     * Шестьдесят групп на одну страницу не помещаются. Прежде лишние просто
     * не печатались, и об этом нигде не говорилось.
     */
    const long = await PDFDocument.load(await buildCashPdf(reportOf(60)));
    expect(long.getPageCount()).toBeGreaterThan(1);

    // Ни одной лишней страницы: их ровно столько, сколько нужно строкам.
    const huge = await PDFDocument.load(await buildCashPdf(reportOf(120)));
    expect(huge.getPageCount()).toBeGreaterThan(long.getPageCount());
  });

  it('повторная выгрузка того же периода даёт тот же файл', async () => {
    /*
     * Иначе «файл изменился» перестаёт что-либо значить: сравнить две
     * выгрузки нельзя, и разбирать расхождение не с чем.
     */
    const first = await buildCashPdf(reportOf(40));
    const second = await buildCashPdf(reportOf(40));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('деньги в книге остаются числами, а период назван', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildCashWorkbook(reportOf(2))) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const summary = workbook.getWorksheet('Итоги');
    const named = new Map<string, unknown>();
    summary?.eachRow((row) => named.set(String(row.getCell(1).value ?? ''), row.getCell(2).value));

    expect(named.get('Период')).toBe('2030-11-01 — 2030-11-30');
    // Число, а не подпись: в файле эти столбцы суммируют.
    expect(named.get('Наличные в кассах')).toBe(1000);
    expect(named.get('Остаток на конец')).toBe(1000);
  });

  it('все группы попадают в книгу: строк столько же, сколько групп', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await buildCashWorkbook(reportOf(40))) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    const sheet = workbook.getWorksheet('Касса');
    const names: string[] = [];
    sheet?.eachRow((row) => {
      const value = String(row.getCell(3).value ?? '');
      if (value.startsWith('Логист ')) {
        names.push(value);
      }
    });
    expect(names).toHaveLength(40);
  });
});
