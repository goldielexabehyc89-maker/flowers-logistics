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
import {
  fromDateColumn,
  isCalendarDate,
  toDateColumn,
} from '../integrations/moysklad/delivery-date.js';
import { moscowCalendarDate } from '@fl/shared';
import { listHistory, routeHistory } from '../history/service.js';
import {
  activateLedger,
  readLedgerActivation,
  resolveTariff,
  toTariffView,
  validateTariffPeriod,
} from './tariffs.js';
import { appendEntry, balanceOf, EXPENSE_KINDS, reverseEntry } from './ledger.js';
import { appendCash, cashBalanceOf, reverseCash } from './cash.js';
import { buildCashReport, visibleDeskIds } from './cash-report.js';
import { recordTransfer, resolveDeskOwner, reverseTransfer } from './transfers.js';
import { buildOperationalReport, buildSettlementReport } from './reports.js';
import { computeBeyondMkad, saveDistanceSnapshot } from './mkad.js';
import { activeRing, bundle } from './mkad-bundle.js';
import { ValhallaClient } from '../integrations/valhalla/client.js';
import { buildSettlementWorkbook } from './export-xlsx.js';
import { buildSettlementPdf } from './export-pdf.js';
import { buildCashPdf, buildCashWorkbook } from './export-cash.js';

const FINANCE_ROLES = ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'] as const;
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

/** Постраничность отчёта считается ГРУППАМИ «день + курьер», а не строками. */
const settlementQuerySchema = periodSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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
  /** Чья касса участвует в передаче. Логисту разрешена только своя. */
  logistUserId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
});

const reversalSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const tariffSchema = z.object({
  kind: z.enum(['REGULAR', 'HOLIDAY']),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().default(null),
  perOrderWalkMinor: z.coerce.bigint(),
  perOrderCarMinor: z.coerce.bigint(),
  perKmMinor: z.coerce.bigint(),
  note: z.string().trim().max(500).nullable().default(null),
});

const activationSchema = z.object({ activeFrom: dateSchema });

const cashQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  logistUserId: z.string().uuid().optional(),
  kind: z
    .enum([
      'RECEIVED_FROM_COURIER',
      'ISSUED_TO_COURIER',
      'TAKEN_FROM_COMPANY',
      'HANDED_TO_COMPANY',
      'ADJUSTMENT',
    ])
    .optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const companySchema = z.object({
  direction: z.enum(['TAKE', 'HAND']),
  amountMinor: moneySchema,
  operationDate: dateSchema,
  logistUserId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
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
    const query = settlementQuerySchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const activation = await readLedgerActivation(deps.db);
    return buildSettlementReport(deps.db, {
      from: query.from,
      to: query.to,
      courierUserId: query.courierUserId,
      ledgerActiveFrom: activation.activeFrom,
      limit: query.limit,
      offset: query.offset,
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

    // Буфер, а не промис и не Uint8Array: тело ответа обязано быть готовым
    // байтовым массивом, иначе клиент получает не файл, а отказ.
    const file = Buffer.from(await buildSettlementPdf(report));

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

  app.get('/api/logistics/reports/cash.xlsx', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = cashQuerySchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const report = await buildCashReport(deps.db, {
      from: query.from,
      to: query.to,
      logistUserId: query.logistUserId,
      kind: query.kind,
      search: query.search,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
      visibleLogistIds: actor.roles.includes('ADMIN') ? null : [actor.userId],
    });

    await writeAudit(deps.db, {
      action: 'FINANCE_REPORT_EXPORTED',
      entityType: 'LogistCashEntry',
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { format: 'xlsx', section: 'cash', from: query.from, to: query.to },
      ...contextOf(request),
    });

    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="cash-${query.from}_${query.to}.xlsx"`)
      .send(await buildCashWorkbook(report));
  });

  app.get('/api/logistics/reports/cash.pdf', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = cashQuerySchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const report = await buildCashReport(deps.db, {
      from: query.from,
      to: query.to,
      logistUserId: query.logistUserId,
      kind: query.kind,
      search: query.search,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
      visibleLogistIds: actor.roles.includes('ADMIN') ? null : [actor.userId],
    });

    await writeAudit(deps.db, {
      action: 'FINANCE_REPORT_EXPORTED',
      entityType: 'LogistCashEntry',
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { format: 'pdf', section: 'cash', from: query.from, to: query.to },
      ...contextOf(request),
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="cash-${query.from}_${query.to}.pdf"`)
      .send(Buffer.from(await buildCashPdf(report)));
  });

  // --- Денежные операции ---------------------------------------------------

  app.post('/api/logistics/ledger/operations', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const body = operationSchema.parse(request.body);

    if (EXPENSE_KINDS.includes(body.kind) && body.reason === undefined) {
      throw new AppError('VALIDATION_FAILED', { publicMessage: 'У расхода обязательна причина.' });
    }

    /*
     * Передача наличных меняет ДВЕ стороны сразу.
     *
     * Сдача и выдача — это фактическое движение денег: долг курьера и касса
     * логиста записываются одной транзакцией с общим идентификатором.
     * Дополнительный расход кассы не касается: наличные при нём не двигаются.
     */
    const transfer =
      body.kind === 'CASH_HANDED_TO_LOGIST'
        ? ('HANDED_BY_COURIER' as const)
        : body.kind === 'CASH_ISSUED_TO_COURIER'
          ? ('ISSUED_TO_COURIER' as const)
          : null;

    const entry = await deps.db.$transaction(async (tx) => {
      if (transfer !== null) {
        const logistUserId = resolveDeskOwner(actor, body.logistUserId);
        const result = await recordTransfer(tx, actor, {
          kind: transfer,
          courierUserId: body.courierUserId,
          logistUserId,
          amountMinor: body.amountMinor,
          operationDate: body.operationDate,
          idempotencyKey: body.idempotencyKey,
        });

        await writeAudit(tx, {
          action: 'FINANCE_OPERATION_RECORDED',
          entityType: 'CourierLedgerEntry',
          entityId: result.courierEntry.id,
          actorUserId: actor.userId,
          actorRoles: actor.roles,
          newValue: {
            kind: result.courierEntry.kind,
            amountMinor: result.courierEntry.amountMinor,
            operationDate: result.courierEntry.operationDate,
            courierUserId: result.courierEntry.courierUserId,
            // Владелец кассы и автор различаются, когда действует администратор.
            logistUserId,
            transferId: result.transferId,
          },
          ...contextOf(request),
        });

        await publishRealtimeEvent(tx, {
          topic: 'finance.ledger_changed',
          payload: { operationDate: result.courierEntry.operationDate },
          audienceRoles: ['ADMIN', 'LOGISTICIAN'],
        });

        return result.courierEntry;
      }

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
      const source = await tx.courierLedgerEntry.findUnique({
        where: { id },
        select: { transferId: true },
      });

      const created = await reverseEntry(tx, {
        entryId: id,
        actorUserId: actor.userId,
        reason: body.reason,
        operationDate: moscowCalendarDate(new Date()),
      });

      /*
       * У передачи две стороны, и отменяются они вместе.
       *
       * Отменённая наполовину передача оставила бы деньги в кассе, которых
       * у логиста нет, или долг у курьера, которого он не делал.
       */
      if (source !== null && source.transferId !== null) {
        await reverseTransfer(tx, {
          transferId: source.transferId,
          actorUserId: actor.userId,
          reason: body.reason,
          operationDate: moscowCalendarDate(new Date()),
        });
      }

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

  // --- Касса логистов -----------------------------------------------------

  /**
   * Кассы, доступные текущему пользователю.
   *
   * Логист видит только свою: наличные лежат у конкретного человека, и чужая
   * касса — это чужие деньги. Администратор видит все.
   */
  const visibleDesks = async (actor: {
    userId: string;
    roles: readonly string[];
  }): Promise<string[] | null> => {
    if (actor.roles.includes('ADMIN')) {
      return null;
    }
    return [actor.userId];
  };

  app.get('/api/logistics/cash', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const query = cashQuerySchema.parse(request.query);
    assertPeriod(query.from, query.to);

    const visible = await visibleDesks(actor);
    return buildCashReport(deps.db, {
      from: query.from,
      to: query.to,
      logistUserId: query.logistUserId,
      kind: query.kind,
      search: query.search,
      limit: query.limit,
      offset: query.offset,
      visibleLogistIds: visible === null ? null : visible,
    });
  });

  /** Список логистов для выбора кассы: нужен администратору. */
  app.get('/api/logistics/cash/desks', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const ids = actor.roles.includes('ADMIN') ? await visibleDeskIds(deps.db) : [actor.userId];

    const users = await deps.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, phone: true },
      orderBy: [{ fullName: 'asc' }],
    });

    return {
      items: await Promise.all(
        users.map(async (user) => ({
          id: user.id,
          fullName: user.fullName,
          phone: user.phone,
          balanceMinor: (await cashBalanceOf(deps.db, user.id, null)).toString(),
        })),
      ),
    };
  });

  /**
   * Движение денег между кассой и компанией.
   *
   * Проводится сразу: промежуточного «ожидает подтверждения» не существует,
   * потому что деньги уже переданы физически, и учёт обязан это отражать.
   */
  app.post('/api/logistics/cash/company', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const body = companySchema.parse(request.body);
    const logistUserId = resolveDeskOwner(actor, body.logistUserId);

    const entry = await deps.db.$transaction(async (tx) => {
      const created = await appendCash(tx, {
        logistUserId,
        kind: body.direction === 'TAKE' ? 'TAKEN_FROM_COMPANY' : 'HANDED_TO_COMPANY',
        amountMinor: body.amountMinor,
        operationDate: body.operationDate,
        actorUserId: actor.userId,
        idempotencyKey: body.idempotencyKey,
      });

      await writeAudit(tx, {
        action: 'FINANCE_CASH_MOVED',
        entityType: 'LogistCashEntry',
        entityId: created.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        // Автор и владелец кассы хранятся раздельно: действие администратора
        // не превращается в кассу владельца системы.
        newValue: {
          kind: created.kind,
          amountMinor: created.amountMinor,
          operationDate: created.operationDate,
          logistUserId,
        },
        ...contextOf(request),
      });

      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: created.operationDate },
        audienceRoles: ['ADMIN', 'LOGISTICIAN'],
      });

      return created;
    });

    return reply.code(201).send({ entry });
  });

  /** Обратная корректировка движения кассы: только с причиной и только один раз. */
  app.post('/api/logistics/cash/:id/reverse', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = reversalSchema.parse(request.body);

    const entry = await deps.db.$transaction(async (tx) => {
      const source = await tx.logistCashEntry.findUnique({
        where: { id },
        select: { logistUserId: true, transferId: true },
      });
      if (source === null) {
        throw new AppError('NOT_FOUND', { publicMessage: 'Операция кассы не найдена.' });
      }
      // Логист отменяет только в своей кассе.
      resolveDeskOwner(actor, source.logistUserId);

      const created =
        source.transferId === null
          ? await reverseCash(tx, {
              entryId: id,
              actorUserId: actor.userId,
              reason: body.reason,
              operationDate: moscowCalendarDate(new Date()),
            })
          : null;

      if (source.transferId !== null) {
        await reverseTransfer(tx, {
          transferId: source.transferId,
          actorUserId: actor.userId,
          reason: body.reason,
          operationDate: moscowCalendarDate(new Date()),
        });
      }

      await writeAudit(tx, {
        action: 'FINANCE_CASH_REVERSED',
        entityType: 'LogistCashEntry',
        entityId: id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        newValue: { logistUserId: source.logistUserId, transfer: source.transferId !== null },
        ...contextOf(request),
      });

      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: moscowCalendarDate(new Date()) },
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
        perOrderWalkMinor: current === null ? null : current.perOrderWalkMinor.toString(),
        perOrderCarMinor: current === null ? null : current.perOrderCarMinor.toString(),
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
      perOrderWalkMinor: body.perOrderWalkMinor,
      perOrderCarMinor: body.perOrderCarMinor,
      perKmMinor: body.perKmMinor,
      note: body.note,
    });

    const created = await deps.db.$transaction(async (tx) => {
      const row = await tx.courierTariffVersion.create({
        data: {
          kind: body.kind,
          effectiveFrom: toDateColumn(body.effectiveFrom),
          effectiveTo: body.effectiveTo === null ? null : toDateColumn(body.effectiveTo),
          perOrderWalkMinor: body.perOrderWalkMinor,
          perOrderCarMinor: body.perOrderCarMinor,
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
          perOrderWalkMinor: body.perOrderWalkMinor.toString(),
          perOrderCarMinor: body.perOrderCarMinor.toString(),
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

    const context = contextOf(request);
    await deps.db.$transaction(async (tx) => {
      await activateLedger(tx, {
        activeFrom: body.activeFrom,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    });

    return { activation: { activeFrom: body.activeFrom } };
  });

  // --- Геометрия МКАД и расстояния ----------------------------------------

  /**
   * Состояние геометрии: только чтение.
   *
   * Действующей считается ровно та версия, отпечаток которой лежит в поставке,
   * а не последняя строка таблицы: версию назначает файл приложения. Прежние
   * версии показываются рядом — на них ссылаются снимки прошлых расчётов.
   */
  app.get('/api/logistics/mkad', async (request) => {
    await authenticateWithRoles(request, deps, FINANCE_ROLES);

    const shipped = bundle();
    const versions = await deps.db.mkadRingVersion.findMany({
      orderBy: [{ createdAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        pointCount: true,
        sha256: true,
        source: true,
        license: true,
        sourceDate: true,
        createdAt: true,
      },
    });

    const current = versions.find((row) => row.sha256 === shipped.sha256) ?? null;
    return {
      configured: current !== null,
      /** Что именно поставлено с приложением: источник, снимок и лицензия. */
      bundled: {
        version: shipped.version,
        sha256: shipped.sha256,
        osmRelationId: shipped.osmRelationId,
        snapshotUrl: shipped.snapshotUrl,
        snapshotMd5: shipped.snapshotMd5,
        dataDate: shipped.dataDate,
        pointCount: shipped.pointCount,
        lengthMeters: shipped.lengthMeters,
        license: shipped.license,
        attribution: shipped.attribution,
        builder: shipped.builder,
      },
      active:
        current === null
          ? null
          : {
              id: current.id,
              pointCount: current.pointCount,
              sha256: current.sha256,
              source: current.source,
              license: current.license,
              sourceDate: current.sourceDate === null ? null : fromDateColumn(current.sourceDate),
              createdAt: current.createdAt.toISOString(),
            },
      versions: versions.map((row) => ({
        id: row.id,
        pointCount: row.pointCount,
        sha256: row.sha256,
        source: row.source,
        license: row.license,
        sourceDate: row.sourceDate === null ? null : fromDateColumn(row.sourceDate),
        createdAt: row.createdAt.toISOString(),
        active: row.sha256 === shipped.sha256,
      })),
    };
  });

  /*
    Загрузки геометрии через интерфейс нет намеренно.

    Кольцо входит в поставку версионированным системным файлом: от него
    зависят деньги, и менять его нажатием кнопки нельзя. Замена — только
    новой версией файла через обновление приложения.
  */

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
        ring,
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
