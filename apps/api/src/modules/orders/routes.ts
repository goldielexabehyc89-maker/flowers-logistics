/**
 * Чтение импортированных заказов.
 *
 * Доступ только у `ADMIN` и `LOGISTICIAN`: глобальный список заказов курьеру
 * не нужен — ему видны лишь собственные доставки, и это появится вместе
 * с маршрутами. Замороженные пользователи отсекаются общей авторизацией.
 *
 * Деньги отдаются десятичными строками: `bigint` не сериализуется в JSON,
 * а `number` теряет точность на больших суммах.
 */

import { moscowCalendarDate } from '@fl/shared';
import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import {
  fromDateColumn,
  isCalendarDate,
  toDateColumn,
} from '../integrations/moysklad/delivery-date.js';
import { toDecimalString } from '../integrations/moysklad/money.js';
import { MAX_MINUTE, MIN_MINUTE, setManualInterval } from './service.js';
import { fromMicro, setManualPoint } from './geo.js';
import {
  ADDRESS_ROLES,
  clearLocalAddress,
  listAddressHistory,
  MAX_ADDRESS_LENGTH,
  resolveAddressConflict,
  setLocalAddress,
} from './address-service.js';
import { isDadataAllowed } from './geocoding/enabled.js';
import { testSuggestFetch } from '../integrations/dadata/test-suggest.js';
import { setSuggestionsStatus } from '../integrations/dadata/status.js';
import { dealsCount, dealsIds, dealsWithoutPointCount, type DealsScope } from './deals-scope.js';
import { addressState } from './address.js';
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  suggestAddresses,
  type AddressSuggestion,
} from '../integrations/dadata/suggest.js';
import { BASEMAP_PREFIX } from '../geo/basemap/routes.js';
import type { BasemapState } from '../geo/basemap/manifest.js';
import { CURRENT_TRAFFIC_MODE } from '../geo/matrix/service.js';
import { isRoutingVerified } from '../geo/routing-status.js';

const ORDER_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
const MAX_LIMIT = 100;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается дата в формате ГГГГ-ММ-ДД')
  .refine(isCalendarDate, 'Ожидается существующая дата');

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Календарная дата `YYYY-MM-DD`. По умолчанию — текущий день Москвы. */
  deliveryDate: dateSchema.optional(),
  needsAttention: z.enum(['true', 'false']).optional(),
  inScope: z.enum(['true', 'false']).optional(),
  /** Поиск по номеру, адресу и получателю. Пустая строка ищет всё. */
  search: z.string().trim().max(200).optional(),
  /**
   * Только заказы, пригодные для распределения на выбранный день.
   *
   * Экран маршрутизации не должен выгружать все заказы и вычитать из них состав
   * маршрутов на клиенте: при сотнях заказов это лишний трафик и гарантированное
   * расхождение с сервером в момент чужой правки.
   */
  unassigned: z.enum(['true', 'false']).optional(),
  /** Состояние георазрешения: логисту нужно видеть, чему ещё не поставлена точка. */
  geoState: z.enum(['UNRESOLVED', 'PENDING', 'RESOLVED', 'NEEDS_REVIEW', 'FAILED']).optional(),
});

const mapQuerySchema = z.object({
  deliveryDate: dateSchema,
});

const geoPointSchema = z.object({
  /** Десятичная строка или число: карта отдаёт число, скрипты — строку. */
  lat: z.union([z.string(), z.number()]),
  lon: z.union([z.string(), z.number()]),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().min(0),
});

const setIntervalBodySchema = z.object({
  startMinute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE),
  endMinute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE),
  version: z.number().int().min(0),
});

/**
 * Запрос «Сделок».
 *
 * День обязателен по смыслу, но по умолчанию берётся московский «сегодня»:
 * логист открывает экран и сразу видит рабочий день, а не пустую форму.
 * Слишком большой `limit` отклоняется, а не урезается молча — клиент,
 * попросивший больше, должен узнать об этом, а не считать, что получил всё.
 */
const dealsQuerySchema = z.object({
  deliveryDate: dateSchema.optional(),
  search: z.string().trim().max(200).optional(),
  fromMinute: z.coerce.number().int().min(0).max(1440).optional(),
  toMinute: z.coerce.number().int().min(0).max(1440).optional(),
  includeDrafts: z.enum(['true', 'false']).optional(),
  group: z.enum(['ROUTABLE', 'ATTENTION', 'ALL']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const suggestQuerySchema = z.object({
  query: z.string().min(MIN_QUERY_LENGTH).max(MAX_QUERY_LENGTH),
});

/** Точка принимается только вместе с адресом и только целыми микроградусами. */
const localAddressSchema = z.object({
  address: z.string().trim().min(1).max(MAX_ADDRESS_LENGTH),
  point: z
    .object({
      latMicro: z.number().int().min(-90_000_000).max(90_000_000),
      lonMicro: z.number().int().min(-180_000_000).max(180_000_000),
    })
    .nullable()
    .optional(),
});

const conflictDecisionSchema = z.object({
  decision: z.enum(['KEEP_LOCAL', 'USE_SOURCE']),
});

const idParamSchema = z.object({
  id: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id'),
});

interface OrdersDeps {
  db: Database;
  config: AppConfig;
  /** Проверенное состояние собственной подложки. Пусто — её просто нет. */
  basemap?: () => BasemapState;
  /**
   * Подменяемый HTTP для подсказок адреса.
   *
   * Существует только ради проверок: настоящих обращений к DaData в тестах
   * не бывает, а разрешать их «случайно» из-за забытой заглушки нельзя.
   */
  suggestFetch?: typeof globalThis.fetch;
}

/**
 * Текущий календарный день Москвы.
 *
 * Имя и внешний контракт сохранены: на него ссылаются маршруты и сценарии
 * наполнения. Собственная арифметика «плюс три часа» убрана — день считает
 * общий модуль времени, тот же самый, что и в браузере.
 */
export function moscowToday(now: Date): string {
  return moscowCalendarDate(now);
}

function toListItem(order: {
  id: string;
  externalName: string;
  deliveryDate: Date | null;
  deliveryDateRaw: string | null;
  intervalRaw: string | null;
  intervalKind: string;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  address: string | null;
  localAddress: string | null;
  addressConflict: boolean;
  recipient: string | null;
  comment: string | null;
  externalStateId: string | null;
  externalStateName: string | null;
  externalStateType: string | null;
  sumMinor: bigint;
  payedSumMinor: bigint;
  cashCollectable: boolean;
  cashToCollectMinor: bigint;
  cashAnomaly: boolean;
  inScope: boolean;
  scopeExitReason: string | null;
  sourceMissing: boolean;
  needsAttention: boolean;
  attentionReasons: string[];
  geoState: string;
  geoSource: string | null;
  geoPrecision: string | null;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  geoReviewReason: string | null;
  version: number;
  updatedAt: Date;
}) {
  return {
    id: order.id,
    number: order.externalName,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    deliveryDateRaw: order.deliveryDateRaw,
    interval: {
      // Исходный текст источника отдаётся всегда: логист должен видеть, что именно
      // написано в МоемСкладе, даже когда интервал исправлен вручную.
      raw: order.intervalRaw,
      kind: order.intervalKind,
      startMinute: order.intervalStartMinute,
      endMinute: order.intervalEndMinute,
      manualStartMinute: order.manualIntervalStartMinute,
      manualEndMinute: order.manualIntervalEndMinute,
    },
    // Рабочий адрес — тот, по которому поедет курьер: исправленный, если он
    // есть, иначе адрес источника. Оба значения отдаются рядом: решение
    // о правке принимается именно их сравнением.
    address: addressState(order).effective,
    sourceAddress: addressState(order).source,
    addressCorrected: addressState(order).corrected,
    addressConflict: addressState(order).conflict,
    recipient: order.recipient,
    comment: order.comment,
    externalState: {
      id: order.externalStateId,
      name: order.externalStateName,
      stateType: order.externalStateType,
    },
    money: {
      sum: toDecimalString(order.sumMinor),
      payed: toDecimalString(order.payedSumMinor),
      cashToCollect: toDecimalString(order.cashToCollectMinor),
      cashCollectable: order.cashCollectable,
      anomaly: order.cashAnomaly,
    },
    scope: {
      inScope: order.inScope,
      exitReason: order.scopeExitReason,
      sourceMissing: order.sourceMissing,
    },
    needsAttention: order.needsAttention,
    attentionReasons: order.attentionReasons,
    // Координаты уходят десятичными строками: целые микроградусы наружу
    // не показываются, а число с плавающей точкой в контракте не появляется.
    geo: {
      state: order.geoState,
      source: order.geoSource,
      precision: order.geoPrecision,
      reviewReason: order.geoReviewReason,
      lat: order.geoLatMicro === null ? null : fromMicro(order.geoLatMicro),
      lon: order.geoLonMicro === null ? null : fromMicro(order.geoLonMicro),
    },
    // Версия нужна интерфейсу: без неё ручное исправление не смогло бы
    // сослаться на конкретное состояние заказа.
    version: order.version,
    updatedAt: order.updatedAt.toISOString(),
  };
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
  };
}

/** Отбор «Сделок» из проверенного запроса. День по умолчанию — московский сегодня. */
function scopeOf(query: {
  deliveryDate?: string | undefined;
  search?: string | undefined;
  fromMinute?: number | undefined;
  toMinute?: number | undefined;
  includeDrafts?: 'true' | 'false' | undefined;
  group?: 'ROUTABLE' | 'ATTENTION' | 'ALL' | undefined;
}): DealsScope {
  return {
    deliveryDate: query.deliveryDate ?? moscowCalendarDate(new Date()),
    search: query.search ?? null,
    fromMinute: query.fromMinute ?? null,
    toMinute: query.toMinute ?? null,
    includeDrafts: query.includeDrafts === 'true',
    group: query.group ?? 'ALL',
  };
}

/**
 * Карточки сделок в порядке переданных идентификаторов.
 *
 * Порядок задаёт канонический отбор, а не база: `findMany` вернул бы строки
 * в своём порядке, и страницы разошлись бы со списком.
 */
async function dealCards(db: Database, ids: string[]) {
  if (ids.length === 0) {
    return [];
  }

  const rows = await db.deliveryOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      externalName: true,
      address: true,
      localAddress: true,
      addressConflict: true,
      recipient: true,
      comment: true,
      deliveryDate: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      needsAttention: true,
      attentionReasons: true,
      geoState: true,
      version: true,
      intervalRaw: true,
      /*
       * Два источника признака «Собран».
       *
       * Флорист завершил сборку либо заказ лежит в складской ячейке. Логисту
       * важен сам факт готовности, а не то, каким путём он наступил: на карте
       * это галочка, в списке — текст. Активное размещение — строка
       * с пустым `releasedAt`; второго такого места не существует физически.
       */
      fulfillmentProcessState: true,
      placements: {
        where: { releasedAt: null },
        select: { id: true },
        take: 1,
      },
      routeOrders: {
        where: { removedAt: null },
        select: { routeId: true, route: { select: { number: true, state: true } } },
        take: 1,
      },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) {
      return [];
    }
    const participation = row.routeOrders[0];
    const address = addressState(row);
    return [
      {
        id: row.id,
        number: row.externalName,
        // Наружу идёт эффективный адрес и признак правки: исходный нужен
        // только в карточке правки, а не в каждом элементе списка.
        address: address.effective,
        sourceAddress: address.source,
        addressCorrected: address.corrected,
        addressConflict: address.conflict,
        recipient: row.recipient,
        // Пустой комментарий не занимает место: клиент не должен рисовать
        // строку-заглушку там, где текста нет.
        comment: row.comment === null || row.comment.trim() === '' ? null : row.comment,
        deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
        startMinute: row.manualIntervalStartMinute ?? row.intervalStartMinute,
        endMinute: row.manualIntervalEndMinute ?? row.intervalEndMinute,
        // Исходный интервал показывается рядом с рабочим: решение о правке
        // принимается именно их сравнением.
        sourceStartMinute: row.intervalStartMinute,
        sourceEndMinute: row.intervalEndMinute,
        sourceIntervalRaw: row.intervalRaw,
        intervalCorrected: row.manualIntervalStartMinute !== null,
        // Версия нужна ручной правке интервала: чужое изменение обязано
        // получить честный отказ, а не молча перезаписаться.
        version: row.version,
        needsAttention: row.needsAttention,
        attentionReasons: row.attentionReasons,
        geoState: row.geoState,
        // Заказ черновика показывается только для чтения и ведёт в свой черновик.
        draftRouteId: participation?.routeId ?? null,
        draftRouteNumber: participation?.route.number ?? null,
        selectable:
          !row.needsAttention && row.geoState === 'RESOLVED' && participation === undefined,
        // Готов к отправке: собран флористом ЛИБО уже размещён на складе.
        // Логисту важен факт готовности, а не путь, которым он наступил.
        assembled: row.fulfillmentProcessState === 'ASSEMBLED' || row.placements.length > 0,
      },
    ];
  });
}

export async function registerOrderRoutes(app: AppServer, deps: OrdersDeps): Promise<void> {
  app.get('/api/orders', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = listQuerySchema.parse(request.query);

    const unassignedOnly = query.unassigned === 'true';

    // Несовместимые параметры отклоняются, а не «выигрывает последний»: запрос
    // «нераспределённые, но вне нашей доставки» бессмыслен, и молча подменять
    // его смысл опаснее, чем отказать.
    if (unassignedOnly && query.inScope === 'false') {
      throw new AppError('VALIDATION_FAILED', {
        message: 'unassigned=true is incompatible with inScope=false',
        publicMessage: 'Нераспределённые заказы существуют только внутри нашей доставки.',
      });
    }

    // Выборка для распределения всегда идёт по заказам нашей области.
    const inScope =
      unassignedOnly || (query.inScope === undefined ? true : query.inScope === 'true');
    const where: Record<string, unknown> = { inScope };

    if (query.needsAttention !== undefined) {
      where['needsAttention'] = query.needsAttention === 'true';
    }

    // Условия собираются в AND: у поиска и у дня свои наборы OR, и записать их
    // в одно поле `OR` нельзя — второй набор молча вытеснил бы первый.
    const conditions: Record<string, unknown>[] = [];
    const searching = query.search !== undefined && query.search !== '';

    if (searching) {
      // Поиск идёт по тем полям, которые логист реально помнит: номер заказа,
      // адрес и получатель. Регистр не важен — номер часто набирают латиницей
      // и в нижнем регистре.
      conditions.push({
        OR: [
          { externalName: { contains: query.search, mode: 'insensitive' } },
          { address: { contains: query.search, mode: 'insensitive' } },
          { recipient: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    // Заказ без распознанной даты виден при ЛЮБОМ выбранном дне — и при дне
    // по умолчанию, и при явно указанном. Иначе он исчезал бы из «Требует
    // внимания» именно тогда, когда им нужно заняться, а даты у него нет
    // ровно потому, что с ним что-то не так.
    //
    // Исключение — выборка для распределения: заказ без даты положить в маршрут
    // нельзя, и на экране маршрутизации он был бы ложным обещанием. Он остаётся
    // в «Сделках → Требуют внимания», где им и занимаются.
    // День у выборки для распределения всегда ровно один: явный либо текущий
    // московский. Поиск его не отменяет — иначе в маршрут одного дня попали бы
    // заказы соседнего, и правило одной даты нарушилось бы ещё до сервера.
    const day = unassignedOnly
      ? (query.deliveryDate ?? moscowToday(new Date()))
      : (query.deliveryDate ?? (searching || !inScope ? null : moscowToday(new Date())));

    if (day !== null) {
      conditions.push(
        unassignedOnly
          ? { deliveryDate: toDateColumn(day) }
          : { OR: [{ deliveryDate: toDateColumn(day) }, { deliveryDate: null }] },
      );
    }

    if (query.geoState !== undefined) {
      where['geoState'] = query.geoState;
    }

    if (unassignedOnly) {
      // Пригодность считает сервер: клиент не знает ни о пропавших заказах,
      // ни о чужих активных маршрутах, и его версия «свободного» заказа
      // устаревала бы к моменту нажатия кнопки.
      conditions.push({ sourceMissing: false, sourceArchived: false, deliveryDate: { not: null } });
      conditions.push({ routeOrders: { none: { removedAt: null } } });
    }

    if (conditions.length > 0) {
      where['AND'] = conditions;
    }

    const [rows, total] = await Promise.all([
      deps.db.deliveryOrder.findMany({
        where,
        // Сначала требующие внимания, затем по времени интервала, затем стабильный
        // дополнительный порядок — иначе одинаковые заказы прыгали бы между страницами.
        orderBy: [
          { needsAttention: 'desc' },
          { deliveryDate: 'asc' },
          { intervalStartMinute: 'asc' },
          { externalName: 'asc' },
          { id: 'asc' },
        ],
        take: query.limit,
        skip: query.offset,
      }),
      deps.db.deliveryOrder.count({ where }),
    ]);

    return { items: rows.map(toListItem), total, limit: query.limit, offset: query.offset };
  });

  app.get('/api/orders/:id', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const order = await deps.db.deliveryOrder.findUnique({ where: { id } });
    if (order === null) {
      throw new AppError('NOT_FOUND', { message: 'order not found' });
    }

    // Снимок ревизии наружу не отдаётся: он дублировал бы персональные данные
    // и раскрывал внутренний формат. Клиенту нужны факт и перечень полей.
    const [revisions, manualChanges] = await Promise.all([
      deps.db.deliveryOrderRevision.findMany({
        where: { orderId: id },
        // Порядок доопределён идентификатором: одинаковые миллисекунды реальны
        // при пакетной обработке, и без этого «последняя» версия прыгала бы.
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { receivedAt: true, externalUpdated: true, reason: true, changedFields: true },
      }),
      // Ручные исправления живут в аудите, а не в ревизиях: ревизия — это версия
      // источника, а интервал задаём мы сами.
      deps.db.auditLog.findMany({
        where: { entityType: 'DeliveryOrder', entityId: id, action: 'ORDER_INTERVAL_SET' },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: { occurredAt: true, actorUserId: true, newValue: true },
      }),
    ]);

    return {
      order: toListItem(order),
      revisions: revisions.map((revision) => ({
        receivedAt: revision.receivedAt.toISOString(),
        externalUpdated: revision.externalUpdated.toISOString(),
        reason: revision.reason,
        changedFields: revision.changedFields,
      })),
      manualIntervalChanges: manualChanges.map((entry) => {
        const value = (entry.newValue ?? {}) as { startMinute?: number; endMinute?: number };
        return {
          occurredAt: entry.occurredAt.toISOString(),
          actorUserId: entry.actorUserId,
          startMinute: value.startMinute ?? null,
          endMinute: value.endMinute ?? null,
        };
      }),
    };
  });

  /**
   * Точки заказов выбранного дня для карты.
   *
   * Отдаются только заказы с пригодной точкой: рисовать маркер там, где координата
   * не подтверждена, значит показывать выдуманное место. Заказы без точки остаются
   * в обычном списке с понятной причиной — из работы они не исчезают.
   */
  app.get('/api/orders/map', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = mapQuerySchema.parse(request.query);

    const rows = await deps.db.deliveryOrder.findMany({
      where: {
        inScope: true,
        // Исчезнувший или архивированный в источнике заказ мы не везём, и точка
        // на карте выглядела бы как обычная работа. Правило то же, что и в выборке
        // для распределения: карта и список маршрутизации обязаны совпадать.
        sourceArchived: false,
        sourceMissing: false,
        deliveryDate: toDateColumn(query.deliveryDate),
        geoState: 'RESOLVED',
      },
      orderBy: [{ externalName: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        externalName: true,
        geoLatMicro: true,
        geoLonMicro: true,
        geoPrecision: true,
        needsAttention: true,
        // Интервал и адрес нужны отметке карты: над кружком стоит время,
        // а в подсказке — номер и адрес. Это те же поля, что и в «Сделках»,
        // поэтому обе карты говорят об одном заказе одно и то же.
        intervalStartMinute: true,
        intervalEndMinute: true,
        manualIntervalStartMinute: true,
        manualIntervalEndMinute: true,
        address: true,
        localAddress: true,
        routeOrders: {
          where: { removedAt: null },
          select: { position: true, route: { select: { id: true, number: true, state: true } } },
        },
      },
    });

    return {
      deliveryDate: query.deliveryDate,
      points: rows.map((order) => {
        const participation = order.routeOrders[0];
        return {
          orderId: order.id,
          number: order.externalName,
          lat: order.geoLatMicro === null ? null : fromMicro(order.geoLatMicro),
          lon: order.geoLonMicro === null ? null : fromMicro(order.geoLonMicro),
          precision: order.geoPrecision,
          needsAttention: order.needsAttention,
          startMinute: order.manualIntervalStartMinute ?? order.intervalStartMinute,
          endMinute: order.manualIntervalEndMinute ?? order.intervalEndMinute,
          // Рабочий адрес: по нему поедет курьер.
          address: order.localAddress ?? order.address,
          // Разные визуальные состояния берутся из факта участия, а не угадываются.
          assigned: participation !== undefined,
          routeId: participation?.route.id ?? null,
          routeNumber: participation?.route.number ?? null,
          position: participation?.position ?? null,
        };
      }),
    };
  });

  /** Ручная установка точки логистом. */
  app.put('/api/orders/:id/geo-point', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = geoPointSchema.parse(request.body);

    const userAgent = request.headers['user-agent'];
    return setManualPoint(deps, actor, id, body, {
      ip: request.ip,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
    });
  });

  /** История геоданных заказа. Адреса и сырых ответов провайдеров здесь нет. */
  app.get('/api/orders/:id/geo-history', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);

    const entries = await deps.db.orderGeoHistory.findMany({
      where: { orderId: id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        occurredAt: true,
        kind: true,
        state: true,
        source: true,
        precision: true,
        latMicro: true,
        lonMicro: true,
        previousLatMicro: true,
        previousLonMicro: true,
        reviewReason: true,
        reason: true,
        actorUserId: true,
      },
    });

    return {
      items: entries.map((entry) => ({
        occurredAt: entry.occurredAt.toISOString(),
        kind: entry.kind,
        state: entry.state,
        source: entry.source,
        precision: entry.precision,
        lat: entry.latMicro === null ? null : fromMicro(entry.latMicro),
        lon: entry.lonMicro === null ? null : fromMicro(entry.lonMicro),
        previousLat: entry.previousLatMicro === null ? null : fromMicro(entry.previousLatMicro),
        previousLon: entry.previousLonMicro === null ? null : fromMicro(entry.previousLonMicro),
        reviewReason: entry.reviewReason,
        reason: entry.reason,
        actorUserId: entry.actorUserId,
      })),
    };
  });

  /**
   * Конфигурация карты.
   *
   * Секретов здесь нет и быть не может: значение целиком уходит в браузер.
   * Адрес маршрутизатора сюда не попадает никогда — он известен только серверу.
   *
   * Собственная подложка предпочтительнее внешнего адреса: если каталог
   * артефактов проверен, стиль отдаётся с нашего origin. Непроверенная
   * подложка — это честное «карта не настроена», а не повод молча пойти
   * на чужой публичный сервер.
   */
  app.get('/api/map/config', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);

    const basemap = deps.basemap?.() ?? { ok: false as const, problem: 'NOT_CONFIGURED' as const };

    // Расчёт доступен только после подтверждения графа, а не при одном лишь
    // наличии адреса сервиса: обещать автоматический расчёт, который откажет
    // на первом же обращении, — это дезинформация, а не оптимизм.
    const routingAvailable =
      deps.config.VALHALLA_URL !== undefined && (await isRoutingVerified(deps.db));

    if (basemap.ok) {
      return {
        configured: true,
        source: 'SELF_HOSTED',
        styleUrl: `${BASEMAP_PREFIX}/${basemap.manifest.style}`,
        attribution: basemap.manifest.attribution,
        revision: basemap.manifest.revision,
        problem: null,
        // Живых данных о дорожной обстановке в собственном стеке нет.
        // Интерфейс обязан сказать это прямо, а не намекать точностью цифр.
        trafficMode: CURRENT_TRAFFIC_MODE,
        routingAvailable,
      };
    }

    // Заранее заданный внешний адрес стиля допустим ТОЛЬКО в локальной разработке.
    //
    // На staging и production подложка своя, и подмена её чужим сервером при
    // неисправном наборе — это ровно тот молчаливый внешний запрос, который
    // запрещён: адреса доставок ушли бы к постороннему, а карта работала бы,
    // пока работает он.
    const styleUrl = deps.config.isLocal ? deps.config.MAP_STYLE_URL : undefined;
    const configured = styleUrl !== undefined && styleUrl !== '';

    return {
      configured,
      source: configured ? 'EXTERNAL_STYLE' : 'NONE',
      styleUrl: styleUrl ?? null,
      attribution: configured ? (deps.config.MAP_ATTRIBUTION ?? null) : null,
      revision: null,
      // Причина отказа технической подробности не раскрывает: только вид.
      problem: configured ? null : basemap.problem,
      trafficMode: CURRENT_TRAFFIC_MODE,
      routingAvailable,
    };
  });

  /**
   * Ручное локальное исправление интервала.
   *
   * PUT, а не PATCH: значение задаётся целиком и повторное исправление заменяет
   * предыдущее. Дата, адрес, получатель и комментарий не редактируются вовсе —
   * они принадлежат МоемуСкладу.
   */
  app.put('/api/orders/:id/interval', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ORDER_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = setIntervalBodySchema.parse(request.body);

    const userAgent = request.headers['user-agent'];
    return setManualInterval(
      deps,
      actor,
      { orderId: id, ...body },
      {
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
      },
    );
  });

  // --- Локальный адрес логиста -------------------------------------------

  /**
   * Подсказки адреса.
   *
   * Ключ и адрес DaData остаются на сервере: браузер обращается только сюда
   * и получает готовые стандартизованные варианты. Сырой ответ провайдера
   * наружу не выходит ни в каком виде.
   */
  app.get('/api/orders/address-suggestions', async (request) => {
    await authenticateWithRoles(request, deps, ADDRESS_ROLES);
    const { query } = suggestQuerySchema.parse(request.query);

    // Окружение решает раньше сети: там, где живой DaData не разрешён,
    // запрос не отправляется вовсе, а экран продолжает работать по базе.
    // Подменённый HTTP заменяет провайдера, но не контракт: дальше работает
    // тот же разбор ответа и те же правила точности.
    const testFetch = deps.config.DADATA_TEST_SUGGESTIONS ? testSuggestFetch() : null;

    if (testFetch === null && !isDadataAllowed(deps.config)) {
      // Отчётный статус обязан совпадать с фактом: подсказок здесь нет.
      await setSuggestionsStatus(deps.db, 'NOT_CONFIGURED', {
        reason: 'no-key-or-environment',
      });
      return { suggestions: [] as AddressSuggestion[], available: false };
    }

    let suggestions: AddressSuggestion[];
    try {
      suggestions = await suggestAddresses(
        {
          credentials: {
            // Подменённому HTTP ключ не нужен и не передаётся: наружу
            // не уходит ни одного запроса.
            apiKey: testFetch === null ? (deps.config.DADATA_API_KEY ?? null) : 'test-only',
          },
          ...(testFetch !== null
            ? { fetch: testFetch }
            : deps.suggestFetch === undefined
              ? {}
              : { fetch: deps.suggestFetch }),
        },
        query,
      );
    } catch (error: unknown) {
      /*
       * Отказ провайдера виден дежурному сразу.
       *
       * Наружу уходит только код: ни запроса, ни ответа, ни ключа. Само
       * обращение при этом отказывает как прежде — статус не подменяет ошибку.
       */
      await setSuggestionsStatus(deps.db, 'ERROR', { reason: 'provider-failed' });
      throw error;
    }

    // Успешный ответ — единственное настоящее доказательство работоспособности.
    await setSuggestionsStatus(deps.db, 'OK', {
      reason: 'suggestions-served',
      // Число вариантов, а не сами варианты: адресов здесь быть не может.
      returned: suggestions.length,
    });

    return { suggestions, available: true };
  });

  /** Сохранить локальный адрес. Точка принимается только из точной подсказки. */
  app.put('/api/orders/:id/address', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADDRESS_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = localAddressSchema.parse(request.body);

    return setLocalAddress(
      deps,
      actor,
      id,
      { address: body.address, point: body.point ?? null },
      contextOf(request),
    );
  });

  /**
   * Снять локальную правку: рабочим снова становится адрес МоегоСклада.
   *
   * Метод `POST`, а не `DELETE`: в этом приложении `DELETE`-маршрутов нет
   * вовсе — ничего не удаляется, и снятие правки тоже лишь добавляет запись
   * в историю.
   */
  app.post('/api/orders/:id/address/clear', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADDRESS_ROLES);
    const { id } = idParamSchema.parse(request.params);

    return clearLocalAddress(deps, actor, id, contextOf(request));
  });

  /** Решение по расхождению адресов: оставить локальный либо принять источник. */
  app.post('/api/orders/:id/address/resolve-conflict', async (request) => {
    const actor = await authenticateWithRoles(request, deps, ADDRESS_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = conflictDecisionSchema.parse(request.body);

    return resolveAddressConflict(deps, actor, id, body.decision, contextOf(request));
  });

  /**
   * Полная история адреса.
   *
   * Здесь персональные данные выдаются целиком, поэтому доступ закрыт ролями
   * на входе: это профильный административный просмотр, а не часть списка.
   */
  app.get('/api/orders/:id/address-history', async (request) => {
    await authenticateWithRoles(request, deps, ADDRESS_ROLES);
    const { id } = idParamSchema.parse(request.params);

    return { items: await listAddressHistory(deps, id) };
  });

  // --- Сделки: один отбор для списка, карты и «выбрать все» ---------------

  /** Рабочий список выбранного московского дня. */
  app.get('/api/deals', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = dealsQuerySchema.parse(request.query);
    const scope = scopeOf(query);

    const [ids, total, withoutPoint] = await Promise.all([
      dealsIds(deps.db, scope, { limit: query.limit, offset: query.offset }),
      dealsCount(deps.db, scope),
      dealsWithoutPointCount(deps.db, scope),
    ]);

    return {
      items: await dealCards(deps.db, ids),
      total,
      // Счётчик называет и общее число, и число заказов без координат:
      // разрыв между списком и картой обязан быть объяснён числом.
      withoutPoint,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + ids.length < total,
      deliveryDate: scope.deliveryDate,
    };
  });

  /**
   * Точки того же множества.
   *
   * На карту попадают только подтверждённые координаты: догадка по строке
   * адреса выглядела бы как настоящая точка и отправила бы курьера не туда.
   */
  app.get('/api/deals/map', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = dealsQuerySchema.parse(request.query);
    const scope = scopeOf(query);
    const ids = await dealsIds(deps.db, scope);

    /*
     * Заказ «Требует внимания» на карту не попадает вовсе.
     *
     * Маркер у заказа с нераспознанным адресом или интервалом выглядел бы
     * готовым к маршрутизации, хотя везти его нельзя. Такой заказ виден
     * в списке, выделен и назван причиной — там его и исправляют.
     */
    const rows = await deps.db.deliveryOrder.findMany({
      where: { id: { in: ids }, geoState: 'RESOLVED', needsAttention: false },
      select: {
        id: true,
        externalName: true,
        address: true,
        localAddress: true,
        geoLatMicro: true,
        geoLonMicro: true,
        intervalStartMinute: true,
        intervalEndMinute: true,
        manualIntervalStartMinute: true,
        manualIntervalEndMinute: true,
        fulfillmentProcessState: true,
        placements: { where: { releasedAt: null }, select: { id: true }, take: 1 },
        routeOrders: { where: { removedAt: null }, select: { routeId: true }, take: 1 },
      },
    });

    return {
      points: rows.map((row) => ({
        orderId: row.id,
        number: row.externalName,
        // Адрес нужен подсказке при наведении: без него маркер не опознать.
        address: row.localAddress ?? row.address,
        lat: fromMicro(row.geoLatMicro ?? 0),
        lon: fromMicro(row.geoLonMicro ?? 0),
        startMinute: row.manualIntervalStartMinute ?? row.intervalStartMinute,
        endMinute: row.manualIntervalEndMinute ?? row.intervalEndMinute,
        assembled: row.fulfillmentProcessState === 'ASSEMBLED' || row.placements.length > 0,
        /*
         * Пригодность решает сервер и отдаёт её вместе с точкой.
         *
         * Без этого признака карта могла выбрать только тот заказ, чья
         * карточка уже загружена: маркер заказа за «Загрузить ещё» не
         * выбирался вовсе.
         */
        selectable: row.routeOrders.length === 0,
      })),
      deliveryDate: scope.deliveryDate,
    };
  });

  /**
   * «Выбрать все» — идентификаторы всех пригодных заказов текущего отбора.
   *
   * Именно всех, а не загруженной страницы: иначе кнопка обманывала бы,
   * выбирая только видимое.
   */
  app.get('/api/deals/selectable', async (request) => {
    await authenticateWithRoles(request, deps, ORDER_ROLES);
    const query = dealsQuerySchema.parse(request.query);
    // Выбрать можно только пригодные: «Требует внимания» и заказы черновиков
    // в выбор не попадают ни при каком переключателе.
    const ids = await dealsIds(deps.db, {
      ...scopeOf(query),
      includeDrafts: false,
      group: 'ROUTABLE',
    });

    return { orderIds: ids, total: ids.length };
  });
}
