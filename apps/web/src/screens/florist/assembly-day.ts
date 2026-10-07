/**
 * Перечитывание счётчика «В сборке» при смене московского дня.
 *
 * Счётчик учитывает заказы с датой доставки не раньше вчерашнего дня Москвы,
 * поэтому в полночь он меняется сам — без единого изменения данных и без
 * единого события. Ждать постороннего события или действия человека нельзя:
 * открытый экран показывал бы вчерашнее число до утра.
 *
 * КОГДА перечитывать, решает сервер. Вместе с числом он отдаёт окно
 * (`assemblyCounter`): сколько миллисекунд осталось до сдвига границы по его
 * часам. Таймер ставится от момента получения ответа, поэтому часы устройства,
 * их пояс и расхождение с сервером роли не играют: перечитывание приходит
 * на сервер уже после его полуночи. Новый ответ приносит новое окно — и
 * следующий таймер.
 *
 * Обычного таймера мало: у уснувшего ноутбука или телефона он «стоит» вместе
 * с монотонными часами и срабатывает с опозданием на всю длину сна. Поэтому
 * рядом работает сторож по настенным часам: раз в полминуты он сравнивает
 * `Date.now()` со сроком и, если срок прошёл, перечитывает сразу. Сработать
 * может только одно из двух, и только один раз на окно.
 *
 * Перечитывается ровно запрос со счётчиком. Очередь, «Мои заказы», назначения
 * и AUTO-раздача отсюда не трогаются.
 */

/** Окно счётчика из ответа сервера (`fulfillment/shifts.ts`). */
export interface AssemblyCounterWindow {
  /** Самая ранняя учитываемая дата доставки — вчерашний день Москвы. */
  countedFrom: string;
  /** Сколько миллисекунд до сдвига границы по часам сервера. */
  refreshInMs: number;
}

/**
 * Запас после сдвига границы.
 *
 * Сам отсчёт от получения ответа уже опаздывает за серверной полночью на время
 * ответа; запас покрывает дрожание таймеров.
 */
export const ASSEMBLY_REFRESH_MARGIN_MS = 1_000;

/** Как часто сторож сверяется с настенными часами. */
export const ASSEMBLY_WATCHDOG_MS = 30_000;

/**
 * Срок перечитывания по часам устройства.
 *
 * `receivedAt` — когда ответ получен (`dataUpdatedAt` запроса). Окна нет —
 * сроку неоткуда взяться, и перечитывания не будет.
 */
export function assemblyRefreshDeadline(
  counter: AssemblyCounterWindow | undefined,
  receivedAt: number,
): number | null {
  if (counter === undefined || receivedAt <= 0) {
    return null;
  }
  return receivedAt + Math.max(0, counter.refreshInMs) + ASSEMBLY_REFRESH_MARGIN_MS;
}

/**
 * Ставит перечитывание к сроку: таймер плюс сторож по настенным часам.
 *
 * Возвращает отмену. Перечитывание выполняется не больше одного раза.
 */
export function scheduleAssemblyRefresh(deadline: number, refresh: () => void): () => void {
  const state: {
    settled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    watchdog?: ReturnType<typeof setInterval>;
  } = { settled: false };

  const stop = (): void => {
    state.settled = true;
    clearTimeout(state.timer);
    clearInterval(state.watchdog);
  };

  const fire = (): void => {
    if (state.settled) {
      return;
    }
    stop();
    refresh();
  };

  state.timer = setTimeout(fire, Math.max(0, deadline - Date.now()));
  state.watchdog = setInterval(() => {
    if (Date.now() >= deadline) {
      fire();
    }
  }, ASSEMBLY_WATCHDOG_MS);

  return stop;
}
