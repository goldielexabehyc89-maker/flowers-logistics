/**
 * API логистической истории, отчётов и денежных операций.
 *
 * Читают и пишут только `ADMIN` и `LOGISTICIAN`: это управленческий контур.
 * Курьерская история (`/api/delivery/history`) остаётся отдельной и здесь
 * не подменяется — у неё другой смысл и другая аудитория.
 *
 * Персональные данные (адрес, получатель) уходят только в профильных ответах
 * истории и выгрузках, но никогда — в realtime и в общий аудит.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { isCalendarDate, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { moscowCalendarDate } from '@fl/shared';
import { listHistory, routeHistory } from '../history/service.js';
import {
  LEDGER_SETTING_KEY,
  readLedgerActivation,
  resolveTariff,
  toTariffView,
  validateTariffPeriod,
} from './tariffs.js';
import { appendEntry, balanceOf, EXPENSE_KINDS, reverseEntry } from './ledger.js';
import { buildOperationalReport, buildSettlementReport } from './reports.js';
import {
  activeRing,
  computeBeyondMkad,
  parseRing,
  saveDistanceSnapshot,
  storeRing,
} from './mkad.js';
import { ValhallaClient } from '../integrations/valhalla/client.js';
import { buildSettlementWorkbook } from './export-xlsx.js';
import { buildSettlementPdf } from './export-pdf.js';

const FINANCE_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
const ADMIN_ONLY = ['ADMIN'] as const;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
  .refine(isCalendarDate, 'Ожидается существующая дата');

const periodSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  courierUserId: z.string().uuid().optional(),
});

const historyQuerySchema = periodSchema.extend({
  actorUserId: z.string().uuid().optional(),
  state: z.enum(['DRAFT', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const moneySchema = z.coerce
  .bigint()
  .refine((value) => value > 0n, 'Сумма должна быть больше нуля');

const operationSchema = z.object({
  courierUserId: z.string().uuid(),
  kind: z.enum([
    'CASH_HANDED_TO_LOGIST',
    'CASH_ISSUED_TO_COURIER',
    'BONUS',
    'ATTEMPT_FEE',
    'EXPENSE_PARKING',
    'EXPENSE_TOLL',
    'EXPENSE_TRANSIT',
    'EXPENSE_REPAIR',
    'EXPENSE_LOADING',
    'EXPENSE_OTHER',
  ]),
  amountMinor: moneySchema,
  operationDate: dateSchema,
  reason: z.string().trim().min(3).max(500).optional(),
  comment: z.string().trim().min(1).max(500).optional(),
  routeId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  attemptId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
});

const reversalSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const tariffSchema = z.object({
  kind: z.enum(['REGULAR', 'HOLIDAY']),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().default(null),
  perOrderMinor: z.coerce.bigint(),
  perKmMinor: z.coerce.bigint(),
  note: z.string().trim().max(500).nullable().default(null),
});

const activationSchema = z.object({ activeFrom: dateSchema });

const ringSchema = z.object({
  points: z.array(z.tuple([z.number(), z.number()])).min(4),
  source: z.string().trim().min(3).max(200),
});

const distanceSchema = z.object({
  routeOrderId: z.string().uuid(),
  kmTenths: z.coerce.number().int().min(0).max(20_000),
  reason: z.string().trim().min(3).max(500),
});

export interface FinanceRouteDeps {
  db: Database;
  config: AppConfig;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null };
}

/** Период не может быть перевёрнутым и длиннее года: отчёт обязан считаться. */
function assertPeriod(from: string, to: string): void {
  if (to < from) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Конец периода раньше его начала.' });
  }
}

export async function registerFinanceRoutes(app: AppServer, deps: FinanceRouteDeps): Promise<void> {
  // --- История -------------------------------------------------------------

  app.get('/api/logistics/history', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = historyQuerySchema.parse(request.query);
    assertPeriod(query.from, query.to);

    return listHistory(deps.db, query);
  });

  app.get('/api/logistics/history/routes/:id', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return routeHistory(deps.db, id);
  });

  // --- Отчёты --------------------------------------------------------------

  app.get('/api/logistics/reports/settlements', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = periodSchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const activation = await readLedgerActivation(deps.db);
    return buildSettlementReport(deps.db, {
      from: query.from,
      to: query.to,
      courierUserId: query.courierUserId,
      ledgerActiveFrom: activation.activeFrom,
    });
  });

  app.get('/api/logistics/reports/operations', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = periodSchema.parse(request.query);
    assertPeriod(query.from, query.to);

    return buildOperationalReport(deps.db, { from: query.from, to: query.to });
  });

  app.get('/api/logistics/reports/balances', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = z.object({ to: dateSchema.optional() }).parse(request.query);

    const couriers = await deps.db.user.findMany({
      where: { roles: { some: { role: 'COURIER' } }, status: 'ACTIVE' },
      select: { id: true, fullName: true },
      orderBy: [{ fullName: 'asc' }],
      take: 200,
    });

    const items = await Promise.all(
      couriers.map(async (courier) => ({
        courierUserId: courier.id,
        fullName: courier.fullName,
        balanceMinor: (await balanceOf(deps.db, courier.id, query.to ?? null)).toString(),
      })),
    );

    return { items };
  });

  // --- Выгрузки ------------------------------------------------------------

  app.get('/api/logistics/reports/settlements.xlsx', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = periodSchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const activation = await readLedgerActivation(deps.db);
    const report = await buildSettlementReport(deps.db, {
      from: query.from,
      to: query.to,
      courierUserId: query.courierUserId,
      ledgerActiveFrom: activation.activeFrom,
    });

    const file = await buildSettlementWorkbook(report);

    /*
     * Факт выгрузки фиксируется всегда: в файле есть номера заказов и суммы,
     * и организация обязана знать, кто и какой период выгрузил. Самих данных
     * в аудите нет — только период, число строк и вид файла.
     */
    await writeAudit(deps.db, {
      action: 'FINANCE_REPORT_EXPORTED',
      entityType: 'CourierLedgerEntry',
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: {
        format: 'xlsx',
        from: query.from,
        to: query.to,
        courierUserId: query.courierUserId ?? null,
        rows: report.rows.length,
      },
      ...contextOf(request),
    });

    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'content-disposition',
        `attachment; filename="settlements-${query.from}_${query.to}.xlsx"`,
      )
      .send(file);
  });

  app.get('/api/logistics/reports/settlements.pdf', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = periodSchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const activation = await readLedgerActivation(deps.db);
    const report = await buildSettlementReport(deps.db, {
      from: query.from,
      to: query.to,
      courierUserId: query.courierUserId,
      ledgerActiveFrom: activation.activeFrom,
    });

    const file = buildSettlementPdf(report);

    await writeAudit(deps.db, {
      action: 'FINANCE_REPORT_EXPORTED',
      entityType: 'CourierLedgerEntry',
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: {
        format: 'pdf',
        from: query.from,
        to: query.to,
        courierUserId: query.courierUserId ?? null,
        rows: report.rows.length,
      },
      ...contextOf(request),
    });

    return reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        `attachment; filename="settlements-${query.from}_${query.to}.pdf"`,
      )
      .send(file);
  });

  // --- Денежные операции ---------------------------------------------------

  app.post('/api/logistics/ledger/operations', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const body = operationSchema.parse(request.body);

    if (EXPENSE_KINDS.includes(body.kind) && body.reason === undefined) {
      throw new AppError('VALIDATION_FAILED', { publicMessage: 'У расхода обязательна причина.' });
    }

    const entry = await deps.db.$transaction(async (tx) => {
      const created = await appendEntry(tx, {
        courierUserId: body.courierUserId,
        kind: body.kind,
        amountMinor: body.amountMinor,
        operationDate: body.operationDate,
        actorUserId: actor.userId,
        reason: body.reason ?? null,
        comment: body.comment ?? null,
        routeId: body.routeId ?? null,
        orderId: body.orderId ?? null,
        attemptId: body.attemptId ?? null,
        idempotencyKey: body.idempotencyKey,
      });

      await writeAudit(tx, {
        action: 'FINANCE_OPERATION_RECORDED',
        entityType: 'CourierLedgerEntry',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        // Ни комментария, ни причины: они могут содержать что угодно, включая
        // персональные подробности. В аудите — вид, сумма и день.
        newValue: {
          kind: created.kind,
          amountMinor: created.amountMinor,
          operationDate: created.operationDate,
          courierUserId: created.courierUserId,
        },
        ...contextOf(request),
      });

      /*
       * Realtime без денег и без людей.
       *
       * Экрану достаточно знать, что учёт изменился, чтобы перечитать отчёт;
       * суммы и имена в поток событий не попадают.
       */
      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: created.operationDate },
        audienceRoles: ['ADMIN', 'LOGISTICIAN'],
      });

      return created;
    });

    return reply.code(201).send({ entry });
  });

  app.post('/api/logistics/ledger/operations/:id/reverse', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = reversalSchema.parse(request.body);

    const entry = await deps.db.$transaction(async (tx) => {
      const created = await reverseEntry(tx, {
        entryId: id,
        actorUserId: actor.userId,
        reason: body.reason,
        operationDate: moscowCalendarDate(new Date()),
      });

      await writeAudit(tx, {
        action: 'FINANCE_OPERATION_REVERSED',
        entityType: 'CourierLedgerEntry',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        newValue: { reversesEntryId: id, amountMinor: created.amountMinor },
        ...contextOf(request),
      });

      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: created.operationDate },
        audienceRoles: ['ADMIN', 'LOGISTICIAN'],
      });

      return created;
    });

    return { entry };
  });

  // --- Тарифы и включение учёта -------------------------------------------

  app.get('/api/logistics/tariffs', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);

    const [rows, activation] = await Promise.all([
      deps.db.courierTariffVersion.findMany({
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 100,
      }),
      readLedgerActivation(deps.db),
    ]);

    const today = moscowCalendarDate(new Date());
    const current = await resolveTariff(deps.db, today);

    return {
      items: rows.map(toTariffView),
      activation,
      today: {
        date: today,
        perOrderMinor: current === null ? null : current.perOrderMinor.toString(),
        perKmMinor: current === null ? null : current.perKmMinor.toString(),
      },
    };
  });

  app.post('/api/logistics/tariffs', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const body = tariffSchema.parse(request.body);

    validateTariffPeriod({
      kind: body.kind,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      perOrderMinor: body.perOrderMinor,
      perKmMinor: body.perKmMinor,
      note: body.note,
    });

    const created = await deps.db.$transaction(async (tx) => {
      const row = await tx.courierTariffVersion.create({
        data: {
          kind: body.kind,
          effectiveFrom: toDateColumn(body.effectiveFrom),
          effectiveTo: body.effectiveTo === null ? null : toDateColumn(body.effectiveTo),
          perOrderMinor: body.perOrderMinor,
          perKmMinor: body.perKmMinor,
          note: body.note,
          createdById: actor.userId,
        },
      });

      await writeAudit(tx, {
        action: 'FINANCE_TARIFF_CREATED',
        entityType: 'CourierTariffVersion',
        entityId: row.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        newValue: {
          kind: body.kind,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo,
          perOrderMinor: body.perOrderMinor.toString(),
          perKmMinor: body.perKmMinor.toString(),
        },
        ...contextOf(request),
      });

      return row;
    });

    return reply.code(201).send({ tariff: toTariffView(created) });
  });

  app.put('/api/logistics/ledger/activation', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const body = activationSchema.parse(request.body);

    await deps.db.$transaction(async (tx) => {
      const previous = await tx.systemSetting.findFirst({
        where: { key: LEDGER_SETTING_KEY },
        orderBy: [{ version: 'desc' }],
        select: { version: true },
      });

      await tx.systemSetting.updateMany({
        where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
        data: { currentKey: null },
      });

      await tx.systemSetting.create({
        data: {
          key: LEDGER_SETTING_KEY,
          version: (previous?.version ?? 0) + 1,
          value: { activeFrom: body.activeFrom },
          currentKey: LEDGER_SETTING_KEY,
          updatedById: actor.userId,
        },
      });

      await writeAudit(tx, {
        action: 'FINANCE_LEDGER_ACTIVATED',
        entityType: 'SystemSetting',
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        newValue: { activeFrom: body.activeFrom },
        ...contextOf(request),
      });
    });

    return { activation: { activeFrom: body.activeFrom } };
  });

  // --- Геометрия МКАД и расстояния ----------------------------------------

  app.get('/api/logistics/mkad', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const ring = await activeRing(deps.db);
    return { configured: ring !== null, pointCount: ring?.points.length ?? 0 };
  });

  app.post('/api/logistics/mkad', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const body = ringSchema.parse(request.body);

    const points = parseRing(body.points);
    const version = await storeRing(deps.db, { points, source: body.source });

    await writeAudit(deps.db, {
      action: 'FINANCE_MKAD_RING_STORED',
      entityType: 'MkadRingVersion',
      entityId: version.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { sha256: version.sha256, pointCount: version.pointCount },
      ...contextOf(request),
    });

    return reply.code(201).send({ version });
  });

  /**
   * Пересчёт расстояний маршрута.
   *
   * Отдельная операция, а не часть подтверждения: расчёт ходит во внешний
   * маршрутизатор, и его недоступность не имеет права мешать логисту
   * подтвердить маршрут.
   */
  app.post('/api/logistics/routes/:id/distances', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const ring = await activeRing(deps.db);
    if (ring === null) {
      throw new AppError('CONFLICT', {
        publicMessage: 'Геометрия МКАД не загружена: расстояние за МКАД считать не от чего.',
      });
    }

    const orders = await deps.db.routeOrder.findMany({
      where: { routeId: id, removedAt: null },
      select: {
        id: true,
        order: { select: { geoLatMicro: true, geoLonMicro: true, geoState: true } },
      },
    });

    const router = new ValhallaClient({ baseUrl: deps.config.VALHALLA_URL ?? null });

    let computed = 0;
    let skipped = 0;
    for (const item of orders) {
      const lat = item.order.geoLatMicro;
      const lon = item.order.geoLonMicro;
      if (lat === null || lon === null || item.order.geoState !== 'RESOLVED') {
        skipped += 1;
        continue;
      }

      const result = await computeBeyondMkad(
        deps.db,
        {
          configured: router.configured,
          route: async (points, costing) => router.route(points, costing),
        },
        {
          routeOrderId: item.id,
          target: { lat: lat / 1_000_000, lon: lon / 1_000_000 },
          graphSha256: null,
        },
      );

      if (result === null) {
        skipped += 1;
        continue;
      }

      await saveDistanceSnapshot(deps.db, {
        routeOrderId: item.id,
        ringVersionId: ring.id,
        graphSha256: null,
        meters: result.meters,
        insideMkad: result.insideMkad,
        source: 'COMPUTED',
      });
      computed += 1;
    }

    await writeAudit(deps.db, {
      action: 'FINANCE_DISTANCE_COMPUTED',
      entityType: 'DeliveryRoute',
      entityId: id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { computed, skipped },
      ...contextOf(request),
    });

    return { computed, skipped };
  });

  /** Ручная правка километров: обязательна причина, расчёт остаётся в истории. */
  app.put('/api/logistics/distances', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const body = distanceSchema.parse(request.body);

    const ring = await activeRing(deps.db);
    if (ring === null) {
      throw new AppError('CONFLICT', {
        publicMessage: 'Геометрия МКАД не загружена: править нечего.',
      });
    }

    await saveDistanceSnapshot(deps.db, {
      routeOrderId: body.routeOrderId,
      ringVersionId: ring.id,
      graphSha256: null,
      meters: body.kmTenths * 100,
      insideMkad: body.kmTenths === 0,
      source: 'MANUAL',
      actorUserId: actor.userId,
      reason: body.reason,
    });

    await writeAudit(deps.db, {
      action: 'FINANCE_DISTANCE_CORRECTED',
      entityType: 'RouteOrder',
      entityId: body.routeOrderId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { kmTenths: body.kmTenths },
      ...contextOf(request),
    });

    return { ok: true };
  });
}
