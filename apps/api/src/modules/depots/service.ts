/**
 * Склады.
 *
 * Склад — предметная сущность, а не настройка: его координаты участвуют
 * в маршрутах, матрицах и неизменяемой истории планирования, и на него
 * ссылаются уже посчитанные планы.
 *
 * Записи не удаляются НИКОГДА (триггер базы на DELETE): недоступность
 * выражается признаком `isActive`. Удалённый склад оставил бы прежние маршруты
 * и снимки планирования без точки отсчёта.
 *
 * ИНВАРИАНТ: складов по умолчанию не больше одного, и он всегда активен.
 * Держится тремя независимыми средствами, а не одним:
 *
 *   1) уникальный индекс по `defaultKey` — «не более одного»;
 *   2) CHECK `Depot_default_active` — «выключен и по умолчанию» невозможно;
 *   3) выделенная advisory-блокировка на все операции смены — две
 *      одновременные смены не могут оставить систему вовсе без склада
 *      по умолчанию.
 *
 * Блокировка транзакционная: она снимается вместе с транзакцией, поэтому
 * забытый разблокировщик невозможен. Ключ ЧИСЛОВОЙ и выделенный: `hashtext`
 * от строки теоретически совпадает с чужим ключом, а совпадение advisory-ключей
 * означало бы, что две несвязанные операции ждут друг друга без причины.
 */

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit, type AuditAction } from '../audit/service.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { MAX_LAT_MICRO, MAX_LON_MICRO, MICRO } from '../orders/geo.js';
import type { Role } from '@fl/shared';

/**
 * Выделенный числовой ключ advisory-блокировки складов.
 *
 * Продолжает ряд 730_201 (синхронизация) и 730_205 (геокодирование).
 * Один ключ на ВСЕ операции, меняющие состав и признак по умолчанию:
 * создание, смену склада по умолчанию и деактивацию. Разные ключи означали бы,
 * что деактивация и смена умолчания идут одновременно и могут разойтись.
 */
export const DEPOT_LOCK_KEY = 730_206n;

const DEPOT_AUDIENCE: readonly Role[] = ['ADMIN', 'LOGISTICIAN'];

/** Значение признака склада по умолчанию. Закреплено ограничением базы. */
const DEFAULT_KEY = 'default';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

export interface DepotRow {
  id: string;
  name: string;
  address: string;
  /** `null` — точка не определена: адрес есть, координат нет. */
  latMicro: number | null;
  lonMicro: number | null;
  /** `null` — точка ни разу не подтверждалась выбором подсказки. */
  pointConfirmedAt: Date | null;
  isActive: boolean;
  defaultKey: string | null;
  version: number;
}

/**
 * Пригоден ли склад для расчёта.
 *
 * Мало иметь координаты: они должны быть подтверждены выбором адреса
 * из подсказок. Набранные руками числа ничем не связаны с адресом, и опереть
 * на них маршрут значит увезти курьера не туда.
 */
export function hasConfirmedPoint(depot: {
  latMicro: number | null;
  lonMicro: number | null;
  pointConfirmedAt: Date | null;
}): boolean {
  return depot.latMicro !== null && depot.lonMicro !== null && depot.pointConfirmedAt !== null;
}

const depotSelect = {
  id: true,
  name: true,
  address: true,
  latMicro: true,
  lonMicro: true,
  pointConfirmedAt: true,
  isActive: true,
  defaultKey: true,
  version: true,
} as const;

/** Берёт транзакционную блокировку складов. Первый шаг любой смены состава. */
async function lockDepots(tx: TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEPOT_LOCK_KEY}::bigint)`;
}

/** Блокирует строки складов в порядке возрастания UUID. */
export async function lockDepotRows(
  tx: TransactionClient,
  ids: readonly string[],
): Promise<DepotRow[]> {
  if (ids.length === 0) {
    return [];
  }
  const list = Prisma.join([...new Set(ids)].map((id) => Prisma.sql`${id}::uuid`));
  return tx.$queryRaw<DepotRow[]>`
    SELECT "id", "name", "address", "latMicro", "lonMicro", "isActive", "defaultKey", "version"
    FROM "Depot"
    WHERE "id" IN (${list})
    ORDER BY "id"
    FOR UPDATE
  `;
}

async function auditDepot(
  tx: TransactionClient,
  action: AuditAction,
  depotId: string,
  actor: AuthenticatedActor,
  context: RequestContext,
  values: { oldValue?: Record<string, unknown>; newValue?: Record<string, unknown> },
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'Depot',
    entityId: depotId,
    actorUserId: actor.userId,
    actorRoles: actor.roles,
    source: 'api',
    ...(values.oldValue === undefined ? {} : { oldValue: values.oldValue }),
    ...(values.newValue === undefined ? {} : { newValue: values.newValue }),
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

async function publishDepot(tx: TransactionClient, depotId: string): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic: 'depot.changed',
    // Ни названия, ни адреса, ни координат: клиент перезапрашивает список.
    payload: { depotId },
    audienceRoles: [...DEPOT_AUDIENCE],
  });
}

/** Координаты приходят градусами и хранятся микроградусами: одна точность на геомодель. */
/**
 * Точка в микроградусы, либо «не определена».
 *
 * Отсутствие точки — не ноль: склад с координатами 0,0 оказался бы
 * в Гвинейском заливе и молча ломал бы расчёт.
 */
function pointToMicro(point: { lat: number; lon: number } | null): {
  latMicro: number | null;
  lonMicro: number | null;
  pointConfirmedAt: Date | null;
} {
  if (point === null) {
    return { latMicro: null, lonMicro: null, pointConfirmedAt: null };
  }
  const micro = toMicro(point.lat, point.lon);
  return { ...micro, pointConfirmedAt: new Date() };
}

function toMicro(lat: number, lon: number): { latMicro: number; lonMicro: number } {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'depot coordinates are not finite',
      publicMessage: 'Координаты склада указаны неверно.',
    });
  }

  const latMicro = Math.round(lat * MICRO);
  const lonMicro = Math.round(lon * MICRO);

  if (Math.abs(latMicro) > MAX_LAT_MICRO || Math.abs(lonMicro) > MAX_LON_MICRO) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'depot coordinates are out of range',
      publicMessage: 'Координаты склада выходят за пределы допустимых значений.',
    });
  }

  return { latMicro, lonMicro };
}

/**
 * Точка склада, подтверждённая выбором подсказки адреса.
 *
 * Отдельным полем, а не парой чисел рядом с адресом: координаты, набранные
 * руками, ничем не связаны с адресом и молча уводят расчёт не туда. Здесь
 * они приходят ВМЕСТЕ с выбранным адресом и только из подсказок.
 */
export interface DepotPoint {
  lat: number;
  lon: number;
}

export interface CreateDepotInput {
  name: string;
  address: string;
  /** `null` — адрес сохранён, но точка не определена: складом по умолчанию он стать не может. */
  point: DepotPoint | null;
}

/**
 * Создаёт склад.
 *
 * ПЕРВЫЙ склад становится складом по умолчанию В ТОЙ ЖЕ транзакции: система
 * с единственным складом, который не является складом по умолчанию, — это
 * система, где планирование отказывает при полностью настроенных данных.
 * Отдельным шагом это делать нельзя: между шагами приложение может упасть.
 *
 * Все последующие склады создаются обычными: смена умолчания — осознанное
 * отдельное действие.
 */
export async function createDepot(
  db: Database,
  actor: AuthenticatedActor,
  input: CreateDepotInput,
  context: RequestContext,
): Promise<DepotRow> {
  const { latMicro, lonMicro, pointConfirmedAt } = pointToMicro(input.point);

  return db.$transaction(async (tx) => {
    await lockDepots(tx);

    const existing = await tx.depot.count();
    // Складом по умолчанию первый склад становится, только если у него есть
    // подтверждённая точка: иначе расчёт получил бы «основной» склад,
    // на координаты которого нельзя опереться.
    const isFirst = existing === 0 && pointConfirmedAt !== null;

    const created = await tx.depot.create({
      data: {
        name: input.name.trim(),
        address: input.address.trim(),
        latMicro,
        lonMicro,
        pointConfirmedAt,
        isActive: true,
        // Ровно здесь первый склад становится складом по умолчанию.
        ...(isFirst ? { defaultKey: DEFAULT_KEY } : {}),
        createdById: actor.userId,
      },
      select: depotSelect,
    });

    await auditDepot(tx, 'DEPOT_CREATED', created.id, actor, context, {
      newValue: {
        name: created.name,
        latMicro,
        lonMicro,
        isActive: true,
        isDefault: isFirst,
        version: created.version,
      },
    });

    if (isFirst) {
      await auditDepot(tx, 'DEPOT_DEFAULT_CHANGED', created.id, actor, context, {
        oldValue: { previousDefaultDepotId: null },
        newValue: { depotId: created.id, reason: 'FIRST_DEPOT' },
      });
    }

    await publishDepot(tx, created.id);

    return created;
  });
}

export interface UpdateDepotInput {
  name: string;
  address: string;
  point: DepotPoint | null;
  expectedVersion: number;
}

/** Изменяет название, адрес и координаты. Признак по умолчанию здесь не трогается. */
export async function updateDepot(
  db: Database,
  actor: AuthenticatedActor,
  depotId: string,
  input: UpdateDepotInput,
  context: RequestContext,
): Promise<DepotRow> {
  const { latMicro, lonMicro, pointConfirmedAt } = pointToMicro(input.point);

  return db.$transaction(async (tx) => {
    const [current] = await lockDepotRows(tx, [depotId]);
    if (current === undefined) {
      throw new AppError('NOT_FOUND', { message: 'depot not found' });
    }

    const updated = await tx.depot.updateManyAndReturn({
      where: { id: depotId, version: input.expectedVersion },
      data: {
        name: input.name.trim(),
        address: input.address.trim(),
        // Смена адреса без новой подсказки сбрасывает точку: прежние
        // координаты относятся к прежнему адресу и увели бы курьера не туда.
        latMicro,
        lonMicro,
        pointConfirmedAt,
        version: { increment: 1 },
      },
      select: depotSelect,
    });

    const row = updated[0];
    if (row === undefined) {
      throw staleDepot();
    }

    await auditDepot(tx, 'DEPOT_UPDATED', depotId, actor, context, {
      oldValue: {
        name: current.name,
        latMicro: current.latMicro,
        lonMicro: current.lonMicro,
        version: current.version,
      },
      newValue: { name: row.name, latMicro, lonMicro, version: row.version },
    });
    await publishDepot(tx, depotId);

    return row;
  });
}

export interface SetDefaultInput {
  /**
   * Склад, который на глазах у вызывающей стороны был складом по умолчанию.
   *
   * Одной версии мало. Версии разных складов независимы и легко совпадают
   * численно: пока запрос готовился, склад по умолчанию мог смениться
   * на другой, оказавшийся в той же версии, и проверка «версия совпала»
   * пропустила бы смену, которой вызывающая сторона не видела.
   */
  expectedCurrentDefaultId: string | null;
  /** Версия склада, который СЕЙЧАС является складом по умолчанию. */
  expectedCurrentDefaultVersion: number | null;
  /** Версия склада, который станет складом по умолчанию. */
  expectedVersion: number;
}

/**
 * Назначает склад складом по умолчанию.
 *
 * Версии называются ДЛЯ ОБОИХ складов и по отдельности: это разные строки
 * с независимой историей, и одно значение `expectedVersion`, применённое
 * к обеим, совпало бы с действительностью только случайно. Версии обеих строк
 * увеличиваются: обе изменились.
 *
 * Если назначение новой строки не обновило ни одной строки, транзакция обязана
 * завершиться ОШИБКОЙ. Молча продолжить нельзя: снятие прежнего признака
 * уже выполнено, и система осталась бы вовсе без склада по умолчанию —
 * состояние хуже исходного.
 */
export async function setDefaultDepot(
  db: Database,
  actor: AuthenticatedActor,
  depotId: string,
  input: SetDefaultInput,
  context: RequestContext,
): Promise<DepotRow> {
  return db.$transaction(async (tx) => {
    await lockDepots(tx);

    const currentDefault = await tx.depot.findUnique({
      where: { defaultKey: DEFAULT_KEY },
      select: depotSelect,
    });

    if (currentDefault?.id === depotId) {
      // Уже склад по умолчанию: повторное назначение ничего не меняет
      // и не должно ни увеличивать версию, ни писать ложную запись в аудит.
      return currentDefault;
    }

    // Сверяются И тождество, И версия прежнего склада: совпадения одних только
    // номеров версий у разных строк случаются, и на них полагаться нельзя.
    if (
      (currentDefault?.id ?? null) !== input.expectedCurrentDefaultId ||
      (currentDefault?.version ?? null) !== input.expectedCurrentDefaultVersion
    ) {
      throw staleDepot();
    }

    if (currentDefault !== null) {
      const cleared = await tx.depot.updateMany({
        where: { id: currentDefault.id, version: input.expectedCurrentDefaultVersion ?? -1 },
        data: { defaultKey: null, version: { increment: 1 } },
      });
      if (cleared.count === 0) {
        throw staleDepot();
      }
    }

    // Активность и наличие подтверждённой точки проверяются ВНУТРИ условия
    // обновления, а не отдельным чтением: между чтением и записью склад успели
    // бы выключить или сменить ему адрес.
    //
    // Склад без подтверждённой точки складом по умолчанию стать не может:
    // расчёт опёрся бы на координаты, которых нет либо которые никто
    // не связывал с этим адресом. То же требует и CHECK базы.
    const assigned = await tx.depot.updateManyAndReturn({
      where: {
        id: depotId,
        version: input.expectedVersion,
        isActive: true,
        latMicro: { not: null },
        lonMicro: { not: null },
        pointConfirmedAt: { not: null },
      },
      data: { defaultKey: DEFAULT_KEY, version: { increment: 1 } },
      select: depotSelect,
    });

    const row = assigned[0];
    if (row === undefined) {
      // Ноль обновлённых строк завершает транзакцию ошибкой: снятие прежнего
      // признака откатывается вместе с ней, и склад по умолчанию сохраняется.
      throw new AppError('CONFLICT', {
        message: 'default depot assignment updated no rows',
        publicMessage:
          'Не удалось назначить склад основным: он выключен, изменён другим ' +
          'пользователем либо у него не определена точка. Выберите адрес ' +
          'из подсказок повторно.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }

    await auditDepot(tx, 'DEPOT_DEFAULT_CHANGED', depotId, actor, context, {
      oldValue: { previousDefaultDepotId: currentDefault?.id ?? null },
      newValue: { depotId, version: row.version },
    });
    await publishDepot(tx, depotId);

    return row;
  });
}

export interface SetActiveInput {
  isActive: boolean;
  expectedVersion: number;
}

/**
 * Включает и выключает склад.
 *
 * Склад по умолчанию выключить нельзя: сначала назначьте складом по умолчанию
 * другой. Ограничение базы `Depot_default_active` не даст выполнить это и мимо
 * сервиса, но отдельная проверка нужна ради понятного сообщения — исключение
 * PostgreSQL логисту ничего не объясняет.
 */
export async function setDepotActive(
  db: Database,
  actor: AuthenticatedActor,
  depotId: string,
  input: SetActiveInput,
  context: RequestContext,
): Promise<DepotRow> {
  return db.$transaction(async (tx) => {
    await lockDepots(tx);

    const [current] = await lockDepotRows(tx, [depotId]);
    if (current === undefined) {
      throw new AppError('NOT_FOUND', { message: 'depot not found' });
    }

    if (!input.isActive && current.defaultKey !== null) {
      throw new AppError('CONFLICT', {
        message: 'default depot cannot be deactivated',
        publicMessage:
          'Это склад по умолчанию. Сначала назначьте складом по умолчанию другой склад.',
        conflict: { kind: 'DEPOT_DEFAULT_REQUIRED' },
      });
    }

    if (current.isActive === input.isActive) {
      return current;
    }

    const updated = await tx.depot.updateManyAndReturn({
      where: { id: depotId, version: input.expectedVersion },
      data: { isActive: input.isActive, version: { increment: 1 } },
      select: depotSelect,
    });

    const row = updated[0];
    if (row === undefined) {
      throw staleDepot();
    }

    await auditDepot(
      tx,
      input.isActive ? 'DEPOT_ACTIVATED' : 'DEPOT_DEACTIVATED',
      depotId,
      actor,
      context,
      {
        oldValue: { isActive: current.isActive, version: current.version },
        newValue: { isActive: row.isActive, version: row.version },
      },
    );
    await publishDepot(tx, depotId);

    return row;
  });
}

function staleDepot(): AppError {
  return new AppError('CONFLICT', {
    message: 'stale depot version',
    publicMessage: 'Склад изменён другим пользователем. Обновите страницу и повторите.',
    conflict: { kind: 'STALE_VERSION' },
  });
}

/** Склад по умолчанию. `null` — администратор ещё не создал ни одного склада. */
export async function findDefaultDepot(
  client: Database | TransactionClient,
): Promise<DepotRow | null> {
  return client.depot.findUnique({ where: { defaultKey: DEFAULT_KEY }, select: depotSelect });
}

/**
 * Склад по умолчанию с подтверждённой точкой.
 *
 * Две разные причины отказа названы по отдельности: «основной склад не выбран»
 * и «у склада не определены координаты» требуют разных действий человека,
 * и общее «расчёт не удался» не подсказывает ни одного из них.
 */
export async function requireDefaultDepot(
  client: Database | TransactionClient,
): Promise<DepotRow & { latMicro: number; lonMicro: number }> {
  const depot = await findDefaultDepot(client);
  if (depot === null) {
    throw new AppError('CONFLICT', {
      message: 'default depot is not configured',
      publicMessage: 'Не выбран основной склад. Выберите его в настройках планирования.',
      conflict: { kind: 'DEPOT_NOT_CONFIGURED' },
    });
  }

  if (!hasConfirmedPoint(depot) || depot.latMicro === null || depot.lonMicro === null) {
    throw new AppError('CONFLICT', {
      message: 'default depot has no confirmed point',
      publicMessage:
        'У склада не определены координаты. Выберите адрес склада из подсказок повторно.',
      conflict: { kind: 'DEPOT_POINT_MISSING' },
    });
  }

  return { ...depot, latMicro: depot.latMicro, lonMicro: depot.lonMicro };
}

export async function listDepots(db: Database): Promise<DepotRow[]> {
  return db.depot.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: depotSelect,
  });
}
