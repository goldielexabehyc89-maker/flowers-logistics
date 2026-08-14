/**
 * Схема ответа МоегоСклада для заказа покупателя.
 *
 * Проверяются только те поля, которые мы действительно импортируем. Всё
 * остальное, что вернёт API, намеренно игнорируется: расширение чужого ответа
 * не должно ломать импорт, а лишние персональные данные не должны попадать
 * внутрь системы просто потому, что пришли.
 */

import { z } from 'zod';

/**
 * Идентификатор сущности МоегоСклада.
 *
 * Строгая проверка `z.uuid()` здесь неприменима: она требует вариант RFC 4122,
 * а МойСклад выдаёт значения вида `4553382b-2ea3-11ed-0a80-09c5000d6021`
 * с вариантом `0`. Такая проверка отвергала бы все боевые идентификаторы аккаунта.
 * Проверяется форма — восемь групп шестнадцатеричных цифр нужной длины.
 */
const uuidLike = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'ожидается идентификатор',
  );

/** Ссылка на связанную сущность: нас интересует только UUID из href. */
const metaSchema = z.object({ href: z.string().min(1), type: z.string().optional() });

const linkSchema = z.object({ meta: metaSchema });

/**
 * Пользовательский атрибут. Значение может быть скаляром или ссылкой
 * на элемент справочника — тогда нужен его UUID и название.
 */
const attributeSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  type: z.string().optional(),
  value: z.unknown().optional(),
});

export const moyskladOrderSchema = z.looseObject({
  id: uuidLike,
  name: z.string().min(1),
  updated: z.string().min(1),
  moment: z.string().min(1).optional(),
  /** Адрес одной строкой — источник по умолчанию. */
  shipmentAddress: z.string().optional(),
  /**
   * Разобранный адрес по составляющим.
   *
   * Используется временно и только там, где явно включён источник
   * `shipmentAddressFull`: строка произвольного формата находится геокодером
   * заметно хуже, чем разобранные части. Поля необязательны все до одного —
   * МойСклад заполняет их как придётся.
   */
  shipmentAddressFull: z
    .looseObject({
      postalCode: z.string().optional(),
      country: z.looseObject({}).optional(),
      region: z.looseObject({}).optional(),
      city: z.string().optional(),
      street: z.string().optional(),
      house: z.string().optional(),
      apartment: z.string().optional(),
      addInfo: z.string().optional(),
      comment: z.string().optional(),
    })
    .optional(),
  /** Комментарий документа. Наш комментарий берётся не отсюда, но поле валидируем. */
  description: z.string().optional(),
  deliveryPlannedMoment: z.string().optional(),
  sum: z.number(),
  payedSum: z.number(),
  applicable: z.boolean().optional(),
  archived: z.boolean().optional(),
  store: linkSchema.optional(),
  /**
   * Статус запрашивается развёрнутым (`expand=state`), поэтому здесь есть и `name`,
   * и `stateType`. Без expand приходила бы только ссылка, и `stateType` навсегда
   * остался бы пустым.
   */
  state: z
    .looseObject({
      meta: metaSchema,
      id: uuidLike.optional(),
      name: z.string().optional(),
      stateType: z.string().optional(),
    })
    .optional(),
  attributes: z.array(attributeSchema).optional(),
});

export type MoyskladOrderDto = z.infer<typeof moyskladOrderSchema>;

/** Развёрнутый статус: приходит при `expand=state`. */
export const moyskladStateSchema = z.object({
  id: uuidLike,
  name: z.string().optional(),
  stateType: z.string().optional(),
});

/** Последний сегмент href — UUID сущности. */
export function idFromHref(href: string | undefined): string | null {
  if (href === undefined) {
    return null;
  }
  const path = href.split('?')[0] ?? href;
  const last = path.split('/').filter(Boolean).pop();
  return last !== undefined && /^[0-9a-f-]{36}$/i.test(last) ? last : null;
}
