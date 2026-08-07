/**
 * Планировщик сердцебиения аренды.
 *
 * Вынесен из React-хука по двум причинам. Во-первых, его можно проверить
 * управляемыми таймерами, не поднимая браузер. Во-вторых, правило простое,
 * но легко нарушаемое: сердцебиение имеет смысл ТОЛЬКО пока аренду держит
 * эта вкладка.
 *
 * Раньше таймер работал для любого открытого черновика: занятая чужой сессией
 * карточка каждые тридцать секунд отправляла запрос, получала отказ и заставляла
 * интерфейс перечитывать данные. Теперь чужая карточка молчит, а после перехвата
 * прежний держатель останавливает таймер сразу, не дожидаясь следующего тика.
 */

export interface HeartbeatDeps {
  intervalMs: number;
  /** Инъекция таймеров: тесты подставляют управляемые. */
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Одно сердцебиение. Отказ означает, что аренды у нас больше нет. */
  send: () => Promise<void>;
  /** Аренда потеряна: карточку нужно перечитать. */
  onLost: () => void;
}

export interface HeartbeatController {
  /** Сообщает контроллеру текущее состояние карточки. */
  setHeld: (held: boolean) => void;
  /** Идёт ли сейчас сердцебиение. Нужно тестам и для остановки при закрытии. */
  isRunning: () => boolean;
  stop: () => void;
}

export function createHeartbeatController(deps: HeartbeatDeps): HeartbeatController {
  let handle: unknown = null;

  const stop = (): void => {
    if (handle !== null) {
      deps.clearInterval(handle);
      handle = null;
    }
  };

  const tick = (): void => {
    void deps.send().catch(() => {
      // Аренду перехватили или она истекла. Останавливаемся немедленно: продолжать
      // стучаться в чужую аренду бессмысленно и шумно.
      stop();
      deps.onLost();
    });
  };

  return {
    setHeld(held: boolean): void {
      if (held && handle === null) {
        handle = deps.setInterval(tick, deps.intervalMs);
        return;
      }
      if (!held) {
        stop();
      }
    },
    isRunning: () => handle !== null,
    stop,
  };
}
