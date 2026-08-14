/**
 * Проверки автоматической разбивки.
 *
 * Защищаемые свойства: разбивка действительно даёт несколько черновиков,
 * запрос собирается по настоящему серверному контракту, и ни один
 * неразмещённый заказ не проходит без явного согласия человека.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSlots,
  DEFAULT_CAPACITY,
  firstDraftId,
  MAX_SLOTS,
  splitPhase,
  vehicleCount,
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

describe('сколько машин заказывать', () => {
  it('выбор больше вместимости даёт несколько машин, а не один длинный маршрут', () => {
    // Прежний клиент слал одну машину вместимостью со всё выделение —
    // это не разбивка.
    expect(vehicleCount(50, DEFAULT_CAPACITY)).toBe(3);
    expect(vehicleCount(20, DEFAULT_CAPACITY)).toBe(1);
    expect(vehicleCount(21, DEFAULT_CAPACITY)).toBe(2);
  });

  it('число машин не превышает серверный предел', () => {
    // Превышение отвергается сервером уже после ожидания расчёта.
    expect(vehicleCount(10_000, 1)).toBe(MAX_SLOTS);
  });

  it('пустой выбор и нулевая вместимость не роняют расчёт числа', () => {
    expect(vehicleCount(0, DEFAULT_CAPACITY)).toBe(1);
    expect(vehicleCount(10, 0)).toBe(1);
  });
});

describe('запрос к серверу', () => {
  it('слоты собираются полем capacityOrders', () => {
    // Прежний клиент слал `capacity`, и сервер отвергал запрос до расчёта.
    const slots = buildSlots({ orderCount: 30, capacityOrders: 10, vehicleType: 'CAR' });

    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({ courierUserId: null, vehicleType: 'CAR', capacityOrders: 10 });
    expect(Object.keys(slots[0] ?? {})).not.toContain('capacity');
  });

  it('пеший транспорт передаётся как выбран', () => {
    const slots = buildSlots({ orderCount: 5, capacityOrders: 5, vehicleType: 'FOOT' });
    expect(slots.every((slot) => slot.vehicleType === 'FOOT')).toBe(true);
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
    // Заказ, который никто не повезёт, не должен уехать в черновики молча.
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
