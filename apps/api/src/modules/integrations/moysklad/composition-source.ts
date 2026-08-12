/**
 * Получение производственного состава заказа из МоегоСклада.
 *
 * Два пути, и разделение между ними принципиальное.
 *
 *  1. `fromEmbedded` — состав, пришедший вместе со страницей заказов
 *     (`expand=positions.assortment`). Сети не касается вовсе. Именно этим
 *     путём проходит подавляющее большинство заказов.
 *  2. `fromApi` — `/entity/customerorder/{id}/positions` для очереди дозагрузки:
 *     заказов, чей вложенный состав не пришёл, пришёл неполным или не поместился
 *     во вложенный предел.
 *
 * Почему страница НЕ ходит в сеть за позициями. Соблазн «не пришло вложенным —
 * дочитаю сразу» выглядит заботливым, но на полной загрузке это тысяча
 * дополнительных обращений при темпе один запрос в секунду: около двадцати минут
 * общего лимита аккаунта, который делится с чужими приложениями. Поэтому
 * неподтверждённый состав уходит в очередь с ограниченной квотой на проход,
 * а не тормозит чтение страниц.
 *
 * Полнота ДОКАЗЫВАЕТСЯ обоими путями. Наблюдение показало худший из возможных
 * отказов: при странице больше 100 МойСклад отвечает `200` и молча перестаёт
 * разворачивать связанные данные (`docs/MOYSKLAD_MAPPING.md` §13б). Неполный
 * состав неотличим от пустого, а пустой выглядит достоверным фактом «в заказе
 * ничего нет». Поэтому число строк сверяется с `meta.size`, и расхождение —
 * отказ, а не половина букета.
 */

import type { MoyskladClient } from './client.js';
import type { MOYSKLAD_IDS } from './config.js';
import { idFromHref, type MoyskladOrderDto } from './dto.js';
import { attribute, text } from './mapper.js';
import {
  embeddedPositionsSchema,
  type MoyskladAssortmentDto,
  type MoyskladOrderPositionDto,
} from './composition-dto.js';
import {
  assortmentKindFrom,
  quantityToDecimalString,
  type FulfillmentComponentSnapshot,
  type FulfillmentPositionSnapshot,
  type FulfillmentSnapshot,
} from '../../fulfillment/composition.js';

type Ids = typeof MOYSKLAD_IDS;

/** Почему состав не подтверждён. Значения данных заказа сюда не попадают. */
export type CompositionFailure =
  'POSITIONS_NOT_EXPANDED' | 'POSITIONS_UNAVAILABLE' | 'BUNDLE_UNAVAILABLE' | 'QUANTITY_INVALID';

export class CompositionError extends Error {
  readonly reason: CompositionFailure;

  constructor(reason: CompositionFailure) {
    super(`Состав заказа не подтверждён: ${reason}`);
    this.name = 'CompositionError';
    this.reason = reason;
  }
}

/** Тексты заказа, которые входят в производственный снимок наравне с составом. */
export interface FulfillmentTexts {
  externalId: string;
  description: string | null;
  cardText: string | null;
}

/**
 * Источник состава на ОДИН проход синхронизации.
 *
 * Кэш бандлов живёт ровно проход: один различный бандл загружается один раз,
 * даже если встретился в сотне заказов. Ключ включает версию бандла, поэтому
 * две версии одного бандла никогда не смешиваются.
 */
export class CompositionSource {
  private readonly client: MoyskladClient;
  private readonly ids: Ids;
  private readonly bundles = new Map<string, FulfillmentComponentSnapshot[]>();
  private requests = 0;

  constructor(client: MoyskladClient, ids: Ids) {
    this.client = client;
    this.ids = ids;
  }

  /** Сколько сетевых обращений за компонентами выполнено за проход. */
  get bundleRequests(): number {
    return this.requests;
  }

  /** Тексты производственного снимка, прочитанные из карточки заказа. */
  texts(order: MoyskladOrderDto): FulfillmentTexts {
    return {
      externalId: order.id,
      description: text(order.description),
      cardText: attribute(order, this.ids.cardTextAttribute).text,
    };
  }

  /**
   * Снимок из состава, пришедшего вместе со страницей заказов.
   *
   * Бросает `POSITIONS_NOT_EXPANDED`, если вложенному составу верить нельзя.
   * Это не ошибка сети и не редкость — это штатный путь в очередь дозагрузки.
   */
  async fromEmbedded(order: MoyskladOrderDto): Promise<FulfillmentSnapshot> {
    const rows = readEmbeddedPositions(order);
    if (rows === null) {
      throw new CompositionError('POSITIONS_NOT_EXPANDED');
    }
    return this.snapshot(this.texts(order), rows);
  }

  /**
   * Снимок с дочитыванием позиций отдельным запросом.
   *
   * Тексты берутся из уже сохранённой карточки заказа, а не из повторного
   * чтения документа: они пришли вместе с заказом, проверены схемой и лежат
   * в базе. Повторный `GET` самого документа означал бы лишнее обращение
   * ради данных, которые у нас уже есть.
   */
  async fromApi(texts: FulfillmentTexts): Promise<FulfillmentSnapshot> {
    let rows: MoyskladOrderPositionDto[];
    try {
      // Пагинацию и равенство `rows.length === meta.size` доказывает клиент.
      this.requests += 1;
      rows = (await this.client.listOrderPositions(texts.externalId)).rows;
    } catch {
      // Сообщение внешней ошибки может содержать адрес запроса с фильтрами.
      throw new CompositionError('POSITIONS_UNAVAILABLE');
    }
    return this.snapshot(texts, rows);
  }

  private async snapshot(
    texts: FulfillmentTexts,
    rows: MoyskladOrderPositionDto[],
  ): Promise<FulfillmentSnapshot> {
    const positions: FulfillmentPositionSnapshot[] = [];
    for (const [index, row] of rows.entries()) {
      positions.push(await this.position(row, index));
    }

    return {
      externalId: texts.externalId,
      description: texts.description,
      cardText: texts.cardText,
      positions,
    };
  }

  private async position(
    row: MoyskladOrderPositionDto,
    index: number,
  ): Promise<FulfillmentPositionSnapshot> {
    const assortment = describeAssortment(row.assortment);
    const components =
      assortment.kind === 'BUNDLE' && assortment.id !== null
        ? await this.components(assortment.id, row.assortment?.updated ?? null)
        : [];

    return {
      externalPositionId: row.id,
      ordinal: index,
      assortmentId: assortment.id,
      assortmentKind: assortment.kind,
      assortmentKindRaw: assortment.rawType,
      name: assortment.name,
      quantity: quantity(row.quantity),
      // Живого контракта характеристики нет: модификаций в аккаунте ноль.
      // Заполнить поле догадкой значило бы объявить проверенным непроверенное.
      characteristicLabel: null,
      components,
    };
  }

  /**
   * Компоненты бандла с кэшем на проход.
   *
   * Кэш используется ТОЛЬКО при подтверждённой версии бандла. Без версии два
   * появления одного бандла — это два появления неизвестно чего: содержимое
   * могло измениться между ними, и переиспользование выдало бы старый состав
   * за текущий. Без доказательства лучше сходить в сеть ещё раз.
   */
  private async components(
    bundleId: string,
    version: string | null,
  ): Promise<FulfillmentComponentSnapshot[]> {
    const key = version === null ? null : `${bundleId}@${version}`;
    if (key !== null) {
      const cached = this.bundles.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    let rows;
    try {
      this.requests += 1;
      rows = (await this.client.listBundleComponents(bundleId)).rows;
    } catch {
      throw new CompositionError('BUNDLE_UNAVAILABLE');
    }

    const components = rows.map((row, index) => {
      const assortment = describeAssortment(row.assortment);
      return {
        externalComponentId: row.id,
        ordinal: index,
        assortmentId: assortment.id,
        assortmentKind: assortment.kind,
        assortmentKindRaw: assortment.rawType,
        name: assortment.name,
        quantity: quantity(row.quantity),
      };
    });

    if (key !== null) {
      this.bundles.set(key, components);
    }
    return components;
  }
}

/**
 * Вложенный состав страницы заказов.
 *
 * `null` означает «вложенному составу верить нельзя» — либо `rows` не пришли
 * вовсе (молчаливое отключение expand), либо их меньше, чем обещает `meta.size`.
 * И то и другое обязано увести заказ в очередь, а не превратиться в пустой состав.
 */
export function readEmbeddedPositions(order: MoyskladOrderDto): MoyskladOrderPositionDto[] | null {
  const raw = (order as { positions?: unknown }).positions;
  if (raw === undefined || raw === null) {
    return null;
  }

  const parsed = embeddedPositionsSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const { rows, meta } = parsed.data;
  if (rows === undefined || rows.length !== meta.size) {
    return null;
  }
  return rows;
}

interface DescribedAssortment {
  id: string | null;
  kind: ReturnType<typeof assortmentKindFrom>;
  rawType: string | null;
  name: string | null;
}

/**
 * Разбирает номенклатуру позиции.
 *
 * Позиция без номенклатуры не отбрасывается: строка без названия честнее молча
 * исчезнувшей строки — флорист увидит, что в заказе есть нечто неопознанное,
 * и спросит, вместо того чтобы собрать неполный букет.
 */
function describeAssortment(assortment: MoyskladAssortmentDto | undefined): DescribedAssortment {
  if (assortment === undefined) {
    return { id: null, kind: 'OTHER', rawType: null, name: null };
  }

  const rawType = text(assortment.meta?.type);
  return {
    id: assortment.id ?? idFromHref(assortment.meta?.href),
    kind: assortmentKindFrom(rawType),
    rawType,
    name: text(assortment.name),
  };
}

function quantity(value: number): string {
  try {
    return quantityToDecimalString(value);
  } catch {
    throw new CompositionError('QUANTITY_INVALID');
  }
}
