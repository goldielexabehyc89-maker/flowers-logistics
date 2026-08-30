/**
 * Разовый корректный пересчёт доставок за дату включения учёта.
 *
 * Учёт включается решением владельца с конкретного дня, но результаты этого дня
 * могли быть записаны РАНЬШЕ включения — тогда live-путь начислений отработал
 * вхолостую (учёт ещё не покрывал дату, снимка тарифа не было). Эта процедура
 * доводит такой день до правильного состояния, НЕ выдумывая ничего задним
 * числом: она лишь воспроизводит фактическую последовательность результатов и
 * их отмен ТЕМИ ЖЕ доменными функциями, что и обычная работа
 * (`captureRouteTariff`, `accrueDeliveryResult`, `reverseDeliveryAccruals`,
 * `activateLedger`). Прямых SQL-проводок здесь нет.
 *
 * ИДЕМПОТЕНТНО. Снимок тарифа один на маршрут; денежный факт — upsert по
 * попытке; записи начислений и сторно — с уникальными ключами идемпотентности;
 * включение — по значению, а не по факту вызова. Повторный запуск не создаёт
 * ни одной новой записи, и это видно в сводке (`snapshotsCreated`,
 * `ledgerEntriesCreated`, `activation.changed` = 0/0/false).
 *
 * DRY-RUN. Всё выполняется в ОДНОЙ транзакции; сводка собирается по её
 * состоянию, а затем — при сухом прогоне — транзакция откатывается. Так план
 * считается теми же функциями, что и реальный прогон, но не пишет ни строки.
 */

import { moscowCalendarDate } from '@fl/shared';
import type { Role } from '@fl/shared';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { accrueDeliveryResult, captureRouteTariff, reverseDeliveryAccruals } from './accrual.js';
import { activateLedger, readLedgerActivation, resolveTariff } from './tariffs.js';

export interface RecomputeInput {
  /** Московский календарный день пересчёта, он же дата включения учёта. */
  date: string;
  actorUserId: string;
  actorRoles: Role[];
  ip: string | null;
  userAgent: string | null;
  /** Сухой прогон: всё считается, но транзакция откатывается. */
  dryRun: boolean;
  /** Ожидаемые ставки действующего тарифа. Несовпадение — остановка. */
  expectedPerOrderMinor: bigint;
  expectedPerKmMinor: bigint;
}

export interface CourierRecomputeSummary {
  courierUserId: string;
  courierName: string;
  deliveryFeeMinor: bigint;
  distanceFeeMinor: bigint;
  cashReceivedMinor: bigint;
  adjustmentMinor: bigint;
  netMinor: bigint;
}

export interface RecomputeSummary {
  date: string;
  dryRun: boolean;
  activation: { activeFrom: string; changed: boolean };
  tariff: { tariffVersionId: string; perOrderMinor: bigint; perKmMinor: bigint };
  snapshotsCreated: number;
  attemptsProcessed: number;
  deliveredCount: number;
  notDeliveredCount: number;
  reversalsApplied: number;
  ledgerEntriesCreated: number;
  couriers: CourierRecomputeSummary[];
  totalMinor: bigint;
}

class DryRunRollback extends Error {
  constructor(readonly summary: RecomputeSummary) {
    super('dry-run rollback');
  }
}

const CONFIRMED_STATES = ['CONFIRMED', 'ACTIVE', 'COMPLETED'] as const;

export async function recomputeDeliveriesForDate(
  db: Database,
  input: RecomputeInput,
): Promise<RecomputeSummary> {
  const date = input.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError('VALIDATION_FAILED', { message: `bad date: ${date}` });
  }
  const day = toDateColumn(date);

  // Проверка тарифа ДО любой записи: ставка обязана точно совпасть с действующей
  // версией, иначе данные противоречивы и процедура останавливается.
  const rates = await resolveTariff(db, date);
  if (rates === null) {
    throw new AppError('CONFLICT', {
      message: 'no tariff for date',
      publicMessage: `На дату ${date} не настроен тариф курьера — пересчёт остановлен.`,
    });
  }
  if (
    rates.perOrderMinor !== input.expectedPerOrderMinor ||
    rates.perKmMinor !== input.expectedPerKmMinor
  ) {
    throw new AppError('CONFLICT', {
      message: 'tariff mismatch',
      publicMessage:
        `Тариф на ${date} не совпадает с ожидаемым: ожидалось ` +
        `${input.expectedPerOrderMinor}/${input.expectedPerKmMinor}, в базе ` +
        `${rates.perOrderMinor}/${rates.perKmMinor}. Пересчёт остановлен.`,
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      const scoped = tx as unknown as Database;

      // 1. Включение учёта — единый доменный путь с аудитом, идемпотентно.
      const activationChange = await activateLedger(tx, {
        activeFrom: date,
        actorUserId: input.actorUserId,
        actorRoles: input.actorRoles,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      const activation = await readLedgerActivation(scoped);

      // 2. Недостающие снимки тарифа для подтверждённых маршрутов от `date` —
      //    и для завершённых этого дня (чтобы начислить), и для будущих
      //    незавершённых (чтобы их результаты потом не остались без оплаты).
      const routesWithoutSnapshot = await tx.deliveryRoute.findMany({
        where: {
          state: { in: [...CONFIRMED_STATES] },
          deliveryDate: { gte: day },
          tariffSnapshot: { is: null },
        },
        select: { id: true, deliveryDate: true },
        orderBy: { deliveryDate: 'asc' },
      });
      let snapshotsCreated = 0;
      for (const route of routesWithoutSnapshot) {
        const routeDate = fromDateColumn(route.deliveryDate);
        const routeRates = await resolveTariff(scoped, routeDate);
        if (routeRates === null) {
          throw new AppError('CONFLICT', {
            message: 'no tariff for confirmed route',
            publicMessage: `Маршрут на ${routeDate} без тарифа — пересчёт остановлен.`,
          });
        }
        await captureRouteTariff(tx, {
          routeId: route.id,
          deliveryDate: routeDate,
          rates: routeRates,
        });
        snapshotsCreated += 1;
      }

      // 3. Все попытки доставки этого дня — воспроизводим их последовательность.
      const attempts = await tx.deliveryAttempt.findMany({
        where: { route: { deliveryDate: day } },
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true,
          routeOrderId: true,
          routeId: true,
          orderId: true,
          courierUserId: true,
          outcome: true,
          cancellation: { select: { occurredAt: true, reason: true } },
        },
      });
      const attemptIds = attempts.map((attempt) => attempt.id);

      const entriesBefore = await tx.courierLedgerEntry.count({
        where: { attemptId: { in: attemptIds } },
      });

      // Начисляем по каждому результату. Функция сама создаёт денежный факт
      // всегда, а платит только за реально доставленные и только при наличии
      // снимка тарифа и покрытия датой.
      let deliveredCount = 0;
      let notDeliveredCount = 0;
      for (const attempt of attempts) {
        if (attempt.outcome === 'DELIVERED') {
          deliveredCount += 1;
        } else {
          notDeliveredCount += 1;
        }
        await accrueDeliveryResult(tx, activation, {
          attemptId: attempt.id,
          routeOrderId: attempt.routeOrderId,
          routeId: attempt.routeId,
          orderId: attempt.orderId,
          courierUserId: attempt.courierUserId,
          actorUserId: input.actorUserId,
          outcome: attempt.outcome,
        });
      }

      // Отменённые результаты корректно сторнируем — обратными записями, не
      // удалением. Дата операции сторно — день фактической отмены.
      let reversalsApplied = 0;
      for (const attempt of attempts) {
        if (attempt.cancellation !== null) {
          await reverseDeliveryAccruals(tx, {
            attemptId: attempt.id,
            actorUserId: input.actorUserId,
            reason: attempt.cancellation.reason ?? 'Пересчёт: отмена результата доставки',
            operationDate: moscowCalendarDate(attempt.cancellation.occurredAt),
          });
          reversalsApplied += 1;
        }
      }

      const entriesAfter = await tx.courierLedgerEntry.count({
        where: { attemptId: { in: attemptIds } },
      });

      // 4. Сводка по курьерам — из состояния транзакции. Без телефонов и адресов:
      //    только имя, количества и суммы по видам.
      const entries = await tx.courierLedgerEntry.findMany({
        where: { attemptId: { in: attemptIds } },
        select: { courierUserId: true, kind: true, amountMinor: true },
      });
      const courierIds = [...new Set(entries.map((entry) => entry.courierUserId))];
      const users = await tx.user.findMany({
        where: { id: { in: courierIds } },
        select: { id: true, fullName: true },
      });
      const nameById = new Map(users.map((user) => [user.id, user.fullName]));

      const byCourier = new Map<string, CourierRecomputeSummary>();
      for (const entry of entries) {
        const summary = byCourier.get(entry.courierUserId) ?? {
          courierUserId: entry.courierUserId,
          courierName: nameById.get(entry.courierUserId) ?? '—',
          deliveryFeeMinor: 0n,
          distanceFeeMinor: 0n,
          cashReceivedMinor: 0n,
          adjustmentMinor: 0n,
          netMinor: 0n,
        };
        if (entry.kind === 'DELIVERY_FEE') {
          summary.deliveryFeeMinor += entry.amountMinor;
        } else if (entry.kind === 'DISTANCE_FEE') {
          summary.distanceFeeMinor += entry.amountMinor;
        } else if (entry.kind === 'CASH_RECEIVED') {
          summary.cashReceivedMinor += entry.amountMinor;
        } else if (entry.kind === 'ADJUSTMENT') {
          summary.adjustmentMinor += entry.amountMinor;
        }
        summary.netMinor += entry.amountMinor;
        byCourier.set(entry.courierUserId, summary);
      }
      const couriers = [...byCourier.values()].sort((a, b) =>
        a.courierName.localeCompare(b.courierName),
      );
      const totalMinor = couriers.reduce((sum, courier) => sum + courier.netMinor, 0n);

      const summary: RecomputeSummary = {
        date,
        dryRun: input.dryRun,
        activation: {
          activeFrom: activation.activeFrom ?? date,
          changed: activationChange.changed,
        },
        tariff: {
          tariffVersionId: rates.tariffVersionId,
          perOrderMinor: rates.perOrderMinor,
          perKmMinor: rates.perKmMinor,
        },
        snapshotsCreated,
        attemptsProcessed: attempts.length,
        deliveredCount,
        notDeliveredCount,
        reversalsApplied,
        ledgerEntriesCreated: entriesAfter - entriesBefore,
        couriers,
        totalMinor,
      };

      if (input.dryRun) {
        // Откат: сухой прогон не оставляет ни включения, ни снимков, ни проводок.
        throw new DryRunRollback(summary);
      }
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return error.summary;
    }
    throw error;
  }
}
