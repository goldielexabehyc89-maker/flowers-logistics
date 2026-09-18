/**
 * API логистической истории, отчётов и денежных операций.
 *
 * Управленческий контур: `ADMIN`, `LOGISTICIAN` и `SUPERVISOR` (`FINANCE_ROLES`).
 * Управляющий читает отчёты и заводит операции БЕЗ движения наличных — расходы,
 * доплаты, оплачиваемые попытки. Всё, где участвует касса (сдача, выдача, касса
 * компании), требует своей кассы и потому доступно логисту и администратору:
 * кассы у управляющего не существует, и писать в чужую он не вправе
 * (`resolveDeskOwner`). Начальный долг, тарифы и включение учёта — только `ADMIN`.
 * Курьерская история (`/api/delivery/history`) остаётся отдельной и здесь
 * не подменяется — у неё другой смысл и другая аудитория.
 *
 * Персональные данные (адрес, получатель) уходят только в профильных ответах
 * истории и выгрузках, но никогда — в realtime и в общий аудит.
 */

import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
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
import {
  appendLedgerEntry,
  balanceOf,
  entryByIdempotencyKey,
  reverseLedgerEntry,
  EXPENSE_KINDS,
  openingDebtsOf,
  signedAmount,
} from './ledger.js';
import {
  appendCashEntry,
  cashBalanceOf,
  cashEntryByIdempotencyKey,
  reverseCash,
  signedCash,
} from './cash.js';
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

/**
 * Начальный долг курьера — долг перед компанией, возникший ДО перехода на ERP.
 *
 * Основание уходит в `reason`, а не в `comment`: журнал расчётов показывает
 * именно причину, и в комментарии основание осталось бы невидимым.
 */
const openingDebtSchema = z.object({
  courierUserId: z.string().uuid(),
  amountMinor: moneySchema,
  operationDate: dateSchema,
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(120),
});

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
  /**
   * Обратная запись, созданная победителем гонки.
   *
   * Две одновременные отмены одной записи упираются в уникальность: выживает
   * одна. Проигравшая транзакция к этому моменту уже аварийна, поэтому читать
   * победителя можно только ПОСЛЕ её отката — здесь. Обоим запросам отдаётся
   * один и тот же результат: обратная запись одна, баланс меняется один раз.
   *
   * Признаком гонки служит САМА ОШИБКА, а не наличие обратной записи. Запись
   * существует и после любой давно завершённой отмены, и разбор «по факту
   * существования» превращал бы в успех что угодно: отказ по правам, ненайденную
   * операцию, отказ базы. Ограничение «начальный долг отменяет только
   * администратор» держалось бы тогда не правилом, а состоянием.
   */
  const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

  const reversalWinner = async (entryId: string, error: unknown): Promise<unknown | null> =>
    isUniqueViolation(error) ? entryByIdempotencyKey(deps.db, `reversal:${entryId}`) : null;

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

    /*
     * Владелец кассы определяется ДО любого ответа.
     *
     * `resolveDeskOwner` — это проверка права, а не деталь записи: логист
     * работает только со своей кассой, администратор обязан назвать чужую.
     * Выполненная только внутри транзакции, она пропускалась на быстром пути
     * повтора, и логист по чужому ключу получал в ответ операцию по ЧУЖОЙ
     * кассе — с суммой, курьером и днём.
     */
    const logistUserId = transfer === null ? null : resolveDeskOwner(actor, body.logistUserId);

    /*
     * Тот же ключ с другими данными — это не повтор, а другая операция.
     *
     * Повтор (двойной клик, сетевой повтор, гонка) обязан вернуть ту же запись
     * и не создать второй. А молча отдать её в ответ на запрос с ДРУГОЙ суммой,
     * датой, видом, курьером или КАССОЙ значило бы ответить «сохранено» о том,
     * что не сохранялось. Путь достижим: форма не закрывается при ошибке и
     * оставляет прежний ключ, а человек правит данные и отправляет снова.
     */
    const sameOperation = (candidate: {
      kind: string;
      courierUserId: string;
      operationDate: string;
      amountMinor: string;
    }): boolean =>
      candidate.kind === body.kind &&
      candidate.courierUserId === body.courierUserId &&
      candidate.operationDate === body.operationDate &&
      BigInt(candidate.amountMinor) === signedAmount(body.kind, body.amountMinor);

    /**
     * У передачи есть вторая сторона — касса, и она тоже часть операции.
     *
     * Иначе тот же ключ с другой кассой отвечал бы «сохранено», а наличные
     * так и оставались бы числиться за прежним логистом.
     */
    const sameDesk = async (candidate: { transferId: string | null }): Promise<boolean> => {
      if (transfer === null) {
        return true;
      }
      if (candidate.transferId === null) {
        return false;
      }
      const cashSide = await deps.db.logistCashEntry.findFirst({
        where: { transferId: candidate.transferId, kind: { not: 'ADJUSTMENT' } },
        select: { logistUserId: true },
      });
      return cashSide !== null && cashSide.logistUserId === logistUserId;
    };

    const conflict = (): never => {
      throw new AppError('CONFLICT', {
        publicMessage: 'Этот ключ идемпотентности уже использован для другой операции.',
      });
    };

    // Повтор уже сохранённой операции: ни второй записи, ни второй строки аудита.
    const known = await entryByIdempotencyKey(deps.db, body.idempotencyKey);
    if (known !== null) {
      return sameOperation(known) && (await sameDesk(known))
        ? reply.code(201).send({ entry: known })
        : conflict();
    }

    const runOperation = async (): Promise<unknown> =>
      deps.db.$transaction(async (tx) => {
        /*
         * Запросы с ОДНИМ ключом выстраиваются в очередь.
         *
         * Предварительного поиска мало: победитель вправе зафиксироваться между
         * ним и вставкой. Блокировка по ключу делает такое чередование
         * невозможным, а признак `created` закрывает его, даже если оно случится.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ledger-operation:${body.idempotencyKey}`})::bigint)`;

        if (transfer !== null && logistUserId !== null) {
          const result = await recordTransfer(tx, actor, {
            kind: transfer,
            courierUserId: body.courierUserId,
            logistUserId,
            amountMinor: body.amountMinor,
            operationDate: body.operationDate,
            idempotencyKey: body.idempotencyKey,
          });

          /*
           * Контракт сверяется и по кассе: `appendCash` находит запись по
           * ключу, не глядя на владельца, и без этой проверки тот же ключ
           * с другой кассой отвечал бы «сохранено».
           */
          if (
            !sameOperation(result.courierEntry) ||
            result.cashEntry.logistUserId !== logistUserId
          ) {
            conflict();
          }

          // Аудит и событие пишет только та транзакция, которая создала запись.
          if (!result.created) {
            return result.courierEntry;
          }

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
            audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
          });

          return result.courierEntry;
        }

        const { entry: created, created: isNew } = await appendLedgerEntry(tx, {
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

        /*
         * Контракт сверяется на КАЖДОМ пути возврата существующей операции,
         * включая тот, где запись нашёл сам `appendLedgerEntry`.
         */
        if (!sameOperation(created)) {
          conflict();
        }

        if (!isNew) {
          return created;
        }

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
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });

    let entry;
    try {
      entry = await runOperation();
    } catch (error) {
      /*
       * Гонку выигрывает один запрос, и его запись — это и есть результат.
       *
       * Нарушение уникальности переводит транзакцию PostgreSQL в аварийное
       * состояние, поэтому победитель читается только здесь, после отката.
       * Любая другая ошибка остаётся ошибкой, а чужая операция под тем же
       * ключом — конфликтом, а не молчаливым «сохранено».
       */
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await entryByIdempotencyKey(deps.db, body.idempotencyKey);
      if (winner === null) {
        throw error;
      }
      if (!sameOperation(winner) || !(await sameDesk(winner))) {
        conflict();
      }
      entry = winner;
    }

    return reply.code(201).send({ entry });
  });

  app.post('/api/logistics/ledger/operations/:id/reverse', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = reversalSchema.parse(request.body);

    let entry;
    try {
      entry = await deps.db.$transaction(async (tx) => {
        const source = await tx.courierLedgerEntry.findUnique({
          where: { id },
          select: { transferId: true, kind: true },
        });

        /*
         * Начальный долг отменяется только администратором и только своим
         * действием.
         *
         * Этот эндпоинт открыт всему финансовому контуру (логист, управляющий),
         * поэтому отмену начального долга он не выполняет НИ ДЛЯ КОГО — иначе
         * ограничение «только ADMIN» обходилось бы прямым запросом сюда.
         */
        if (source !== null && source.kind === 'OPENING_DEBT') {
          throw new AppError('FORBIDDEN', {
            publicMessage:
              'Отмена начального долга выполняется отдельным действием администратора.',
          });
        }

        /*
         * У передачи ДВА маршрута отмены, и очередь у них обязана быть общей.
         *
         * Журнал курьера пишет сначала свою обратную запись, потом кассовую;
         * касса — наоборот. Разные ключи блокировки не сериализовали их вовсе,
         * и две одновременные отмены одной передачи упирались в уникальные
         * индексы в противоположном порядке: PostgreSQL сообщал о взаимной
         * блокировке, а человек видел внутреннюю ошибку — иногда с обеих
         * сторон сразу, и тогда отмена не выполнялась вообще.
         *
         * Ключ передачи берётся ПЕРВЫМ в обоих маршрутах: порядок захвата
         * одинаков, значит цикла ожидания не возникает.
         */
        if (source !== null && source.transferId !== null) {
          /*
           * Отмена передачи двигает КАССУ, а значит требует права на неё.
           *
           * Этот маршрут открыт всему финансовому контуру, но у передачи есть
           * вторая сторона — наличные конкретного логиста. Без проверки чужой
           * логист и управляющий обнуляли бы кассу, к которой не имеют
           * отношения, и снимали долг курьера: на СОЗДАНИИ передачи право
           * проверяется, а на отмене проверки не было вовсе.
           */
          const cashSide = await tx.logistCashEntry.findFirst({
            where: { transferId: source.transferId, kind: { not: 'ADJUSTMENT' } },
            select: { logistUserId: true },
          });
          /*
           * Нет второй стороны — значит и разрешать нечего.
           *
           * «Данных не нашли, поэтому пропускаем» в правах на деньги работает
           * наоборот: весь остальной модуль закрывается, а не открывается.
           */
          if (cashSide === null) {
            throw new AppError('CONFLICT', {
              message: 'transfer has no cash side',
              publicMessage:
                'У этой передачи не найдена кассовая сторона. Обратитесь к администратору.',
            });
          }
          resolveDeskOwner(actor, cashSide.logistUserId);

          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-reversal:${source.transferId}`})::bigint)`;
        }

        /*
         * Отмены одной записи выстраиваются в очередь по ключу.
         *
         * Предварительного поиска мало: победитель может зафиксироваться сразу
         * после него, и тогда отмена вернётся уже существующей — маршрут принял
         * бы её за новую и повторил аудит и событие. Признак `created` ниже
         * закрывает этот путь окончательно, даже без блокировки.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reversal:${id}`})::bigint)`;

        const { entry: created, created: isNewReversal } = await reverseLedgerEntry(tx, {
          entryId: id,
          actorUserId: actor.userId,
          reason: body.reason,
          operationDate: moscowCalendarDate(new Date()),
        });

        // Аудит, событие и отмену встречной передачи делает только создатель.
        if (!isNewReversal) {
          return created;
        }

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
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });
    } catch (error) {
      const winner = await reversalWinner(id, error);
      if (winner === null) {
        throw error;
      }
      entry = winner;
    }

    return { entry };
  });

  // --- Начальный долг курьера ----------------------------------------------

  /**
   * Долг курьера перед компанией, возникший ДО перехода на ERP.
   *
   * Это именно долг курьера, а не задолженность компании по оплате его работы:
   * знак «плюс» увеличивает долг. Операция не двигает наличные, не относится
   * к заработку и расходам и не создаёт ни заказа, ни доставки, ни передачи
   * денег — поэтому ни касса логиста, ни касса компании ею не меняются.
   *
   * Заводит только администратор: это ручной ввод исторической суммы, который
   * ничем в системе не подтверждается.
   */
  app.post('/api/logistics/ledger/opening-debt', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const body = openingDebtSchema.parse(request.body);

    /*
     * Получатель долга обязан быть курьером.
     *
     * Проверки формата UUID недостаточно: без этого долг молча лёг бы на
     * логиста, администратора или на несуществующего пользователя, и отчёт
     * расчётов с курьерами показал бы сумму у того, кто в нём не участвует.
     */
    const courier = await deps.db.user.findFirst({
      where: { id: body.courierUserId, roles: { some: { role: 'COURIER' } } },
      select: { id: true },
    });
    if (courier === null) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: 'Начальный долг заводится только курьеру.',
      });
    }

    /*
     * Тот же ключ с другими данными — это не повтор, а другая операция.
     *
     * Повтор той же самой операции (двойной клик, сетевой повтор, гонка двух
     * запросов) обязан вернуть ту же запись и не создать вторую. А вот молча
     * отдать её в ответ на запрос с ДРУГОЙ суммой, датой или курьером значило
     * бы ответить «сохранено» о том, что не сохранялось.
     */
    const sameOperation = (candidate: {
      kind: string;
      courierUserId: string;
      operationDate: string;
      amountMinor: string;
    }): boolean =>
      candidate.kind === 'OPENING_DEBT' &&
      candidate.courierUserId === body.courierUserId &&
      candidate.operationDate === body.operationDate &&
      BigInt(candidate.amountMinor) === signedAmount('OPENING_DEBT', body.amountMinor);

    const conflict = (): never => {
      throw new AppError('CONFLICT', {
        publicMessage: 'Этот ключ идемпотентности уже использован для другой операции.',
      });
    };

    // Повтор уже сохранённой операции: ни второй записи, ни второй строки аудита.
    const known = await entryByIdempotencyKey(deps.db, body.idempotencyKey);
    if (known !== null) {
      return sameOperation(known) ? reply.code(201).send({ entry: known }) : conflict();
    }

    let entry;
    try {
      entry = await deps.db.$transaction(async (tx) => {
        /*
         * Запись могла появиться между предварительной проверкой и этой
         * транзакцией.
         *
         * Тогда `appendEntry` молча вернул бы чужую запись, и запрос с ДРУГОЙ
         * суммой получил бы 201 «сохранено» вместе с лишней строкой аудита.
         * Поэтому повтор распознаётся здесь же, до записи: контракт сверяется
         * на КАЖДОМ пути возврата существующей операции.
         */
        /*
         * Запросы с ОДНИМ ключом выстраиваются в очередь.
         *
         * Предварительного SELECT недостаточно: победитель вправе
         * зафиксироваться между проверкой и вставкой, и тогда `appendEntry`
         * вернул бы чужую запись уже внутри транзакции. Блокировка по ключу
         * делает такое чередование невозможным, а признак `created` ниже
         * закрывает его даже если оно случится.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`opening-debt:${body.idempotencyKey}`})::bigint)`;

        const { entry: saved, created: isNew } = await appendLedgerEntry(tx, {
          courierUserId: body.courierUserId,
          kind: 'OPENING_DEBT',
          amountMinor: body.amountMinor,
          operationDate: body.operationDate,
          actorUserId: actor.userId,
          // Основание — в «причину»: журнал расчётов показывает именно её.
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        });

        /*
         * Контракт сверяется на КАЖДОМ пути возврата существующей операции,
         * включая тот, где запись нашёл сам `appendEntry`.
         */
        if (!sameOperation(saved)) {
          conflict();
        }

        // Аудит и событие пишет только та транзакция, которая создала запись.
        if (!isNew) {
          return saved;
        }

        const created = saved;

        await writeAudit(tx, {
          action: 'FINANCE_OPERATION_RECORDED',
          entityType: 'CourierLedgerEntry',
          entityId: created.id,
          actorUserId: actor.userId,
          actorRoles: actor.roles,
          // Основание не пишем: в аудите вид, сумма, день и курьер.
          newValue: {
            kind: created.kind,
            amountMinor: created.amountMinor,
            operationDate: created.operationDate,
            courierUserId: created.courierUserId,
          },
          ...contextOf(request),
        });

        await publishRealtimeEvent(tx, {
          topic: 'finance.ledger_changed',
          payload: { operationDate: created.operationDate },
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });
    } catch (error) {
      /*
       * Гонку выигрывает один запрос, и его запись — это и есть результат.
       *
       * Проигравший узнаёт об этом по-разному: нарушение уникальности переводит
       * транзакцию PostgreSQL в аварийное состояние, и следующий же запрос в ней
       * падает уже не кодом уникальности. Поэтому признак гонки здесь не код
       * ошибки, а факт: запись с ЭТИМ ключом существует. Если её нет, ошибка
       * настоящая и должна остаться ошибкой.
       */
      const winner = await entryByIdempotencyKey(deps.db, body.idempotencyKey);
      if (winner === null) {
        throw error;
      }
      if (!sameOperation(winner)) {
        return conflict();
      }
      entry = winner;
    }

    return reply.code(201).send({ entry });
  });

  /**
   * Отмена начального долга — обратной записью, а не правкой исходной суммы.
   *
   * Исходная запись остаётся в своём дне; отмена относится к дню, когда её
   * действительно провели, поэтому прошлые отчёты не переписываются.
   */
  app.post('/api/logistics/ledger/opening-debt/:id/reverse', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = reversalSchema.parse(request.body);

    let entry;
    try {
      entry = await deps.db.$transaction(async (tx) => {
        const source = await tx.courierLedgerEntry.findUnique({
          where: { id },
          select: { kind: true },
        });
        if (source === null) {
          throw new AppError('NOT_FOUND', { publicMessage: 'Операция не найдена.' });
        }
        if (source.kind !== 'OPENING_DEBT') {
          throw new AppError('VALIDATION_FAILED', {
            publicMessage: 'Этим действием отменяется только начальный долг.',
          });
        }

        /*
         * Отмены одной записи выстраиваются в очередь по ключу.
         *
         * Предварительного поиска мало: победитель может зафиксироваться сразу
         * после него, и тогда отмена вернётся уже существующей — маршрут принял
         * бы её за новую и повторил аудит и событие. Признак `created` ниже
         * закрывает этот путь окончательно, даже без блокировки.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reversal:${id}`})::bigint)`;

        const { entry: created, created: isNewReversal } = await reverseLedgerEntry(tx, {
          entryId: id,
          actorUserId: actor.userId,
          reason: body.reason,
          operationDate: moscowCalendarDate(new Date()),
        });

        // Аудит, событие и отмену встречной передачи делает только создатель.
        if (!isNewReversal) {
          return created;
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
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });
    } catch (error) {
      /*
       * Проигравший гонку получает ту же обратную запись, а не 500: отмена
       * идемпотентна, и оба запроса обязаны увидеть один результат.
       */
      const winner = await reversalWinner(id, error);
      if (winner === null) {
        throw error;
      }
      entry = winner;
    }

    return { entry };
  });

  /** Уже заведённые начальные долги курьера: форма предупреждает о повторе. */
  app.get('/api/logistics/ledger/opening-debt', async (request) => {
    await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const { courierUserId } = z.object({ courierUserId: z.string().uuid() }).parse(request.query);

    return { entries: await openingDebtsOf(deps.db, courierUserId) };
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
    const kind = body.direction === 'TAKE' ? 'TAKEN_FROM_COMPANY' : 'HANDED_TO_COMPANY';

    /*
     * Тот же ключ с другими данными — другая операция, а не повтор.
     *
     * Правило то же, что у журнала курьера: молчаливый возврат чужой записи
     * означал бы ответ «сохранено» о том, что не сохранялось.
     */
    const sameCashOperation = (candidate: {
      logistUserId: string;
      kind: string;
      amountMinor: string;
      operationDate: string;
    }): boolean =>
      candidate.logistUserId === logistUserId &&
      candidate.kind === kind &&
      candidate.operationDate === body.operationDate &&
      BigInt(candidate.amountMinor) === signedCash(kind, body.amountMinor);

    const cashConflict = (): never => {
      throw new AppError('CONFLICT', {
        publicMessage: 'Этот ключ идемпотентности уже использован для другой операции.',
      });
    };

    const run = async (): Promise<unknown> =>
      deps.db.$transaction(async (tx) => {
        /*
         * Запросы с одним ключом выстраиваются в очередь.
         *
         * Внутри `appendCash` поиск по ключу стоит ДО блокировки кассы, поэтому
         * два одновременных запроса оба решают «ключа нет» и второй доходит до
         * вставки. Без этой блокировки обычное двойное нажатие давало отказ.
         */
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash:${body.idempotencyKey}`})::bigint)`;

        const { entry: created, created: isNew } = await appendCashEntry(tx, {
          logistUserId,
          kind,
          amountMinor: body.amountMinor,
          operationDate: body.operationDate,
          actorUserId: actor.userId,
          idempotencyKey: body.idempotencyKey,
        });

        if (!sameCashOperation(created)) {
          cashConflict();
        }

        /*
         * Аудит и событие пишет только та транзакция, которая создала запись.
         *
         * Очередь по ключу сделала повторы ТИХИМИ: раньше второй запрос падал,
         * а теперь успешно дописывал бы третью строку аудита о деньгах,
         * внесённых один раз. В финансовом контуре это хуже самой записи.
         */
        if (!isNew) {
          return created;
        }

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
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });

    let entry;
    try {
      entry = await run();
    } catch (error) {
      /*
       * Победитель гонки читается снаружи: нарушение уникальности делает
       * транзакцию аварийной, и перечитывать запись внутри неё нельзя.
       * Любая другая ошибка остаётся ошибкой.
       */
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await cashEntryByIdempotencyKey(deps.db, body.idempotencyKey);
      if (winner === null) {
        throw error;
      }
      if (!sameCashOperation(winner)) {
        cashConflict();
      }
      entry = winner;
    }

    return reply.code(201).send({ entry });
  });

  /** Обратная корректировка движения кассы: только с причиной и только один раз. */
  app.post('/api/logistics/cash/:id/reverse', async (request) => {
    const actor = await authenticateWithRoles(request, deps, FINANCE_ROLES);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = reversalSchema.parse(request.body);

    const runReversal = async (): Promise<unknown> =>
      deps.db.$transaction(async (tx) => {
        const source = await tx.logistCashEntry.findUnique({
          where: { id },
          select: { logistUserId: true, transferId: true, kind: true },
        });
        if (source === null) {
          throw new AppError('NOT_FOUND', { publicMessage: 'Операция кассы не найдена.' });
        }
        // Логист отменяет только в своей кассе.
        resolveDeskOwner(actor, source.logistUserId);

        /*
         * Обратную запись отменить нельзя — и у передачи тоже.
         *
         * У обратной записи передачи есть `transferId`, и маршрут уходил в
         * отмену передачи мимо собственного запрета: человек отменял
         * корректировку, а получал сообщение про уже отменённую операцию.
         */
        if (source.kind === 'ADJUSTMENT') {
          throw new AppError('CONFLICT', {
            publicMessage: 'Корректировку нельзя отменить: заведите новую операцию с причиной.',
          });
        }

        /*
         * Общая очередь обеих сторон передачи — тот же ключ и тот же порядок
         * захвата, что в отмене операции журнала. Без него две отмены одной
         * передачи вставляли записи в противоположном порядке и упирались во
         * взаимную блокировку, а человек видел внутреннюю ошибку.
         */
        if (source.transferId !== null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-reversal:${source.transferId}`})::bigint)`;
        }

        // Отмены одной записи кассы выстраиваются в очередь по своему ключу.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cash-reversal:${id}`})::bigint)`;

        /*
         * Отменил ли ЧТО-ТО именно этот запрос.
         *
         * Повтор отмены передачи теперь успешен — уже отменённые стороны
         * пропускаются, — и вместе с отказом ушла единственная преграда перед
         * второй строкой аудита. Признак возвращает сама отмена: историю и
         * событие пишет только тот, кто действительно отменил.
         */
        const reversedNow =
          source.transferId === null
            ? true
            : await reverseTransfer(tx, {
                transferId: source.transferId,
                actorUserId: actor.userId,
                reason: body.reason,
                operationDate: moscowCalendarDate(new Date()),
              });

        /*
         * Возвращается созданная обратная запись — и у передачи тоже.
         *
         * Прежде маршрут отдавал `entry: null`, хотя запись создавалась:
         * контракт ответа зависел от того, передача это или нет.
         */
        const created =
          source.transferId === null
            ? await reverseCash(tx, {
                entryId: id,
                actorUserId: actor.userId,
                reason: body.reason,
                operationDate: moscowCalendarDate(new Date()),
              })
            : await cashEntryByIdempotencyKey(tx, `cash-reversal:${id}`);

        if (!reversedNow) {
          return created;
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
          audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
        });

        return created;
      });

    let entry;
    try {
      entry = await runReversal();
    } catch (error) {
      /*
       * Ту же запись успел отменить кто-то ещё — например, через отмену
       * передачи со стороны журнала курьера: там свой ключ блокировки, и от
       * этой очереди он не защищает. Человеку отвечаем тем же, что и на
       * обычный повтор, а не невнятным отказом сервера.
       */
      if (
        !isUniqueViolation(error) ||
        (await cashEntryByIdempotencyKey(deps.db, `cash-reversal:${id}`)) === null
      ) {
        throw error;
      }
      throw new AppError('CONFLICT', { publicMessage: 'Эта операция кассы уже отменена.' });
    }

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
