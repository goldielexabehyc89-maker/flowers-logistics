/**
 * Критические проверки выгрузок «Отчётов» и «Кассы».
 *
 * Саму кнопку проверяет браузерный сценарий: только настоящий браузер
 * показывает, что файл скачивается с токеном, а не открывается страница 401.
 * Здесь — то, чего сценарий не заметит: выгрузка расчётов несёт ВЕСЬ отбор,
 * а не показанную страницу, и файл называется так же, как его называет сервер.
 */

import { describe, expect, it } from 'vitest';
import { reportExportRequest } from './ReportExport';

const COURIER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function query(path: string): Record<string, string> {
  return Object.fromEntries(new URL(path, 'http://app.test').searchParams);
}

describe('выгрузка расчётов', () => {
  it('несёт период и курьера, но не страницу: в файле весь отбор', () => {
    /*
     * Экран просит отчёт страницами («Показать ещё» наращивает `limit`).
     * Выгрузка с теми же `limit`/`offset` молча отдала бы только показанные
     * дни — сумма в файле разошлась бы с итогом периода.
     */
    for (const format of ['xlsx', 'pdf'] as const) {
      const request = reportExportRequest('settlements', format, {
        from: '2026-11-01',
        to: '2026-11-11',
        courierUserId: COURIER,
      });
      expect(new URL(request.path, 'http://app.test').pathname).toBe(
        `/api/logistics/reports/settlements.${format}`,
      );
      expect(query(request.path)).toEqual({
        from: '2026-11-01',
        to: '2026-11-11',
        courierUserId: COURIER,
      });
    }
  });

  it('«Все курьеры» не превращаются в пустой отбор по курьеру', () => {
    const request = reportExportRequest('settlements', 'xlsx', {
      from: '2026-11-01',
      to: '2026-11-11',
      courierUserId: '',
    });
    // Пустой `courierUserId=` сервер отверг бы проверкой UUID.
    expect(query(request.path)).toEqual({ from: '2026-11-01', to: '2026-11-11' });
  });

  it('имя файла повторяет серверное', () => {
    expect(
      reportExportRequest('settlements', 'xlsx', { from: '2026-11-01', to: '2026-11-11' }).fileName,
    ).toBe('settlements-2026-11-01_2026-11-11.xlsx');
    expect(
      reportExportRequest('settlements', 'pdf', { from: '2026-11-01', to: '2026-11-11' }).fileName,
    ).toBe('settlements-2026-11-01_2026-11-11.pdf');
  });
});

describe('выгрузка кассы', () => {
  it('отбирается периодом, имя файла — как у сервера', () => {
    for (const format of ['xlsx', 'pdf'] as const) {
      const request = reportExportRequest('cash', format, { from: '2026-11-11', to: '2026-11-11' });
      expect(new URL(request.path, 'http://app.test').pathname).toBe(
        `/api/logistics/reports/cash.${format}`,
      );
      expect(query(request.path)).toEqual({ from: '2026-11-11', to: '2026-11-11' });
      expect(request.fileName).toBe(`cash-2026-11-11_2026-11-11.${format}`);
    }
  });
});
