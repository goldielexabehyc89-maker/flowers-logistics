/**
 * Выгрузка расчётов с курьерами в XLSX.
 *
 * Формат делает библиотека, а не собственный код: XLSX — это zip с несколькими
 * XML внутри, и самописный вариант доказал бы только согласованность с самим
 * собой, а открывать файл будет чужой Excel.
 *
 * Деньги выгружаются ЧИСЛАМИ в рублях с двумя знаками, а не строками: в файле
 * их суммируют, и текст в этом месте превратил бы отчёт в набор подписей.
 * Само хранение остаётся в целых минорных единицах — перевод выполняется
 * ровно здесь, на границе выгрузки.
 */

import ExcelJS from 'exceljs';
import type { SettlementReport } from './reports.js';

/** Минорные единицы в рубли. Делится ровно один раз и в одном месте. */
export function toRubles(minor: string): number {
  return Number(BigInt(minor)) / 100;
}

const OUTCOME_LABELS: Record<string, string> = {
  DELIVERED: 'Доставлен',
  NOT_DELIVERED: 'Не доставлен',
};

const KIND_LABELS: Record<string, string> = {
  CASH_RECEIVED: 'Наличные получены курьером',
  DELIVERY_FEE: 'Оплата за доставку',
  DISTANCE_FEE: 'Оплата километров за МКАД',
  ATTEMPT_FEE: 'Оплачиваемая попытка',
  CASH_HANDED_TO_LOGIST: 'Курьер сдал логисту',
  CASH_ISSUED_TO_COURIER: 'Логист выдал курьеру',
  EXPENSE_PARKING: 'Расход: парковка',
  EXPENSE_TOLL: 'Расход: платная дорога',
  EXPENSE_TRANSIT: 'Расход: общественный транспорт',
  EXPENSE_REPAIR: 'Расход: ремонт',
  EXPENSE_LOADING: 'Расход: погрузка',
  EXPENSE_OTHER: 'Дополнительный расход',
  BONUS: 'Доплата курьеру',
  ADJUSTMENT: 'Обратная корректировка',
};

export function ledgerKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export async function buildSettlementWorkbook(report: SettlementReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Логистика';
  /*
   * Даты создания фиксированы началом периода.
   *
   * Повторная выгрузка того же периода обязана давать тот же файл: иначе
   * сравнить две выгрузки нельзя, а «файл изменился» перестаёт что-либо значить.
   */
  workbook.created = new Date(`${report.period.from}T00:00:00.000Z`);
  workbook.modified = workbook.created;

  const summary = workbook.addWorksheet('Итоги');
  summary.columns = [
    { header: 'Показатель', key: 'name', width: 38 },
    { header: 'Сумма, ₽', key: 'value', width: 16, style: { numFmt: '#,##0.00' } },
  ];
  summary.addRows([
    { name: 'Период', value: `${report.period.from} — ${report.period.to}` },
    { name: 'Начальный баланс', value: toRubles(report.totals.openingBalanceMinor) },
    { name: 'Наличные, полученные курьером', value: toRubles(report.totals.cashReceivedMinor) },
    { name: 'Сдано логисту', value: toRubles(report.totals.handedToLogistMinor) },
    { name: 'Выдано курьеру', value: toRubles(report.totals.issuedToCourierMinor) },
    { name: 'Базовая оплата доставок', value: toRubles(report.totals.deliveryFeesMinor) },
    { name: 'Оплачиваемые попытки', value: toRubles(report.totals.attemptFeesMinor) },
    { name: 'Километры за МКАД', value: toRubles(report.totals.distanceFeesMinor) },
    { name: 'Расходы', value: toRubles(report.totals.expensesMinor) },
    { name: 'Доплаты', value: toRubles(report.totals.bonusesMinor) },
    { name: 'Обратные корректировки', value: toRubles(report.totals.adjustmentsMinor) },
    { name: 'Конечный баланс', value: toRubles(report.totals.closingBalanceMinor) },
  ]);
  summary.getRow(1).font = { bold: true };

  const rows = workbook.addWorksheet('Заказы');
  rows.columns = [
    { header: 'Уровень', key: 'level', width: 12 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Курьер', key: 'courier', width: 26 },
    { header: 'Телефон', key: 'phone', width: 16 },
    { header: 'Листы', key: 'sheets', width: 8 },
    { header: 'Заказы', key: 'orders', width: 8 },
    { header: 'Маршрутный лист', key: 'route', width: 22 },
    { header: 'Заказ', key: 'order', width: 16 },
    { header: 'Статус', key: 'outcome', width: 14 },
    { header: 'Способ оплаты', key: 'payment', width: 22 },
    { header: 'Наличные, ₽', key: 'cash', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'За заказ, ₽', key: 'fee', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'За МКАД, км', key: 'km', width: 12, style: { numFmt: '#,##0.0' } },
    { header: 'За МКАД, ₽', key: 'distance', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Доп., ₽', key: 'extra', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Начислено, ₽', key: 'accrued', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Курьер сдал, ₽', key: 'handed', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Выдано курьеру, ₽', key: 'issued', width: 18, style: { numFmt: '#,##0.00' } },
    { header: 'Итог, ₽', key: 'total', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Примечание', key: 'note', width: 24 },
  ];

  /*
   * Иерархия сохраняется и в файле: строка группы, затем её подробности.
   *
   * Столбец «Уровень» нужен, чтобы фильтром в Excel можно было оставить только
   * итоги или только детализацию: без него две разные сущности в одной таблице
   * не различить.
   */
  for (const day of report.days) {
    for (const group of day.couriers) {
      rows.addRow({
        level: 'Итог дня',
        date: day.date,
        courier: group.fullName,
        phone: group.phone ?? '',
        sheets: group.sheets,
        orders: group.orders,
        cash: toRubles(group.cashMinor),
        fee: toRubles(group.deliveryFeesMinor),
        km: group.distanceKmTenths / 10,
        distance: toRubles(group.distanceFeesMinor),
        extra: toRubles(group.extraExpensesMinor),
        accrued: toRubles(group.accruedMinor),
        handed: toRubles(group.handedMinor),
        issued: toRubles(group.issuedMinor),
        total: toRubles(group.totalMinor),
        note: group.settlementMissing ? 'Расчёт отсутствует' : '',
      }).font = { bold: true };

      for (const row of group.rows) {
        rows.addRow({
          level: 'Заказ',
          date: row.deliveryDate,
          courier: group.fullName,
          phone: group.phone ?? '',
          route: row.routeNumber,
          order: row.orderNumber,
          outcome: OUTCOME_LABELS[row.outcome] ?? row.outcome,
          payment: row.paymentTypeName ?? '—',
          cash: toRubles(row.cashMinor),
          fee: toRubles(row.deliveryFeeMinor),
          km: row.beyondMkadKmTenths === null ? null : row.beyondMkadKmTenths / 10,
          distance: toRubles(row.distanceFeeMinor),
          accrued: toRubles(
            (
              BigInt(row.deliveryFeeMinor) +
              BigInt(row.distanceFeeMinor) +
              BigInt(row.attemptFeeMinor)
            ).toString(),
          ),
          total: toRubles(row.totalMinor),
          note: row.settlementMissing
            ? 'Расчёт отсутствует'
            : row.cancelled
              ? 'Результат отменён'
              : '',
        });
      }
    }
  }
  rows.getRow(1).font = { bold: true };

  const operations = workbook.addWorksheet('Операции');
  operations.columns = [
    { header: 'Уровень', key: 'level', width: 12 },
    { header: 'День', key: 'date', width: 12 },
    { header: 'Курьер', key: 'courier', width: 26 },
    { header: 'Телефон', key: 'phone', width: 16 },
    { header: 'Операций', key: 'count', width: 10 },
    { header: 'Время', key: 'time', width: 20 },
    { header: 'Операция', key: 'kind', width: 32 },
    { header: 'Сумма, ₽', key: 'amount', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Автор', key: 'author', width: 24 },
    { header: 'Пояснение', key: 'reason', width: 40 },
    { header: 'Отменена', key: 'reversed', width: 12 },
  ];

  for (const day of report.days) {
    for (const group of day.couriers) {
      if (group.operations.count === 0) {
        continue;
      }

      operations.addRow({
        level: 'Итог дня',
        date: day.date,
        courier: group.fullName,
        phone: group.phone ?? '',
        count: group.operations.count,
        amount: toRubles(group.operations.totalMinor),
      }).font = { bold: true };

      for (const entry of group.operations.entries) {
        operations.addRow({
          level: 'Операция',
          date: entry.operationDate,
          courier: group.fullName,
          phone: group.phone ?? '',
          time: entry.occurredAt,
          kind: ledgerKindLabel(entry.kind),
          amount: toRubles(entry.amountMinor),
          author: entry.actorName ?? '',
          reason: entry.reason ?? '',
          reversed: entry.reversed ? 'да' : '',
        });
      }
    }
  }
  operations.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
