/**
 * Операторская процедура: корректный пересчёт доставок за 30.08.2026 и включение
 * финансового учёта с этого дня.
 *
 * Считает ТЕМИ ЖЕ доменными функциями, что и обычная работа (`captureRouteTariff`,
 * `accrueDeliveryResult`, `reverseDeliveryAccruals`, `activateLedger`) — прямых
 * SQL-проводок нет. Всё идемпотентно: повторный запуск не создаёт ни одной новой
 * записи.
 *
 * По умолчанию — СУХОЙ ПРОГОН: ничего не пишет, печатает ожидаемые итоги.
 * Реальный прогон — только с флагом `--apply`. После применения выполняется
 * контрольный сухой прогон, доказывающий идемпотентность (0 снимков, 0 проводок,
 * включение без изменений).
 *
 *   node apps/api/dist/scripts/finance-recompute-2026-08-30.js            # сухой прогон
 *   node apps/api/dist/scripts/finance-recompute-2026-08-30.js --apply    # применить
 */

import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logging/logger.js';
import { createDatabase } from '../platform/db.js';
import { recomputeDeliveriesForDate, type RecomputeSummary } from '../modules/finance/recompute.js';

const DATE = '2026-08-30';
const EXPECTED_PER_ORDER_MINOR = 50000n; // 500,00 ₽ за доставленный заказ
const EXPECTED_PER_KM_MINOR = 0n; // 0 ₽ за километр

function rub(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rubles = abs / 100n;
  const kopecks = abs % 100n;
  return `${negative ? '-' : ''}${rubles},${kopecks.toString().padStart(2, '0')} ₽`;
}

function printSummary(title: string, summary: RecomputeSummary): void {
  const lines: string[] = [
    title,
    `  дата: ${summary.date}`,
    `  режим: ${summary.dryRun ? 'сухой прогон (без записи)' : 'применение'}`,
    `  включение учёта с: ${summary.activation.activeFrom}` +
      ` (${summary.activation.changed ? 'изменено этим запуском' : 'без изменений'})`,
    `  тариф: ${rub(summary.tariff.perOrderWalkMinor)} за заказ (пеший), ` +
      `${rub(summary.tariff.perOrderCarMinor)} за заказ (авто), ` +
      `${rub(summary.tariff.perKmMinor)} за км`,
    `  создано снимков тарифа: ${summary.snapshotsCreated}`,
    `  обработано попыток: ${summary.attemptsProcessed}` +
      ` (доставлено ${summary.deliveredCount}, не доставлено ${summary.notDeliveredCount})`,
    `  сторнировано отмен: ${summary.reversalsApplied}`,
    `  создано записей учёта этим запуском: ${summary.ledgerEntriesCreated}`,
    '  по курьерам (имя · оплата за заказы · за км · наличные · сторно · итого):',
  ];
  for (const courier of summary.couriers) {
    lines.push(
      `    ${courier.courierName} · ${rub(courier.deliveryFeeMinor)} · ` +
        `${rub(courier.distanceFeeMinor)} · ${rub(courier.cashReceivedMinor)} · ` +
        `${rub(courier.adjustmentMinor)} · ${rub(courier.netMinor)}`,
    );
  }
  lines.push(`  ИТОГО по курьерам: ${rub(summary.totalMinor)}`, '');
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<number> {
  const apply = process.argv.slice(2).includes('--apply');
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config, logger);

  try {
    const admin = await db.user.findFirst({
      where: { status: 'ACTIVE', roles: { some: { role: 'ADMIN' } } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (admin === null) {
      process.stderr.write('нет активного администратора для атрибуции действия\n');
      return 2;
    }

    const actor = { userId: admin.id, roles: ['ADMIN'] as const };

    // Сухой прогон — всегда и первым.
    const planned = await recomputeDeliveriesForDate(db, {
      date: DATE,
      actorUserId: actor.userId,
      actorRoles: [...actor.roles],
      ip: null,
      userAgent: 'finance-recompute-2026-08-30',
      dryRun: true,
      expectedPerOrderMinor: EXPECTED_PER_ORDER_MINOR,
      expectedPerKmMinor: EXPECTED_PER_KM_MINOR,
    });
    printSummary('СУХОЙ ПРОГОН (ожидаемые итоги, ничего не записано):', planned);

    if (!apply) {
      process.stdout.write('для применения запустите с флагом --apply\n');
      return 0;
    }

    // Реальный прогон.
    const applied = await recomputeDeliveriesForDate(db, {
      date: DATE,
      actorUserId: actor.userId,
      actorRoles: [...actor.roles],
      ip: null,
      userAgent: 'finance-recompute-2026-08-30',
      dryRun: false,
      expectedPerOrderMinor: EXPECTED_PER_ORDER_MINOR,
      expectedPerKmMinor: EXPECTED_PER_KM_MINOR,
    });
    printSummary('ПРИМЕНЕНО:', applied);

    // Контрольный сухой прогон: доказательство идемпотентности.
    const recheck = await recomputeDeliveriesForDate(db, {
      date: DATE,
      actorUserId: actor.userId,
      actorRoles: [...actor.roles],
      ip: null,
      userAgent: 'finance-recompute-2026-08-30',
      dryRun: true,
      expectedPerOrderMinor: EXPECTED_PER_ORDER_MINOR,
      expectedPerKmMinor: EXPECTED_PER_KM_MINOR,
    });
    const idempotent =
      recheck.snapshotsCreated === 0 &&
      recheck.ledgerEntriesCreated === 0 &&
      !recheck.activation.changed;
    process.stdout.write(
      `КОНТРОЛЬ ИДЕМПОТЕНТНОСТИ: снимков ${recheck.snapshotsCreated}, ` +
        `записей ${recheck.ledgerEntriesCreated}, включение изменено ` +
        `${recheck.activation.changed} → ${idempotent ? 'OK (0 новых действий)' : 'НАРУШЕНА'}\n`,
    );
    return idempotent ? 0 : 3;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `пересчёт не выполнен: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
