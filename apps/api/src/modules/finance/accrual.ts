/**
 * Начисления курьеру: где деньги входят в учёт.
 *
 * Две точки на весь продукт:
 *
 * 1. Подтверждение маршрута — снимок тарифа по дате доставки. С этого момента
 *    ставки маршрута зафиксированы, и правка тарифа их не трогает.
 * 2. Результат доставки — денежный факт и сами начисления: наличные к получению,
 *    оплата за доставленный заказ и оплата километров за МКАД.
 *
 * Отмена результата не переписывает записи: на каждую создаётся связанная
 * обратная. Отменённая доставка не оставляет ни долга, ни оплаты.
 *
 * Пока учёт не включён владельцем, ни одна из точек ничего не делает: прошлые
 * доставки остаются без начислений, и отчёт помечает их «Расчёт отсутствует».
 */

import type { CourierLedgerKind } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../auth/sessions.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';
import { appendEntry, accrualKey, reversalKey, reverseEntry } from './ledger.js';
import {
  ledgerCoversDate,
  perOrderForVehicle,
  type LedgerActivation,
  type TariffRates,
} from './tariffs.js';

export interface CaptureTariffInput {
  routeId: string;
  deliveryDate: string;
  /** Тип транспорта маршрута: им выбирается пешая или автомобильная ставка. */
  vehicleType: 'CAR' | 'FOOT';
  rates: TariffRates;
}

/**
 * Снимок тарифа маршрута.
 *
 * Повтор безопасен: у снимка один маршрут, и при повторном подтверждении
 * (например, после возврата в черновик) сохраняется первый снимок — ставки
 * не имеют права поменяться под уже посчитанными деньгами.
 */
export async function captureRouteTariff(
  tx: TransactionClient,
  input: CaptureTariffInput,
): Promise<void> {
  const existing = await tx.routeTariffSnapshot.findUnique({
    where: { routeId: input.routeId },
    select: { id: true },
  });
  if (existing !== null) {
    return;
  }

  await tx.routeTariffSnapshot.create({
    data: {
      routeId: input.routeId,
      tariffVersionId: input.rates.tariffVersionId,
      vehicleType: input.vehicleType,
      // Ставка выбирается по типу транспорта здесь и замораживается: смена
      // настроек тарифа задним числом подтверждённый маршрут не пересчитывает.
      perOrderMinor: perOrderForVehicle(input.rates, input.vehicleType),
      perKmMinor: input.rates.perKmMinor,
      deliveryDate: new Date(`${input.deliveryDate}T00:00:00.000Z`),
    },
  });
}

export interface DeliveryAccrualInput {
  attemptId: string;
  routeOrderId: string;
  routeId: string;
  orderId: string;
  courierUserId: string;
  actorUserId: string;
  outcome: 'DELIVERED' | 'NOT_DELIVERED';
}

/**
 * Начисления по результату доставки.
 *
 * Денежный факт снимается всегда, даже когда наличных нет: отчёт обязан
 * различать «наличных не было» и «мы не знаем». Начисления создаются только
 * при доставке и только если у маршрута есть тарифный снимок.
 */
export async function accrueDeliveryResult(
  tx: TransactionClient,
  activation: LedgerActivation,
  input: DeliveryAccrualInput,
): Promise<void> {
  const route = await tx.deliveryRoute.findUnique({
    where: { id: input.routeId },
    select: { deliveryDate: true },
  });
  if (route === null) {
    return;
  }

  const deliveryDate = fromDateColumn(route.deliveryDate);
  if (!ledgerCoversDate(activation, deliveryDate)) {
    return;
  }

  /*
   * Строка заказа блокируется ДО чтения сумм.
   *
   * Импорт из МоегоСклада блокирует ту же строку, и без этой блокировки
   * доставка читала бы оплату «до», импорт фиксировал бы новую оплату, а
   * финансовое задание успевало отработать по ещё пустому журналу — начисление
   * появлялось бы после него и оставалось непоправленным. Под общей блокировкой
   * порядок любой: либо мы считаем уже по новой оплате, либо задание увидит наши
   * записи и снимет разницу.
   *
   * Порядок блокировок прежний: DeliveryRoute (выше по стеку) → DeliveryOrder.
   */
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;

  const order = await tx.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: {
      cashCollectable: true,
      sumMinor: true,
      payedSumMinor: true,
      paymentTypeId: true,
      paymentTypeName: true,
      cancelledInSource: true,
    },
  });
  if (order === null) {
    return;
  }

  /*
   * Сумма к получению считается тем же правилом, что и везде: разница суммы
   * и оплаченного, но не меньше нуля. Переплата не превращается в долг
   * компании перед курьером.
   */
  const outstanding = order.sumMinor - order.payedSumMinor;
  const cash = order.cashCollectable && outstanding > 0n ? outstanding : 0n;

  await tx.deliveryMoneyFact.upsert({
    where: { attemptId: input.attemptId },
    update: {},
    create: {
      attemptId: input.attemptId,
      orderId: input.orderId,
      routeId: input.routeId,
      courierUserId: input.courierUserId,
      cashCollectable: order.cashCollectable,
      cashToCollectMinor: cash,
      paymentTypeId: order.paymentTypeId,
      paymentTypeName: order.paymentTypeName,
    },
  });

  if (input.outcome !== 'DELIVERED') {
    return;
  }

  /*
   * Заказ, отменённый в источнике, денег не приносит.
   *
   * Денежный факт выше уже записан — физическая доставка остаётся историей, — а
   * вот начислений быть не должно: иначе отмена, обработанная РАНЬШЕ доставки,
   * снимала бы пустой журнал, а доставка потом возвращала заказу ненулевой
   * результат, который снимать уже некому. Проверка стоит под той же
   * блокировкой строки, что и чтение сумм.
   */
  if (order.cancelledInSource) {
    return;
  }

  if (cash > 0n) {
    await appendEntry(tx, {
      courierUserId: input.courierUserId,
      kind: 'CASH_RECEIVED',
      amountMinor: cash,
      operationDate: deliveryDate,
      actorUserId: input.actorUserId,
      routeId: input.routeId,
      orderId: input.orderId,
      attemptId: input.attemptId,
      idempotencyKey: accrualKey(input.attemptId, 'CASH_RECEIVED'),
    });
  }

  const snapshot = await tx.routeTariffSnapshot.findUnique({
    where: { routeId: input.routeId },
    select: { perOrderMinor: true, perKmMinor: true },
  });
  if (snapshot === null) {
    // Маршрут подтверждён до включения учёта: начислять нечем, и выдумывать
    // ставку задним числом запрещено решением владельца.
    return;
  }

  if (snapshot.perOrderMinor > 0n) {
    await appendEntry(tx, {
      courierUserId: input.courierUserId,
      kind: 'DELIVERY_FEE',
      amountMinor: snapshot.perOrderMinor,
      operationDate: deliveryDate,
      actorUserId: input.actorUserId,
      routeId: input.routeId,
      orderId: input.orderId,
      attemptId: input.attemptId,
      idempotencyKey: accrualKey(input.attemptId, 'DELIVERY_FEE'),
    });
  }

  await accrueDistanceFee(tx, {
    attemptId: input.attemptId,
    routeOrderId: input.routeOrderId,
    routeId: input.routeId,
    orderId: input.orderId,
    courierUserId: input.courierUserId,
    actorUserId: input.actorUserId,
    operationDate: deliveryDate,
    perKmMinor: snapshot.perKmMinor,
  });
}

export interface DistanceFeeInput {
  /**
   * Догоняющее начисление: расстояние пришло ПОСЛЕ доставки.
   *
   * Отличает поздний ответ маршрутизатора от уточнения уже готового расчёта.
   * Первое начисляет, второе — нет: уточнение меняет деньги только решением
   * человека.
   */
  catchUp?: boolean;
  attemptId: string;
  routeOrderId: string;
  routeId: string;
  orderId: string;
  courierUserId: string;
  actorUserId: string;
  /** Дата операции в форме ГГГГ-ММ-ДД. */
  operationDate: string;
  perKmMinor: bigint;
}

/**
 * Начисление оплаты километров за МКАД по действующему снимку расстояния.
 *
 * Вынесено отдельно, потому что вызывается из двух мест: сразу при результате
 * «Доставлен», если расстояние уже посчитано, и позднее — когда Valhalla
 * ответила уже после доставки и расстояние сохранилось. Уникальный ключ
 * `attempt:<id>:DISTANCE_FEE` не даёт начислить километры дважды: повторный
 * вызов после позднего снимка добавляет запись ровно один раз, а основная
 * оплата `DELIVERY_FEE` остаётся нетронутой.
 */
export async function accrueDistanceFee(
  tx: TransactionClient,
  input: DistanceFeeInput,
): Promise<void> {
  if (input.perKmMinor <= 0n) {
    return;
  }

  /*
   * Отменённому заказу километры не начисляются.
   *
   * Это ВТОРОЙ путь начисления, и он срабатывает позже доставки — когда
   * Valhalla ответила уже после неё. Без проверки поздний расчёт возвращал бы
   * отменённому заказу ненулевой результат. Строка заказа блокируется, чтобы
   * отмена не проскочила между проверкой и записью.
   */
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;
  const order = await tx.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: { cancelledInSource: true },
  });
  if (order === null || order.cancelledInSource) {
    return;
  }

  /*
   * Километры оплачиваются ОДИН раз — правилом, а не совпадением ключей.
   *
   * Догоняющее начисление опиралось на занятость ключа `attempt:<id>:
   * DISTANCE_FEE`. Но доставка бывает отмечена ДО того, как расстояние
   * посчитано: тогда записи нет, ключ свободен, а логист успевает поставить
   * километры вручную. Валгалла отвечала позже, ручной снимок признавался
   * подходящим — и те же километры начислялись ВТОРОЙ раз, по 246 ₽ вместо
   * 123 ₽. Признак — действующая запись километров у этой попытки, чем бы
   * она ни была заведена.
   */
  const alreadyPaid = await tx.courierLedgerEntry.count({
    where: { attemptId: input.attemptId, kind: 'DISTANCE_FEE', reversedBy: { is: null } },
  });
  if (alreadyPaid > 0) {
    return;
  }

  /*
   * Догоняющее начисление существует ровно для одного случая: расстояния на
   * момент доставки НЕ БЫЛО (маршрутизатор не ответил), и оно пришло позже.
   *
   * Рассчитанный ноль — это завершённый расчёт, а не его отсутствие: адрес
   * внутри МКАД. Позднее уточнение такого расчёта — то же самое уточнение, что
   * и у ненулевых километров, а деньги по нему меняет только решение человека.
   * Иначе одно правило действовало при ненулевых километрах, а другое — при
   * нулевых: автоматика начисляла 800 ₽ днём доставки, никого не спросив.
   *
   * Признак — история снимков: они не удаляются, а гасятся, поэтому «был ли
   * расчёт к моменту доставки» читается прямо.
   */
  if (input.catchUp === true) {
    const attempt = await tx.deliveryAttempt.findUnique({
      where: { id: input.attemptId },
      select: { occurredAt: true },
    });
    const settledAtDelivery =
      attempt !== null &&
      (await tx.routeOrderDistance.count({
        where: { routeOrderId: input.routeOrderId, capturedAt: { lte: attempt.occurredAt } },
      })) > 0;
    if (settledAtDelivery) {
      return;
    }
  }

  const distance = await tx.routeOrderDistance.findFirst({
    where: { routeOrderId: input.routeOrderId, activeKey: { not: null } },
    select: { roundedKmTenths: true },
  });

  if (distance === null || distance.roundedKmTenths <= 0) {
    return;
  }

  // Десятые доли километра: ставка задана за целый километр, поэтому
  // умножение и деление выполняются в целых минорных единицах.
  const amount = (input.perKmMinor * BigInt(distance.roundedKmTenths)) / 10n;
  if (amount <= 0n) {
    return;
  }

  await appendEntry(tx, {
    courierUserId: input.courierUserId,
    kind: 'DISTANCE_FEE',
    amountMinor: amount,
    operationDate: input.operationDate,
    actorUserId: input.actorUserId,
    routeId: input.routeId,
    orderId: input.orderId,
    attemptId: input.attemptId,
    // Километры сохраняются вместе с суммой: восстановить их делением нельзя —
    // сумма округлена, и при дробной ставке обратная формула ошибается.
    distanceKmTenths: distance.roundedKmTenths,
    idempotencyKey: accrualKey(input.attemptId, 'DISTANCE_FEE'),
  });
}

/**
 * Виды, которые начисляет САМА система по результату доставки.
 *
 * Список закрытый и сверен с местами записи: `accrueDeliveryResult`,
 * `accrueDistanceFee` и корректировка наличных после оплаты в источнике.
 */
const ACCRUED_KINDS: readonly CourierLedgerKind[] = [
  'CASH_RECEIVED',
  'DELIVERY_FEE',
  'DISTANCE_FEE',
  'CASH_PAYMENT_CORRECTION',
];

/**
 * Пересчёт километров после того, как деньги уже начислены.
 *
 * Ручная правка километров меняла ТОЛЬКО показанное. Строка отчёта берёт
 * километры живьём из действующего снимка, а деньги — из замороженной записи
 * `DISTANCE_FEE`, и после правки строка показывала «20,0 км · 500,00 ₽» при
 * ставке 40 ₽/км: арифметика строки не сходилась сама с собой, а пометки об
 * этом не было ни на экране, ни в файле. Повторно начислить было нечем —
 * ключ `attempt:<id>:DISTANCE_FEE` уже занят.
 *
 * Поэтому правка пересчитывает деньги: прежнее начисление снимается обратной
 * записью, новое заводится по исправленным километрам. Исходная запись
 * остаётся — по ней видно, сколько было начислено и почему снято.
 *
 * День — ДЕНЬ ИСПРАВЛЕНИЯ, а не день доставки. Правка, сделанная сегодня,
 * не переписывает итоги закрытого (а то и прошлого месяца) дня: по этому же
 * правилу живут все остальные отмены в модуле. Связь с доставкой сохраняется
 * маршрутом, заказом и попыткой, а строка доставки показывает километры, по
 * которым начислены деньги, — и называет расхождение с текущим расчётом.
 */
export async function restateDistanceFee(
  tx: TransactionClient,
  input: { routeOrderId: string; actorUserId: string; reason: string; operationDate: string },
): Promise<boolean> {
  const routeOrder = await tx.routeOrder.findUnique({
    where: { id: input.routeOrderId },
    select: {
      route: { select: { id: true, deliveryDate: true } },
      order: { select: { id: true, cancelledInSource: true, cancellationCount: true } },
    },
  });
  if (routeOrder === null) {
    return false;
  }

  const attempt = await tx.deliveryAttempt.findFirst({
    where: { routeOrderId: input.routeOrderId, activeKey: { not: null }, outcome: 'DELIVERED' },
    select: { id: true, courierUserId: true, financeStrippedAt: true },
  });
  // Доставки ещё нет — начислять будет обычный путь, по уже исправленному снимку.
  if (attempt === null) {
    return false;
  }

  /*
   * Тот же порядок блокировок, что и у начисления: строка заказа первой.
   * Отмена заказа не должна проскочить между проверкой и записью.
   */
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${routeOrder.order.id}::uuid FOR UPDATE`;
  const order = await tx.deliveryOrder.findUnique({
    where: { id: routeOrder.order.id },
    select: { cancelledInSource: true },
  });
  // У отменённого заказа финансовый результат снят: возвращать его правкой нельзя.
  if (order === null || order.cancelledInSource) {
    return false;
  }

  const snapshot = await tx.routeTariffSnapshot.findUnique({
    where: { routeId: routeOrder.route.id },
    select: { perKmMinor: true },
  });
  if (snapshot === null || snapshot.perKmMinor <= 0n) {
    return false;
  }

  const distance = await tx.routeOrderDistance.findFirst({
    where: { routeOrderId: input.routeOrderId, activeKey: { not: null } },
    select: { id: true, roundedKmTenths: true },
  });
  const target =
    distance === null || distance.roundedKmTenths <= 0
      ? 0n
      : (snapshot.perKmMinor * BigInt(distance.roundedKmTenths)) / 10n;

  /*
   * Снятый финансовый результат правкой километров не оживляется.
   *
   * После отмены заказа в источнике все начисления сняты; снятие отмены денег
   * не возвращает. Правка километров в этом состоянии завела бы оплату одних
   * километров — заказ, за который заплачены только они, и ничего больше.
   *
   * Признак — ПРИЧИНА отмены записей ЭТОЙ попытки, а не состояние журнала и не
   * счётчик отмен заказа. Оба предыдущих признака были ложными: «все начисления
   * погашены» истинно и при обычной правке километров в ноль, а счётчик отмен
   * относится ко всей истории заказа — из-за него старая отмена блокировала
   * километры НОВОЙ, законной доставки того же заказа.
   */
  const active = await tx.courierLedgerEntry.count({
    where: { attemptId: attempt.id, kind: { in: [...ACCRUED_KINDS] }, reversedBy: { is: null } },
  });
  /*
   * Неизвестная причина — это «возможно, снятие», а не «снятия не было».
   *
   * У отмен, созданных прежней версией, причины нет вовсе: колонка появилась
   * позже и осталась пустой. Считая пустоту доказательством обычной правки,
   * обновление возвращало 800 ₽ попытке, деньги которой сняла отмена заказа.
   * Молча восстанавливать снятое нельзя — при неоднозначности отказ.
   */
  const stripMarks = await tx.courierLedgerEntry.count({
    where: {
      attemptId: attempt.id,
      reversesEntryId: { not: null },
      reversesEntry: { kind: { in: [...ACCRUED_KINDS] } },
      OR: [{ reversalCause: 'ORDER_CANCELLED' }, { reversalCause: null }],
    },
  });
  const stripped = active === 0 && (attempt.financeStrippedAt !== null || stripMarks > 0);
  if (stripped) {
    return false;
  }

  const existing = await tx.courierLedgerEntry.findMany({
    where: { attemptId: attempt.id, kind: 'DISTANCE_FEE', reversedBy: { is: null } },
    select: { id: true, amountMinor: true },
  });
  /*
   * Был ли базовый ключ когда-либо занят: отменённая запись его не освобождает.
   * Без этого повторная правка после отмены упиралась бы в занятый ключ и
   * возвращала снятую запись вместо новой.
   */
  const hadAnyDistanceFee =
    (await tx.courierLedgerEntry.count({
      where: { attemptId: attempt.id, kind: 'DISTANCE_FEE' },
    })) > 0;

  // В журнале заработок отрицателен: начисленная величина — со сменой знака.
  const accrued = existing.reduce((total, entry) => total - entry.amountMinor, 0n);
  if (accrued === target) {
    return false;
  }

  const operationDate = input.operationDate;
  for (const entry of existing) {
    await reverseEntry(tx, {
      entryId: entry.id,
      actorUserId: input.actorUserId,
      reason: input.reason,
      operationDate,
      cause: 'DISTANCE_RESTATED',
    });
  }

  if (target > 0n) {
    await appendEntry(tx, {
      courierUserId: attempt.courierUserId,
      kind: 'DISTANCE_FEE',
      amountMinor: target,
      operationDate,
      actorUserId: input.actorUserId,
      reason: input.reason,
      routeId: routeOrder.route.id,
      orderId: routeOrder.order.id,
      attemptId: attempt.id,
      distanceKmTenths: distance?.roundedKmTenths ?? 0,
      /*
       * Ключ: базовый, пока он свободен, дальше — по СНИМКУ расстояния.
       *
       * Базовый `attempt:<id>:DISTANCE_FEE` занимается первым начислением —
       * не важно, системным или этой правкой. Занять его здесь обязательно:
       * иначе догоняющее начисление Valhalla придёт на свободный ключ и
       * оплатит те же километры второй раз.
       *
       * Ключ из самих километров не годится: он повторялся бы при возврате к
       * прежнему значению, и правка 12,5 → 20,0 → 12,5 → 20,0 на четвёртом
       * шаге попала бы в УЖЕ ОТМЕНЁННУЮ запись, вернула бы её и оставила
       * курьера без денег. Каждая правка создаёт новый снимок, поэтому его
       * идентификатор различает правки и оставляет повтор одной записью.
       */
      idempotencyKey:
        existing.length === 0 && !hadAnyDistanceFee
          ? accrualKey(attempt.id, 'DISTANCE_FEE')
          : `${accrualKey(attempt.id, 'DISTANCE_FEE')}:snapshot:${distance?.id ?? 'none'}`,
    });
  }

  return true;
}

/**
 * Отмена результата доставки.
 *
 * Каждое начисление этой попытки получает связанную обратную запись с причиной.
 * Исходные записи остаются: по ним видно, что деньги начислялись и почему были
 * сняты. Денежный факт не удаляется — он остаётся историей.
 */

/**
 * Оплата ЗА САМУ ПОПЫТКУ.
 *
 * Отдельно от расходов и доплат: она существует только потому, что попытка
 * состоялась, и вместе с отменённой попыткой теряет основание. Расход же
 * курьер понёс физически — парковку он оплатил независимо от того, что потом
 * решили с результатом.
 */
const ATTEMPT_KINDS: readonly CourierLedgerKind[] = ['ATTEMPT_FEE'];

/**
 * Что именно снимать — решает ВЫЗЫВАЮЩИЙ, потому что поводы разные.
 *
 * `SYSTEM` — только начисленное системой. Так снимает деньги отмена ЗАКАЗА
 * в источнике: доставка состоялась, попытка была, и оплата за неё вместе с
 * расходами курьера остаётся — отмена заказа их не возвращает.
 *
 * `ATTEMPT` — начисленное системой И оплата за попытку. Так снимается ОТМЕНА
 * РЕЗУЛЬТАТА: самой попытки больше нет, платить за неё не за что. Расходы и
 * доплаты не трогаются ни в одном случае: эти деньги курьер уже потратил или
 * заработал, и снять их вправе только тот же человек, отдельным действием.
 */
export type ReversalScope = 'SYSTEM' | 'ATTEMPT';

export async function reverseDeliveryAccruals(
  tx: TransactionClient,
  input: {
    attemptId: string;
    actorUserId: string;
    reason: string;
    operationDate: string;
    scope: ReversalScope;
  },
): Promise<boolean> {
  const entries = await tx.courierLedgerEntry.findMany({
    where: {
      attemptId: input.attemptId,
      kind: {
        in: input.scope === 'SYSTEM' ? [...ACCRUED_KINDS] : [...ACCRUED_KINDS, ...ATTEMPT_KINDS],
      },
      reversedBy: { is: null },
    },
    select: {
      id: true,
      courierUserId: true,
      amountMinor: true,
      routeId: true,
      orderId: true,
      attemptId: true,
    },
  });

  for (const entry of entries) {
    await tx.courierLedgerEntry.create({
      data: {
        courierUserId: entry.courierUserId,
        kind: 'ADJUSTMENT',
        amountMinor: -entry.amountMinor,
        operationDate: new Date(`${input.operationDate}T00:00:00.000Z`),
        actorUserId: input.actorUserId,
        reason: input.reason,
        routeId: entry.routeId,
        orderId: entry.orderId,
        attemptId: entry.attemptId,
        reversesEntryId: entry.id,
        /*
         * Повод называется прямо: по нему потом видно, что финансовый результат
         * этой попытки СНЯТ, а не просто исправлен человеком.
         */
        reversalCause: input.scope === 'SYSTEM' ? 'ORDER_CANCELLED' : 'RESULT_CANCELLED',
        idempotencyKey: reversalKey(entry.id),
      },
    });
  }

  // Было ли что снимать: вызывающий по этому признаку решает, сообщать ли
  // отчёту об изменении журнала.
  return entries.length > 0;
}
