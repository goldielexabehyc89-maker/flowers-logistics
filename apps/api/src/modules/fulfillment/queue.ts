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
}

export interface QueueRoute {
  id: string;
  number: string;
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

/** Ключ сортировки маршрутной группы: раньше время первой доставки — раньше группа. */
function compareRoutes(a: QueueRoute, b: QueueRoute): number {
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
     * Раньше по дате — раньше в списке.
     *
     * Сравнение включается только там, где список охватывает несколько дней
     * («Мои заказы» без границы дня). Внутри одного дня даты равны, и правило
     * ничего не меняет: приоритет листов и срочность работают как прежде.
     * Вчерашний невыполненный заказ обязан стоять выше завтрашнего — иначе
     * просроченная работа уезжает вниз именно тогда, когда она горит.
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

    const aRoute = a.route;
    const bRoute = b.route;

    // Любой заказ подтверждённого листа идёт раньше любого заказа без листа.
    if ((aRoute === null) !== (bRoute === null)) {
      return aRoute === null ? 1 : -1;
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
