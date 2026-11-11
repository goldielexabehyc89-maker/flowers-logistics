/**
 * Выгрузки отчётов: «Выгрузить XLSX» и «Итог в PDF».
 *
 * Это кнопки, а не ссылки на адрес API. Access-токен живёт только в памяти
 * клиента и уходит заголовком `Authorization`, а переход по `href` его не
 * несёт: сервер отвечал 401, и вкладка вместо файла показывала текст ошибки.
 * Поэтому файл забирается запросом с токеном — с тем же обновлением сессии
 * и единственным повтором, что у любого запроса, — и сохраняется из памяти.
 * Сервер по-прежнему принимает только заголовок: токена в адресе и cookie
 * для выгрузок нет.
 */

import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import { Button } from '../../ui/components';

export type ReportExportKind = 'settlements' | 'cash';
export type ReportExportFormat = 'xlsx' | 'pdf';

const ACCEPT: Record<ReportExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export interface ReportExportSelection {
  from: string;
  to: string;
  /** Только для расчётов: выгрузка по одному курьеру. Пустая строка — все курьеры. */
  courierUserId?: string;
}

export interface ReportExportRequest {
  path: string;
  accept: string;
  fileName: string;
}

/**
 * Адрес выгрузки и имя файла.
 *
 * Выгрузка отдаёт ВЕСЬ отбор, а не показанную страницу: ни `limit`, ни
 * `offset` в адрес не попадают. Имя повторяет то, что сервер ставит
 * в `Content-Disposition`: файл сохраняется из памяти, заголовка ответа там
 * уже нет, и без явного имени браузер назвал бы файл случайной строкой.
 */
export function reportExportRequest(
  kind: ReportExportKind,
  format: ReportExportFormat,
  selection: ReportExportSelection,
): ReportExportRequest {
  const search = new URLSearchParams({ from: selection.from, to: selection.to });
  if (selection.courierUserId !== undefined && selection.courierUserId !== '') {
    search.set('courierUserId', selection.courierUserId);
  }
  return {
    path: `/api/logistics/reports/${kind}.${format}?${search.toString()}`,
    accept: ACCEPT[format],
    fileName: `${kind}-${selection.from}_${selection.to}.${format}`,
  };
}

/** Отдаёт файл браузеру. Ссылка на объект освобождается сразу: иначе вкладка копила бы их. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export interface ReportExportButtonsProps {
  kind: ReportExportKind;
  selection: ReportExportSelection;
  /** Префикс `data-testid`: `reports` в расчётах, `cash` в кассе. */
  testIdPrefix: string;
}

export function ReportExportButtons({
  kind,
  selection,
  testIdPrefix,
}: ReportExportButtonsProps): React.JSX.Element {
  const { client } = useAuth();
  const { showToast } = useToast();
  /**
   * Какие файлы сейчас готовятся.
   *
   * Пока файл собирается, его кнопка занята: повторное нажатие не запускает
   * вторую выгрузку, а каждая выгрузка оставляет запись в аудите. Соседняя
   * кнопка остаётся доступной — XLSX и PDF друг другу не мешают.
   */
  const [pending, setPending] = useState<ReadonlySet<ReportExportFormat>>(new Set());

  async function download(format: ReportExportFormat): Promise<void> {
    const request = reportExportRequest(kind, format, selection);
    setPending((current) => new Set(current).add(format));
    try {
      saveBlob(await client.getBlob(request.path, request.accept), request.fileName);
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Не удалось выгрузить отчёт.', 'error');
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(format);
        return next;
      });
    }
  }

  return (
    <>
      <Button
        className="reports__export"
        data-testid={`${testIdPrefix}-xlsx`}
        loading={pending.has('xlsx')}
        onClick={() => void download('xlsx')}
      >
        Выгрузить XLSX
      </Button>
      <Button
        className="reports__export"
        data-testid={`${testIdPrefix}-pdf`}
        loading={pending.has('pdf')}
        onClick={() => void download('pdf')}
      >
        Итог в PDF
      </Button>
    </>
  );
}
