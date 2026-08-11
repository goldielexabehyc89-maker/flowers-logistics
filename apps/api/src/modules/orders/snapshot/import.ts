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
import { resolveIdentities } from './identity.js';
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

/**
 * Отчёт импорта.
 *
 * Состояния различаются намеренно. «Обновлено» и «не изменилось» — разные
 * события: первое означает, что снимок принёс новое значение, второе — что
 * повторный прогон ничего не тронул. Слить их значило бы лишить дежурного
 * единственного способа отличить настоящее изменение от лишнего запуска.
 */
export interface ImportResult {
  created: number;
  updated: number;
  /** Строка уже совпадала со снимком: не записано ничего, версия не выросла. */
  unchanged: number;
  /** Заказ был выведен из области и снимком возвращён обратно. */
  restored: number;
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
 * Контракт ручного интервала: три поля только полным комплектом.
 *
 * База требует того же (CHECK `DeliveryOrder_manual_interval_complete`), но
 * отказ базы приходит уже внутри транзакции и говорит на языке ограничения.
 * Здесь снимок отвергается ДО неё и с понятной причиной: половинчатый ручной
 * интервал — это не «почти интервал», а значение, которого логист не задавал.
 */
export function assertIntervalContract(snapshot: OrdersSnapshot): void {
  for (const order of snapshot.orders) {
    const parts = [
      order.manualIntervalStartMinute,
      order.manualIntervalEndMinute,
      order.manualIntervalSetAt,
    ];
    const filled = parts.filter((part) => part !== null).length;

    if (filled === 0) {
      continue;
    }
    if (filled !== parts.length) {
      throw new SnapshotImportError(
        'Снимок содержит неполный ручной интервал: нужны начало, окончание и время установки',
      );
    }

    const start = order.manualIntervalStartMinute ?? -1;
    const end = order.manualIntervalEndMinute ?? -1;

    if (start < 0 || start > 1439 || end < 1 || end > 1439 || end <= start) {
      throw new SnapshotImportError('Снимок содержит некорректный ручной интервал');
    }
    if (Number.isNaN(Date.parse(order.manualIntervalSetAt ?? ''))) {
      throw new SnapshotImportError(
        'Снимок содержит некорректное время установки ручного интервала',
      );
    }
  }
}

/**
 * Исходный текст интервала для синтетического заказа.
 *
 * Настоящий текст из МоегоСклада на staging не переносится: он написан
 * человеком про конкретный заказ и относится к данным клиента. Но и пустая
 * колонка неверна — интерфейс показывает исходное значение, и логист видел бы
 * заданный интервал без строки, из которой он получен.
 *
 * Поэтому текст ВЫВОДИТСЯ из уже разобранного вида: он честно описывает то,
 * что лежит в минутах, и ничего не добавляет от себя.
 */
export function syntheticIntervalRaw(
  kind: string,
  startMinute: number | null,
  endMinute: number | null,
): string | null {
  const hhmm = (minute: number): string =>
    `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

  switch (kind) {
    case 'RANGE':
      return startMinute === null || endMinute === null
        ? null
        : `с ${hhmm(startMinute)} по ${hhmm(endMinute)}`;
    case 'EXACT':
      return startMinute === null ? null : `к ${hhmm(startMinute)}`;
    case 'UNRECOGNIZED':
      // Что именно было написано в источнике, снимок не переносит. Заказ при
      // этом обязан остаться нераспознанным: иначе он молча стал бы пригодным.
      return 'время доставки не перенесено со снимком';
    default:
      return null;
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
  assertIntervalContract(snapshot);
  // Идентичность всех заказов считается ЦЕЛИКОМ и до транзакции. Снимок,
  // в котором два ключа сходятся в один идентификатор, отвергается до первой
  // записи, до аудита и до события: слияние двух заказов в один не должно
  // обнаруживаться по расхождению счётчиков в отчёте.
  const identities = resolveIdentities(snapshot);

  const result: ImportResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    restored: 0,
    withoutPoint: 0,
  };

  await db.$transaction(async (tx) => {
    for (const { order, externalId } of identities) {
      const outcome = await upsertOrder(tx, order, externalId);
      result[outcome.kind] += 1;
      if (!outcome.hasPoint) {
        result.withoutPoint += 1;
      }
    }
  });

  return result;
}

interface UpsertOutcome {
  kind: 'created' | 'updated' | 'unchanged' | 'restored';
  hasPoint: boolean;
}

/**
 * Поля, которыми снимок распоряжается.
 *
 * Всё, что здесь перечислено, импорт задаёт целиком и по нему же сравнивает.
 * Полей, которые он «иногда трогает», нет намеренно: именно из них выросло бы
 * расхождение между отчётом и действительностью.
 */
const COMPARED_FIELDS = [
  'externalName',
  'deliveryDate',
  'deliveryDateRaw',
  'intervalRaw',
  'intervalKind',
  'intervalStartMinute',
  'intervalEndMinute',
  'manualIntervalStartMinute',
  'manualIntervalEndMinute',
  'manualIntervalSetAt',
  'address',
  'recipient',
  'comment',
  'externalStateName',
  'externalStateType',
  'sumMinor',
  'payedSumMinor',
  'cashCollectable',
  'cashToCollectMinor',
  'cashAnomaly',
  'inScope',
  'scopeExitReason',
  'sourceArchived',
  'sourceMissing',
  'needsAttention',
  'attentionReasons',
  'geoState',
  'geoSource',
  'geoPrecision',
  'geoLatMicro',
  'geoLonMicro',
  'geoReviewReason',
] as const;

/**
 * Сравнимое представление значения.
 *
 * Дата, BigInt и массив причин внимания не сравниваются оператором равенства:
 * два одинаковых `Date` — разные объекты, а `1n` не равно `'1'`. Без приведения
 * повторный импорт всегда выглядел бы изменением.
 */
function comparable(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return `d:${value.getTime()}`;
  }
  if (typeof value === 'bigint') {
    return `n:${value.toString()}`;
  }
  if (Array.isArray(value)) {
    // Порядок причин внимания задаётся снимком и значим: пересортировка
    // скрыла бы настоящее изменение состава.
    return `a:${value.map((item) => String(item)).join(',')}`;
  }
  return `v:${String(value)}`;
}

function sameAsStored(stored: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  return COMPARED_FIELDS.every((field) => comparable(stored[field]) === comparable(desired[field]));
}

async function upsertOrder(
  tx: TransactionClient,
  order: SnapshotOrder,
  // Идентификатор посчитан воротами ДО транзакции и передан сюда готовым:
  // считать его здесь заново значило бы завести второй путь к идентичности
  // в обход проверки на столкновение ключей.
  externalId: string,
): Promise<UpsertOutcome> {
  const point = order.addressAlias === null ? null : pointForAlias(order.addressAlias);
  const hasPoint = point !== null;

  const existing = await tx.deliveryOrder.findUnique({
    where: { externalId },
    select: Object.fromEntries(COMPARED_FIELDS.map((field) => [field, true])) as never,
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
          geoReviewReason: null,
        };

  const desired = {
    externalName: order.number,
    deliveryDate: order.deliveryDate === null ? null : toDateColumn(order.deliveryDate),
    deliveryDateRaw: order.deliveryDate,
    // Текст выводится из разобранного вида: настоящий текст источника
    // на staging не переносится.
    intervalRaw: syntheticIntervalRaw(
      order.intervalKind,
      order.intervalStartMinute,
      order.intervalEndMinute,
    ),
    intervalKind: order.intervalKind as never,
    intervalStartMinute: order.intervalStartMinute,
    intervalEndMinute: order.intervalEndMinute,
    manualIntervalStartMinute: order.manualIntervalStartMinute,
    manualIntervalEndMinute: order.manualIntervalEndMinute,
    // Три поля ручного интервала пишутся вместе: комплектность уже проверена
    // до транзакции, поэтому здесь достаточно перенести значение как есть.
    manualIntervalSetAt:
      order.manualIntervalSetAt === null ? null : new Date(order.manualIntervalSetAt),
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
    // Причина выхода снимается вместе с возвратом в область: заказ, снова
    // числящийся нашим и одновременно «пропавшим из источника», объяснить
    // логисту было бы нечем.
    scopeExitReason: null,
    sourceArchived: false,
    sourceMissing: false,
    needsAttention: order.needsAttention,
    attentionReasons: order.attentionReasons as never,
    ...geo,
  };

  if (existing === null) {
    await tx.deliveryOrder.create({
      data: {
        ...desired,
        externalId,
        externalUpdated: new Date(),
        scopeExitedAt: null,
        ...(hasPoint ? { geoResolvedAt: new Date() } : { geoResolvedAt: null }),
        version: 1,
      },
    });
    return { kind: 'created', hasPoint };
  }

  const stored = existing as unknown as Record<string, unknown>;

  // Ничего не изменилось — не пишем ВООБЩЕ. Ни версии, ни времени обновления,
  // ни времени разрешения точки: повторный прогон обязан быть неотличим
  // от невыполненного, иначе он сам становится изменением данных.
  if (sameAsStored(stored, desired as unknown as Record<string, unknown>)) {
    return { kind: 'unchanged', hasPoint };
  }

  const wasRetired = stored['sourceMissing'] === true;

  await tx.deliveryOrder.update({
    where: { externalId },
    data: {
      ...desired,
      externalUpdated: new Date(),
      scopeExitedAt: null,
      ...(hasPoint ? { geoResolvedAt: new Date() } : { geoResolvedAt: null }),
      version: { increment: 1 },
    },
  });

  return { kind: wasRetired ? 'restored' : 'updated', hasPoint };
}
