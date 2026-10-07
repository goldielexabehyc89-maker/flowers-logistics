/**
 * Перечитывание счётчика «В сборке» при смене московского дня.
 *
 * Счётчик меняется в полночь без единого события, поэтому открытый экран
 * обязан перечитать его сам — к сроку, который назвал сервер, без действий
 * человека. Проверяется на поддельных часах: и обычный ход времени через
 * 23:59 → 00:00, и сон устройства, когда таймер опаздывает, а настенные часы
 * уходят вперёд.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSEMBLY_REFRESH_MARGIN_MS,
  ASSEMBLY_WATCHDOG_MS,
  assemblyRefreshDeadline,
  scheduleAssemblyRefresh,
} from './assembly-day';

/** 23:59:00 Москвы 6 марта 2031 года — по часам устройства. */
const AT_2359 = new Date('2031-03-06T20:59:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT_2359);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('срок перечитывания', () => {
  it('от получения ответа плюс серверный остаток плюс запас', () => {
    const receivedAt = AT_2359.getTime();
    expect(
      assemblyRefreshDeadline({ countedFrom: '2031-03-05', refreshInMs: 60_000 }, receivedAt),
    ).toBe(receivedAt + 60_000 + ASSEMBLY_REFRESH_MARGIN_MS);
  });

  it('без окна или без ответа срока нет', () => {
    expect(assemblyRefreshDeadline(undefined, AT_2359.getTime())).toBeNull();
    expect(
      assemblyRefreshDeadline({ countedFrom: '2031-03-05', refreshInMs: 60_000 }, 0),
    ).toBeNull();
  });

  it('часы устройства в срок не входят: сдвиг часов не меняет задержку', () => {
    const counter = { countedFrom: '2031-03-05', refreshInMs: 60_000 };
    // Устройство спешит на пять минут: срок сдвигается вместе с моментом
    // получения ответа, а задержка остаётся серверной минутой.
    const fast = AT_2359.getTime() + 5 * 60_000;
    expect(assemblyRefreshDeadline(counter, fast)! - fast).toBe(
      60_000 + ASSEMBLY_REFRESH_MARGIN_MS,
    );
  });
});

describe('переход 23:59 → 00:00', () => {
  it('перечитывание ровно после полуночи сервера и ровно один раз', () => {
    const refresh = vi.fn();
    // Ответ получен в 23:59:00, сервер говорит: граница через минуту.
    const deadline = assemblyRefreshDeadline(
      { countedFrom: '2031-03-05', refreshInMs: 60_000 },
      Date.now(),
    )!;
    scheduleAssemblyRefresh(deadline, refresh);

    // 23:59:59 — ещё рано.
    vi.advanceTimersByTime(59_000);
    expect(refresh).not.toHaveBeenCalled();
    // 00:00:00 — граница сервера, запас ещё не истёк.
    vi.advanceTimersByTime(1_000);
    expect(refresh).not.toHaveBeenCalled();
    // 00:00:01 — перечитано.
    vi.advanceTimersByTime(ASSEMBLY_REFRESH_MARGIN_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Больше — никогда: следующий срок поставит уже новый ответ.
    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('новый ответ ставит следующий срок — через сутки', () => {
    const refresh = vi.fn();
    const first = assemblyRefreshDeadline(
      { countedFrom: '2031-03-05', refreshInMs: 60_000 },
      Date.now(),
    )!;
    scheduleAssemblyRefresh(first, refresh);
    vi.advanceTimersByTime(60_000 + ASSEMBLY_REFRESH_MARGIN_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Перечитанный ответ: граница сдвинута, следующая через сутки без секунды.
    const second = assemblyRefreshDeadline(
      { countedFrom: '2031-03-06', refreshInMs: 24 * 60 * 60 * 1000 - 1_000 },
      Date.now(),
    )!;
    scheduleAssemblyRefresh(second, refresh);
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('сон устройства и уход с экрана', () => {
  it('сторож по настенным часам перечитывает, даже если таймер «проспал»', () => {
    const refresh = vi.fn();
    // Ответ в 20:00 Москвы, граница через 4 часа. Ноутбук засыпает: монотонный
    // таймер стоит, а настенные часы при пробуждении уже показывают утро.
    // Поддельные часы ведут себя так же: перевод системного времени таймеры
    // не продвигает.
    vi.setSystemTime(new Date('2031-03-06T17:00:00.000Z'));
    const deadline = assemblyRefreshDeadline(
      { countedFrom: '2031-03-05', refreshInMs: 4 * 60 * 60 * 1000 },
      Date.now(),
    )!;
    scheduleAssemblyRefresh(deadline, refresh);

    vi.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));
    expect(refresh).not.toHaveBeenCalled();
    // Ближайший обход сторожа.
    vi.advanceTimersByTime(ASSEMBLY_WATCHDOG_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Опоздавший таймер второго перечитывания не даёт.
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ушли с экрана до срока — перечитывания нет', () => {
    const refresh = vi.fn();
    const deadline = assemblyRefreshDeadline(
      { countedFrom: '2031-03-05', refreshInMs: 60_000 },
      Date.now(),
    )!;
    const cancel = scheduleAssemblyRefresh(deadline, refresh);
    vi.advanceTimersByTime(30_000);
    cancel();
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('срок уже прошёл к моменту постановки — перечитывание сразу', () => {
    const refresh = vi.fn();
    scheduleAssemblyRefresh(Date.now() - 1, refresh);
    vi.advanceTimersByTime(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
