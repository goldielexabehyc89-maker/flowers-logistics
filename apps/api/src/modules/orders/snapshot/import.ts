/**
 * Импорт обезличенного снимка заказов на staging.
 *
 * Направление одно: production → staging. Обратного переноса нет и не будет.
 *
 * Импорт разрешён ровно в одном окружении. Проверяются оба признака сразу:
 * смешанная конфигурация вроде `APP_ENV=staging` с production-маркером означает
 * ошибку развёртывания, и продолжать в такой ситуации нельзя — снимок
 * с псевдонимами затёр бы настоящие заказы.
 *
 * Fail closed на каждом шаге. Неизвестный формат, настоящий адрес вместо
 * псевдонима, внешний идентификатор МоегоСклада, след секрета — всё это
 * останавливает импорт ЦЕЛИКОМ, до единой записи. Частичный импорт хуже
 * отказа: часть реальных данных осталась бы в staging без следа в отчёте.
 *
 * К DaData импорт не обращается ни при каких условиях: координаты берутся
 * из синтетического набора, а не выясняются у платного сервиса по псевдониму.
 */

import type { AppConfig } from '../../../platform/config.js';
import type { Database } from '../../../platform/db.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { toDateColumn } from '../../integrations/moysklad/delivery-date.js';
import {
  assertSnapshotIsSafe,
  type OrdersSnapshot,
  type SnapshotOrder,
} from '../snapshot-export.js';
import { pointForAlias } from './synthetic-points.js';

/** Похоже ли значение на UUID МоегоСклада. Внешние идентификаторы не переносятся. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Признаки настоящего адреса.
 *
 * Псевдоним выглядит как `addr-<hex>`; всё, что содержит название улицы, дома
 * или города, настоящим адресом и является. Список намеренно грубый: он ловит
 * очевидные случаи и не претендует на полноту, а точную проверку делает
 * префикс псевдонима.
 */
const ADDRESS_MARKERS = [
  'ул.',
  'улица',
  'просп',
  'проезд',
  'переулок',
  'шоссе',
  'бульвар',
  'москва',
  'кв.',
  'д.',
];

export interface ImportResult {
  created: number;
  updated: number;
  /** Заказы снимка, у которых нет псевдонима адреса: точка им не назначается. */
  withoutPoint: number;
}

export class SnapshotImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotImportError';
  }
}

/**
 * Проверяет окружение.
 *
 * Отдельная экспортируемая функция, чтобы правило можно было доказать тестом
 * напрямую: «production и CI не могут выполнить staging-импорт» — это
 * не деталь запуска, а обещание.
 */
export function assertStagingEnvironment(config: AppConfig): void {
  if (config.APP_ENV !== 'staging' || config.APP_ENVIRONMENT_MARKER !== 'staging') {
    throw new SnapshotImportError(
      'Импорт снимка допустим только при APP_ENV=staging и APP_ENVIRONMENT_MARKER=staging',
    );
  }
}

/**
 * Дополнительные проверки содержимого сверх общей `assertSnapshotIsSafe`.
 *
 * Здесь ловится то, что относится именно к импорту: внешние идентификаторы
 * и настоящие адреса, случайно попавшие в поля снимка.
 */
export function assertNoRealData(snapshot: OrdersSnapshot): void {
  for (const order of snapshot.orders) {
    if (UUID.test(order.key)) {
      throw new SnapshotImportError('Снимок содержит внешний идентификатор вместо псевдонима');
    }

    for (const value of [order.addressAlias, order.recipientAlias]) {
      if (value === null) {
        continue;
      }
      const lower = value.toLowerCase();
      if (ADDRESS_MARKERS.some((marker) => lower.includes(marker))) {
        throw new SnapshotImportError('Снимок содержит настоящий адрес вместо псевдонима');
      }
    }
  }
}

/**
 * Импортирует снимок.
 *
 * Всё выполняется одной транзакцией: отказ на середине не должен оставить
 * половину снимка. Повтор того же снимка идемпотентен — заказы находятся
 * по ключу и обновляются, а не дублируются.
 *
 * Пользователи, сессии, аудит, outbox, realtime, курсоры интеграции
 * и настройки не переносятся вовсе: снимок их просто не содержит, а импорт
 * не пишет ни в одну из этих таблиц.
 */
export async function importOrdersSnapshot(
  db: Database,
  config: AppConfig,
  snapshot: OrdersSnapshot,
): Promise<ImportResult> {
  assertStagingEnvironment(config);
  assertSnapshotIsSafe(snapshot);
  assertNoRealData(snapshot);

  const result: ImportResult = { created: 0, updated: 0, withoutPoint: 0 };

  await db.$transaction(async (tx) => {
    for (const order of snapshot.orders) {
      const outcome = await upsertOrder(tx, order);
      if (outcome.created) {
        result.created += 1;
      } else {
        result.updated += 1;
      }
      if (!outcome.hasPoint) {
        result.withoutPoint += 1;
      }
    }
  });

  return result;
}

interface UpsertOutcome {
  created: boolean;
  hasPoint: boolean;
}

async function upsertOrder(tx: TransactionClient, order: SnapshotOrder): Promise<UpsertOutcome> {
  // Ключ снимка — псевдоним идентификатора заказа. Он же служит внешним
  // идентификатором на staging: настоящий UUID МоегоСклада сюда не попадает.
  const externalId = pseudoUuid(order.key);
  const point = order.addressAlias === null ? null : pointForAlias(order.addressAlias);

  const existing = await tx.deliveryOrder.findUnique({
    where: { externalId },
    select: { id: true },
  });

  // Геоданные задаются ЯВНО в обоих случаях.
  //
  // Пустой объект оставил бы прежнюю точку на месте: заказ, у которого пропал
  // псевдоним адреса, остался бы в состоянии RESOLVED с координатами от старого
  // снимка — и отчёт импорта при этом честно сообщал бы «без точки».
  const geo =
    point === null
      ? {
          geoState: 'UNRESOLVED' as const,
          geoSource: null,
          geoPrecision: null,
          geoLatMicro: null,
          geoLonMicro: null,
          geoResolvedAt: null,
          geoReviewReason: null,
        }
      : {
          geoState: 'RESOLVED' as const,
          // Источник строго SYNTHETIC: по нему на любом экране видно, что точка
          // выдумана. Production-код это значение не создаёт нигде.
          geoSource: 'SYNTHETIC' as const,
          geoPrecision: 'EXACT_HOUSE' as const,
          geoLatMicro: point.latMicro,
          geoLonMicro: point.lonMicro,
          geoResolvedAt: new Date(),
          geoReviewReason: null,
        };

  const data = {
    externalName: order.number,
    externalUpdated: new Date(),
    deliveryDate: order.deliveryDate === null ? null : toDateColumn(order.deliveryDate),
    deliveryDateRaw: order.deliveryDate,
    intervalKind: order.intervalKind as never,
    intervalStartMinute: order.intervalStartMinute,
    intervalEndMinute: order.intervalEndMinute,
    manualIntervalStartMinute: order.manualIntervalStartMinute,
    manualIntervalEndMinute: order.manualIntervalEndMinute,
    // Псевдонимы попадают в поля адреса и получателя как есть: они и есть
    // всё, что staging знает о клиенте.
    address: order.addressAlias === null ? null : `${order.addressAlias} (${point?.label ?? ''})`,
    recipient: order.recipientAlias,
    comment: order.hasComment ? 'комментарий скрыт при переносе' : null,
    externalStateName: order.externalStateName,
    externalStateType: order.externalStateType,
    sumMinor: BigInt(order.sumMinor),
    payedSumMinor: BigInt(order.payedSumMinor),
    cashCollectable: order.cashCollectable,
    cashToCollectMinor: BigInt(order.cashToCollectMinor),
    cashAnomaly: order.cashAnomaly,
    inScope: order.inScope,
    sourceArchived: false,
    sourceMissing: false,
    needsAttention: order.needsAttention,
    attentionReasons: order.attentionReasons as never,
    ...geo,
  };

  if (existing === null) {
    await tx.deliveryOrder.create({ data: { ...data, externalId, version: 1 } });
    return { created: true, hasPoint: point !== null };
  }

  await tx.deliveryOrder.update({
    where: { externalId },
    data: { ...data, version: { increment: 1 } },
  });
  return { created: false, hasPoint: point !== null };
}

/**
 * Детерминированный UUID из псевдонима.
 *
 * Колонка внешнего идентификатора имеет тип UUID, а ключ снимка им не является.
 * Значение выводится из псевдонима, поэтому повторный импорт того же снимка
 * находит тот же заказ и обновляет его, а не создаёт второй.
 */
export function pseudoUuid(key: string): string {
  const hex = Buffer.from(key.padEnd(16, '0').slice(0, 16), 'utf8').toString('hex').slice(0, 32);
  const padded = hex.padEnd(32, '0');
  return [
    padded.slice(0, 8),
    padded.slice(8, 12),
    // Версия 8: UUID выведен из имени и случайным не является.
    `8${padded.slice(13, 16)}`,
    `8${padded.slice(17, 20)}`,
    padded.slice(20, 32),
  ].join('-');
}
