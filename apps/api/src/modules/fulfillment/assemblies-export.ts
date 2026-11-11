/**
 * Выгрузка сборок флористов за период: кто, какой заказ и когда собрал.
 *
 * Источник — неизменяемый аудит «Букет собран» (`ORDER_FULFILLMENT_ASSEMBLED`),
 * тот же, по которому считается статистика смен. Отметки на самом заказе
 * (`fulfillmentAssembledById`) для выгрузки не годятся: переоткрытие и
 * пересборка их снимают, и прошлая работа пропала бы из файла.
 *
 * ЕДИНИЦА — СБОРКА ЗАКАЗА ФЛОРИСТОМ В КРУГЕ. Строка — это флорист, заказ и
 * круг сборки (`assemblyRound`). Повторное «Собрано» того же круга после
 * переоткрытия строки не добавляет: время берётся последнее. Пересборка —
 * новый круг после возврата или решения «Пересобрать» — это отдельная работа
 * и отдельная строка с пометкой. Так файл считает собранное так же, как экран
 * статистики.
 *
 * СТРОКА ОТНОСИТСЯ К ПЕРИОДУ ПОСЛЕДНЕЙ ОТМЕТКИ. Если после переоткрытия заказ
 * собран снова уже за границей периода, строка уходит в тот период, где сборка
 * завершилась окончательно. Поэтому выгрузки соседних периодов складываются
 * без двойного счёта.
 *
 * Время — московское: файл открывают в Excel, а он часовых поясов не знает.
 */

import ExcelJS from 'exceljs';
import { moscowDayRange } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';

export interface AssemblyExportRow {
  floristName: string;
  orderNumber: string;
  assembledAt: Date;
  /** Новый круг сборки (`assemblyRound > 1`), а не первая сборка заказа. */
  reassembly: boolean;
}

/**
 * Самый длинный период выгрузки — год, как у финансовых выгрузок: без предела
 * `from=2000-01-01` вытянул бы в память всю историю одним запросом.
 */
export const ASSEMBLY_EXPORT_MAX_DAYS = 366;

/** Порция идентификаторов в одном `IN`: у PostgreSQL есть предел параметров запроса. */
const LOOKUP_CHUNK = 5_000;

/** Москва — фиксированный UTC+3. */
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const ASSEMBLED = 'ORDER_FULFILLMENT_ASSEMBLED';

export function assertAssemblyExportPeriod(from: string, to: string): void {
  if (to < from) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Конец периода раньше его начала.' });
  }
  const days =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > ASSEMBLY_EXPORT_MAX_DAYS) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: `Период длиннее года: выберите срок не больше ${ASSEMBLY_EXPORT_MAX_DAYS} дней.`,
    });
  }
}

/** Круг сборки из записи аудита. У старых записей круга нет — это первый круг. */
function roundOf(newValue: unknown): number {
  const round = ((newValue ?? {}) as { assemblyRound?: unknown }).assemblyRound;
  return typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 1;
}

function assemblyKey(floristId: string | null, orderId: string, round: number): string {
  return `${floristId ?? '-'}|${orderId}|${round}`;
}

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += LOOKUP_CHUNK) {
    result.push(items.slice(index, index + LOOKUP_CHUNK));
  }
  return result;
}

export async function readAssemblyExportRows(
  db: Database,
  period: { from: string; to: string },
): Promise<AssemblyExportRow[]> {
  const start = moscowDayRange(period.from).from;
  const end = moscowDayRange(period.to).to;

  const events = await db.auditLog.findMany({
    where: { action: ASSEMBLED, occurredAt: { gte: start, lt: end } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: {
      occurredAt: true,
      actorUserId: true,
      entityId: true,
      newValue: true,
      actor: { select: { fullName: true } },
    },
  });

  // Выборка идёт по времени, поэтому поздняя отметка той же сборки
  // перезаписывает раннюю: остаётся последняя.
  const latest = new Map<
    string,
    { orderId: string; floristName: string | null; assembledAt: Date; round: number }
  >();
  for (const event of events) {
    if (event.entityId === null) {
      continue;
    }
    const round = roundOf(event.newValue);
    latest.set(assemblyKey(event.actorUserId, event.entityId, round), {
      orderId: event.entityId,
      floristName: event.actor?.fullName ?? null,
      assembledAt: event.occurredAt,
      round,
    });
  }

  const orderIds = [...new Set([...latest.values()].map((assembly) => assembly.orderId))];
  const finishedLater = new Set<string>();
  const numbers = new Map<string, string>();
  for (const ids of chunks(orderIds)) {
    const later = await db.auditLog.findMany({
      where: { action: ASSEMBLED, occurredAt: { gte: end }, entityId: { in: ids } },
      select: { actorUserId: true, entityId: true, newValue: true },
    });
    for (const event of later) {
      if (event.entityId !== null) {
        finishedLater.add(assemblyKey(event.actorUserId, event.entityId, roundOf(event.newValue)));
      }
    }

    const orders = await db.deliveryOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, externalName: true },
    });
    for (const order of orders) {
      numbers.set(order.id, order.externalName);
    }
  }

  return [...latest.entries()]
    .filter(([key]) => !finishedLater.has(key))
    .map(([, assembly]) => ({
      floristName: assembly.floristName ?? 'Флорист удалён из справочника',
      orderNumber: numbers.get(assembly.orderId) ?? '—',
      assembledAt: assembly.assembledAt,
      reassembly: assembly.round > 1,
    }))
    .sort(
      (a, b) =>
        a.assembledAt.getTime() - b.assembledAt.getTime() ||
        a.floristName.localeCompare(b.floristName, 'ru') ||
        a.orderNumber.localeCompare(b.orderNumber, 'ru'),
    );
}

export async function buildAssembliesWorkbook(
  rows: readonly AssemblyExportRow[],
  period: { from: string; to: string },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Логистика';
  // Повторная выгрузка того же периода даёт тот же файл: дата создания — начало периода.
  workbook.created = new Date(`${period.from}T00:00:00.000Z`);
  workbook.modified = workbook.created;

  const sheet = workbook.addWorksheet('Сборки');
  sheet.columns = [
    { header: 'ФИО', key: 'florist', width: 32 },
    { header: 'Номер заказа', key: 'order', width: 18 },
    { header: 'Время сборки', key: 'at', width: 18, style: { numFmt: 'dd.mm.yyyy hh:mm' } },
    { header: 'Пересборка', key: 'reassembly', width: 12 },
  ];
  sheet.addRows(
    rows.map((row) => ({
      florist: row.floristName,
      order: row.orderNumber,
      // Дата в ячейке без пояса: Excel покажет ровно московские часы.
      at: new Date(row.assembledAt.getTime() + MOSCOW_OFFSET_MS),
      reassembly: row.reassembly ? 'да' : 'нет',
    })),
  );
  sheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
