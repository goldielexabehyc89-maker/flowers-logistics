/**
 * Правила экрана курьера, вынесенные из компонентов.
 *
 * Здесь только чистые функции и типы: их проверяют тестами без браузера.
 * Ни одна из них не решает, ЧТО показать вместо сервера — они лишь
 * раскладывают уже полученный ответ и считают то, что зависит от часов:
 * досрочность, опоздание и остаток пятиминутного окна.
 *
 * ДЕЙСТВИЕ ТОЛЬКО ONLINE. Клиентской очереди статусов здесь нет и быть
 * не должно: отложенно отправленный результат приехал бы с чужим временем
 * и поверх чужого решения. Отсюда и правило потерянного ответа — сначала
 * перечитать состояние сервера, и только потом показывать исход.
 */

export type DeliveryOutcome = 'DELIVERED' | 'NOT_DELIVERED';
export type CancelKind = 'COURIER_SELF' | 'MANAGER_CORRECTION';

export interface FailureReasonView {
  id: string;
  code: string;
  name: string;
  requiresComment: boolean;
  isActive: boolean;
  version: number;
}

export interface AttemptView {
  id: string;
  outcome: DeliveryOutcome;
  reasonId: string | null;
  reasonName: string | null;
  comment: string | null;
  occurredAt: string;
  courier: { id: string; fullName: string };
  cancellable: boolean;
}

export interface ActiveOrderView {
  /** Заказ отменён: везти его не нужно, надо вернуть на склад. */
  cancelled: boolean;
  routeOrderId: string;
  orderId: string;
  position: number;
  number: string;
  /** Рабочий адрес: правка логиста сильнее исходного значения источника. */
  address: string | null;
  /** Подтверждённая точка. `null` — точки нет, и догадка не подставляется. */
  point: { lat: string; lon: string } | null;
  recipient: string | null;
  comment: string | null;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  cashToCollectMinor: string;
  cashCollectable: boolean;
  result: AttemptView | null;
}

export interface ActiveRouteView {
  routeId: string;
  number: string;
  deliveryDate: string;
  state: string;
  vehicleType: 'CAR' | 'FOOT';
  courier: { id: string; fullName: string } | null;
  orders: ActiveOrderView[];
}

export interface HistoryItemView {
  attemptId: string;
  orderNumber: string;
  routeNumber: string;
  outcome: DeliveryOutcome;
  reasonName: string | null;
  occurredAt: string;
  cancelled: boolean;
  masked: boolean;
  address: string | null;
  recipient: string | null;
  comment: string | null;
}

/** Пять минут — то же число, что и на сервере. Клиент лишь показывает остаток. */
export const CANCEL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Положение заказа во времени относительно обещанного интервала.
 *
 * `early` — предупреждение о ещё не начавшемся интервале: подтвердить всё равно
 * можно, продукт это прямо разрешает. `late` — заказ уже опоздал, но результат
 * тоже не блокируется: запретить курьеру закрыть просроченный заказ значило бы
 * потерять факт доставки.
 */
export type IntervalPosition = 'early' | 'inside' | 'late' | 'unknown';

export function intervalPosition(
  order: Pick<ActiveOrderView, 'intervalStartMinute' | 'intervalEndMinute'>,
  minutesOfDay: number,
): IntervalPosition {
  const { intervalStartMinute: start, intervalEndMinute: end } = order;
  if (start === null && end === null) return 'unknown';
  if (start !== null && minutesOfDay < start) return 'early';
  if (end !== null && minutesOfDay > end) return 'late';
  return 'inside';
}

/** Минуты от полуночи Москвы. Часовой пояс устройства на это не влияет. */
export function moscowMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Сколько миллисекунд осталось курьеру на самостоятельное исправление. */
export function cancelWindowLeftMs(attempt: Pick<AttemptView, 'occurredAt'>, now: Date): number {
  const elapsed = now.getTime() - new Date(attempt.occurredAt).getTime();
  return Math.max(0, CANCEL_WINDOW_MS - elapsed);
}

export interface ResultDraft {
  outcome: DeliveryOutcome | null;
  reasonId: string | null;
  comment: string;
}

/**
 * Можно ли отправлять результат.
 *
 * Возвращает причину отказа, а не булево: интерфейс обязан объяснить курьеру,
 * чего именно не хватает, а не просто погасить кнопку.
 */
export function resultDraftProblem(
  draft: ResultDraft,
  reasons: FailureReasonView[],
): string | null {
  if (draft.outcome === null) return 'Выберите результат.';
  if (draft.outcome === 'DELIVERED') return null;

  if (draft.reasonId === null) return 'Выберите причину недоставки.';
  const reason = reasons.find((entry) => entry.id === draft.reasonId);
  if (reason === undefined || !reason.isActive) return 'Причина недоступна. Обновите список.';
  /*
   * Причина, требующая пояснения, курьеру не предлагается вовсе.
   *
   * Поля комментария в окне нет: у двери человек нажимает кнопку, а не пишет
   * текст. Поэтому такие причины отфильтрованы (`selectableReasons`), а эта
   * проверка остаётся защитой от несогласованного состояния — например,
   * если справочник изменили, пока окно было открыто.
   */
  if (reason.requiresComment && draft.comment.trim() === '') {
    return 'Эта причина требует пояснения и сейчас недоступна.';
  }
  return null;
}

/**
 * Причины, которые показываются курьеру кнопками.
 *
 * Действующие и не требующие пояснения: поля комментария в окне нет, и
 * предлагать причину, которую без текста не принять, значило бы поставить
 * человека у двери в тупик.
 */
export function selectableReasons(reasons: readonly FailureReasonView[]): FailureReasonView[] {
  return reasons.filter((reason) => reason.isActive && !reason.requiresComment);
}

/**
 * Ссылка на Яндекс Карты к подтверждённой точке заказа.
 *
 * `rtext=~lat,lon` означает «маршрут от моего места до этой точки»: курьеру
 * нужен путь, а не булавка на карте. Ключей и подключаемых сценариев здесь
 * нет — обычная ссылка, которую открывает браузер или приложение карт.
 *
 * `null`, если подтверждённой точки нет: вести человека по догаданной
 * координате хуже, чем не дать ссылку вовсе.
 */
export function routeLink(point: { lat: string; lon: string } | null): string | null {
  if (point === null) {
    return null;
  }
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return `https://yandex.ru/maps/?rtext=~${point.lat},${point.lon}&rtt=auto`;
}

/** Сколько заказов маршрута ещё без результата. */
export function remainingOf(route: Pick<ActiveRouteView, 'orders'>): number {
  return route.orders.filter((order) => order.result === null).length;
}

/**
 * Объединённый список курьера, но сгруппированный по маршрутам.
 *
 * Порядок остановок рекомендательный: заказы внутри маршрута идут по позиции,
 * а маршруты — по дате и номеру. Незавершённые маршруты идут раньше: курьеру
 * нужен тот, который ещё нужно везти.
 */
export function groupRoutes(
  routes: ActiveRouteView[],
  filterRouteId: string | null,
): ActiveRouteView[] {
  const visible =
    filterRouteId === null ? routes : routes.filter((r) => r.routeId === filterRouteId);
  return [...visible]
    .map((route) => ({
      ...route,
      orders: [...route.orders].sort((a, b) => a.position - b.position),
    }))
    .sort((a, b) => {
      const left = remainingOf(a) === 0 ? 1 : 0;
      const right = remainingOf(b) === 0 ? 1 : 0;
      if (left !== right) return left - right;
      if (a.deliveryDate !== b.deliveryDate) return a.deliveryDate < b.deliveryDate ? -1 : 1;
      return a.number < b.number ? -1 : 1;
    });
}

/** Устойчивый цвет маршрута: список окрашивается по маршрутам, а не по счётчику. */
export function routeAccent(routeNumber: string): number {
  let hash = 0;
  for (const char of routeNumber) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

/** Сумма к получению из копеек в рубли. Деньги показываются как есть. */
export function formatCash(minor: string): string {
  const value = Number(minor);
  if (!Number.isFinite(value)) return '—';
  return `${(value / 100).toFixed(2)} ₽`;
}

/**
 * Сумма к получению крупно и без копеек, когда их нет.
 *
 * Курьер читает эту строку на ходу, одной рукой держа коробку: «4 990 ₽»
 * схватывается взглядом, «4990.00 ₽» — нет. Копейки показываются только
 * если они есть: дописанные ноли создают вид точности, которой в
 * наличном расчёте не бывает.
 */
export function formatCashToCollect(minor: string): string {
  const value = Number(minor);
  if (!Number.isFinite(value)) return '—';

  const rubles = Math.trunc(value / 100);
  const pennies = Math.abs(value % 100);
  const grouped = rubles.toLocaleString('ru-RU').replace(/\u00A0/g, ' ');
  return pennies === 0 ? `${grouped} ₽` : `${grouped},${String(pennies).padStart(2, '0')} ₽`;
}
