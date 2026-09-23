/**
 * Денежные последствия изменений заказа в МоемСкладе.
 *
 * Два события источника меняют деньги курьера уже ПОСЛЕ доставки:
 *
 * 1. Выросла оплаченная сумма. Наличных, которые курьер должен сдать, стало
 *    меньше — ровно на разницу. Оплата работы курьера и километры за МКАД при
 *    этом не трогаются: он всё отвёз, и его труд оплачивается независимо от
 *    того, как покупатель рассчитался.
 * 2. Заказ отменён в источнике. Финансовый результат этой доставки снимается
 *    целиком: заказ перестаёт давать и плюс, и минус.
 *
 * Оба случая идут через ОБЩИЙ журнал связанными записями: исходное начисление
 * не переписывается и не удаляется, история остаётся читаемой.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ЗАДАНИЕМ, А НЕ ПРЯМО В ИМПОРТЕ. Импорт блокирует строку
 * ЗАКАЗА, фиксация доставки — строку МАРШРУТА. Запись в журнал прямо из импорта
 * свела бы в одной транзакции два разных порядка блокировок, а это взаимная
 * блокировка при одновременных «Доставлен» и импорте. Задание ставится в
 * транзакции импорта и выполняется отдельно, уже после её фиксации, поэтому
 * любой порядок событий даёт один и тот же итог:
 *   • доставка зафиксирована раньше импорта — начисление посчитано по прежней
 *     оплате, и обработчик снимает разницу;
 *   • импорт раньше доставки — начисление сразу считается по новой оплате,
 *     и снимать уже нечего: обработчик видит нулевую разницу и молчит.
 */

import { moscowCalendarDate } from '@fl/shared';
import type { TransactionClient } from '../auth/sessions.js';
import type { OutboxHandler } from '../outbox/worker.js';
import { enqueueOutbox } from '../outbox/producer.js';
import { publishRealtimeEvent } from '../realtime/events.js';
import { appendLedgerEntry } from './ledger.js';
import { reverseDeliveryAccruals } from './accrual.js';

export const ORDER_FINANCE_TOPIC = 'finance.order_sync' as const;

/**
 * Ключ задания на корректировку наличных.
 *
 * В ключ входит НОМЕР события оплаты, а не её величина. Выполненные сообщения
 * очереди не удаляются, поэтому ключ из величины занимался навсегда:
 * «оплата 2000 → отмена результата → новая доставка → снова оплата 2000» не
 * ставила второго задания, и за новой доставкой оставались все 5000 наличных
 * вместо 3000.
 *
 * От двойного списания это не ослабляет защиту: её держат не ключ задания, а
 * ключ самой записи (`cashCorrectionEntryKey`, «попытка + состояние оплаты») и
 * формула, которая никогда не снимает больше начисленного. Номер же растёт
 * только на РОСТЕ оплаты, поэтому повторный импорт одного снимка задания не
 * ставит вовсе.
 */
export function cashCorrectionJobKey(orderId: string, generation: number): string {
  /*
   * Отдельное слово `event` в ключе — это ПРОСТРАНСТВО ИМЁН, а не украшение.
   *
   * Прежний формат `…:payment:<заказ>:<сумма в копейках>` отличался от нового
   * только смыслом последнего числа. Оплата в одну копейку давала ровно тот же
   * ключ, что событие номер один, — и на обновлении существующей очереди первое
   * же новое задание считалось бы уже выполненным. Сообщения не удаляются,
   * поэтому прежние ключи живут вечно и обязаны не пересекаться с новыми.
   */
  return `${ORDER_FINANCE_TOPIC}:payment:${orderId}:event:${generation}`;
}

/**
 * Ключ задания на снятие денег отменённого заказа.
 *
 * В ключ входит НОМЕР отмены, а не только заказ. Отмену в источнике снимают
 * и ставят заново: заказ возвращается в работу, получает новую доставку —
 * а с ней наличные, оплату заказа и километры. Ключ из одного заказа был бы
 * занят навсегда, повторная отмена не поставила бы задания вовсе, и эти новые
 * деньги так и остались бы за курьером по отменённому заказу. Сообщения
 * очереди не удаляются, поэтому «занят навсегда» здесь буквально.
 *
 * Оплаченная попытка в этот список НЕ входит ни при первой отмене, ни при
 * повторной: отмена заказа снимает только начисленное системой (`SYSTEM`),
 * а попытка состоялась и оплачена логистом отдельным решением.
 *
 * Номер, а не момент времени: два события отмены обязаны различаться даже
 * тогда, когда часы отдали одно и то же значение.
 */
export function cancellationJobKey(orderId: string, generation: number): string {
  return `${ORDER_FINANCE_TOPIC}:cancel:${orderId}:${generation}`;
}

/** Ключ самой корректирующей записи: одна на попытку и состояние оплаты. */
export function cashCorrectionEntryKey(attemptId: string, payedSumMinor: bigint): string {
  return `cash-correction:${attemptId}:${payedSumMinor.toString()}`;
}

export async function enqueueCashPaymentCorrection(
  tx: TransactionClient,
  input: { orderId: string; generation: number },
): Promise<void> {
  await enqueueOutbox(tx, {
    topic: ORDER_FINANCE_TOPIC,
    idempotencyKey: cashCorrectionJobKey(input.orderId, input.generation),
    payload: { reason: 'PAYMENT', orderId: input.orderId },
  });
}

export async function enqueueCancelledOrderFinance(
  tx: TransactionClient,
  input: { orderId: string; generation: number },
): Promise<void> {
  await enqueueOutbox(tx, {
    topic: ORDER_FINANCE_TOPIC,
    idempotencyKey: cancellationJobKey(input.orderId, input.generation),
    payload: { reason: 'CANCEL', orderId: input.orderId },
  });
}

/** Рубли из копеек для человекочитаемой причины в журнале. */
function rubles(minor: bigint): string {
  const value = minor < 0n ? -minor : minor;
  const whole = value / 100n;
  const cents = value % 100n;
  return `${whole.toString()},${cents.toString().padStart(2, '0')} ₽`;
}

/**
 * Уменьшение наличных за курьером после оплаты заказа в источнике.
 *
 * Считается не «сколько доплатили», а «сколько наличных должно остаться»:
 * остаток = сумма заказа − оплачено, но не меньше нуля и не больше того, что
 * когда-то начислили. Уже снятое учитывается, поэтому повторная синхронизация и
 * частичные оплаты подряд не снимают одно и то же дважды, а переплата не уводит
 * остаток в минус.
 *
 * Обратного хода нет: если оплату в источнике уменьшат, снятое не возвращается
 * само — это отдельное решение человека, а не молчаливое действие обмена.
 */
export async function applyCashPaymentCorrection(
  tx: TransactionClient,
  input: { orderId: string; now: Date },
): Promise<boolean> {
  /*
   * Строка заказа блокируется ПЕРВОЙ.
   *
   * Ту же строку блокируют импорт и начисление доставки. Без этого обработчик
   * мог прочитать ещё пустой журнал незавершённой доставки, успешно завершиться
   * и стать DONE, а начисление появлялось бы следом — по старой оплате и уже
   * некому его поправить. Под общей блокировкой обработчик либо ждёт доставку и
   * видит её записи, либо отрабатывает раньше, а доставка считает уже по новой
   * оплате.
   */
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;

  const order = await tx.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: {
      externalName: true,
      sumMinor: true,
      payedSumMinor: true,
      cancelledInSource: true,
    },
  });
  if (order === null) {
    return false;
  }

  /*
   * У отменённого заказа финансового результата уже нет: он снят целиком.
   * Оплата, пришедшая после отмены, ничего не меняет — итог остаётся нулевым.
   */
  if (order.cancelledInSource) {
    return false;
  }

  // Наличные бывают только по успешной доставке: корректировать нечего, пока
  // начисления нет.
  const accrued = await tx.courierLedgerEntry.findMany({
    where: {
      orderId: input.orderId,
      kind: 'CASH_RECEIVED',
      reversedBy: { is: null },
    },
    select: {
      amountMinor: true,
      attemptId: true,
      courierUserId: true,
      routeId: true,
    },
  });

  const outstanding = order.sumMinor - order.payedSumMinor;
  const remaining = outstanding > 0n ? outstanding : 0n;

  let changed = false;
  for (const entry of accrued) {
    if (entry.attemptId === null) {
      continue;
    }

    // Снятое ранее по этой же попытке: суммы отрицательные, берём величину.
    const corrections = await tx.courierLedgerEntry.aggregate({
      where: {
        attemptId: entry.attemptId,
        kind: 'CASH_PAYMENT_CORRECTION',
        reversedBy: { is: null },
      },
      _sum: { amountMinor: true },
    });
    const alreadyRemoved = -(corrections._sum.amountMinor ?? 0n);

    // Остаток не может превышать когда-то начисленное: предоплату, которую и
    // так не начисляли, второй раз не вычитаем.
    const target = remaining < entry.amountMinor ? remaining : entry.amountMinor;
    const delta = entry.amountMinor - alreadyRemoved - target;
    if (delta <= 0n) {
      continue;
    }

    /*
     * Менялся ли журнал — решает ЗАПИСЬ, а не намерение её создать.
     *
     * Ключ корректировки одинаков для попытки и состояния оплаты. Если
     * предыдущую корректировку человек отменил, она перестаёт учитываться
     * в `alreadyRemoved`, и `delta` снова окажется положительной — но запись
     * по этому ключу уже существует, и новой не появится. Сообщать отчёту
     * «журнал изменился» в таком случае значило бы звать его перечитывать
     * то, что не менялось.
     */
    const { created } = await appendLedgerEntry(tx, {
      courierUserId: entry.courierUserId,
      kind: 'CASH_PAYMENT_CORRECTION',
      amountMinor: delta,
      operationDate: moscowCalendarDate(input.now),
      actorUserId: entry.courierUserId,
      reason: `Корректировка наличных: оплата в МойСклад. Заказ ${order.externalName}, ${rubles(delta)}`,
      routeId: entry.routeId,
      orderId: input.orderId,
      attemptId: entry.attemptId,
      idempotencyKey: cashCorrectionEntryKey(entry.attemptId, order.payedSumMinor),
    });
    changed = changed || created;
  }

  return changed;
}

/**
 * Снятие финансового результата отменённого заказа.
 *
 * Каждое начисление этой доставки получает связанную обратную запись: наличные,
 * оплата доставки, километры за МКАД и уже сделанные корректировки наличных.
 * В сумме вклад заказа становится нулевым — ни плюса, ни минуса, — а история
 * показывает и исходные суммы, и их снятие.
 *
 * ДЕНЬ УЧЁТА СТОРНО — день исходной записи (решение владельца, 24.09.2026).
 * Курьер отметил заказ доставленным, а спустя дни заказ отменили в МоемСкладе:
 * начисления снимаются в тех днях, где были учтены. Отчёт за день доставки
 * показывает по заказу нули по наличным, оплате работы и километрам, а день
 * обработки отмены отдельного минуса не получает. У корректировки оплаты и
 * пересчитанных километров свои дни — каждая снимается в своём. Историческая
 * дата стоит только на самих обратных записях: реальное время их появления,
 * аудит и отметка снятия попытки (`financeStrippedAt`) — фактические.
 *
 * Снимается только НАЧИСЛЕННОЕ СИСТЕМОЙ. Начальный долг, фактические передачи
 * денег курьер ↔ логист и ручные операции логиста — в том числе привязанные
 * к попытке — остаются как были: эти деньги курьер уже потратил или заработал,
 * и отмена заказа в источнике их не возвращает. Поэтому вклад отменённого
 * заказа равен нулю ровно в той части, которую начислила система; одобренный
 * человеком расход в нём остаётся и снимается только тем же человеком.
 * Физическая доставка не отменяется: снимаются только деньги.
 */
export async function stripCancelledOrderFinance(
  tx: TransactionClient,
  input: { orderId: string; now: Date },
): Promise<boolean> {
  // Та же блокировка, что у доставки и импорта: снимать нужно ПОСЛЕ того, как
  // параллельная доставка зафиксировала свои начисления, иначе снимать нечего.
  await tx.$queryRaw`SELECT "id" FROM "DeliveryOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`;

  /*
   * Заказ обязан быть отменён ПРЯМО СЕЙЧАС, а не в момент постановки задания.
   *
   * Задание выполняется отдельно и при неудачах откладывается с отсрочкой до
   * пятнадцати минут. За это время отмену в источнике успевают снять: заказ
   * возвращается в работу, и снимать его деньги уже не за что. Соседние
   * обработчики эту проверку делают (`applyCashPaymentCorrection`,
   * `accrueDeliveryResult`), а снятие — не делало.
   */
  const order = await tx.deliveryOrder.findUnique({
    where: { id: input.orderId },
    select: { cancelledInSource: true },
  });
  if (order === null || !order.cancelledInSource) {
    return false;
  }

  /*
   * Отмена закрывает финансовый результат КАЖДОЙ доставки заказа — независимо
   * от того, осталось ли что сторнировать.
   *
   * Попытку могли обнулить раньше (например, километры исправили в ноль). Тогда
   * непогашенных записей нет, сторно не создаётся — и признак снятия, выведенный
   * из обратных записей, не появлялся вовсе. После снятия отмены правка
   * километров возвращала такой попытке деньги.
   */
  const delivered = await tx.deliveryAttempt.findMany({
    where: { orderId: input.orderId, activeKey: { not: null }, outcome: 'DELIVERED' },
    select: { id: true },
  });
  if (delivered.length > 0) {
    await tx.deliveryAttempt.updateMany({
      where: { id: { in: delivered.map((attempt) => attempt.id) } },
      // Фактическое время обработки отмены: отметка — событие, а не день учёта.
      data: { financeStrippedAt: input.now },
    });
  }

  const entries = await tx.courierLedgerEntry.findMany({
    where: {
      orderId: input.orderId,
      attemptId: { not: null },
      kind: { not: 'ADJUSTMENT' },
      reversedBy: { is: null },
    },
    select: { attemptId: true, courierUserId: true },
  });

  const attempts = new Map<string, string>();
  for (const entry of entries) {
    if (entry.attemptId !== null && !attempts.has(entry.attemptId)) {
      attempts.set(entry.attemptId, entry.courierUserId);
    }
  }

  /*
   * Изменением считается СНЯТАЯ запись, а не найденная попытка.
   *
   * Снимается только начисленное системой, а попытки ищутся шире — по любой
   * непогашенной записи. У заказа, где осталась лишь ручная операция логиста,
   * попытка нашлась бы, снимать было бы нечего, а отчёт получал бы событие
   * «журнал изменился» и перечитывался у всех открытых вкладок.
   */
  let reversed = false;
  for (const [attemptId, courierUserId] of attempts) {
    const done = await reverseDeliveryAccruals(tx, {
      attemptId,
      actorUserId: courierUserId,
      reason: 'Отмена в МойСклад: заказ исключён из расчётов с курьером',
      /*
       * Каждое сторно — в дне снятой им записи, а не в дне обработки отмены.
       * Так снимается и всё, что уже начислено и скорректировано ранее: у
       * каждой записи свой день, и вклад заказа обнуляется в каждом из них.
       */
      dating: { kind: 'ORIGINAL_DAY' },
      /*
       * Ручное решение логиста остаётся: расход курьер уже понёс, доплату
       * заработал, и отмена заказа в источнике их не возвращает.
       */
      scope: 'SYSTEM',
    });
    reversed = reversed || done;
  }

  return reversed;
}

export interface OrderFinanceHandlerDeps {
  now?: () => Date;
}

/**
 * Обработчик задания: выполняется в транзакции воркера, уже после фиксации
 * импорта, поэтому читает окончательное состояние заказа.
 */
export function createOrderFinanceHandler(deps: OrderFinanceHandlerDeps = {}): OutboxHandler {
  const now = deps.now ?? ((): Date => new Date());

  return async (message, tx) => {
    if (tx === undefined) {
      return;
    }

    const payload = message.payload as { reason?: unknown; orderId?: unknown };
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (orderId === null) {
      return;
    }

    const at = now();
    const changed =
      payload.reason === 'CANCEL'
        ? await stripCancelledOrderFinance(tx, { orderId, now: at })
        : await applyCashPaymentCorrection(tx, { orderId, now: at });

    /*
     * Открытый отчёт обязан обновиться сам.
     *
     * Событие публикуется В ТОЙ ЖЕ транзакции и только когда журнал
     * действительно изменился: события импорта заказа отчёт не инвалидируют и
     * приходят раньше этого задания. Аудитория — все роли, которым разрешён
     * отчёт расчётов, включая управляющего. В событии — день самого события;
     * какие дни журнала изменились (у отмены заказа это исходные дни
     * начислений), отчёт узнаёт, перечитав себя целиком.
     */
    if (changed) {
      await publishRealtimeEvent(tx, {
        topic: 'finance.ledger_changed',
        payload: { operationDate: moscowCalendarDate(at) },
        audienceRoles: ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'],
      });
    }
  };
}
