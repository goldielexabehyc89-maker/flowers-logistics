/**
 * Точки печати: компьютер с принтером, подключённый к системе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ — второй очереди печати. Очередь у заказа уже
 * есть: событие «Собран» создаёт неизменяемый бланк и ровно одно задание
 * `OrderPrintJob`, а термоэтикетка — второе представление того же документа
 * (см. `fulfillment/print.ts`). Отдельная сущность «этикетка» дала бы одному
 * заказу две несогласованные истории печати. Здесь живёт только то, чего
 * раньше не было: куда печатать и кто на том конце провода.
 *
 * СЕКРЕТЫ. Одноразовый код подключения — короткий и его диктуют человеку,
 * поэтому он хранится argon2-хешем с серверным pepper, как PIN и код
 * активации. Постоянный токен агента — 32 случайных байта, и для него
 * достаточно SHA-256: перебор невозможен, а argon2 сделал бы медленным
 * каждый опрос очереди. Обе схемы уже приняты в проекте для ровно этих
 * двух случаев, и заводить третью незачем.
 */

import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { redactString } from '../../platform/logging/redact.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  hashSecretCode,
  verifySecretCode,
} from '../auth/crypto.js';
import { writeAudit } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';

/** Кто управляет точками печати. Тот же список, что и у прочих настроек. */
export const PRINT_ADMIN_ROLES = ['ADMIN'] as const;

/** Кому адресованы изменения точек: администратору и флористу, который печатает. */
export const PRINT_AUDIENCE = ['ADMIN', 'FLORIST'] as const;

/**
 * Через сколько молчания точка считается недоступной.
 *
 * Порог намеренно НЕ привязан к периоду опроса: при опросе раз в три секунды
 * девяносто секунд молчания — это десятки подряд пропущенных отметок, а не
 * одна-две. Так короткий сетевой сбой не гасит точку, а по-настоящему
 * выключенный компьютер обнаруживается всё за те же полторы минуты. Значение
 * фиксированное и от периода опроса не зависит.
 */
export const OFFLINE_AFTER_MS = 90_000;

/**
 * Период опроса очереди печати: как часто агент отмечается и забирает задание.
 * Значение уходит агенту в ответе (`heartbeatMs`), и агент спит его между
 * опросами. Три секунды — чтобы задание после «Собран» подхватывалось за пару
 * секунд, а не ждало следующего редкого опроса.
 */
export const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * Как часто ОБЫЧНАЯ отметка живости пишется в базу.
 *
 * Опрос идёт каждые три секунды, но писать `lastSeenAt` на каждый опрос — это
 * двадцать записей в минуту на точку впустую. Достаточно освежать отметку не
 * чаще раза в тридцать секунд: до порога недоступности (90 с) остаётся втрое
 * больший запас, и точка не гаснет. Ошибка агента, результат печати и смена
 * состояния этой экономии НЕ подчиняются — они фиксируются немедленно.
 */
export const HEARTBEAT_PERSIST_MS = 30_000;

/** Сколько живёт одноразовый код подключения. */
export const PAIRING_TTL_MS = 15 * 60_000;

export const MAX_POINT_NAME_LENGTH = 120;

/** Длина безопасного текста ошибки в интерфейсе. */
const MAX_ERROR_LENGTH = 300;

export type PrintPointState = 'ONLINE' | 'OFFLINE' | 'ERROR';

export interface PrintPointView {
  id: string;
  name: string;
  computerName: string | null;
  printerName: string | null;
  isActive: boolean;
  state: PrintPointState;
  /** Подключён ли агент: у точки есть постоянный токен. */
  paired: boolean;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
  lastErrorText: string | null;
  /** Сколько заданий ждёт передачи принтеру. */
  queued: number;
  /** Действует ли выданный код подключения. Само значение нигде не хранится. */
  pairingActive: boolean;
  /** Ждёт ли выдачи тестовый отпечаток. */
  testPending: boolean;
}

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

interface PointRow {
  id: string;
  name: string;
  computerName: string | null;
  printerName: string | null;
  isActive: boolean;
  agentTokenHash: string | null;
  pairingExpiresAt: Date | null;
  lastSeenAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorText: string | null;
  testRequestedAt: Date | null;
}

const POINT_SELECT = {
  id: true,
  name: true,
  computerName: true,
  printerName: true,
  isActive: true,
  agentTokenHash: true,
  pairingExpiresAt: true,
  lastSeenAt: true,
  lastErrorAt: true,
  lastErrorText: true,
  testRequestedAt: true,
} as const;

/**
 * Состояние точки выводится, а не хранится.
 *
 * Хранимое пришлось бы обновлять по расписанию, и оно показывало бы «Онлайн»
 * у компьютера, выключенного полчаса назад. Ошибка «прилипает» до следующего
 * успешного отклика: администратор должен увидеть, что случилось, а не только
 * то, что сейчас связь есть.
 */
export function pointState(row: PointRow, now: Date): PrintPointState {
  if (!row.isActive || row.lastSeenAt === null) {
    return 'OFFLINE';
  }
  if (now.getTime() - row.lastSeenAt.getTime() > OFFLINE_AFTER_MS) {
    return 'OFFLINE';
  }
  if (row.lastErrorAt !== null && row.lastErrorAt.getTime() >= row.lastSeenAt.getTime()) {
    return 'ERROR';
  }
  return 'ONLINE';
}

function toView(row: PointRow, queued: number, now: Date): PrintPointView {
  return {
    id: row.id,
    name: row.name,
    computerName: row.computerName,
    printerName: row.printerName,
    isActive: row.isActive,
    state: pointState(row, now),
    paired: row.agentTokenHash !== null,
    lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.toISOString(),
    lastErrorAt: row.lastErrorAt === null ? null : row.lastErrorAt.toISOString(),
    lastErrorText: row.lastErrorText,
    queued,
    pairingActive: row.pairingExpiresAt !== null && row.pairingExpiresAt.getTime() > now.getTime(),
    testPending: row.testRequestedAt !== null,
  };
}

/** Текст ошибки для показа: без секретов и без бесконечной длины. */
export function safeErrorText(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text === '') {
    return null;
  }
  return redactString(text).slice(0, MAX_ERROR_LENGTH);
}

/**
 * Сколько заданий ждёт передачи принтеру.
 *
 * Считается по СУЩЕСТВУЮЩЕЙ таблице заданий печати: очередь у нас одна.
 */
async function queuedCounts(
  db: Database | TransactionClient,
  pointIds: readonly string[],
): Promise<Map<string, number>> {
  if (pointIds.length === 0) {
    return new Map();
  }
  const rows = await db.orderPrintJob.groupBy({
    by: ['printPointId'],
    where: { printPointId: { in: [...pointIds] }, deliveryState: { in: ['QUEUED', 'CLAIMED'] } },
    _count: { _all: true },
  });
  return new Map(
    rows.flatMap((row) => (row.printPointId === null ? [] : [[row.printPointId, row._count._all]])),
  );
}

export async function listPrintPoints(db: Database, now = new Date()): Promise<PrintPointView[]> {
  const rows = await db.printPoint.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: POINT_SELECT,
  });
  const counts = await queuedCounts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toView(row, counts.get(row.id) ?? 0, now));
}

/**
 * Точки, которые флорист может выбрать на смену.
 *
 * Только действующие и уже подключённые: выбрать точку, к которой не подключён
 * ни один компьютер, значит отправлять наклейки в никуда и узнать об этом
 * от покупателя.
 */
export async function listSelectablePoints(
  db: Database,
  now = new Date(),
): Promise<PrintPointView[]> {
  const points = await listPrintPoints(db, now);
  return points.filter((point) => point.isActive && point.paired);
}

export async function getPrintPoint(
  db: Database,
  id: string,
  now = new Date(),
): Promise<PrintPointView> {
  const row = await db.printPoint.findUnique({ where: { id }, select: POINT_SELECT });
  if (row === null) {
    throw new AppError('NOT_FOUND', {
      message: 'print point not found',
      publicMessage: 'Точка печати не найдена.',
    });
  }
  const counts = await queuedCounts(db, [row.id]);
  return toView(row, counts.get(row.id) ?? 0, now);
}

export async function createPrintPoint(
  db: Database,
  actor: AuthenticatedActor,
  input: { name: string },
  context: RequestContext,
): Promise<PrintPointView> {
  const name = input.name.normalize('NFKC').trim();
  if (name === '' || name.length > MAX_POINT_NAME_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'invalid print point name',
      publicMessage: `Название точки — от одного до ${MAX_POINT_NAME_LENGTH} символов.`,
    });
  }

  return db.$transaction(async (tx) => {
    const created = await tx.printPoint.create({
      data: { name, createdById: actor.userId },
      select: POINT_SELECT,
    });

    await writeAudit(tx, {
      action: 'PRINT_POINT_CREATED',
      entityType: 'PrintPoint',
      entityId: created.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { name: created.name },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishPointChange(tx, created.id);
    return toView(created, 0, new Date());
  });
}

/**
 * Одноразовый код подключения.
 *
 * Возвращается ровно один раз: показать его повторно нельзя даже
 * администратору, потому что на сервере его нет — есть только хеш. Срок жизни
 * короткий, код диктуют человеку, стоящему у компьютера.
 *
 * Восемь цифр, а не четыре: код открывает право печатать на чужом принтере.
 */
export async function issuePairingCode(
  db: Database,
  actor: AuthenticatedActor,
  pointId: string,
  pepper: string,
  context: RequestContext,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const { randomInt } = await import('node:crypto');
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const codeHash = await hashSecretCode(code, pepper);

  await db.$transaction(async (tx) => {
    const point = await tx.printPoint.findUnique({ where: { id: pointId }, select: { id: true } });
    if (point === null) {
      throw new AppError('NOT_FOUND', {
        message: 'print point not found',
        publicMessage: 'Точка печати не найдена.',
      });
    }

    await tx.printPoint.update({
      where: { id: pointId },
      data: { pairingCodeHash: codeHash, pairingExpiresAt: expiresAt },
    });

    await writeAudit(tx, {
      action: 'PRINT_POINT_PAIRING_ISSUED',
      entityType: 'PrintPoint',
      entityId: pointId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      // Ни кода, ни его хеша: журнал читают все административные экраны.
      newValue: { expiresAt: expiresAt.toISOString() },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishPointChange(tx, pointId);
  });

  return { code, expiresAt: expiresAt.toISOString() };
}

/**
 * Подключение агента по одноразовому коду.
 *
 * Код гасится вместе с выдачей токена: второй компьютер, набравший тот же код
 * секундой позже, получит отказ, а не вторую точку печати на одном принтере.
 */
export async function pairAgent(
  db: Database,
  input: { code: string; computerName: string; printerName: string },
  pepper: string,
  now = new Date(),
): Promise<{ pointId: string; pointName: string; token: string; heartbeatMs: number }> {
  const code = input.code.trim();

  const candidates = await db.printPoint.findMany({
    where: { pairingExpiresAt: { gt: now }, isActive: true, pairingCodeHash: { not: null } },
    select: { id: true, name: true, pairingCodeHash: true },
  });

  let matched: { id: string; name: string } | null = null;
  for (const candidate of candidates) {
    if (await verifySecretCode(candidate.pairingCodeHash ?? '', code, pepper)) {
      matched = { id: candidate.id, name: candidate.name };
      break;
    }
  }

  if (matched === null) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'pairing code is invalid or expired',
      publicMessage: 'Код подключения неверен или истёк. Выпустите новый.',
    });
  }

  const token = generateRefreshToken();
  const point = matched;

  return db.$transaction(async (tx) => {
    // Код гасится ВНУТРИ транзакции и только если он ещё на месте: между
    // проверкой и записью его мог погасить другой компьютер.
    const claimed = await tx.printPoint.updateMany({
      where: { id: point.id, pairingCodeHash: { not: null }, pairingExpiresAt: { gt: now } },
      data: {
        agentTokenHash: hashRefreshToken(token),
        pairingCodeHash: null,
        pairingExpiresAt: null,
        pairedAt: now,
        computerName: input.computerName.slice(0, 200),
        printerName: input.printerName.slice(0, 200),
        lastSeenAt: now,
        lastErrorAt: null,
        lastErrorText: null,
      },
    });

    if (claimed.count !== 1) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'pairing code already used',
        publicMessage: 'Код подключения уже использован. Выпустите новый.',
      });
    }

    await writeAudit(tx, {
      action: 'PRINT_POINT_PAIRED',
      entityType: 'PrintPoint',
      entityId: point.id,
      actorUserId: null,
      source: 'worker',
      // Имя компьютера и принтера — адрес железа, а не персональные данные.
      newValue: { computerName: input.computerName.slice(0, 200) },
      ip: null,
      userAgent: null,
    });

    await publishPointChange(tx, point.id);

    return { pointId: point.id, pointName: point.name, token, heartbeatMs: HEARTBEAT_INTERVAL_MS };
  });
}

/**
 * Отключение точки.
 *
 * Токен агента стирается: отключённый компьютер теряет право печати
 * немедленно, а не после того, как кто-то удалит агента с диска.
 *
 * Ждавшие задания снимаются с автоматической доставки, но САМИ задания
 * остаются: это существующие задания печати заказов, и терять их историю
 * нельзя. Флорист увидит их в своей вкладке печати и напечатает вручную.
 */
export async function disconnectPrintPoint(
  db: Database,
  actor: AuthenticatedActor,
  pointId: string,
  context: RequestContext,
): Promise<PrintPointView> {
  return db.$transaction(async (tx) => {
    const point = await tx.printPoint.findUnique({ where: { id: pointId }, select: POINT_SELECT });
    if (point === null) {
      throw new AppError('NOT_FOUND', {
        message: 'print point not found',
        publicMessage: 'Точка печати не найдена.',
      });
    }

    const cancelled = await tx.orderPrintJob.updateMany({
      where: { printPointId: pointId, deliveryState: { in: ['QUEUED', 'CLAIMED'] } },
      data: { deliveryState: 'CANCELLED', leaseUntil: null },
    });

    const updated = await tx.printPoint.update({
      where: { id: pointId },
      data: {
        isActive: false,
        agentTokenHash: null,
        pairingCodeHash: null,
        pairingExpiresAt: null,
        testRequestedAt: null,
        testRequestedById: null,
      },
      select: POINT_SELECT,
    });

    // Смены, выбравшие эту точку, теряют выбор: печатать больше некуда,
    // и флорист обязан узнать об этом при следующем «Собран», а не отправить
    // наклейку в никуда.
    await tx.floristShift.updateMany({
      where: { printPointId: pointId, closedAt: null },
      data: { printPointId: null },
    });

    await writeAudit(tx, {
      action: 'PRINT_POINT_DISCONNECTED',
      entityType: 'PrintPoint',
      entityId: pointId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { cancelledDeliveries: cancelled.count },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishPointChange(tx, pointId);
    return toView(updated, 0, new Date());
  });
}

/**
 * Запрос тестового отпечатка.
 *
 * Это ОТМЕТКА, а не задание: второй очереди у нас нет. Агент заберёт её
 * ближайшим опросом и погасит. Повторное нажатие до опроса не копит
 * отпечатки — печатать десять наклеек подряд человек не просил.
 */
export async function requestTestPrint(
  db: Database,
  actor: AuthenticatedActor,
  pointId: string,
  context: RequestContext,
  now = new Date(),
): Promise<PrintPointView> {
  return db.$transaction(async (tx) => {
    const point = await tx.printPoint.findUnique({ where: { id: pointId }, select: POINT_SELECT });
    if (point === null) {
      throw new AppError('NOT_FOUND', {
        message: 'print point not found',
        publicMessage: 'Точка печати не найдена.',
      });
    }
    if (!point.isActive || point.agentTokenHash === null) {
      throw new AppError('CONFLICT', {
        message: 'print point is not connected',
        publicMessage: 'К точке не подключён компьютер: печатать нечем.',
      });
    }

    const updated = await tx.printPoint.update({
      where: { id: pointId },
      data: { testRequestedAt: now, testRequestedById: actor.userId },
      select: POINT_SELECT,
    });

    await writeAudit(tx, {
      action: 'PRINT_POINT_TEST_REQUESTED',
      entityType: 'PrintPoint',
      entityId: pointId,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      source: 'api',
      newValue: { requestedAt: now.toISOString() },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await publishPointChange(tx, pointId);
    const counts = await queuedCounts(tx, [pointId]);
    return toView(updated, counts.get(pointId) ?? 0, now);
  });
}

/** Гасит отметку тестового отпечатка: агент её забрал. */
export async function clearTestRequest(db: Database, pointId: string): Promise<void> {
  await db.printPoint.updateMany({
    where: { id: pointId },
    data: { testRequestedAt: null, testRequestedById: null },
  });
}

export async function publishPointChange(tx: TransactionClient, pointId: string): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'print_point.changed',
    payload: { pointId },
    audienceRoles: [...PRINT_AUDIENCE],
  });
}

/** Отметка агента о том, что он жив. Ошибка, если она есть, прилипает к точке. */
export async function recordHeartbeat(
  db: Database,
  pointId: string,
  input: { error?: string | null } = {},
  now = new Date(),
): Promise<void> {
  const error = safeErrorText(input.error);

  // Ошибка агента — НЕМЕДЛЕННО: и текст, и отметка живости. Её нельзя копить,
  // администратор должен увидеть отказ печати сразу, а не через полминуты.
  if (error !== null) {
    await db.printPoint.update({
      where: { id: pointId },
      data: { lastSeenAt: now, lastErrorAt: now, lastErrorText: error },
    });
    return;
  }

  // Обычная отметка пишется не чаще раза в HEARTBEAT_PERSIST_MS. Условие стоит
  // В САМОМ запросе (updateMany с WHERE по свежести), а не читается заранее:
  // так параллельные опросы одной точки не превращаются в гонку чтения-записи,
  // и в минуту получается всего две-три записи вместо двадцати.
  const staleBefore = new Date(now.getTime() - HEARTBEAT_PERSIST_MS);
  await db.printPoint.updateMany({
    where: {
      id: pointId,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: staleBefore } }],
    },
    data: { lastSeenAt: now },
  });
}

export interface AgentPoint {
  id: string;
  name: string;
  testRequestedAt: Date | null;
}

/**
 * Точка печати по токену агента.
 *
 * Токен сравнивается по хешу: открытого значения на сервере нет вовсе,
 * поэтому украсть его из базы невозможно — там его просто не лежит.
 */
export async function pointByAgentToken(db: Database, token: string): Promise<AgentPoint> {
  const point = await db.printPoint.findUnique({
    where: { agentTokenHash: hashRefreshToken(token) },
    select: { id: true, name: true, isActive: true, testRequestedAt: true },
  });

  if (point === null || !point.isActive) {
    throw new AppError('UNAUTHENTICATED', {
      message: 'unknown agent token',
      publicMessage: 'Точка печати отключена. Подключите заново.',
    });
  }

  return { id: point.id, name: point.name, testRequestedAt: point.testRequestedAt };
}
