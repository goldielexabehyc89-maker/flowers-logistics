/**
 * Автоматическая разбивка выбранных сделок на несколько черновиков.
 *
 * Здесь только правила, без React и без сети: как разобрать введённые логистом
 * параметры, каким получится запрос к решателю и что означает очередное
 * состояние запуска.
 *
 * Число машин и вместимость логист указывает сам, перед запуском. Значения
 * по умолчанию здесь нет намеренно: подставленное «сколько-нибудь» — это
 * скрытое бизнес-решение, принятое за человека, и план вышел бы из числа,
 * которого никто не выбирал.
 *
 * Расчёт остаётся двухфазным на сервере — превью, затем применение, — но
 * логист этих стадий не видит. Он выбирает заказы и получает готовые
 * черновики; технический запуск в интерфейс не всплывает.
 */

export type VehicleType = 'CAR' | 'FOOT';

export interface SlotRequest {
  courierUserId: string | null;
  vehicleType: VehicleType;
  /** Вместимость в заказах: один заказ — одна единица. */
  capacityOrders: number;
}

/** Верхние границы. Совпадают с серверными: отказ после ожидания расчёта хуже. */
export const MAX_SLOTS = 50;
export const MAX_CAPACITY = 500;

export interface SplitParams {
  vehicles: number;
  capacityOrders: number;
}

export type SplitParamsResult =
  | { ok: true; value: SplitParams }
  | { ok: false; vehicles: string | null; capacityOrders: string | null };

/**
 * Разбор одного поля.
 *
 * Отклоняются пустое, ноль, отрицательное и дробное. Дробное — отдельный
 * случай: `Number('2.5')` даёт число, и без явной проверки «две с половиной
 * машины» ушли бы на сервер.
 */
function parseCount(raw: string, max: number, unit: string): { value: number } | { error: string } {
  const text = raw.trim();
  if (text === '') {
    return { error: 'Укажите значение.' };
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return { error: 'Введите целое число.' };
  }
  if (!Number.isInteger(parsed)) {
    return { error: 'Введите целое число, без дробной части.' };
  }
  if (parsed < 1) {
    return { error: 'Значение должно быть больше нуля.' };
  }
  if (parsed > max) {
    return { error: `Не больше ${max} ${unit}.` };
  }
  return { value: parsed };
}

/** Разбирает оба поля сразу: логист должен увидеть все ошибки, а не первую. */
export function parseSplitParams(input: {
  vehicles: string;
  capacityOrders: string;
}): SplitParamsResult {
  const vehicles = parseCount(input.vehicles, MAX_SLOTS, 'машин');
  const capacity = parseCount(input.capacityOrders, MAX_CAPACITY, 'заказов');

  if ('value' in vehicles && 'value' in capacity) {
    return { ok: true, value: { vehicles: vehicles.value, capacityOrders: capacity.value } };
  }

  return {
    ok: false,
    vehicles: 'error' in vehicles ? vehicles.error : null,
    capacityOrders: 'error' in capacity ? capacity.error : null,
  };
}

/**
 * Слоты машин для решателя.
 *
 * Ровно столько машин, сколько указал логист, — число не выводится из размера
 * выбора и ниоткуда больше. Поле называется `capacityOrders`, а не `capacity`:
 * прежний клиент слал второе, и сервер отвергал запрос ещё до расчёта.
 */
export function buildSlots(input: SplitParams & { vehicleType: VehicleType }): SlotRequest[] {
  return Array.from({ length: input.vehicles }, () => ({
    courierUserId: null,
    vehicleType: input.vehicleType,
    capacityOrders: input.capacityOrders,
  }));
}

/**
 * Хватит ли указанной вместимости на выбранные заказы.
 *
 * Это предупреждение, а не запрет: решатель сам отправит лишние заказы
 * в неразмещённые, и отдельное согласие на них уже спрашивается. Но сказать
 * об этом до ожидания расчёта честнее, чем после.
 */
export function capacityShortfall(orderCount: number, params: SplitParams): number {
  return Math.max(0, orderCount - params.vehicles * params.capacityOrders);
}

export type PlanRunState = 'QUEUED' | 'COMPUTING' | 'PREVIEW' | 'APPLIED' | 'FAILED' | 'EXPIRED';

export interface PlanRunView {
  id: string;
  state: PlanRunState;
  version: number;
  routeIds: string[];
  preview: { unassignedOrderIds: string[] } | null;
}

export type SplitPhase =
  /** Решатель ещё считает: ждём, оставаясь в «Сделках». */
  | { kind: 'RUNNING' }
  /** Всё разместилось: можно применять без вопросов. */
  | { kind: 'READY' }
  /** Часть заказов никто не повезёт: нужно отдельное согласие человека. */
  | { kind: 'NEEDS_CONSENT'; unassignedCount: number }
  /** Расчёт отказал либо превью снято. */
  | { kind: 'FAILED' };

/**
 * Что означает текущее состояние запуска.
 *
 * Неразмещённые заказы не проходят молча: заказ, который никто не повезёт,
 * логист обязан увидеть до создания черновиков, а не вечером.
 */
export function splitPhase(run: PlanRunView): SplitPhase {
  switch (run.state) {
    case 'QUEUED':
    case 'COMPUTING':
      return { kind: 'RUNNING' };
    case 'PREVIEW': {
      const unassigned = run.preview?.unassignedOrderIds ?? [];
      return unassigned.length > 0
        ? { kind: 'NEEDS_CONSENT', unassignedCount: unassigned.length }
        : { kind: 'READY' };
    }
    case 'APPLIED':
      return { kind: 'READY' };
    default:
      return { kind: 'FAILED' };
  }
}

// --- Ход разбивки -----------------------------------------------------------

/** Как часто спрашивать готовность расчёта и сколько всего его ждать. */
export const SPLIT_POLL_MS = 1500;
export const SPLIT_TIMEOUT_MS = 120_000;

export interface SplitClient {
  start: (body: {
    deliveryDate: string;
    orderIds: string[];
    slots: SlotRequest[];
  }) => Promise<PlanRunView>;
  read: (runId: string) => Promise<PlanRunView>;
  apply: (
    runId: string,
    body: { expectedVersion: number; allowUnassigned: boolean },
  ) => Promise<PlanRunView>;
}

export interface SplitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type SplitOutcome =
  | { kind: 'CONSENT'; run: PlanRunView; unassignedCount: number }
  | { kind: 'APPLIED'; run: PlanRunView };

/**
 * Весь ход разбивки одним местом.
 *
 * Вынесен из компонента, чтобы поведение можно было доказать без браузера:
 * отказ сервера, ограниченное ожидание и согласие на частичный результат —
 * это правила, а не разметка.
 *
 * Отказ на любом шаге пробрасывается как есть и НЕ превращается в частичный
 * успех: черновики создаёт только явный `apply`. Поэтому упавший расчёт
 * не может увести логиста в «Маршрутизацию».
 */
export async function runAutoSplit(
  client: SplitClient,
  input: {
    deliveryDate: string;
    orderIds: string[];
    params: SplitParams;
    vehicleType: VehicleType;
  },
  clock: SplitClock,
): Promise<SplitOutcome> {
  const started = await client.start({
    deliveryDate: input.deliveryDate,
    orderIds: input.orderIds,
    slots: buildSlots({ ...input.params, vehicleType: input.vehicleType }),
  });

  const ready = await awaitPreview(client, started.id, clock);
  const phase = splitPhase(ready);

  if (phase.kind === 'FAILED') {
    throw new Error('Расчёт не удался. Проверьте условия и повторите.');
  }
  if (phase.kind === 'NEEDS_CONSENT') {
    return { kind: 'CONSENT', run: ready, unassignedCount: phase.unassignedCount };
  }

  const applied = await client.apply(ready.id, {
    expectedVersion: ready.version,
    allowUnassigned: false,
  });
  return { kind: 'APPLIED', run: applied };
}

/**
 * Ожидание готового превью.
 *
 * Ограничено по времени намеренно: висящая без объяснения кнопка хуже честного
 * отказа. Запуск при этом не теряется — он остаётся в истории расчётов.
 */
export async function awaitPreview(
  client: Pick<SplitClient, 'read'>,
  runId: string,
  clock: SplitClock,
): Promise<PlanRunView> {
  const deadline = clock.now() + SPLIT_TIMEOUT_MS;

  for (;;) {
    const run = await client.read(runId);
    if (splitPhase(run).kind !== 'RUNNING') {
      return run;
    }
    if (clock.now() >= deadline) {
      throw new Error(
        'Расчёт идёт дольше обычного. Он не потерян: откройте его позже или повторите.',
      );
    }
    await clock.sleep(SPLIT_POLL_MS);
  }
}

/**
 * Что делать с отказом разбивки.
 *
 * Правило вынесено отдельно, потому что все четыре его части легко нарушить
 * незаметно: снять выбор «на всякий случай», увести на пустую «Маршрутизацию»,
 * оставить кнопку в вечном ожидании или показать техническую строку вместо
 * причины.
 */
export interface SplitFailureEffect {
  /** Текст для человека. Сообщение сервера сохраняется, если оно есть. */
  message: string;
  /** Выбор остаётся: логист исправляет условия и повторяет с тем же набором. */
  keepSelection: true;
  /** Переход в «Маршрутизацию» не происходит: черновиков не создано. */
  navigate: false;
  /** Ожидание закончено, кнопка снова доступна. */
  busy: false;
}

export function splitFailure(error: unknown): SplitFailureEffect {
  const message =
    typeof (error as { message?: unknown })?.message === 'string' &&
    (error as { message: string }).message.trim() !== ''
      ? (error as { message: string }).message
      : 'Расчёт не запущен: проверьте выбор и настройки.';

  return { message, keepSelection: true, navigate: false, busy: false };
}

/**
 * Куда вести после применения.
 *
 * В «Маршрутизации» раскрывается первый созданный черновик: логист попадает
 * в работу, а не в общий список, где свой результат пришлось бы искать.
 * Пустой набор означает, что применение ничего не создало, — вести некуда.
 */
export function firstDraftId(run: PlanRunView): string | null {
  return run.routeIds[0] ?? null;
}
