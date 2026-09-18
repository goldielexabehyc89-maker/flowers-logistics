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
import {
  VEHICLE_TYPE_LABELS,
  ledgerEntryTitle,
  ledgerKindLabel as sharedKindLabel,
} from '@fl/shared';
import type { SettlementReport } from './reports.js';

/** Минорные единицы в рубли. Делится ровно один раз и в одном месте. */
export function toRubles(minor: string): number {
  return Number(BigInt(minor)) / 100;
}

const OUTCOME_LABELS: Record<string, string> = {
  DELIVERED: 'Доставлен',
  NOT_DELIVERED: 'Не доставлен',
};

/*
 * Названия операций живут в общем пакете: экран и файл обязаны называть одну
 * строку одинаково, иначе найти её в выгрузке по увиденному на экране нельзя.
 */
export const ledgerKindLabel = sharedKindLabel;
export const ledgerEntryLabel = ledgerEntryTitle;

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
  /*
   * Баланс существует только у КОНКРЕТНОГО курьера: без отбора входящее сальдо
   * равно нулю, и «конечный баланс» — это изменение за период. Называть его
   * балансом значило бы утверждать о долге, которого никто не считал.
   */
  const perCourier = report.courierUserId !== null;
  summary.addRows([
    { name: 'Период', value: `${report.period.from} — ${report.period.to}` },
    ...(perCourier
      ? [{ name: 'Начальный баланс', value: toRubles(report.totals.openingBalanceMinor) }]
      : []),
    { name: 'Наличные, полученные курьером', value: toRubles(report.totals.cashReceivedMinor) },
    {
      name: 'Корректировки наличных (оплата в МойСклад)',
      value: toRubles(report.totals.cashCorrectionsMinor),
    },
    { name: 'Сдано логисту', value: toRubles(report.totals.handedToLogistMinor) },
    { name: 'Выдано курьеру', value: toRubles(report.totals.issuedToCourierMinor) },
    { name: 'Базовая оплата доставок', value: toRubles(report.totals.deliveryFeesMinor) },
    { name: 'Оплачиваемые попытки', value: toRubles(report.totals.attemptFeesMinor) },
    { name: 'Километры за МКАД', value: toRubles(report.totals.distanceFeesMinor) },
    { name: 'Расходы', value: toRubles(report.totals.expensesMinor) },
    { name: 'Доплаты', value: toRubles(report.totals.bonusesMinor) },
    { name: 'Обратные корректировки', value: toRubles(report.totals.adjustmentsMinor) },
    { name: 'Начальный долг', value: toRubles(report.totals.openingDebtMinor) },
    {
      name: perCourier ? 'Конечный баланс' : 'Изменение за период (по всем курьерам)',
      value: toRubles(report.totals.closingBalanceMinor),
    },
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
    { header: 'Тип', key: 'vehicle', width: 12 },
    { header: 'Ставка/заказ, ₽', key: 'rate', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'За заказ, ₽', key: 'fee', width: 14, style: { numFmt: '#,##0.00' } },
    /*
     * Километры, ПО КОТОРЫМ начислены деньги, и рядом — текущий расчёт, если
     * он другой. Одна колонка «километры» показывала бы живой снимок рядом с
     * прежней суммой: арифметика строки не сходилась бы, и объяснить это в
     * файле было бы нечем.
     */
    { header: 'За МКАД, км', key: 'km', width: 12, style: { numFmt: '#,##0.0' } },
    { header: 'Текущий расчёт, км', key: 'kmNow', width: 18, style: { numFmt: '#,##0.0' } },
    { header: 'За МКАД, ₽', key: 'distance', width: 14, style: { numFmt: '#,##0.00' } },
    /*
     * Оплачиваемая попытка своим столбцом.
     *
     * Она входит в «Начислено», но в «Доп.» её нет намеренно (иначе удвоится).
     * Без собственного столбца «Начислено» в файле не раскладывалось: «За
     * заказ» + «За МКАД» + «Доп.» не давали его суммы, и объяснить разницу
     * было нечем. На экране столбца нет по недостатку места, и там она стоит
     * под «Начислено»; в файле место есть.
     */
    { header: 'За попытку, ₽', key: 'attempt', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Доп., ₽', key: 'extra', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Начислено, ₽', key: 'accrued', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Курьер сдал, ₽', key: 'handed', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Выдано курьеру, ₽', key: 'issued', width: 18, style: { numFmt: '#,##0.00' } },
    { header: 'Начальный долг, ₽', key: 'debt', width: 18, style: { numFmt: '#,##0.00' } },
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
        kmNow: null,
        distance: toRubles(group.distanceFeesMinor),
        attempt: toRubles(group.attemptFeesMinor),
        extra: toRubles(group.extraExpensesMinor),
        accrued: toRubles(group.accruedMinor),
        handed: toRubles(group.handedMinor),
        issued: toRubles(group.issuedMinor),
        // Начальный долг не попадает ни в один столбец заработка и наличных,
        // но входит в итог дня: без него итог нечем объяснить.
        debt: toRubles(group.openingDebtMinor),
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
          vehicle: row.vehicleType === null ? '—' : VEHICLE_TYPE_LABELS[row.vehicleType],
          rate: row.perOrderMinor === null ? null : toRubles(row.perOrderMinor),
          cash: toRubles(row.cashMinor),
          fee: toRubles(row.deliveryFeeMinor),
          km: row.beyondMkadKmTenths === null ? null : row.beyondMkadKmTenths / 10,
          kmNow: row.currentKmTenths === null ? null : row.currentKmTenths / 10,
          distance: toRubles(row.distanceFeeMinor),
          /*
           * «Доп.» строки: расход или доплата, привязанные к попытке.
           *
           * Они входят в «Доп.» и «Начислено» дня, поэтому обязаны быть видны
           * и здесь — иначе сумма строк не сходится с итогом дня, и разницу
           * не объяснить. Правило то же, что на экране и в `grouping.ts`.
           */
          attempt: toRubles(row.attemptFeeMinor),
          extra: toRubles((BigInt(row.expensesMinor) + BigInt(row.bonusesMinor)).toString()),
          accrued: toRubles(
            (
              BigInt(row.deliveryFeeMinor) +
              BigInt(row.distanceFeeMinor) +
              BigInt(row.attemptFeeMinor) +
              BigInt(row.expensesMinor) +
              BigInt(row.bonusesMinor)
            ).toString(),
          ),
          total: toRubles(row.totalMinor),
          /*
           * Пометки СКЛАДЫВАЮТСЯ, а не вытесняют друг друга.
           *
           * Отсутствие расчёта раньше затирало всё остальное, и отменённый
           * в источнике заказ без тарифного снимка выглядел в файле обычной
           * строкой без расчёта — а на экране плашка отмены стоит всегда.
           * Итог строки при этом остаётся числом: пометка объясняет ноль,
           * а не заменяет сумму.
           */
          note: [
            row.settlementMissing ? 'Расчёт отсутствует' : '',
            row.cancelled ? 'Результат отменён' : '',
            // Отмена заказа в источнике и снятие его денег — разные факты:
            // в день доставки первый истинен, а второй нет.
            row.sourceCancelled ? 'Отменён в МоемСкладе' : '',
            row.financeCancelled ? 'Начисления дня сняты' : '',
            // Деньги меняет только решение человека, поэтому расхождение
            // текущего расчёта с оплаченным называется прямо.
            row.currentKmTenths === null
              ? ''
              : `Расчёт уточнён: ${(row.currentKmTenths / 10).toFixed(1).replace('.', ',')} км`,
          ]
            .filter((note) => note !== '')
            .join('; '),
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
          kind: ledgerEntryLabel(entry),
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
