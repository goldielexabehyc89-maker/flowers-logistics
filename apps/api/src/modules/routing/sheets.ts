/**
 * Единый экран маршрутных листов.
 *
 * Три раздела идут подряд и отвечают на один вопрос логиста: что ещё не уехало,
 * что в пути и что закончено. Разделы — это состояния маршрута, а не отдельные
 * сущности: `CONFIRMED` — неотгруженные, `ACTIVE` — отгруженные, `COMPLETED` —
 * доставленные.
 *
 * Листы группируются по МОСКОВСКИМ календарным дням. Текущий день раскрыт,
 * прошлые свёрнуты и открываются по требованию: смена начинается с сегодняшнего
 * дня, а вся история в разметке превратила бы экран в бесконечную ленту.
 *
 * Отбор и поиск считает сервер. Фильтровать уже загруженные строки нельзя:
 * лист, не попавший на первую страницу, иначе исчез бы из поиска вовсе.
 */

import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Раздел экрана. Значение — часть контракта с браузером. */
export type SheetSection = 'UNSHIPPED' | 'SHIPPED' | 'DELIVERED';

const SECTION_STATE = {
  UNSHIPPED: 'CONFIRMED',
  SHIPPED: 'ACTIVE',
  DELIVERED: 'COMPLETED',
} as const;

export interface SheetsQuery {
  section: SheetSection;
  /** Точный день. Пусто — все дни разделa страницами. */
  deliveryDate?: string | undefined;
  /** Номер листа, номер заказа, имя или телефон курьера. */
  search?: string | undefined;
  limit: number;
  offset: number;
}

export interface SheetView {
  id: string;
  number: string;
  deliveryDate: string;
  state: string;
  version: number;
  courier: { id: string; fullName: string } | null;
  totalOrders: number;
  deliveredOrders: number;
  /** Номера доставленных заказов: их показывает предупреждение об отмене. */
  deliveredNumbers: string[];
}

export interface SheetsDay {
  date: string;
  sheets: SheetView[];
}

export interface SheetsResult {
  days: SheetsDay[];
  total: number;
  hasMore: boolean;
}

/** Только цифры: телефон ищется в любом написании. */
function digitsOf(value: string): string {
  return value.replace(/\D+/gu, '');
}

/**
 * Условие поиска.
 *
 * Один запрос покрывает всё, чем логист помнит лист: номер самого листа,
 * номер любого заказа в нём, имя или телефон курьера. Заставлять человека
 * выбирать поле поиска значит заставлять его гадать.
 */
function searchWhere(search: string): Prisma.DeliveryRouteWhereInput[] {
  const trimmed = search.trim();
  if (trimmed === '') {
    return [];
  }

  const digits = digitsOf(trimmed);
  const byPhone: Prisma.DeliveryRouteWhereInput[] =
    digits.length >= 3 ? [{ courier: { phone: { contains: digits } } }] : [];

  return [
    {
      OR: [
        { number: { contains: trimmed, mode: 'insensitive' } },
        { courier: { fullName: { contains: trimmed, mode: 'insensitive' } } },
        {
          orders: {
            some: {
              removedAt: null,
              order: { externalName: { contains: trimmed, mode: 'insensitive' } },
            },
          },
        },
        ...byPhone,
      ],
    },
  ];
}

export async function listSheets(db: Database, query: SheetsQuery): Promise<SheetsResult> {
  const where: Prisma.DeliveryRouteWhereInput = {
    state: SECTION_STATE[query.section],
    ...(query.deliveryDate === undefined ? {} : { deliveryDate: toDateColumn(query.deliveryDate) }),
    AND: searchWhere(query.search ?? ''),
  };

  const total = await db.deliveryRoute.count({ where });

  const rows = await db.deliveryRoute.findMany({
    where,
    /*
     * Порядок разделa.
     *
     * В неотгруженных первыми идут листы БЕЗ курьера: именно они требуют
     * решения логиста, и искать их прокруткой было бы работой ради работы.
     * Дальше — свежие дни впереди старых, внутри дня номера по возрастанию.
     */
    orderBy: [
      ...(query.section === 'UNSHIPPED'
        ? [{ courierUserId: { sort: 'asc', nulls: 'first' } as const }]
        : []),
      { deliveryDate: 'desc' as const },
      { number: 'asc' as const },
    ],
    take: query.limit,
    skip: query.offset,
    select: {
      id: true,
      number: true,
      deliveryDate: true,
      state: true,
      version: true,
      courier: { select: { id: true, fullName: true } },
      orders: {
        where: { removedAt: null },
        select: {
          order: { select: { externalName: true } },
          attempts: {
            where: { activeKey: { not: null }, outcome: 'DELIVERED' },
            select: { id: true },
          },
        },
      },
    },
  });

  const byDay = new Map<string, SheetView[]>();
  for (const row of rows) {
    const delivered = row.orders.filter((item) => item.attempts.length > 0);
    const date = row.deliveryDate.toISOString().slice(0, 10);
    const view: SheetView = {
      id: row.id,
      number: row.number,
      deliveryDate: date,
      state: row.state,
      version: row.version,
      courier: row.courier,
      totalOrders: row.orders.length,
      deliveredOrders: delivered.length,
      // Только номера заказов: ни адресов, ни получателей, ни телефонов.
      deliveredNumbers: delivered.map((item) => item.order.externalName),
    };
    byDay.set(date, [...(byDay.get(date) ?? []), view]);
  }

  return {
    days: [...byDay.entries()]
      .sort((left, right) => right[0].localeCompare(left[0]))
      .map(([date, sheets]) => ({ date, sheets })),
    total,
    hasMore: query.offset + rows.length < total,
  };
}
