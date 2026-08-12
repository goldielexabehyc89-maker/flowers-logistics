/**
 * Канонический производственный снимок заказа.
 *
 * Снимок отделён от логистического `OrderSnapshot` намеренно и не может быть
 * частью его. Логистический снимок хеширует фиксированный список ключей; добавь
 * в него состав — и хеш изменился бы у ВСЕХ уже сохранённых заказов, то есть
 * первый же проход создал бы ревизию каждому заказу и объявил бы изменившимся
 * то, что не менялось.
 *
 * Что входит в производственный снимок и почему именно это:
 *
 *  * `description` — нижний комментарий заказа, отдельный от логистического
 *    «Комментария по доставке»;
 *  * «Текст открытки» — показывается флористу;
 *  * позиции и компоненты бандлов в воспроизводимом порядке.
 *
 * Тексты входят в снимок наравне с позициями, иначе изменение комментария или
 * открытки не попало бы в историю, и будущая проверка «Заказ изменён» молча
 * пропускала бы правку, которую флорист обязан увидеть.
 *
 * `externalUpdated` в снимок НЕ входит и в хеш не участвует: он меняется и от
 * чужих логистических полей, и признание его частью снимка порождало бы
 * производственные ревизии там, где производственные данные не менялись.
 * В ревизии он сохраняется отдельным полем как источник и контекст.
 */

import { createHash } from 'node:crypto';

/**
 * Тип номенклатуры позиции.
 *
 * `VARIANT` объявлен, но фактически поддержанным не считается: модификаций
 * в аккаунте нет ни одной, и проверить их живой контракт было не на чем
 * (`docs/OWNER_DECISIONS.md`, `FUL-005` п.5). `OTHER` существует, чтобы новый
 * или незнакомый тип не ронял импорт и не исчезал молча.
 */
export type FulfillmentAssortmentKind = 'PRODUCT' | 'SERVICE' | 'BUNDLE' | 'VARIANT' | 'OTHER';

export interface FulfillmentComponentSnapshot {
  externalComponentId: string;
  ordinal: number;
  assortmentId: string | null;
  assortmentKind: FulfillmentAssortmentKind;
  /** Исходное значение `meta.type`: незнакомый тип обязан остаться видимым. */
  assortmentKindRaw: string | null;
  name: string | null;
  /** Десятичная строка: `number` для количества теряет дробную часть на округлении. */
  quantity: string;
}

export interface FulfillmentPositionSnapshot {
  externalPositionId: string;
  ordinal: number;
  assortmentId: string | null;
  assortmentKind: FulfillmentAssortmentKind;
  assortmentKindRaw: string | null;
  name: string | null;
  quantity: string;
  /**
   * Отображаемая характеристика модификации.
   *
   * Всегда `null` до подтверждения живого контракта: модификаций в аккаунте нет,
   * и заполнять поле догадкой значило бы объявить проверенным то, что не
   * проверялось. Технический ключ модификации — `assortmentId`.
   */
  characteristicLabel: string | null;
  components: FulfillmentComponentSnapshot[];
}

export interface FulfillmentSnapshot {
  externalId: string;
  /** Стандартный `customerorder.description`. */
  description: string | null;
  /** Атрибут «Текст открытки». */
  cardText: string | null;
  positions: FulfillmentPositionSnapshot[];
}

/** Порядок ключей снимка. Фиксирован, чтобы хеш не зависел от порядка полей API. */
const SNAPSHOT_KEYS: (keyof FulfillmentSnapshot)[] = [
  'externalId',
  'description',
  'cardText',
  'positions',
];

const POSITION_KEYS: (keyof FulfillmentPositionSnapshot)[] = [
  'externalPositionId',
  'ordinal',
  'assortmentId',
  'assortmentKind',
  'assortmentKindRaw',
  'name',
  'quantity',
  'characteristicLabel',
  'components',
];

const COMPONENT_KEYS: (keyof FulfillmentComponentSnapshot)[] = [
  'externalComponentId',
  'ordinal',
  'assortmentId',
  'assortmentKind',
  'assortmentKindRaw',
  'name',
  'quantity',
];

/** Канонический JSON: ключи в фиксированном порядке на всех трёх уровнях. */
export function canonicalJson(snapshot: FulfillmentSnapshot): string {
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

export function snapshotHash(snapshot: FulfillmentSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/**
 * Изменившиеся элементы снимка.
 *
 * Возвращаются имена верхнего уровня: `description`, `cardText`, `positions`.
 * Подробности изменения состава лежат в самой ревизии — здесь достаточно
 * указателя, потому что список попадает в аудит, а аудит не должен содержать
 * ни названий позиций, ни текста комментария.
 */
export function diffSnapshots(
  previous: FulfillmentSnapshot | null,
  next: FulfillmentSnapshot,
): string[] {
  if (previous === null) {
    return [...SNAPSHOT_KEYS];
  }

  const changed: string[] = [];
  for (const key of SNAPSHOT_KEYS) {
    if (key === 'positions') {
      if (canonicalPositions(previous) !== canonicalPositions(next)) {
        changed.push(key);
      }
      continue;
    }
    if (previous[key] !== next[key]) {
      changed.push(key);
    }
  }
  return changed;
}

function canonicalPositions(snapshot: FulfillmentSnapshot): string {
  const parsed = JSON.parse(canonicalJson(snapshot)) as { positions: unknown };
  return JSON.stringify(parsed.positions);
}

/**
 * Количество как десятичная строка.
 *
 * МойСклад отдаёт количество числом, а число с плавающей точкой нельзя ни
 * хранить, ни сравнивать: `0.1 + 0.2` и округление до целого одинаково тихо
 * портят состав букета. Значение нормализуется один раз здесь, на границе,
 * и дальше живёт строкой и колонкой `DECIMAL`.
 *
 * Диапазон ограничен сознательно: `1e21` в JavaScript печатается как `1e+21`,
 * и такая строка не является десятичным числом ни для базы, ни для сравнения.
 * Значение вне диапазона — не «большое количество», а испорченные данные.
 */
export const MAX_QUANTITY = 1e12;
const QUANTITY_SCALE = 6;

export class QuantityError extends Error {
  constructor() {
    // Значение в сообщение не попадает: оно приходит из внешнего ответа.
    super('Некорректное количество позиции');
    this.name = 'QuantityError';
  }
}

export function quantityToDecimalString(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) {
    throw new QuantityError();
  }
  const fixed = value.toFixed(QUANTITY_SCALE);
  // Хвостовые нули убираются, чтобы одно и то же количество давало один хеш
  // независимо от того, пришло оно как `2` или как `2.000`.
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/** `meta.type` МоегоСклада → наш тип номенклатуры. */
export function assortmentKindFrom(rawType: string | null): FulfillmentAssortmentKind {
  switch (rawType) {
    case 'product':
      return 'PRODUCT';
    case 'service':
      return 'SERVICE';
    case 'bundle':
      return 'BUNDLE';
    case 'variant':
      return 'VARIANT';
    default:
      return 'OTHER';
  }
}
