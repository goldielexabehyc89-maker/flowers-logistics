/**
 * Машина шагов складского сканирования.
 *
 * Одна на три способа ввода: камеру, аппаратный сканер-клавиатуру и ручной
 * набор. Иначе результат зависел бы от устройства — а физическая коробка
 * от устройства не зависит, и правило «пара сканов» обязано быть одним
 * и тем же везде.
 *
 * Функция чистая намеренно: камеру, таймеры и сеть проверять таймерными
 * прогонами дорого и ненадёжно, а всё, что решает исход, живёт здесь и
 * проверяется обычными вызовами.
 *
 * Правила, ради которых машина существует:
 *
 *  * пока идёт запрос к серверу или открыто уведомление, новый код не
 *    принимается — один QR в кадре не должен вызвать две операции;
 *  * тот же самый код повторно не принимается, пока не исчез из кадра;
 *  * до полной пары «заказ + ячейка» серверу ничего не отправляется, поэтому
 *    прерванная цепочка не оставляет следа в базе;
 *  * успех закрывает уведомление сам, ошибка ждёт человека.
 */

/** Что делает кладовщик. */
export type ScanChain =
  /** Приёмка: заказ → ячейка хранения. */
  | 'RECEIVE'
  /** Комплектование: заказ → маршрутная ячейка, и так для каждого заказа. */
  | 'PICK'
  /** Выдача: заказ за заказом в одной открытой сессии. */
  | 'ISSUE'
  /**
   * Только ячейка: назначение маршрутной полки листу.
   *
   * Заказа в этой цепочке нет вовсе — человек показывает камере полку,
   * а не коробку. Отдельная цепочка нужна затем, чтобы окно сканирования
   * осталось одним на весь склад: второе окно «только для ячейки» вело бы
   * себя по-своему в мелочах.
   */
  | 'CELL_ONLY';

/** Шаг, которого ждёт машина. */
export type ScanStep =
  /** Ждём QR заказа. */
  | 'ORDER'
  /** Ждём QR ячейки. */
  | 'CELL'
  /** Заказ уже в подтверждённом листе: нужен явный ответ человека. */
  | 'ROUTE_CELL_CONSENT'
  /** Цепочка завершена, экран закрывается. */
  | 'DONE';

export type NoticeKind = 'success' | 'error';

export interface ScanNotice {
  kind: NoticeKind;
  /** Текст для человека. Ни адреса, ни получателя, ни текста исключения. */
  text: string;
}

export interface ScanState {
  chain: ScanChain;
  step: ScanStep;
  /** Подтверждённый сервером номер заказа текущей пары. */
  orderNumber: string | null;
  /** Код ячейки, ожидающий явного согласия на маршрутную ячейку. */
  pendingCellCode: string | null;
  /** Идёт запрос к серверу. */
  busy: boolean;
  notice: ScanNotice | null;
  /**
   * Последний принятый код и признак того, что кадр с ним уже уходил.
   *
   * Без этой пары один неподвижный QR перед камерой давал бы бесконечный
   * поток одинаковых событий.
   */
  lastAccepted: string | null;
  frameCleared: boolean;
  /** Прогресс выдачи или комплектования: «X из N». */
  progress: { done: number; total: number } | null;
}

export type ScanEvent =
  /** Декодер распознал значение. */
  | { type: 'scanned'; code: string }
  /** В кадре ничего нет: прежний код разрешено принять снова. */
  | { type: 'frameEmpty' }
  /** Сервер подтвердил номер заказа. */
  | { type: 'orderResolved'; orderNumber: string }
  /** Ячейка отсканирована и требует явного согласия. */
  | { type: 'consentRequired'; cellCode: string }
  /** Человек ответил на согласие. */
  | { type: 'consentAnswered'; agreed: boolean }
  /** Операция завершена успешно. */
  | { type: 'succeeded'; text: string; progress?: { done: number; total: number }; final: boolean }
  /** Операция или разрешение номера отказали. */
  | { type: 'failed'; text: string }
  /** Уведомление об успехе закрылось само. */
  | { type: 'noticeExpired' }
  /** Человек нажал «Повторить». */
  | { type: 'retry' }
  /** Человек нажал «Отмена». */
  | { type: 'cancel' };

export function initialState(chain: ScanChain): ScanState {
  return {
    chain,
    // Цепочка ячейки начинается сразу с ячейки: заказа в ней нет.
    step: chain === 'CELL_ONLY' ? 'CELL' : 'ORDER',
    orderNumber: null,
    pendingCellCode: null,
    busy: false,
    notice: null,
    lastAccepted: null,
    frameCleared: true,
    progress: null,
  };
}

/**
 * Готов ли декодер принимать кадры.
 *
 * Единственный источник правды для камеры и для кнопок отправки: пока
 * уведомление открыто или идёт запрос, ввод заблокирован целиком.
 */
export function canAccept(state: ScanState): boolean {
  return (
    !state.busy &&
    state.notice === null &&
    state.step !== 'DONE' &&
    state.step !== 'ROUTE_CELL_CONSENT'
  );
}

/** Подсказка текущего шага. Видна постоянно, а не всплывает на секунду. */
export function stepHint(state: ScanState): string {
  if (state.step === 'ORDER') {
    return 'Наведите камеру на QR-код заказа';
  }
  if (state.step === 'CELL') {
    return state.chain === 'RECEIVE'
      ? 'Наведите камеру на QR-код ячейки'
      : 'Наведите камеру на QR-код маршрутной ячейки';
  }
  if (state.step === 'ROUTE_CELL_CONSENT') {
    return 'Подтвердите, что заказ кладётся сразу в маршрутную ячейку';
  }
  return 'Готово';
}

/**
 * Заголовок окна сканирования.
 *
 * Он отвечает на единственный вопрос человека с коробкой в руках: что
 * подносить к камере СЕЙЧАС. Как только предмет назван — номер заказа или
 * код ожидаемой ячейки, — он попадает в заголовок: «Сканирование ячейки 8»
 * читается на ходу, а «Сканирование ячейки» заставляет вспоминать, какой.
 */
export function scanTitle(state: ScanState, expectedCell?: string | null): string {
  if (state.step === 'ORDER') {
    return 'Сканирование заказа';
  }
  if (state.step === 'CELL' || state.step === 'ROUTE_CELL_CONSENT') {
    const cell = expectedCell ?? null;
    return cell === null ? 'Сканирование ячейки' : `Сканирование ячейки ${cell}`;
  }
  return 'Сканирование';
}

/** Что именно машина ждёт от сервера после принятого кода. */
export type ScanIntent =
  | { kind: 'none' }
  /** Разрешить номер заказа. */
  | { kind: 'resolveOrder'; code: string }
  /** Отправить готовую пару. */
  | { kind: 'submitPair'; orderNumber: string; cellCode: string }
  /** Выдать заказ: пары здесь нет, достаточно номера. */
  | { kind: 'issueOrder'; orderNumber: string }
  /** Назначить маршрутную ячейку листу: заказа в этой цепочке нет. */
  | { kind: 'submitCell'; cellCode: string };

export interface ScanTransition {
  state: ScanState;
  intent: ScanIntent;
}

/**
 * Единственный переход машины.
 *
 * Возвращает и новое состояние, и намерение: что именно вызывающий обязан
 * спросить у сервера. Сама машина в сеть не ходит — иначе её нельзя было бы
 * проверить без сервера.
 */
export function reduce(state: ScanState, event: ScanEvent): ScanTransition {
  const stay = (next: Partial<ScanState> = {}): ScanTransition => ({
    state: { ...state, ...next },
    intent: { kind: 'none' },
  });

  switch (event.type) {
    case 'frameEmpty':
      return stay({ frameCleared: true });

    case 'scanned': {
      if (!canAccept(state)) {
        return stay();
      }
      // Тот же код без исчезновения из кадра — это тот же физический QR,
      // а не второе действие человека.
      if (state.lastAccepted === event.code && !state.frameCleared) {
        return stay();
      }

      const accepted = { lastAccepted: event.code, frameCleared: false, busy: true };

      if (state.step === 'ORDER') {
        // Выдача не требует ячейки: номер заказа — уже вся операция.
        if (state.chain === 'ISSUE') {
          return {
            state: { ...state, ...accepted },
            intent: { kind: 'issueOrder', orderNumber: event.code },
          };
        }
        return {
          state: { ...state, ...accepted },
          intent: { kind: 'resolveOrder', code: event.code },
        };
      }

      if (state.chain === 'CELL_ONLY') {
        // Пары нет: назначение полки — операция сама по себе.
        return {
          state: { ...state, ...accepted },
          intent: { kind: 'submitCell', cellCode: event.code },
        };
      }

      // Шаг ячейки: пара собрана, только теперь что-то меняется в базе.
      return {
        state: { ...state, ...accepted },
        intent: {
          kind: 'submitPair',
          orderNumber: state.orderNumber ?? '',
          cellCode: event.code,
        },
      };
    }

    case 'orderResolved':
      return stay({ busy: false, step: 'CELL', orderNumber: event.orderNumber });

    case 'consentRequired':
      return stay({ busy: false, step: 'ROUTE_CELL_CONSENT', pendingCellCode: event.cellCode });

    case 'consentAnswered': {
      if (!event.agreed) {
        // Отказ возвращает к сканированию ДРУГОЙ ячейки, а не отменяет заказ.
        return stay({
          step: 'CELL',
          pendingCellCode: null,
          frameCleared: true,
          lastAccepted: null,
        });
      }
      return {
        state: { ...state, busy: true, step: 'CELL' },
        intent: {
          kind: 'submitPair',
          orderNumber: state.orderNumber ?? '',
          cellCode: state.pendingCellCode ?? '',
        },
      };
    }

    case 'succeeded': {
      const progress = event.progress ?? state.progress;
      // Выдача остаётся открытой до последнего заказа: сессия одна на лист.
      const nextStep: ScanStep = event.final ? 'DONE' : state.chain === 'ISSUE' ? 'ORDER' : 'DONE';
      return stay({
        busy: false,
        notice: { kind: 'success', text: event.text },
        step: nextStep,
        orderNumber: null,
        pendingCellCode: null,
        progress,
      });
    }

    case 'failed':
      // Ошибка не откатывает подтверждённый заказ: человек повторяет только
      // неудавшийся шаг.
      return stay({ busy: false, notice: { kind: 'error', text: event.text } });

    case 'noticeExpired': {
      if (state.notice?.kind !== 'success') {
        return stay();
      }
      return stay({ notice: null, frameCleared: true, lastAccepted: null });
    }

    case 'retry':
      return stay({ notice: null, busy: false, frameCleared: true, lastAccepted: null });

    case 'cancel':
      return stay({ step: 'DONE', notice: null, busy: false });

    default:
      return stay();
  }
}

/** Завершена ли цепочка: экран камеры пора закрывать. */
export function isFinished(state: ScanState): boolean {
  return state.step === 'DONE' && state.notice === null;
}
