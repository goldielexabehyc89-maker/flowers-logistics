/**
 * Схема ответа МоегоСклада для заказа покупателя.
 *
 * Проверяются только те поля, которые мы действительно импортируем. Всё
 * остальное, что вернёт API, намеренно игнорируется: расширение чужого ответа
 * не должно ломать импорт, а лишние персональные данные не должны попадать
 * внутрь системы просто потому, что пришли.
 */

import { z } from 'zod';

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

export const moyskladOrderSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    updated: z.string().min(1),
    moment: z.string().min(1).optional(),
    /** Адрес одной строкой — единственный источник адреса. */
    shipmentAddress: z.string().optional(),
    /** Комментарий документа. Наш комментарий берётся не отсюда, но поле валидируем. */
    description: z.string().optional(),
    deliveryPlannedMoment: z.string().optional(),
    sum: z.number(),
    payedSum: z.number(),
    applicable: z.boolean().optional(),
    archived: z.boolean().optional(),
    store: linkSchema.optional(),
    state: linkSchema.extend({ name: z.string().optional() }).optional(),
    attributes: z.array(attributeSchema).optional(),
  })
  .passthrough();

export type MoyskladOrderDto = z.infer<typeof moyskladOrderSchema>;

/** Развёрнутый статус: приходит при `expand=state`. */
export const moyskladStateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  stateType: z.string().optional(),
});

/** Последний сегмент href — UUID сущности. */
export function idFromHref(href: string | undefined): string | null {
  if (href === undefined) {
    return null;
  }
  const last = href.split('?')[0].split('/').filter(Boolean).pop();
  return last !== undefined && /^[0-9a-f-]{36}$/i.test(last) ? last : null;
}
