/**
 * Схемы производственного состава заказа: позиции, номенклатура и компоненты.
 *
 * Схемы намеренно СТРОГИЕ в другом смысле, чем `moyskladOrderSchema`: там
 * `looseObject` сохраняет неизвестные ключи, потому что заказ читается целиком
 * и лишние поля просто игнорируются при построении снимка. Здесь используется
 * обычный `z.object`, который неизвестные ключи ОТБРАСЫВАЕТ.
 *
 * Причина не в аккуратности, а в безопасности: состав попадает в базу и в
 * неизменяемую ревизию. Сохранённый «на всякий случай» сырой фрагмент чужого
 * ответа однажды принесёт цену, ссылку на файл или новое чувствительное поле,
 * и оно окажется в истории, аудите или у клиента, не пройдя ни одной проверки.
 * Всё, что мы храним, обязано быть перечислено здесь явно.
 */

import { z } from 'zod';

/**
 * Идентификатор сущности МоегоСклада.
 *
 * Форма та же, что в `dto.ts`: строгая `z.uuid()` требует вариант RFC 4122,
 * а МойСклад выдаёт вариант `0` и отверг бы все боевые идентификаторы.
 */
const uuidLike = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'ожидается идентификатор',
  );

const metaSchema = z.object({
  href: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  /** Размер коллекции. Именно по нему доказывается полнота выборки. */
  size: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

/**
 * Развёрнутая номенклатура позиции (`expand=assortment`).
 *
 * Берутся только название, идентификатор, тип и время изменения. Цены,
 * артикулы, штрихкоды, остатки, изображения и папки не читаются вовсе:
 * карточка флориста их не показывает, а хранение расширило бы набор данных
 * без основания.
 */
export const assortmentSchema = z.object({
  id: uuidLike.optional(),
  name: z.string().optional(),
  meta: metaSchema.optional(),
  /**
   * Версия номенклатуры. Для бандла это единственное доказательство того, что
   * два его появления в проходе — одно и то же содержимое. Поле необязательное:
   * при его отсутствии кэш компонентов переиспользовать нельзя.
   */
  updated: z.string().min(1).optional(),
});

export type MoyskladAssortmentDto = z.infer<typeof assortmentSchema>;

/**
 * Позиция заказа.
 *
 * Цена, скидка, НДС, резерв и отгруженное количество приходят в ответе, но
 * здесь не объявлены и потому отбрасываются: владелец решил, что цена и артикул
 * флористу не показываются (`FUL-005`), а хранить их «на будущее» — значит
 * положить в производственную историю данные, которых она не должна содержать.
 */
export const orderPositionSchema = z.object({
  id: uuidLike,
  quantity: z.number(),
  assortment: assortmentSchema.optional(),
});

export type MoyskladOrderPositionDto = z.infer<typeof orderPositionSchema>;

/** Компонент комплекта: собственная идентичность, количество и номенклатура. */
export const bundleComponentSchema = z.object({
  id: uuidLike,
  quantity: z.number(),
  assortment: assortmentSchema.optional(),
});

export type MoyskladBundleComponentDto = z.infer<typeof bundleComponentSchema>;

/**
 * Коллекция МоегоСклада: строки и `meta` с размером.
 *
 * `meta.size` обязателен: без него доказать полноту невозможно, а молча принять
 * усечённый состав за полный — ровно та ошибка, ради которой введён fail closed
 * (`docs/MOYSKLAD_MAPPING.md` §13б).
 */
export function collectionSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({
    rows: z.array(row),
    meta: z.object({
      size: z.number().int().min(0),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  });
}

export const orderPositionsPageSchema = collectionSchema(orderPositionSchema);
export const bundleComponentsPageSchema = collectionSchema(bundleComponentSchema);

/**
 * Изображение номенклатуры.
 *
 * Читается ровно то, что нужно проксированию: адрес загрузки, размер и тип.
 * Ни `title`, ни `updated`, ни миниатюры: карточка показывает одно фото,
 * и лишний адрес — это лишний способ увести сервер не туда.
 *
 * Размер и тип объявлены необязательными, потому что доверять им нельзя:
 * фактический ответ проверяется по заголовкам и по числу прочитанных байт.
 * Значение отсюда используется только как ранний отказ до загрузки.
 */
export const assortmentImageSchema = z.object({
  filename: z.string().optional(),
  size: z.number().int().min(0).optional(),
  meta: z.object({
    downloadHref: z.string().min(1),
    mediaType: z.string().optional(),
  }),
});

export type MoyskladAssortmentImage = z.infer<typeof assortmentImageSchema>;

export const assortmentImagesPageSchema = collectionSchema(assortmentImageSchema);

/**
 * Позиции, вложенные в заказ при `expand=positions.assortment`.
 *
 * `rows` объявлен необязательным намеренно: именно его отсутствие — наблюдённый
 * признак того, что МойСклад ответил `200`, но связанные данные молча
 * не развернул. Обнаружить это обязан код, а не человек по пустой карточке.
 */
export const embeddedPositionsSchema = z.object({
  rows: z.array(orderPositionSchema).optional(),
  meta: z.object({
    size: z.number().int().min(0),
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
});

export type MoyskladEmbeddedPositions = z.infer<typeof embeddedPositionsSchema>;
