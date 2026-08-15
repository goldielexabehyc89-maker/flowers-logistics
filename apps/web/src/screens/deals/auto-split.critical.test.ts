/**
 * Проверки автоматической разбивки.
 *
 * Защищаемые свойства: число машин и вместимость приходят от логиста и никак
 * не выводятся из размера выбора; запрос собирается по настоящему серверному
 * контракту; мусор в полях отклоняется до сети; ни один неразмещённый заказ
 * не проходит без явного согласия человека.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildSlots,
  capacityShortfall,
  firstDraftId,
  MAX_CAPACITY,
  MAX_SLOTS,
  parseSplitParams,
  runAutoSplit,
  SPLIT_POLL_MS,
  SPLIT_TIMEOUT_MS,
  splitFailure,
  splitPhase,
  type PlanRunView,
  type SplitClient,
  type SplitClock,
} from './auto-split';

function run(patch: Partial<PlanRunView>): PlanRunView {
  return {
    id: 'run-1',
    state: 'PREVIEW',
    version: 1,
    routeIds: [],
    preview: { unassignedOrderIds: [] },
    ...patch,
  };
}

describe('параметры вводит логист', () => {
  it('оба целых положительных значения принимаются как есть', () => {
    const result = parseSplitParams({ vehicles: '4', capacityOrders: '15' });
    expect(result).toEqual({ ok: true, value: { vehicles: 4, capacityOrders: 15 } });
  });

  it('пустые значения отклоняются, и названы оба поля сразу', () => {
    // Логист должен увидеть все ошибки, а не исправлять их по одной.
    const result = parseSplitParams({ vehicles: '', capacityOrders: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.vehicles).not.toBeNull();
      expect(result.capacityOrders).not.toBeNull();
    }
  });

  it('ноль и отрицательные отклоняются', () => {
    expect(parseSplitParams({ vehicles: '0', capacityOrders: '10' }).ok).toBe(false);
    expect(parseSplitParams({ vehicles: '3', capacityOrders: '0' }).ok).toBe(false);
    expect(parseSplitParams({ vehicles: '-2', capacityOrders: '10' }).ok).toBe(false);
    expect(parseSplitParams({ vehicles: '3', capacityOrders: '-5' }).ok).toBe(false);
  });

  it('дробные отклоняются', () => {
    // `Number('2.5')` — обычное число, и без явной проверки «две с половиной
    // машины» ушли бы на сервер.
    expect(parseSplitParams({ vehicles: '2.5', capacityOrders: '10' }).ok).toBe(false);
    expect(parseSplitParams({ vehicles: '3', capacityOrders: '10.5' }).ok).toBe(false);
  });

  it('нечисловой мусор отклоняется', () => {
    expect(parseSplitParams({ vehicles: 'три', capacityOrders: '10' }).ok).toBe(false);
    expect(parseSplitParams({ vehicles: '3', capacityOrders: 'много' }).ok).toBe(false);
  });

  it('превышение серверных границ отклоняется до сети', () => {
    // Отказ после ожидания расчёта хуже отказа сразу.
    expect(parseSplitParams({ vehicles: String(MAX_SLOTS + 1), capacityOrders: '10' }).ok).toBe(
      false,
    );
    expect(parseSplitParams({ vehicles: '3', capacityOrders: String(MAX_CAPACITY + 1) }).ok).toBe(
      false,
    );
  });
});

describe('запрос к серверу', () => {
  it('указанное число машин даёт столько же слотов', () => {
    const slots = buildSlots({ vehicles: 4, capacityOrders: 15, vehicleType: 'CAR' });
    expect(slots).toHaveLength(4);
  });

  it('число слотов не зависит от размера выбора', () => {
    // Прежняя реализация считала машины из количества заказов. Теперь
    // единственный источник числа машин — сам логист.
    const slots = buildSlots({ vehicles: 2, capacityOrders: 5, vehicleType: 'CAR' });
    expect(slots).toHaveLength(2);
  });

  it('вместимость передаётся полем capacityOrders', () => {
    const slots = buildSlots({ vehicles: 3, capacityOrders: 15, vehicleType: 'CAR' });
    expect(slots[0]).toEqual({ courierUserId: null, vehicleType: 'CAR', capacityOrders: 15 });
    expect(Object.keys(slots[0] ?? {})).not.toContain('capacity');
    expect(slots.every((slot) => slot.capacityOrders === 15)).toBe(true);
  });

  it('пеший транспорт передаётся как выбран', () => {
    const slots = buildSlots({ vehicles: 2, capacityOrders: 5, vehicleType: 'FOOT' });
    expect(slots.every((slot) => slot.vehicleType === 'FOOT')).toBe(true);
  });
});

describe('скрытого значения по умолчанию нет', () => {
  it('в модуле разбивки не зашито ни одной вместимости', () => {
    // Проверка смотрит в исходник намеренно: значение по умолчанию легко
    // вернуть «одной строчкой», и заметить это в поведении нельзя, пока
    // логист не забудет заполнить поле.
    const source = readFileSync(new URL('./auto-split.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/DEFAULT_CAPACITY/);
    expect(source).not.toMatch(/\bceil\s*\(/i);
    expect(source).not.toMatch(/=\s*20\b/);
  });
});

describe('предупреждение о нехватке мест', () => {
  it('считает, скольким заказам не хватит машин', () => {
    // Это предупреждение, а не запрет: лишние заказы решатель отправит
    // в неразмещённые, и согласие на них спрашивается отдельно.
    expect(capacityShortfall(50, { vehicles: 2, capacityOrders: 20 })).toBe(10);
    expect(capacityShortfall(30, { vehicles: 2, capacityOrders: 20 })).toBe(0);
  });
});

describe('стадия разбивки', () => {
  it('пока считается — логист ждёт', () => {
    expect(splitPhase(run({ state: 'QUEUED' }))).toEqual({ kind: 'RUNNING' });
    expect(splitPhase(run({ state: 'COMPUTING' }))).toEqual({ kind: 'RUNNING' });
  });

  it('всё разместилось — можно применять без вопросов', () => {
    expect(splitPhase(run({ state: 'PREVIEW' }))).toEqual({ kind: 'READY' });
  });

  it('неразмещённые требуют отдельного согласия и названы числом', () => {
    expect(
      splitPhase(run({ state: 'PREVIEW', preview: { unassignedOrderIds: ['a', 'b'] } })),
    ).toEqual({ kind: 'NEEDS_CONSENT', unassignedCount: 2 });
  });

  it('отказ и снятое превью — это отказ, а не ожидание', () => {
    expect(splitPhase(run({ state: 'FAILED' }))).toEqual({ kind: 'FAILED' });
    expect(splitPhase(run({ state: 'EXPIRED' }))).toEqual({ kind: 'FAILED' });
  });
});

describe('отказ решателя доходит до логиста без потерь', () => {
  /** Управляемые часы: ожидание проверяется без настоящих пауз. */
  function clock(): SplitClock & { elapsed: number } {
    const state = { elapsed: 0 };
    return {
      get elapsed() {
        return state.elapsed;
      },
      now: () => state.elapsed,
      sleep: async (ms: number) => {
        state.elapsed += ms;
      },
    };
  }

  const input = {
    deliveryDate: '2026-08-14',
    orderIds: ['a', 'b'],
    params: { vehicles: 2, capacityOrders: 10 },
    vehicleType: 'CAR' as const,
  };

  it('503 показывается сообщением сервера и не превращается в частичный успех', async () => {
    // Сервер отвечает 503, когда решатель не настроен. Ни превью, ни
    // применения быть не должно — иначе логист уехал бы в пустую вкладку.
    const calls = { read: 0, apply: 0 };
    const client: SplitClient = {
      start: async () => {
        throw Object.assign(new Error('Автоматический расчёт недоступен: решатель не настроен.'), {
          status: 503,
        });
      },
      read: async () => {
        calls.read += 1;
        throw new Error('не должно вызываться');
      },
    };

    await expect(runAutoSplit(client, input, clock())).rejects.toThrow(/решатель не настроен/);
    expect(calls.read).toBe(0);
  });

  it('отказ оставляет выбор, не уводит в «Маршрутизацию» и снимает ожидание', async () => {
    const effect = splitFailure(
      new Error('Автоматический расчёт недоступен: решатель не настроен.'),
    );

    expect(effect.message).toBe('Автоматический расчёт недоступен: решатель не настроен.');
    // Выбор — это работа логиста. Снять его «на всякий случай» значит
    // заставить набирать заказы заново из-за чужой поломки.
    expect(effect.keepSelection).toBe(true);
    // Черновиков не создано, вести некуда.
    expect(effect.navigate).toBe(false);
    // Кнопка обязана вернуться в рабочее состояние: вечное ожидание
    // неотличимо от зависшего приложения.
    expect(effect.busy).toBe(false);
  });

  it('предпосылки расчёта названы точно, а не общим «расчёт не удался»', () => {
    // Каждая причина требует своего действия: создать склад, выбрать его адрес
    // заново или настроить смену. Общий текст не подсказывает ни одного.
    const cases = [
      ['DEPOT_NOT_CONFIGURED', /не выбран основной склад/i],
      ['DEPOT_POINT_MISSING', /не определены координаты/i],
      ['SHIFT_NOT_CONFIGURED', /не настроена рабочая смена/i],
    ] as const;

    for (const [kind, expected] of cases) {
      const effect = splitFailure(
        Object.assign(new Error('Расчёт не удался'), { conflict: { kind } }),
      );
      expect(effect.message, kind).toMatch(expected);
      expect(effect.keepSelection).toBe(true);
      expect(effect.navigate).toBe(false);
    }
  });

  it('фактический отказ решателя показывается как есть', () => {
    // Незнакомую причину нельзя подменять догадкой из списка предпосылок.
    const effect = splitFailure(
      Object.assign(new Error('Решатель отказал: недостижимая пара точек'), {
        conflict: { kind: 'MATRIX_UNREACHABLE_PAIR' },
      }),
    );
    expect(effect.message).toMatch(/недостижимая пара/i);
  });

  it('отказ без внятного текста подменяется понятной причиной', () => {
    // Пустое сообщение и техническая строка одинаково бесполезны человеку.
    expect(splitFailure(new Error('')).message).toMatch(/проверьте выбор и настройки/i);
    expect(splitFailure(undefined).message).toMatch(/проверьте выбор и настройки/i);
  });

  it('бесконечного ожидания нет: расчёт, который не завершается, обрывается', async () => {
    let reads = 0;
    const client: SplitClient = {
      start: async () => ({
        id: 'run-1',
        state: 'QUEUED',
        version: 1,
        routeIds: [],
        preview: null,
      }),
      // Запуск навсегда остаётся в очереди — ровно так вёл себя день,
      // занятый расчётом при невзведённом решателе.
      read: async () => {
        reads += 1;
        return { id: 'run-1', state: 'QUEUED', version: 1, routeIds: [], preview: null };
      },
    };

    await expect(runAutoSplit(client, input, clock())).rejects.toThrow(/дольше обычного/);
    // Число обращений конечно: цикл ограничен сроком, а не надеждой.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(SPLIT_TIMEOUT_MS / SPLIT_POLL_MS + 1);
  });

  it('после исправления конфигурации тот же выбор считается повторно', async () => {
    // Повтор возможен именно потому, что выбор не был сброшен отказом.
    let broken = true;
    const client: SplitClient = {
      start: async () => {
        if (broken) {
          throw new Error('Автоматический расчёт недоступен: решатель не настроен.');
        }
        return { id: 'run-2', state: 'QUEUED', version: 1, routeIds: [], preview: null };
      },
      read: async () => ({
        id: 'run-2',
        state: 'PREVIEW',
        version: 2,
        routeIds: [],
        preview: { unassignedOrderIds: [] },
      }),
    };

    await expect(runAutoSplit(client, input, clock())).rejects.toThrow(/не настроен/);

    broken = false;
    const outcome = await runAutoSplit(client, input, clock());

    // Черновиков ещё нет: разбивка доводит до превью и останавливается.
    expect(outcome.kind).toBe('PREVIEW');
    expect(outcome.run.routeIds).toEqual([]);
  });

  it('частичный результат тоже доводится до превью, а не до черновиков', async () => {
    // Согласие на неразмещённые спрашивается в «Маршрутизации», когда логист
    // уже видит, что именно предложено.
    const client: SplitClient = {
      start: async () => ({
        id: 'run-3',
        state: 'QUEUED',
        version: 1,
        routeIds: [],
        preview: null,
      }),
      read: async () => ({
        id: 'run-3',
        state: 'PREVIEW',
        version: 2,
        routeIds: [],
        preview: { unassignedOrderIds: ['x'] },
      }),
    };

    const outcome = await runAutoSplit(client, input, clock());

    expect(outcome.kind).toBe('PREVIEW');
    expect(outcome.run.routeIds).toEqual([]);
  });
});

describe('куда вести после применения', () => {
  it('раскрывается первый созданный черновик', () => {
    expect(firstDraftId(run({ state: 'APPLIED', routeIds: ['r1', 'r2'] }))).toBe('r1');
  });

  it('без созданных черновиков вести некуда', () => {
    expect(firstDraftId(run({ state: 'APPLIED', routeIds: [] }))).toBeNull();
  });
});
