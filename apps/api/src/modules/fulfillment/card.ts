/**
 * Карточка сборки.
 *
 * Показывается РОВНО то, что утвердил владелец (`FUL-002` §2.5): номер,
 * московские дата и интервал, позиции с количеством и характеристикой, бандлы
 * с компонентами, «Текст открытки» и нижний комментарий заказа.
 *
 * Чего здесь нет и не появится: цены, артикула, «Комментария по доставке»,
 * адреса, телефона и получателя. Это не забывчивость проекции — карточка
 * флориста намеренно не является карточкой заказа, и лишнее поле здесь
 * означало бы разглашение данных клиента человеку, которому они не нужны
 * для сборки букета.
 *
 * Фото в БД не хранится и в карточке не передаётся байтами: отдаётся только
 * идентификатор номенклатуры, по которому браузер просит серверный проxy.
 * Недоступное фото карточку не ломает и места под себя не занимает.
 *
 * ЕДИНИЦА ИЗМЕРЕНИЯ отдаётся ОБОЗНАЧЕНИЕМ, а не ссылкой на каталог. Клиенту
 * нужен ответ на вопрос «два чего», а UUID справочника МоегоСклада ему не
 * нужен ни для показа, ни для действия. Обозначение то самое, что было
 * получено в момент снимка: переименование единицы в каталоге не должно
 * задним числом менять уже показанный состав.
 */

import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { effectiveMinutes } from './queue.js';
import { visiblePositions } from './visibility.js';
import type { FulfillmentAssortmentKind } from './composition.js';

export interface CardComponent {
  name: string | null;
  quantity: string;
  /** Обозначение единицы на момент снимка. `null` — показывается одно число. */
  uomName: string | null;
}

export interface CardPosition {
  name: string | null;
  quantity: string;
  uomName: string | null;
  characteristicLabel: string | null;
  isBundle: boolean;
  /**
   * Ключ номенклатуры для запроса фотографии.
   *
   * Это внешний идентификатор каталога, а не персональные данные. Сам URL
   * источника, токен и байты клиенту не передаются никогда.
   */
  assortmentId: string | null;
  components: CardComponent[];
}

export interface CardPrintJob {
  id: string;
  attempt: number;
  state: string;
  createdAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
}

export interface OrderCard {
  id: string;
  number: string;
  deliveryDate: string | null;
  startMinute: number | null;
  endMinute: number | null;
  cardText: string | null;
  description: string | null;
  positions: CardPosition[];
  process: {
    state: string;
    version: number;
    assignee: { id: string; fullName: string } | null;
    assignedAt: string | null;
    assembledAt: string | null;
    assembledById: string | null;
  };
  /** Производственные данные изменились после того, как заказ взяли в работу. */
  changedSinceClaim: boolean;
  print: {
    formId: string | null;
    jobs: CardPrintJob[];
  };
}

/** Количество из `DECIMAL` строкой: `number` теряет дробную часть. */
function quantityText(value: unknown): string {
  if (value === null || value === undefined) {
    return '0';
  }
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

export async function readOrderCard(db: Database, orderId: string): Promise<OrderCard> {
  const order = await db.deliveryOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      externalName: true,
      deliveryDate: true,
      intervalKind: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      fulfillmentInScope: true,
      fulfillmentCardText: true,
      fulfillmentDescription: true,
      fulfillmentProcessState: true,
      fulfillmentProcessVersion: true,
      fulfillmentAssignedAt: true,
      fulfillmentAssembledAt: true,
      fulfillmentAssembledById: true,
      fulfillmentAssignee: { select: { id: true, fullName: true } },
      fulfillmentPositions: {
        orderBy: { ordinal: 'asc' },
        select: {
          ordinal: true,
          name: true,
          quantity: true,
          uomName: true,
          characteristicLabel: true,
          assortmentKind: true,
          assortmentId: true,
          components: {
            orderBy: { ordinal: 'asc' },
            select: { name: true, quantity: true, uomName: true },
          },
        },
      },
      fulfillmentRevisions: {
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { receivedAt: true },
      },
      printForms: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true },
      },
      printJobs: {
        orderBy: [{ attempt: 'desc' }],
        select: {
          id: true,
          attempt: true,
          state: true,
          createdAt: true,
          completedAt: true,
          lastErrorCode: true,
        },
      },
    },
  });

  if (order === null) {
    throw new AppError('NOT_FOUND', { message: 'order not found' });
  }

  // Заказ вне производственной области карточкой флориста не является:
  // отдавать его состав и тексты по прямому адресу нельзя.
  if (!order.fulfillmentInScope) {
    throw new AppError('NOT_FOUND', { message: 'order is out of fulfillment scope' });
  }

  const minutes = effectiveMinutes(order);
  const visible = visiblePositions(
    order.fulfillmentPositions.map((position) => ({
      ...position,
      assortmentKind: position.assortmentKind as FulfillmentAssortmentKind,
    })),
    MOYSKLAD_IDS,
  );

  const lastRevision = order.fulfillmentRevisions[0];
  const changedSinceClaim =
    order.fulfillmentProcessState === 'IN_ASSEMBLY' &&
    order.fulfillmentAssignedAt !== null &&
    lastRevision !== undefined &&
    lastRevision.receivedAt.getTime() > order.fulfillmentAssignedAt.getTime();

  return {
    id: order.id,
    number: order.externalName,
    deliveryDate: order.deliveryDate === null ? null : fromDateColumn(order.deliveryDate),
    startMinute: minutes.startMinute,
    endMinute: minutes.endMinute,
    cardText: order.fulfillmentCardText,
    description: order.fulfillmentDescription,
    positions: visible.map((position) => ({
      name: position.name,
      quantity: quantityText(position.quantity),
      uomName: position.uomName,
      characteristicLabel: position.characteristicLabel,
      isBundle: position.assortmentKind === 'BUNDLE',
      assortmentId: position.assortmentId,
      components: position.components.map((component) => ({
        name: component.name,
        quantity: quantityText(component.quantity),
        uomName: component.uomName,
      })),
    })),
    process: {
      state: order.fulfillmentProcessState,
      version: order.fulfillmentProcessVersion,
      assignee: order.fulfillmentAssignee,
      assignedAt:
        order.fulfillmentAssignedAt === null ? null : order.fulfillmentAssignedAt.toISOString(),
      assembledAt:
        order.fulfillmentAssembledAt === null ? null : order.fulfillmentAssembledAt.toISOString(),
      assembledById: order.fulfillmentAssembledById,
    },
    changedSinceClaim,
    print: {
      formId: order.printForms[0]?.id ?? null,
      jobs: order.printJobs.map((job) => ({
        id: job.id,
        attempt: job.attempt,
        state: job.state,
        createdAt: job.createdAt.toISOString(),
        completedAt: job.completedAt === null ? null : job.completedAt.toISOString(),
        lastErrorCode: job.lastErrorCode,
      })),
    },
  };
}
