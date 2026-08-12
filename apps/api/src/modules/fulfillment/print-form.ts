/**
 * Снимок печатного бланка.
 *
 * Бланк строится из ЭТОГО снимка, а не из живого заказа. Разница не
 * теоретическая: заказ в МоемСкладе меняется, а к букету уже приложена бумага.
 * Повторная печать обязана выдать тот же документ, иначе к цветам окажется
 * приложен бланк, которого никто не собирал.
 *
 * Что на бланке (`FUL-002` §2.5 и §2.9): номер заказа, московские дата и
 * интервал, состав, текст открытки и нижний комментарий. Чего на бланке нет:
 * адреса, телефона, цены, артикула, логистического комментария и фотографий.
 * Поэтому их нет и в снимке — хранить то, что не показывается, незачем.
 */

import { createHash } from 'node:crypto';
import { visiblePositions } from './visibility.js';
import type { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import type { FulfillmentAssortmentKind } from './composition.js';

/**
 * Версия шаблона бланка.
 *
 * Хранится вместе со снимком, чтобы старый бланк остался воспроизводимым ровно
 * таким, каким его печатали. Увеличивается при любом изменении разметки или
 * состава полей формы.
 */
export const PRINT_TEMPLATE_VERSION = 1;

export interface PrintFormComponent {
  name: string | null;
  quantity: string;
}

export interface PrintFormPosition {
  name: string | null;
  quantity: string;
  /** Характеристика/вариант. Пусто, пока живого контракта модификаций нет. */
  characteristicLabel: string | null;
  isBundle: boolean;
  components: PrintFormComponent[];
}

export interface PrintFormSnapshot {
  /** Номер заказа МоегоСклада: и текстом, и в QR. */
  orderNumber: string;
  /** Календарная дата Москвы `YYYY-MM-DD`. Не момент времени. */
  deliveryDate: string | null;
  /** Минуты от полуночи. Точное время — интервал нулевой ширины. */
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  cardText: string | null;
  description: string | null;
  positions: PrintFormPosition[];
}

/** Порядок ключей: одинаковые данные обязаны давать одинаковый хеш. */
const SNAPSHOT_KEYS: (keyof PrintFormSnapshot)[] = [
  'orderNumber',
  'deliveryDate',
  'intervalStartMinute',
  'intervalEndMinute',
  'cardText',
  'description',
  'positions',
];

const POSITION_KEYS: (keyof PrintFormPosition)[] = [
  'name',
  'quantity',
  'characteristicLabel',
  'isBundle',
  'components',
];

const COMPONENT_KEYS: (keyof PrintFormComponent)[] = ['name', 'quantity'];

export function canonicalJson(snapshot: PrintFormSnapshot): string {
  const ordered: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) {
    if (key === 'positions') {
      ordered[key] = snapshot.positions.map((position) => {
        const p: Record<string, unknown> = {};
        for (const positionKey of POSITION_KEYS) {
          if (positionKey === 'components') {
            p[positionKey] = position.components.map((component) => {
              const c: Record<string, unknown> = {};
              for (const componentKey of COMPONENT_KEYS) {
                c[componentKey] = component[componentKey];
              }
              return c;
            });
          } else {
            p[positionKey] = position[positionKey];
          }
        }
        return p;
      });
    } else {
      ordered[key] = snapshot[key];
    }
  }
  return JSON.stringify(ordered);
}

export function snapshotHash(snapshot: PrintFormSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** Строка состава в том виде, в каком её отдаёт проекция базы. */
export interface StoredPosition {
  ordinal: number;
  name: string | null;
  quantity: unknown;
  characteristicLabel: string | null;
  assortmentKind: FulfillmentAssortmentKind;
  assortmentId: string | null;
  components: {
    ordinal: number;
    name: string | null;
    quantity: unknown;
  }[];
}

/**
 * Количество из колонки `DECIMAL` в строку без потери дробной части.
 *
 * Prisma отдаёт `Decimal`, у которого есть `toString`. Приводить его к `number`
 * запрещено: именно ради сохранности дроби количество и хранится десятичным.
 */
function quantityText(value: unknown): string {
  if (value === null || value === undefined) {
    return '0';
  }
  const text = String(value);
  // Хвостовые нули убираются, чтобы «2» и «2.000000» давали один бланк и один хеш.
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * Собирает снимок бланка.
 *
 * Скрытые сервисные позиции в бланк не попадают: бланк — это то, что видит
 * флорист, а служебная строка доставки к сборке букета отношения не имеет.
 * Решение о видимости принимает тот же проектор, что и на экране, — иначе
 * бумага и экран однажды разошлись бы.
 */
export function buildPrintFormSnapshot(input: {
  orderNumber: string;
  deliveryDate: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  cardText: string | null;
  description: string | null;
  positions: readonly StoredPosition[];
  ids: Pick<typeof MOYSKLAD_IDS, 'hiddenFulfillmentServices'>;
}): PrintFormSnapshot {
  const visible = visiblePositions(input.positions, input.ids);

  return {
    orderNumber: input.orderNumber,
    deliveryDate: input.deliveryDate,
    intervalStartMinute: input.intervalStartMinute,
    intervalEndMinute: input.intervalEndMinute,
    cardText: input.cardText,
    description: input.description,
    positions: [...visible]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((position) => ({
        name: position.name,
        quantity: quantityText(position.quantity),
        characteristicLabel: position.characteristicLabel,
        isBundle: position.assortmentKind === 'BUNDLE',
        components: [...position.components]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((component) => ({
            name: component.name,
            quantity: quantityText(component.quantity),
          })),
      })),
  };
}
