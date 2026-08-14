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
  splitPhase,
  type PlanRunView,
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

describe('куда вести после применения', () => {
  it('раскрывается первый созданный черновик', () => {
    expect(firstDraftId(run({ state: 'APPLIED', routeIds: ['r1', 'r2'] }))).toBe('r1');
  });

  it('без созданных черновиков вести некуда', () => {
    expect(firstDraftId(run({ state: 'APPLIED', routeIds: [] }))).toBeNull();
  });
});
