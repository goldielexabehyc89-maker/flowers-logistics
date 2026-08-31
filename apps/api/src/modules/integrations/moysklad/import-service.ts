/**
 * Применение одной карточки МоегоСклада к нашей базе.
 *
 * Всё выполняется в ОДНОЙ транзакции: карточка, ревизия, аудит и realtime-событие.
 * Иначе возможны состояния «заказ обновлён, следа нет» и «событие ушло, данных нет».
 *
 * Порядок блокировок единый во всём модуле:
 *   1) глобальный advisory-lock прохода синхронизации (берётся снаружи, в sync.ts);
 *   2) строка `DeliveryOrder` через `SELECT … FOR UPDATE` по `externalId`;
 *   3) вставки в `DeliveryOrderRevision`, `AuditLog`, `RealtimeEvent`.
 * Обратного порядка нет нигде, поэтому взаимной блокировки между проходами не возникает.
 *
 * PII не покидает таблицу заказа и его ревизии: ни аудит, ни realtime не получают
 * адрес, получателя, комментарий, номер заказа и суммы.
 */

import type { $Enums, Prisma } from '../../../generated/prisma/client.js';
import type { TransactionClient } from '../../auth/sessions.js';
import { writeAudit, type AuditAction } from '../../audit/service.js';
import { publishRealtimeEvent } from '../../realtime/events.js';
import { toDateColumn } from './delivery-date.js';
import { parseMoscow } from './moscow-time.js';
import { diffSnapshots, snapshotHash, type OrderSnapshot } from './mapper.js';
import {
  effectiveAttentionReasons,
  needsLogisticsAttention,
  type AddressAttention,
  type AttentionReason,
  type ManualInterval,
} from '../../orders/attention.js';
import { recordOrderConflicts } from '../../routing/conflicts.js';
import { applyCancellation, isCancelledInSource } from './cancellation.js';
import { invalidateGeoOnAddressChange } from '../../orders/geo.js';
import {
  automaticGeocodingAddress,
  contractVersionOf,
  geocodingAddress,
  isSourceConflict,
  type AddressContract,
} from '../../orders/address.js';
import { enqueueGeocoding } from '../../orders/geocoding/queue.js';

/** События заказов видят только эти роли. Курьеру глобальный поток заказов не нужен. */
const ORDER_AUDIENCE = ['ADMIN', 'LOGISTICIAN'] as const;

export type ApplyOutcome =
  | 'CREATED'
  | 'UPDATED'
  | 'UNCHANGED'
  | 'SCOPE_ENTERED'
  | 'SCOPE_EXITED'
  | 'SKIPPED_OUT_OF_SCOPE'
  /**
   * Заказ старше нижней границы отбора и потому НЕ СОЗДАЁТСЯ.
   *
   * Отдельный исход, а не тихий пропуск: проход обязан уметь сказать, сколько
   * заказов он не создал и почему. Уже существующий заказ этим исходом никогда
   * не получает — граница решает только судьбу впервые создаваемой строки.
   */
  | 'SKIPPED_BEFORE_CUTOFF';

export interface ApplyResult {
  outcome: ApplyOutcome;
  changedFields: string[];
}

/**
 * Нижняя граница даты доставки: московская календарная дата `ГГГГ-ММ-ДД`.
 *
 * Сравнение строковое и потому московское по построению: обе стороны —
 * календарные даты одного формата, а `ГГГГ-ММ-ДД` сравнивается лексикографически
 * ровно как хронологически. Переводить их в абсолютное время нельзя: полночь
 * Москвы и полночь UTC — разные моменты, и заказ на границе попадал бы то в одну
 * сторону, то в другую в зависимости от часа запуска.
 */
export function beforeImportCutoff(
  deliveryDate: string | null,
  cutoff: string | undefined,
): boolean {
  if (cutoff === undefined) {
    return false;
  }
  // Заказ без даты доставки автоматически не создаётся: границу к нему
  // применить не к чему, а угадывать — значит однажды завести в новом контуре
  // сделку прошлого года.
  if (deliveryDate === null) {
    return true;
  }
  return deliveryDate < cutoff;
}

export interface ApplyOptions {
  /**
   * Идентификатор статуса «Отменен» этого аккаунта МоегоСклада.
   *
   * `null` или отсутствие значения означает «распознавание отмен выключено»:
   * ни один заказ отменённым не считается. Значение приходит из настройки
   * окружения и в коде не хранится.
   */
  cancelledStateId?: string | null;

  /**
   * Нижняя граница даты доставки для ВПЕРВЫЕ создаваемых заказов.
   *
   * Отсутствие значения означает «границы нет» — так работают local и staging.
   * На существующие заказы не влияет никогда: они продолжают получать
   * обновления, иначе новый контур потерял бы отмену или смену интервала
   * у заказа, который уже везут.
   */
  importDeliveryDateFrom?: string | undefined;

  /**
   * Ставить ли адрес в очередь геокодирования.
   *
   * По умолчанию — нет. Очередь имеет смысл только там, где её кто-то
   * обрабатывает: в local, CI и staging worker не существует, и заказ,
   * навсегда застрявший в состоянии «Определяется», врал бы логисту о том,
   * что точка вот-вот появится. Заказы, импортированные до включения
   * геокодирования, попадают в очередь разовым наполнением (`backfillGeocoding`).
   */
  geocoding?: boolean;

  /**
   * Создавать ли ВПЕРВЫЕ появившийся заказ по новому адресному контракту.
   *
   * Влияет ровно на создание: существующий заказ на новый контракт не
   * переводится ни при каком значении, а заказ версии 2 остаётся собой
   * и после выключения. Значение приходит из настройки окружения.
   */
  structuredAddressV2?: boolean;
}

interface StoredOrder {
  id: string;
  version: number;
  inScope: boolean;
  fulfillmentInScope: boolean;
  sourceMissing: boolean;
  /// Геоданные: смена адреса обесценивает прежнюю точку.
  geoState: $Enums.OrderGeoState;
  geoSource: $Enums.OrderGeoSource | null;
  geoLatMicro: number | null;
  geoLonMicro: number | null;
  /// Поколение адреса: постановка новой версии в очередь увеличивает его.
  geoGeneration: number;
  cancelledInSource: boolean;
  /// Ручной интервал логиста: синхронизация обязана его учитывать и не затирать.
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  /// Локальная правка адреса: синхронизация её тоже не затирает.
  /// Адрес заказа и запрос к геокодеру: по их паре решается, изменился ли
  /// фактический запрос, а значит — нужно ли геокодировать заново.
  address: string | null;
  geocodeAddress: string | null;
  localAddress: string | null;
  sourceAddressAtLocalEdit: string | null;
  addressConflict: boolean;
  /// Контракт адреса ЭТОГО заказа. Синхронизация его только читает.
  structuredAddress: string | null;
  addressDetails: string | null;
  addressContractVersion: number | null;
}

/** Пустая строка и отсутствие значения — одно и то же: сравниваются они так же. */
function normalizedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Относится ли снимок хотя бы к одной из наших областей.
 *
 * Производственная область строго шире логистической, поэтому проверка
 * сводится к ней. Написано через обе, чтобы правило читалось явно и не
 * сломалось молча, если когда-нибудь области разойдутся.
 */
function inAnyScope(snapshot: OrderSnapshot): boolean {
  return snapshot.inScope || snapshot.fulfillmentInScope;
}

/**
 * Применяет снимок заказа.
 *
 * Заказ, который никогда к нам не относился, не создаётся вовсе: хранить чужие
 * персональные данные «на всякий случай» нельзя. Уже импортированный заказ
 * сохраняется всегда — даже выйдя из области.
 */
export async function applyOrderSnapshot(
  tx: TransactionClient,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const existing = await lockByExternalId(tx, snapshot.externalId);

  if (existing === null) {
    /*
     * Граница отбора проверяется ЗДЕСЬ, перед созданием строки.
     *
     * Серверный фильтр МоегоСклада сужает выборку, но полагаться только на него
     * нельзя: delta-проход ходит по окну `updated` и приносит заказы с любой
     * датой доставки, а чужой API однажды вернёт лишнюю страницу. Заказ до
     * границы не должен появиться ни одним путём — все они сходятся сюда.
     */
    if (beforeImportCutoff(snapshot.deliveryDate, options.importDeliveryDateFrom)) {
      return { outcome: 'SKIPPED_BEFORE_CUTOFF', changedFields: [] };
    }

    if (!inAnyScope(snapshot)) {
      // Пункт Б задания: чужой заказ не попадает в базу ни одним полем.
      // Проверяются обе области сразу: самовывоз утверждённого склада к нам
      // относится и сохраняется, а заказ чужого склада не оставляет ни адреса,
      // ни получателя, ни суммы.
      return { outcome: 'SKIPPED_OUT_OF_SCOPE', changedFields: [] };
    }
    return createOrder(tx, snapshot, now, options);
  }

  return updateOrder(tx, existing, snapshot, now, options);
}

/**
 * Блокирует строку заказа по внешнему идентификатору.
 * Без `FOR UPDATE` два прохода могли бы одновременно прочитать одну версию
 * и создать две ревизии одного изменения.
 */
async function lockByExternalId(
  tx: TransactionClient,
  externalId: string,
): Promise<StoredOrder | null> {
  const rows = await tx.$queryRaw<StoredOrder[]>`
    SELECT "id", "version", "inScope", "fulfillmentInScope", "sourceMissing",
           "manualIntervalStartMinute", "manualIntervalEndMinute",
           "geoState", "geoSource", "geoLatMicro", "geoLonMicro", "geoGeneration",
           "address", "geocodeAddress", "cancelledInSource",
           "localAddress", "sourceAddressAtLocalEdit", "addressConflict",
           "structuredAddress", "addressDetails", "addressContractVersion"
    FROM "DeliveryOrder"
    WHERE "externalId" = ${externalId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Поля карточки из снимка.
 *
 * Сам ручной интервал сюда не входит намеренно — синхронизация его не трогает.
 * Но на расчёт «Требует внимания» он влияет: иначе следующий же проход вернул бы
 * причину, которую логист уже закрыл руками.
 */
function orderData(
  snapshot: OrderSnapshot,
  now: Date,
  manual: ManualInterval | null,
  address?: AddressAttention | null,
  /**
   * Контракт ЭТОГО заказа.
   *
   * `LEGACY` — новые колонки не пишутся вовсе: существующий заказ не переводят
   * на новый контракт очередной синхронизацией. `V2` — обновляются рабочий
   * адрес и детали.
   */
  contract: AddressContract = 'LEGACY',
): Prisma.DeliveryOrderUncheckedUpdateInput {
  const reasons = effectiveAttentionReasons(snapshot.attentionReasons, manual, address);

  return {
    externalName: snapshot.externalName,
    externalUpdated: parseMoscow(snapshot.externalUpdated),
    externalMoment: snapshot.externalMoment === null ? null : parseMoscow(snapshot.externalMoment),
    externalStateId: snapshot.externalStateId,
    externalStateName: snapshot.externalStateName,
    externalStateType: snapshot.externalStateType,
    storeId: snapshot.storeId,
    salesChannelId: snapshot.salesChannelId,
    deliveryMethodId: snapshot.deliveryMethodId,
    deliveryDate: snapshot.deliveryDate === null ? null : toDateColumn(snapshot.deliveryDate),
    deliveryDateRaw: snapshot.deliveryDateRaw,
    intervalRaw: snapshot.intervalRaw,
    intervalKind: snapshot.intervalKind,
    intervalStartMinute: snapshot.intervalStartMinute,
    intervalEndMinute: snapshot.intervalEndMinute,
    address: snapshot.address,
    geocodeAddress: snapshot.geocodeAddress,
    /*
     * Новые колонки — только у нового контракта.
     *
     * У legacy-заказа их не касаются даже значением `null`: запись `null`
     * в уже пустое поле безвредна, но она стёрла бы границу между «мы этот
     * заказ не трогаем» и «мы его обновили пустотой», а именно эта граница
     * и доказывается проверкой «legacy после синхронизации идентичен».
     */
    ...(contract === 'V2'
      ? {
          structuredAddress: snapshot.structuredAddress,
          addressDetails: snapshot.addressDetails,
        }
      : {}),
    recipient: snapshot.recipient,
    comment: snapshot.comment,
    paymentTypeId: snapshot.paymentTypeId,
    paymentTypeName: snapshot.paymentTypeName,
    sumMinor: BigInt(snapshot.sumMinor),
    payedSumMinor: BigInt(snapshot.payedSumMinor),
    cashCollectable: snapshot.cashCollectable,
    cashToCollectMinor: BigInt(snapshot.cashToCollectMinor),
    cashAnomaly: snapshot.cashAnomaly,
    sourceArchived: snapshot.sourceArchived,
    inScope: snapshot.inScope,
    fulfillmentInScope: snapshot.fulfillmentInScope,
    needsAttention: needsLogisticsAttention(reasons),
    attentionReasons: reasons,
    scopeExitReason: snapshot.inScope ? null : snapshot.scopeExitReason,
    scopeExitedAt: snapshot.inScope ? null : now,
    // Возвращение в область снимает признак отсутствия источника.
    sourceMissing: false,
    updatedAt: now,
  };
}

/**
 * Поля снимка, которых у прежнего контракта не существует.
 *
 * Маппер собирает кандидатов ВСЕГДА: версию заказа он не знает и знать
 * не должен. Поэтому отсеиваются они здесь — по версии уже созданной строки.
 *
 * Без этого отсева правка одной лишь квартиры в МоёмСкладе заводила бы
 * у СТАРОГО заказа ревизию, запись в журнале и уведомление на всех экранах —
 * при том что ни адрес, ни точка, ни маршрут не менялись. Переход обязан быть
 * невидимым для заказов, которые к нему не переводили.
 */
const V2_ONLY_SNAPSHOT_FIELDS: readonly string[] = ['structuredAddress', 'addressDetails'];

function contractChangedFields(fields: string[], contract: AddressContract): string[] {
  return contract === 'V2'
    ? fields
    : fields.filter((field) => !V2_ONLY_SNAPSHOT_FIELDS.includes(field));
}

async function createOrder(
  tx: TransactionClient,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions,
): Promise<ApplyResult> {
  /*
   * Версия адресного контракта выбирается ЗДЕСЬ и только здесь.
   *
   * Это наше решение о переходе, а не данные источника: снимок МоегоСклада
   * о версии не знает и знать не должен. Выключатель спрашивается ровно один
   * раз — в момент появления нашей строки; дальше заказ живёт по записанной
   * версии, что бы с выключателем ни случилось потом.
   */
  const contract: AddressContract = options.structuredAddressV2 === true ? 'V2' : 'LEGACY';

  const created = await tx.deliveryOrder.create({
    data: {
      // Новый заказ ручного интервала иметь не может: он появляется только руками.
      ...(orderData(
        snapshot,
        now,
        null,
        contract === 'V2'
          ? {
              corrected: false,
              conflict: false,
              structuredIncomplete: snapshot.structuredAddress === null,
            }
          : null,
        contract,
      ) as Prisma.DeliveryOrderUncheckedCreateInput),
      // Ключ идемпотентности и версия задаются после общих полей: они не входят
      // в набор, который переиспользуется при обновлении.
      externalId: snapshot.externalId,
      version: 1,
      // Единицу не записывает никто: legacy — это отсутствие версии.
      ...(contract === 'V2' ? { addressContractVersion: 2 } : {}),
    },
    select: { id: true },
  });

  // Адрес нового заказа сразу отправляется на разрешение — в той же транзакции.
  // Отдельная постановка «потом» дала бы состояние «заказ есть, задания нет»,
  // и такой заказ навсегда остался бы без точки.
  //
  // Но только если автоматический источник вообще есть. Строка `address`
  // произвольного формата основанием не служит: по ней геокодер подбирает
  // похожий дом, а не находит нужный. Заказ без разобранного адреса уходит
  // в «Требует внимания» с причиной GEOCODING_ADDRESS_INCOMPLETE и ждёт
  // человека — задание появится после его правки.
  const automaticSource = automaticGeocodingAddress({
    address: snapshot.address,
    geocodeAddress: snapshot.geocodeAddress,
    localAddress: null,
    structuredAddress: snapshot.structuredAddress,
    addressContractVersion: contract === 'V2' ? 2 : null,
  });

  if (options.geocoding === true && automaticSource !== null) {
    await enqueueGeocoding(
      tx,
      {
        id: created.id,
        address: snapshot.address,
        geocodeAddress: snapshot.geocodeAddress,
        structuredAddress: snapshot.structuredAddress,
        addressContractVersion: contract === 'V2' ? 2 : null,
        // Новый заказ локальной правки ещё не имеет по определению.
        localAddress: null,
        inScope: snapshot.inScope,
        sourceArchived: snapshot.sourceArchived,
        sourceMissing: false,
        geoState: 'UNRESOLVED',
        geoSource: null,
        geoGeneration: 0,
      },
      now,
    );
  }

  if (isCancelledInSource(snapshot, options.cancelledStateId ?? null)) {
    // Заказ приехал уже отменённым: в работу он не попадает вовсе.
    await applyCancellation(tx, {
      orderId: created.id,
      cancelled: true,
      previous: false,
      now,
    });
  }

  const changedFields = contractChangedFields(diffSnapshots(null, snapshot), contract);
  await writeRevision(tx, created.id, snapshot, changedFields, 'INITIAL_IMPORT');
  await writeOrderAudit(tx, 'ORDER_IMPORTED', created.id, snapshot, changedFields, 1, [
    ...snapshot.attentionReasons,
  ]);
  await publishOrderEvent(tx, 'order.created', created.id, snapshot, [
    ...snapshot.attentionReasons,
  ]);

  return { outcome: 'CREATED', changedFields };
}

async function updateOrder(
  tx: TransactionClient,
  existing: StoredOrder,
  snapshot: OrderSnapshot,
  now: Date,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const previous = await previousSnapshot(tx, existing.id);
  /*
   * Контракт берётся ИЗ СТРОКИ БАЗЫ, а не из выключателя.
   *
   * Выключатель спрашивают только при создании. Спроси мы его здесь —
   * очередная синхронизация переводила бы старые заказы на новый контракт
   * пачками, а это и есть та массовая миграция, которой в пакете нет.
   * И обратное верно: выключенный флаг не откатывает заказ версии 2 к прежним
   * правилам, потому что его версия уже записана.
   */
  const contract = contractVersionOf(existing);
  const changedFields = contractChangedFields(diffSnapshots(previous, snapshot), contract);

  // Заказ, найденный снова после контрольной сверки, обязан вернуться в работу
  // даже если внешний снимок не изменился ни одним полем: пропал он не из-за
  // изменения данных, а из-за отсутствия в выборке.
  // Восстановление считается по ОБЕИМ областям: самовывоз, ошибочно объявленный
  // пропавшим, возвращается в работу так же, как доставка.
  const restoring = existing.sourceMissing && inAnyScope(snapshot);

  if (changedFields.length === 0 && !restoring) {
    // Та же версия пришла повторно в overlap-окне: ни ревизии, ни аудита,
    // ни события. Иначе перекрытие порождало бы поток пустых уведомлений.
    return { outcome: 'UNCHANGED', changedFields: [] };
  }

  // Заказ, который был и остаётся вне нашей области. Обновляются только
  // технические поля, нужные для определения области: полная ревизия сохранила бы
  // адрес, получателя и суммы чужого склада, а хранить их мы не имеем оснований.
  // Обе области сразу: заказ, оставшийся в производственной области (самовывоз),
  // продолжает получать полное обновление общих импортируемых полей.
  if (!inAnyScope(snapshot) && !existing.inScope && !existing.fulfillmentInScope) {
    await tx.deliveryOrder.update({
      where: { id: existing.id },
      data: scopeOnlyData(snapshot, now),
    });
    return { outcome: 'SKIPPED_OUT_OF_SCOPE', changedFields: [] };
  }

  const enteredScope = snapshot.inScope && (!existing.inScope || existing.sourceMissing);
  const exitedScope = !snapshot.inScope && existing.inScope;
  // Аудит и событие показывают то же, что увидит логист в карточке, а не сырой
  // набор причин из снимка: иначе уведомление противоречило бы экрану.
  const manual: ManualInterval = {
    startMinute: existing.manualIntervalStartMinute,
    endMinute: existing.manualIntervalEndMinute,
  };
  // Исходный адрес изменился при действующей локальной правке: значение логиста
  // не затирается, а заказ получает явный конфликт и блокирующую причину.
  // Выбор между двумя адресами делает человек — молча взять один из них нельзя,
  // потому что правильными могут быть оба.
  const conflictDetected = isSourceConflict(
    existing,
    // Сравнивается РАБОЧИЙ адрес источника: у версии 2 это разобранный адрес,
    // а не операционная строка. Иначе поправленная в МоёмСкладе квартира
    // объявляла бы расхождение с правкой логиста, хотя дом тот же.
    contract === 'V2' ? snapshot.structuredAddress : snapshot.address,
  );
  const address = {
    corrected: existing.localAddress !== null,
    conflict: existing.addressConflict || conflictDetected,
    ...(contract === 'V2' ? { structuredIncomplete: snapshot.structuredAddress === null } : {}),
  };
  const reasons = effectiveAttentionReasons(snapshot.attentionReasons, manual, address);

  await tx.deliveryOrder.update({
    where: { id: existing.id },
    data: {
      ...orderData(snapshot, now, manual, address, contract),
      version: existing.version + 1,
      ...(conflictDetected ? { addressConflict: true, addressConflictDetectedAt: now } : {}),
    },
  });

  /*
   * История нового контракта.
   *
   * Рабочий адрес и детали — разные события: по первому курьер едет, второе
   * читает человек у двери. Слитая строка «адрес изменился» заставляла бы
   * гадать, надо ли перепроверять маршрут.
   */
  if (contract === 'V2') {
    if (normalizedText(existing.structuredAddress) !== normalizedText(snapshot.structuredAddress)) {
      await tx.orderStructuredAddressEvent.create({
        data: {
          orderId: existing.id,
          kind: 'ADDRESS',
          occurredAt: now,
          oldValue: existing.structuredAddress,
          newValue: snapshot.structuredAddress,
          actorUserId: null,
        },
      });
    }
    if (normalizedText(existing.addressDetails) !== normalizedText(snapshot.addressDetails)) {
      await tx.orderStructuredAddressEvent.create({
        data: {
          orderId: existing.id,
          kind: 'DETAILS',
          occurredAt: now,
          oldValue: existing.addressDetails,
          newValue: snapshot.addressDetails,
          actorUserId: null,
        },
      });
    }
  }

  if (conflictDetected) {
    // История адреса живёт отдельно от общего аудита: адрес — персональные
    // данные, и в журнал, который читают все административные экраны, он
    // не дублируется.
    await tx.orderAddressHistory.create({
      data: {
        orderId: existing.id,
        action: 'SOURCE_CONFLICT_DETECTED',
        occurredAt: now,
        oldAddress: existing.sourceAddressAtLocalEdit,
        newAddress: existing.localAddress,
        sourceAddress: contract === 'V2' ? snapshot.structuredAddress : snapshot.address,
        actorUserId: null,
      },
    });
  }

  /*
   * Отмена в источнике.
   *
   * Признак снимается ровно так же, как ставится: если статус перестал быть
   * «Отменен», заказ возвращается в работу нераспределённым. Физическое место
   * букета при этом не меняется — незавершённый возврат остаётся возвратом.
   */
  await applyCancellation(tx, {
    orderId: existing.id,
    cancelled: isCancelledInSource(snapshot, options.cancelledStateId ?? null),
    previous: existing.cancelledInSource,
    now,
  });

  const reason = restoring
    ? 'SOURCE_RESTORED'
    : enteredScope
      ? 'SCOPE_ENTERED'
      : exitedScope
        ? 'SCOPE_EXITED'
        : 'EXTERNAL_UPDATE';
  await writeRevision(tx, existing.id, snapshot, changedFields, reason);

  const action: AuditAction = restoring
    ? 'ORDER_SOURCE_RESTORED'
    : enteredScope
      ? 'ORDER_SCOPE_ENTERED'
      : exitedScope
        ? 'ORDER_SCOPE_EXITED'
        : 'ORDER_SYNCED';
  await writeOrderAudit(
    tx,
    action,
    existing.id,
    snapshot,
    changedFields,
    existing.version + 1,
    reasons,
  );

  await publishOrderEvent(
    tx,
    restoring || enteredScope || exitedScope ? 'order.scope_changed' : 'order.updated',
    existing.id,
    snapshot,
    reasons,
  );

  // Изменился ЗАПРОС К ГЕОКОДЕРУ — прежняя точка больше не относится к этому
  // заказу. Оставить её пригодной опаснее, чем потерять: координата от старого
  // адреса выглядит как нормальные данные и молча отправит курьера не туда.
  //
  // Сравнивается именно запрос, а не показываемый адрес. Смена одной лишь
  // квартиры или домофона меняет операционный адрес, но не дом: повторно
  // геокодировать его незачем, а сбрасывать корректную точку — вредно.
  //
  // Пока действует локальная правка, запрос равен ей и не меняется вовсе:
  // точка относится к адресу логиста и остаётся пригодной.
  const geocodeQueryBefore = geocodingAddress(existing);
  const geocodeQueryAfter = geocodingAddress({
    localAddress: existing.localAddress,
    geocodeAddress: snapshot.geocodeAddress,
    address: snapshot.address,
    // У нового контракта запрос — это рабочий адрес из города, улицы и дома.
    // Смена квартиры или «Другого» его не меняет, поэтому точка остаётся.
    structuredAddress: snapshot.structuredAddress,
    addressContractVersion: existing.addressContractVersion,
  });

  /*
   * Автоматический источник запроса: правка логиста, затем разобранный адрес.
   *
   * Строка `address` произвольного формата сюда не входит — по ней геокодер
   * подбирает похожий дом, а не находит нужный. Это то же правило, по которому
   * работает первый импорт.
   */
  const automaticBefore = automaticGeocodingAddress(existing);
  const automaticAfter = automaticGeocodingAddress({
    localAddress: existing.localAddress,
    geocodeAddress: snapshot.geocodeAddress,
    address: snapshot.address,
    structuredAddress: snapshot.structuredAddress,
    addressContractVersion: existing.addressContractVersion,
  });

  let geoState = existing.geoState;
  let geoSource = existing.geoSource;

  if (geocodeQueryBefore !== geocodeQueryAfter) {
    const invalidated = await invalidateGeoOnAddressChange(tx, existing.id, {
      geoState: existing.geoState,
      latMicro: existing.geoLatMicro,
      lonMicro: existing.geoLonMicro,
    });

    if (invalidated) {
      geoState = 'NEEDS_REVIEW';
      geoSource = null;
    }
  }

  /*
   * Адрес, пригодный для геокодера, ВПЕРВЫЕ появился или действительно
   * изменился — заказ отправляется на разрешение.
   *
   * Прежде задание здесь не создавалось вовсе, и это оставляло дыру ровно там,
   * где адрес приходит вторым сообщением: заказ создавался пустым, склад
   * дозаполнял `shipmentAddressFull`, повторный импорт молча приносил адрес —
   * и заказ навсегда оставался без координат, потому что события «появился
   * адрес» никто не фиксировал.
   *
   * Сравнивается именно автоматический источник, а не показываемый адрес:
   * повторный импорт того же значения ничего не меняет и задания не создаёт,
   * а смена одной квартиры или домофона не отправляет дом на повторный поиск.
   *
   * Пока действует правка логиста, источник равен ей и от изменений
   * МоегоСклада не зависит: ни адрес человека, ни его точка не перетираются.
   * Подтверждённую вручную точку `isGeocodable` не переспрашивает.
   */
  if (options.geocoding === true && automaticAfter !== null && automaticAfter !== automaticBefore) {
    await enqueueGeocoding(
      tx,
      {
        id: existing.id,
        address: snapshot.address,
        geocodeAddress: snapshot.geocodeAddress,
        structuredAddress: snapshot.structuredAddress,
        addressContractVersion: existing.addressContractVersion,
        localAddress: existing.localAddress,
        inScope: snapshot.inScope,
        sourceArchived: snapshot.sourceArchived,
        sourceMissing: false,
        geoState,
        geoSource,
        geoGeneration: existing.geoGeneration,
      },
      now,
    );
  }

  // Заказ мог уже лежать в маршруте. Из маршрута он НЕ удаляется: участие и история
  // сохраняются, а расхождение становится видимым конфликтом. Блокировка маршрута
  // здесь не берётся — порядок импорта начинается с заказа (см. routing/conflicts.ts).
  await recordOrderConflicts(tx, existing.id, {
    deliveryDate: snapshot.deliveryDate === null ? null : toDateColumn(snapshot.deliveryDate),
    inScope: snapshot.inScope,
    sourceArchived: snapshot.sourceArchived,
    sourceMissing: false,
  });

  return {
    outcome: enteredScope ? 'SCOPE_ENTERED' : exitedScope ? 'SCOPE_EXITED' : 'UPDATED',
    changedFields,
  };
}

/** Минимальные технические поля для заказа, остающегося вне нашей области. */
function scopeOnlyData(
  snapshot: OrderSnapshot,
  now: Date,
): Prisma.DeliveryOrderUncheckedUpdateInput {
  return {
    externalUpdated: parseMoscow(snapshot.externalUpdated),
    storeId: snapshot.storeId,
    salesChannelId: snapshot.salesChannelId,
    deliveryMethodId: snapshot.deliveryMethodId,
    sourceArchived: snapshot.sourceArchived,
    inScope: false,
    fulfillmentInScope: false,
    updatedAt: now,
  };
}

/** Последний канонический снимок заказа. Ревизии неизменяемы, поэтому он достоверен. */
async function previousSnapshot(
  tx: TransactionClient,
  orderId: string,
): Promise<OrderSnapshot | null> {
  const revision = await tx.deliveryOrderRevision.findFirst({
    where: { orderId },
    // Одинаковые миллисекунды реальны при пакетной обработке, поэтому
    // порядок доопределяется идентификатором.
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { snapshot: true },
  });
  return revision === null ? null : (revision.snapshot as unknown as OrderSnapshot);
}

async function writeRevision(
  tx: TransactionClient,
  orderId: string,
  snapshot: OrderSnapshot,
  changedFields: string[],
  // Тип берётся из сгенерированного клиента: перечисление и код не могут разойтись.
  reason: $Enums.OrderRevisionReason,
): Promise<void> {
  await tx.deliveryOrderRevision.create({
    data: {
      orderId,
      externalUpdated: parseMoscow(snapshot.externalUpdated),
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotHash: snapshotHash(snapshot),
      changedFields,
      reason,
    },
  });
}

/**
 * Аудит системного действия.
 *
 * Значения полей заказа сюда не попадают: они лежат в защищённой ревизии.
 * Здесь — только факт, идентификатор, перечень изменившихся полей и признаки области.
 */
async function writeOrderAudit(
  tx: TransactionClient,
  action: AuditAction,
  orderId: string,
  snapshot: OrderSnapshot,
  changedFields: string[],
  version: number,
  reasons: AttentionReason[],
): Promise<void> {
  await writeAudit(tx, {
    action,
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue: {
      changedFields,
      version,
      inScope: snapshot.inScope,
      scopeExitReason: snapshot.scopeExitReason,
      needsAttention: needsLogisticsAttention(reasons),
      attentionReasons: reasons,
      externalStateType: snapshot.externalStateType,
    },
  });
}

/**
 * Realtime-событие без персональных данных.
 *
 * Клиент по нему перезапрашивает список: пересылать адрес, получателя и суммы
 * в широковещательном канале незачем и небезопасно.
 */
async function publishOrderEvent(
  tx: TransactionClient,
  topic: 'order.created' | 'order.updated' | 'order.scope_changed',
  orderId: string,
  snapshot: OrderSnapshot,
  reasons: AttentionReason[],
): Promise<void> {
  await publishRealtimeEvent(tx, {
    topic,
    payload: {
      orderId,
      inScope: snapshot.inScope,
      needsAttention: needsLogisticsAttention(reasons),
      deliveryDate: snapshot.deliveryDate,
    },
    /*
     * Выход из области адресуется и менеджеру самовывоза.
     *
     * Архив и пропажа источника блокируют выдачу, и человек за прилавком
     * обязан увидеть это до того, как отдаст коробку. Обычные правки заказа
     * ему не рассылаются: раздел выдачи от них не меняется.
     */
    audienceRoles:
      topic === 'order.scope_changed' ? [...ORDER_AUDIENCE, 'MANAGER'] : [...ORDER_AUDIENCE],
  });
}

/** Помечает заказ отсутствующим в источнике. Вызывается только контрольной сверкой. */
export async function markSourceMissing(
  tx: TransactionClient,
  orderId: string,
  now: Date,
): Promise<void> {
  const updated = await tx.deliveryOrder.updateMany({
    where: { id: orderId, sourceMissing: false },
    data: {
      sourceMissing: true,
      // Отсутствие исходного документа выводит заказ из обеих областей:
      // собирать и везти нечего, пока документ не вернётся.
      inScope: false,
      fulfillmentInScope: false,
      scopeExitReason: 'SOURCE_MISSING',
      scopeExitedAt: now,
      updatedAt: now,
    },
  });

  if (updated.count === 0) {
    return;
  }

  await writeAudit(tx, {
    action: 'ORDER_SOURCE_MISSING',
    entityType: 'DeliveryOrder',
    entityId: orderId,
    actorUserId: null,
    source: 'worker',
    newValue: { inScope: false, scopeExitReason: 'SOURCE_MISSING' },
  });

  await publishRealtimeEvent(tx, {
    topic: 'order.scope_changed',
    payload: { orderId, inScope: false, sourceMissing: true },
    // Пропавший заказ блокирует выдачу — менеджер узнаёт об этом сам.
    audienceRoles: [...ORDER_AUDIENCE, 'MANAGER'],
  });

  // Пропавший заказ мог быть распределён. Этот путь не проходит через
  // applyOrderSnapshot, поэтому конфликт фиксируется здесь отдельно.
  // Строка заказа уже заблокирована обновлением выше — порядок соблюдён.
  const stored = await tx.deliveryOrder.findUnique({
    where: { id: orderId },
    select: { deliveryDate: true },
  });
  await recordOrderConflicts(tx, orderId, {
    deliveryDate: stored?.deliveryDate ?? null,
    inScope: false,
    sourceArchived: false,
    sourceMissing: true,
  });
}
