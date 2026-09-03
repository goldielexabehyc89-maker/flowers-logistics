/**
 * Порядок очереди флориста.
 *
 * Функция чистая и работает с уже прочитанными строками, а не с SQL. Причина
 * не в удобстве: правило приоритета — групповое, и выразить его сортировкой
 * базы значило бы посчитать для каждого заказа время первой доставки его
 * маршрута подзапросом и надеяться, что план не изменится. Очередь одного дня
 * ограничена сотнями строк, поэтому порядок считается в памяти и полностью
 * покрывается проверками.
 *
 * ПРАВИЛО ПРИОРИТЕТА (`FUL-002` §2.4 и §2.4.1).
 *
 * Сначала — целыми группами подтверждённых маршрутных листов:
 *
 *   1. все несобранные заказы самого раннего подтверждённого листа;
 *   2. затем все заказы следующего листа, и так далее;
 *   3. только после маршрутов — заказы без подтверждённого листа по обычной
 *      срочности.
 *
 * Заказ более позднего листа НЕ поднимается выше оставшегося заказа более
 * раннего листа, даже если его собственное время ближе. Цель — последовательно
 * подготовить к выдаче полный ранний маршрут, а не получить несколько
 * наполовину собранных.
 *
 * Внутри листа порядок — порядок остановок маршрута, а не срочность: курьер
 * поедет именно так.
 *
 * ОБЫЧНАЯ СРОЧНОСТЬ (для заказов без подтверждённого листа):
 * просроченные сверху, затем ближайшее время начала, затем заказы без времени,
 * стабильный tie-break по номеру заказа.
 */

import { moscowDayRange } from '@fl/shared';

/** Заказ очереди в том виде, в каком его сортируют. */
export interface QueueOrder {
  id: string;
  /** Номер заказа МоегоСклада: стабильный tie-break и человеческий ключ. */
  externalName: string;
  /**
   * Календарный день доставки. Нужен там, где список охватывает несколько дней.
   *
   * Необязателен: очередь одного дня о нём не спрашивает — там он у всех
   * одинаковый, и сравнивать нечего.
   */
  deliveryDate?: string | null;
  /** Минуты от полуночи Москвы. `null` — время не задано. */
  startMinute: number | null;
  endMinute: number | null;
  /** Подтверждённый маршрутный лист, если заказ в него включён. */
  route: QueueRoute | null;
  /** Позиция остановки внутри маршрута, начиная с 1. */
  routePosition: number | null;
  /**
   * Самовывоз, до начала которого осталось меньше часа.
   *
   * Считается сервером по полному набору очереди и по абсолютному моменту, а
   * не по календарному дню: заказ на 00:30 обязан подняться в 23:31 накануне.
   */
  pickupSoon: boolean;
  /**
   * Момент возврата в очередь из карантина «Нет цветов». `null`/undefined —
   * заказ не возвращался. Возвращённые встают В КОНЕЦ очереди (после всех
   * обычных), между собой — по времени возврата. Один ключ читают и список,
   * и авто-раздача.
   */
  requeuedAt?: string | null;
}

export interface QueueRoute {
  id: string;
  number: string;
  /**
   * День листа.
   *
   * Очередь показывает и вчерашние невыполненные заказы, поэтому в списке
   * встречаются листы разных дней. Без даты сравнение шло по одному лишь
   * времени суток, и вчерашний лист на 14:00 вставал ниже сегодняшнего
   * на 10:00 — при том что машина по нему ждёт со вчера.
   */
  deliveryDate: string;
  /**
   * Время первой запланированной доставки маршрута.
   *
   * Именно оно определяет «самый ранний лист». `null` означает, что ни у одной
   * остановки маршрута времени нет: такой лист идёт после листов со временем,
   * но всё равно раньше заказов без листа вовсе.
   */
  firstStopMinute: number | null;
}

/**
 * Эффективное время заказа.
 *
 * Ручной интервал логиста перекрывает исходный текст МоегоСклада: он и есть
 * то, о чём договорились с клиентом. Точное время — интервал нулевой ширины,
 * достраивать из него диапазон запрещено.
 */
export function effectiveMinutes(order: {
  intervalKind: string;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
}): { startMinute: number | null; endMinute: number | null } {
  if (order.manualIntervalStartMinute !== null && order.manualIntervalEndMinute !== null) {
    return {
      startMinute: order.manualIntervalStartMinute,
      endMinute: order.manualIntervalEndMinute,
    };
  }
  if (order.intervalKind === 'RANGE' || order.intervalKind === 'EXACT') {
    return {
      startMinute: order.intervalStartMinute,
      // У точного времени конца нет: интервал нулевой ширины.
      endMinute: order.intervalEndMinute ?? order.intervalStartMinute,
    };
  }
  return { startMinute: null, endMinute: null };
}

/**
 * Окно приоритета самовывоза в минутах.
 *
 * Ровно час — уже НЕ «ближайший»: условие строгое. Граница выбрана владельцем
 * и одна на сервер и проверки, чтобы «меньше часа» не разошлось с «не позже
 * часа» между двумя местами.
 */
export const PICKUP_SOON_WINDOW_MINUTES = 60;

/**
 * Ближайший ли это самовывоз.
 *
 * Сравниваются абсолютные моменты, а не минуты внутри дня: до начала интервала
 * может лежать полночь, и разница «12:00 минус 23:31» внутри суток дала бы
 * почти сутки вместо пятидесяти девяти минут.
 *
 * Начало, которое уже наступило, из группы не выводит. Просроченный самовывоз
 * ждёт человека у прилавка прямо сейчас — опустить его вниз значит потерять
 * единственный заказ, у которого срок уже вышел.
 *
 * Заказ без распознанного начала интервала в группу не попадает: «когда-нибудь
 * сегодня» не является ближайшим часом.
 */
export function isPickupSoon(
  order: {
    /** Способ получения — самовывоз. Определяется точным справочником. */
    pickup: boolean;
    cancelled: boolean;
    deliveryDate: string | null;
    startMinute: number | null;
  },
  now: Date,
): boolean {
  if (!order.pickup || order.cancelled) {
    return false;
  }
  if (order.deliveryDate === null || order.startMinute === null) {
    return false;
  }
  const startsAt = moscowDayRange(order.deliveryDate).from.getTime() + order.startMinute * 60_000;
  return startsAt - now.getTime() < PICKUP_SOON_WINDOW_MINUTES * 60_000;
}

/**
 * Просрочен ли заказ.
 *
 * Считается только для просматриваемого дня, равного сегодняшнему: у завтрашних
 * заказов просрочки не бывает по определению, а вчерашние в очередь не попадают.
 * Сравниваются минуты внутри дня — часовой пояс в них не участвует, поэтому
 * результат не зависит от `TZ` сервера.
 */
export function isOverdue(
  order: { endMinute: number | null; deliveryDate?: string | null },
  context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number },
): boolean {
  /*
   * Заказ прошлого дня просрочен целиком.
   *
   * Время внутри дня здесь уже не при чём: день кончился, а заказ остался
   * несобранным. Он попадает в «Сегодня» именно поэтому и обязан быть
   * помечен — иначе неотличим от сегодняшней работы.
   */
  if (
    order.deliveryDate !== undefined &&
    order.deliveryDate !== null &&
    order.deliveryDate < context.todayMoscow
  ) {
    return true;
  }
  if (context.viewDate !== context.todayMoscow) {
    return false;
  }
  return order.endMinute !== null && order.endMinute < context.nowMinuteMoscow;
}

/** Ключ сортировки маршрутной группы: раньше день и время первой доставки — раньше группа. */
function compareRoutes(a: QueueRoute, b: QueueRoute): number {
  // День решает раньше времени суток: вчерашний лист горит сильнее сегодняшнего.
  if (a.deliveryDate !== b.deliveryDate) {
    return a.deliveryDate.localeCompare(b.deliveryDate);
  }
  const aMinute = a.firstStopMinute;
  const bMinute = b.firstStopMinute;
  if (aMinute !== bMinute) {
    // Лист без времени идёт после листов со временем, но остаётся выше
    // заказов, не включённых ни в один подтверждённый лист.
    if (aMinute === null) return 1;
    if (bMinute === null) return -1;
    return aMinute - bMinute;
  }
  // Стабильный порядок при равном времени — по номеру листа.
  return a.number.localeCompare(b.number, 'ru');
}

/**
 * Обычная срочность: просроченные, затем ближайшее время, затем без времени.
 */
function compareUrgency(
  a: QueueOrder,
  b: QueueOrder,
  context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number },
): number {
  const aOverdue = isOverdue(a, context);
  const bOverdue = isOverdue(b, context);
  if (aOverdue !== bOverdue) {
    return aOverdue ? -1 : 1;
  }

  if (a.startMinute !== b.startMinute) {
    // Заказы без времени — внизу, а не в начале: `null` не является «ноль часов».
    if (a.startMinute === null) return 1;
    if (b.startMinute === null) return -1;
    return a.startMinute - b.startMinute;
  }

  return a.externalName.localeCompare(b.externalName, 'ru');
}

/**
 * Порядок внутри группы ближайших самовывозов.
 *
 * Самый ранний сверху по ПОЛНОЙ дате и времени: в группе одновременно бывают
 * сегодняшний вечерний заказ и завтрашний ночной. Устойчивый добор — по
 * номеру заказа, чтобы порядок не менялся между двумя одинаковыми запросами.
 */
function comparePickupSoon(a: QueueOrder, b: QueueOrder): number {
  const aDate = a.deliveryDate ?? null;
  const bDate = b.deliveryDate ?? null;
  if (aDate !== bDate) {
    if (aDate === null) return 1;
    if (bDate === null) return -1;
    return aDate.localeCompare(bDate);
  }
  if (a.startMinute !== b.startMinute) {
    if (a.startMinute === null) return 1;
    if (b.startMinute === null) return -1;
    return a.startMinute - b.startMinute;
  }
  return a.externalName.localeCompare(b.externalName, 'ru');
}

/**
 * Итоговый порядок очереди.
 *
 * Сортировка не мутирует вход: очередь строится заново при каждом запросе,
 * и молчаливое изменение чужого массива здесь было бы источником неповторимых
 * расхождений между списком и карточкой.
 */
export function sortQueue(
  orders: readonly QueueOrder[],
  context: { viewDate: string; todayMoscow: string; nowMinuteMoscow: number },
): QueueOrder[] {
  return [...orders].sort((a, b) => {
    /*
     * Возвращённые из карантина «Нет цветов» — в КОНЕЦ очереди, ниже всего
     * остального (включая ближайшие самовывозы и маршрутные листы).
     *
     * Менеджер намеренно отправил такой заказ в хвост: сразу вернувшись наверх,
     * он тут же выхватил бы следующего флориста и остановил уже его работу.
     * Между собой возвращённые идут по времени возврата (кого раньше вернули —
     * выше). Один и тот же ключ читают и этот список, и авто-раздача.
     */
    const aReq = a.requeuedAt ?? null;
    const bReq = b.requeuedAt ?? null;
    if ((aReq === null) !== (bReq === null)) {
      return aReq === null ? -1 : 1;
    }
    if (aReq !== null && bReq !== null && aReq !== bReq) {
      return aReq.localeCompare(bReq);
    }

    /*
     * Ближайшие самовывозы — выше всего остального, включая маршрутные листы.
     *
     * За таким заказом человек уже едет или стоит у прилавка, и собрать его
     * позже некому: курьерский заказ ждёт машину, а самовывоз — покупателя.
     */
    if (a.pickupSoon !== b.pickupSoon) {
      return a.pickupSoon ? -1 : 1;
    }
    if (a.pickupSoon && b.pickupSoon) {
      return comparePickupSoon(a, b);
    }

    const aRoute = a.route;
    const bRoute = b.route;

    /*
     * Заказы подтверждённых листов идут первыми — раньше любых других,
     * включая просроченные.
     *
     * Лист уже назначен курьеру и ждёт отгрузки: не собранный вовремя заказ
     * задержит весь лист и всех, кто в нём едет. Просроченный заказ без листа
     * горит только сам за себя, поэтому уступает.
     *
     * Сравнение стоит ВЫШЕ сравнения по дате намеренно. Прежде дата решала
     * первой, и вчерашняя просрочка выдавливала сегодняшний лист на вторую
     * страницу — флорист не видел работы, которая держит машину.
     */
    if ((aRoute === null) !== (bRoute === null)) {
      return aRoute === null ? 1 : -1;
    }

    /*
     * Раньше по дате — раньше в списке.
     *
     * Сравнение включается только там, где список охватывает несколько дней
     * («Мои заказы» без границы дня). Внутри одного дня даты равны, и правило
     * ничего не меняет. Среди заказов БЕЗ листа вчерашний невыполненный
     * обязан стоять выше завтрашнего — иначе просроченная работа уезжает
     * вниз именно тогда, когда она горит.
     */
    if (a.deliveryDate !== undefined && b.deliveryDate !== undefined) {
      const left = a.deliveryDate;
      const right = b.deliveryDate;
      if (left !== right) {
        // Заказ без даты — в конец: «нет даты» не значит «сегодня».
        if (left === null) return 1;
        if (right === null) return -1;
        return left.localeCompare(right);
      }
    }

    if (aRoute !== null && bRoute !== null) {
      if (aRoute.id !== bRoute.id) {
        const byRoute = compareRoutes(aRoute, bRoute);
        if (byRoute !== 0) {
          return byRoute;
        }
        // Два разных листа с одинаковым временем и номером невозможны:
        // номер уникален. Сравнение по идентификатору остаётся страховкой
        // от нестабильного порядка.
        return aRoute.id.localeCompare(bRoute.id);
      }
      // Внутри листа — порядок остановок, а не срочность.
      const aPosition = a.routePosition ?? Number.MAX_SAFE_INTEGER;
      const bPosition = b.routePosition ?? Number.MAX_SAFE_INTEGER;
      if (aPosition !== bPosition) {
        return aPosition - bPosition;
      }
      return a.externalName.localeCompare(b.externalName, 'ru');
    }

    return compareUrgency(a, b, context);
  });
}

/**
 * Время первой доставки маршрута по его остановкам.
 *
 * Берётся минимальное время среди остановок, а не время первой по позиции:
 * подтверждённый маршрут может содержать остановку без распознанного времени,
 * и она не должна делать весь лист «без времени».
 */
export function routeFirstStopMinute(
  stops: readonly { startMinute: number | null }[],
): number | null {
  let earliest: number | null = null;
  for (const stop of stops) {
    if (stop.startMinute === null) {
      continue;
    }
    if (earliest === null || stop.startMinute < earliest) {
      earliest = stop.startMinute;
    }
  }
  return earliest;
}

/** Минуты от начала московских суток для абсолютного момента. */
export function moscowMinuteOfDay(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
  const [hours, minutes] = parts.split(':');
  return Number(hours) * 60 + Number(minutes);
}
