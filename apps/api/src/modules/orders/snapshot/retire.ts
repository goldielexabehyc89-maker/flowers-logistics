/**
 * Вывод синтетического набора из рабочих выборок staging.
 *
 * Физического удаления НЕТ и быть не может: `DeliveryOrder` защищён триггером
 * базы, и это правильно — заказ может перестать быть нашим, но не может
 * исчезнуть из истории. Поэтому «очистка» здесь означает ровно то же, что
 * означает исчезновение заказа в источнике: он выходит из области.
 *
 * Путь используется существующий — `markSourceMissing`. Ни одной собственной
 * записи в базу этот модуль не делает: свой путь означал бы второй способ
 * выводить заказ из области, и однажды они разошлись бы.
 *
 * Границы операции:
 *
 *  - только заказы, ключи которых перечислены в переданном снимке. Ни выборки
 *    «по признаку», ни масок: набор определяется файлом, а не догадкой;
 *  - сначала сухая проверка, и только потом запись;
 *  - отказ целиком, если хотя бы один заказ состоит в активном маршруте.
 *    Маршруты отменяет человек через интерфейс — команда за него этого
 *    не делает: отмена маршрута требует причины и остаётся решением логиста;
 *  - повторный вывод — безопасное бездействие.
 */

import type { AppConfig } from '../../../platform/config.js';
import type { Database } from '../../../platform/db.js';
import { markSourceMissing } from '../../integrations/moysklad/import-service.js';
import { assertSnapshotIsSafe, type OrdersSnapshot } from '../snapshot-export.js';
import { resolveIdentities } from './identity.js';
import {
  assertIntervalContract,
  assertNoRealData,
  assertStagingEnvironment,
  SnapshotImportError,
} from './import.js';

export interface RetireResult {
  /** Ключи снимка, найденные в базе. */
  matched: number;
  /** Ключи снимка, которых в базе нет: выводить нечего. */
  missing: number;
  /** Выведено из области этим запуском. */
  retired: number;
  /** Уже было выведено раньше: повтор ничего не изменил. */
  alreadyRetired: number;
  /** Проверка без записи. */
  dryRun: boolean;
}

/**
 * Отказ из-за активного маршрута.
 *
 * Наружу выносятся только номера маршрутов и количества: псевдонимы ключей
 * и содержимое снимка в вывод команды не попадают.
 */
export class RetireBlockedError extends Error {
  readonly routeNumbers: string[];
  readonly blockedOrders: number;

  constructor(routeNumbers: string[], blockedOrders: number) {
    super(
      `Вывод из области невозможен: ${blockedOrders} заказ(ов) состоят в активных маршрутах ` +
        `(${routeNumbers.join(', ')}). Отмените маршруты в интерфейсе и повторите.`,
    );
    this.name = 'RetireBlockedError';
    this.routeNumbers = routeNumbers;
    this.blockedOrders = blockedOrders;
  }
}

export interface RetireOptions {
  /** Проверка без записи. Команда всегда выполняет её первой. */
  dryRun: boolean;
  now?: Date;
}

export async function retireSnapshotOrders(
  db: Database,
  config: AppConfig,
  snapshot: OrdersSnapshot,
  options: RetireOptions,
): Promise<RetireResult> {
  // Те же ворота, что у импорта. Снимок проверяется целиком, хотя выводу нужны
  // одни ключи: файл с настоящими данными не должен становиться пригодным
  // оттого, что его передали другой команде.
  assertStagingEnvironment(config);
  assertSnapshotIsSafe(snapshot);
  assertNoRealData(snapshot);
  assertIntervalContract(snapshot);

  if (snapshot.orders.length === 0) {
    throw new SnapshotImportError('Снимок пуст: выводить из области нечего');
  }

  // Те же ворота и тот же mapper, что у импорта. Выводить из области нужно
  // ровно те заказы, которые импорт создал бы из этого файла; расхождение
  // здесь означало бы, что команда выводит не тот набор, что показала.
  const externalIds = resolveIdentities(snapshot).map((item) => item.externalId);

  const orders = await db.deliveryOrder.findMany({
    where: { externalId: { in: externalIds } },
    select: { id: true, sourceMissing: true },
  });

  const result: RetireResult = {
    matched: orders.length,
    missing: externalIds.length - orders.length,
    retired: 0,
    alreadyRetired: orders.filter((order) => order.sourceMissing).length,
    dryRun: options.dryRun,
  };

  const pending = orders.filter((order) => !order.sourceMissing);

  // Активные участия проверяются ДО любой записи и по всем заказам набора,
  // включая уже выведенные: заказ, лежащий в маршруте, остаётся его частью
  // независимо от того, числится он нашим или нет.
  const active = await db.routeOrder.findMany({
    where: { orderId: { in: orders.map((order) => order.id) }, removedAt: null },
    select: { orderId: true, route: { select: { number: true, state: true } } },
  });

  if (active.length > 0) {
    const numbers = [...new Set(active.map((item) => item.route.number))].sort();
    throw new RetireBlockedError(numbers, new Set(active.map((item) => item.orderId)).size);
  }

  if (options.dryRun) {
    result.retired = pending.length;
    return result;
  }

  const now = options.now ?? new Date();

  // Транзакция одна: половина выведенного набора хуже, чем ни одного.
  await db.$transaction(async (tx) => {
    for (const order of pending) {
      // Доменный путь: он же ставит признаки, пишет аудит и событие.
      // Повторный вызов для уже выведенного заказа не делает ничего.
      await markSourceMissing(tx, order.id, now);
    }
  });

  result.retired = pending.length;
  return result;
}
