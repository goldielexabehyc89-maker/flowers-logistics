/**
 * Критические проверки правил экрана маршрутизации.
 *
 * Проверяется то, что меняет решение логиста: доступно ли редактирование, что он
 * увидит вместо кода конфликта и какой порядок получится после сдвига остановки.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHeartbeatController } from './lease-controller';
import {
  blockerLabel,
  canEdit,
  conflictLabel,
  conflictMessage,
  editingHint,
  formatDate,
  moscowToday,
  moveTo,
  moveWithin,
  routeActionLabel,
  stopInterval,
} from './routing';

function lock(
  overrides: Partial<{
    locked: boolean;
    heldByCurrentSession: boolean;
    holder: { id: string; fullName: string } | null;
  }> = {},
) {
  return {
    locked: true,
    heldByCurrentSession: true,
    holder: { id: 'u1', fullName: 'Логист Петров' },
    expiresAt: '2026-08-12T10:00:00.000Z',
    leaseVersion: 3,
    ...overrides,
  };
}

describe('право на редактирование', () => {
  it('черновик со своей арендой редактируется', () => {
    const route = { state: 'DRAFT' as const, editLock: lock() };
    expect(canEdit(route)).toBe(true);
    expect(editingHint(route)).toBeNull();
  });

  it('чужая аренда закрывает редактирование и называет держателя', () => {
    const route = { state: 'DRAFT' as const, editLock: lock({ heldByCurrentSession: false }) };
    expect(canEdit(route)).toBe(false);
    expect(editingHint(route)).toContain('Логист Петров');
  });

  it('без аренды предлагается взять маршрут в работу', () => {
    const route = {
      state: 'DRAFT' as const,
      editLock: lock({ locked: false, heldByCurrentSession: false, holder: null }),
    };
    expect(canEdit(route)).toBe(false);
    expect(editingHint(route)).toContain('в работу');
  });

  it('подтверждённый и отменённый маршрут не редактируются даже со своей арендой', () => {
    for (const state of ['CONFIRMED', 'CANCELLED'] as const) {
      const route = { state, editLock: lock() };
      expect(canEdit(route), state).toBe(false);
      expect(editingHint(route), state).not.toBeNull();
    }
    expect(editingHint({ state: 'CONFIRMED', editLock: lock() })).toContain('черновик');
    expect(editingHint({ state: 'CANCELLED', editLock: lock() })).toContain('отменён');
  });
});

describe('перестановка остановок', () => {
  const ids = ['a', 'b', 'c'];

  it('сдвигает элемент вверх и вниз', () => {
    expect(moveWithin(ids, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveWithin(ids, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('на границах и для чужого идентификатора не двигает ничего', () => {
    expect(moveWithin(ids, 'a', -1)).toBeNull();
    expect(moveWithin(ids, 'c', 1)).toBeNull();
    expect(moveWithin(ids, 'нет-такого', -1)).toBeNull();
  });

  it('сохраняет состав без дубликатов и потерь', () => {
    const next = moveWithin(ids, 'c', -1);
    expect(next).not.toBeNull();
    expect([...(next ?? [])].sort()).toEqual([...ids].sort());
    expect(new Set(next ?? []).size).toBe(ids.length);
  });
});

describe('тексты для человека', () => {
  it('конфликт объясняется словами, а неизвестный код не прячется', () => {
    expect(conflictMessage('STALE_VERSION', 'запасной текст')).toContain('другой пользователь');
    expect(conflictMessage('EDIT_LOCK_HELD_BY_OTHER', 'запасной текст')).toContain('редактирует');
    expect(conflictMessage('НЕИЗВЕСТНЫЙ', 'запасной текст')).toBe('запасной текст');
    expect(conflictMessage(undefined, 'запасной текст')).toBe('запасной текст');
  });

  it('блокировки подтверждения, расхождения и действия названы понятно', () => {
    expect(blockerLabel('ROUTE_EMPTY')).toBe('В маршруте нет заказов');
    expect(blockerLabel('ЧТО_ТО_НОВОЕ')).toBe('ЧТО_ТО_НОВОЕ');
    expect(conflictLabel('DELIVERY_DATE_CHANGED')).toBe('Дата доставки изменилась');
    expect(routeActionLabel('ROUTE_CONFIRMED')).toBe('Маршрут подтверждён');
  });

  it('сообщение о конкурентном изменении не предлагает повторить молча', () => {
    const text = conflictMessage('STALE_VERSION', '');
    expect(text).toContain('обновили карточку');
    expect(text).not.toContain('повторили автоматически');
  });
});

describe('отображение данных остановки', () => {
  const interval = {
    raw: null,
    kind: 'MISSING',
    startMinute: null,
    endMinute: null,
    manualStartMinute: null,
    manualEndMinute: null,
  };

  it('ручной интервал важнее текста источника', () => {
    expect(
      stopInterval({
        ...interval,
        kind: 'UNRECOGNIZED',
        raw: 'позвонить',
        manualStartMinute: 600,
        manualEndMinute: 720,
      }),
    ).toBe('10:00 – 12:00');
  });

  it('точное время не превращается в выдуманное окно', () => {
    expect(stopInterval({ ...interval, kind: 'EXACT', startMinute: 840 })).toBe('к 14:00');
    // Час без минут доходит до остановки и печатной формы тем же значением.
    expect(stopInterval({ ...interval, kind: 'EXACT', startMinute: 540 })).toBe('к 09:00');
    expect(stopInterval({ ...interval, kind: 'RANGE', startMinute: 540, endMinute: 600 })).toBe(
      '09:00 – 10:00',
    );
  });

  it('нераспознанный интервал и пустая дата дают честный прочерк', () => {
    expect(stopInterval({ ...interval, kind: 'UNRECOGNIZED', raw: 'когда удобно' })).toBe('—');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('2026-08-07')).toBe('07.08.2026');
  });

  it('текущий день считается по Москве', () => {
    expect(moscowToday(new Date('2026-08-06T21:30:00.000Z'))).toBe('2026-08-07');
    expect(moscowToday(new Date('2026-08-06T20:59:59.000Z'))).toBe('2026-08-06');
  });
});

describe('сердцебиение аренды', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function controller(send: () => Promise<void>, onLost = (): void => undefined) {
    return createHeartbeatController({
      intervalMs: 30_000,
      setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
      clearInterval: (handle) => globalThis.clearInterval(handle as number),
      send,
      onLost,
    });
  }

  it('чужая карточка не отправляет ни одного сердцебиения', async () => {
    const send = vi.fn(async () => undefined);
    const lease = controller(send);

    // Аренду держит другой редактор: таймер не запускается вовсе.
    lease.setHeld(false);
    expect(lease.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('своя аренда подтверждается по расписанию', async () => {
    const send = vi.fn(async () => undefined);
    const lease = controller(send);

    lease.setHeld(true);
    expect(lease.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(send).toHaveBeenCalledTimes(3);

    lease.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('после перехвата таймер останавливается сразу, не дожидаясь следующего тика', async () => {
    const send = vi.fn(async () => undefined);
    const onLost = vi.fn();
    const lease = controller(send, onLost);

    lease.setHeld(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);

    // Карточка узнала о перехвате: аренда больше не наша.
    lease.setHeld(false);
    expect(lease.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('отказ сервера останавливает сердцебиение и сообщает о потере', async () => {
    const send = vi.fn(async () => {
      throw new Error('409');
    });
    const onLost = vi.fn();
    const lease = controller(send, onLost);

    lease.setHeld(true);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lease.isRunning()).toBe(false);

    // Повторных попыток нет: стучаться в чужую аренду бессмысленно.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('повторное подтверждение удержания не плодит таймеры', async () => {
    const send = vi.fn(async () => undefined);
    const lease = controller(send);

    lease.setHeld(true);
    lease.setHeld(true);
    lease.setHeld(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('перестановка перетаскиванием', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('заказ встаёт на место, куда его отпустили', () => {
    expect(moveTo(ids, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('прежний порядок сохранять нечего', () => {
    // Лишний запрос сбросил бы линию маршрута ради того же результата.
    expect(moveTo(ids, 1, 1)).toBeNull();
  });

  it('выход за границы списка ничего не меняет', () => {
    expect(moveTo(ids, 0, 9)).toBeNull();
    expect(moveTo(ids, -1, 2)).toBeNull();
  });

  it('состав списка не меняется, меняется только порядок', () => {
    expect([...(moveTo(ids, 0, 3) ?? [])].sort()).toEqual([...ids].sort());
  });
});
