/**
 * Критические правила экрана планирования.
 *
 * Проверяется то, что решает поведение интерфейса: когда можно применить план,
 * когда нужно отдельное подтверждение и что показывается вместо технического
 * кода отказа. Неверный ответ здесь означает либо кнопку, которой быть
 * не должно, либо молча применённый план с брошенными заказами.
 */

import { describe, expect, it } from 'vitest';
import {
  assignedCount,
  canApply,
  failureLabel,
  formatDistance,
  formatDuration,
  formatMinute,
  isRunning,
  needsUnassignedConfirmation,
  PLAN_FAILURE_LABELS,
  PLAN_STATE_LABELS,
  type PlanRunView,
} from './planning';

function run(overrides: Partial<PlanRunView> = {}): PlanRunView {
  return {
    id: 'run-1',
    deliveryDate: '2026-09-01',
    state: 'PREVIEW',
    version: 1,
    failureCode: null,
    createdAt: '2026-09-01T06:00:00.000Z',
    appliedAt: null,
    slots: [],
    preview: {
      routes: [
        {
          slotId: 'slot-1',
          slotIndex: 1,
          vehicleType: 'CAR',
          courierUserId: null,
          stops: [
            { orderId: 'order-a', position: 1, arrivalMinute: 600 },
            { orderId: 'order-b', position: 2, arrivalMinute: 640 },
          ],
          travelSeconds: 1200,
          serviceSeconds: 1200,
          distanceMeters: 12345,
        },
      ],
      unassignedOrderIds: [],
    },
    routeIds: [],
    ...overrides,
  };
}

describe('состояние расчёта', () => {
  it('опрашивается, пока идёт, и не опрашивается после завершения', () => {
    expect(isRunning('QUEUED')).toBe(true);
    expect(isRunning('COMPUTING')).toBe(true);
    expect(isRunning('PREVIEW')).toBe(false);
    expect(isRunning('APPLIED')).toBe(false);
    expect(isRunning('FAILED')).toBe(false);
    expect(isRunning('EXPIRED')).toBe(false);
  });

  it('у каждого состояния есть подпись на русском', () => {
    for (const label of Object.values(PLAN_STATE_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('применение', () => {
  it('доступно только для готового превью с хотя бы одним маршрутом', () => {
    expect(canApply(run())).toBe(true);
    expect(canApply(run({ state: 'QUEUED' }))).toBe(false);
    expect(canApply(run({ state: 'APPLIED' }))).toBe(false);
    expect(canApply(run({ preview: null }))).toBe(false);
  });

  it('план из одних пустых маршрутов применять нечего', () => {
    const empty = run({
      preview: {
        routes: [
          {
            slotId: 'slot-1',
            slotIndex: 1,
            vehicleType: 'CAR',
            courierUserId: null,
            stops: [],
            travelSeconds: 0,
            serviceSeconds: 0,
            distanceMeters: 0,
          },
        ],
        unassignedOrderIds: [],
      },
    });
    expect(canApply(empty)).toBe(false);
  });

  it('неразмещённые заказы требуют отдельного подтверждения', () => {
    expect(needsUnassignedConfirmation(run())).toBe(false);
    expect(
      needsUnassignedConfirmation(
        run({ preview: { routes: run().preview?.routes ?? [], unassignedOrderIds: ['order-c'] } }),
      ),
    ).toBe(true);
  });

  it('считает размещённые заказы по всем маршрутам', () => {
    expect(assignedCount(run().preview)).toBe(2);
    expect(assignedCount(null)).toBe(0);
  });
});

describe('причина отказа', () => {
  it('известный код превращается в объяснение, а не в аббревиатуру', () => {
    expect(failureLabel('MATRIX_UNREACHABLE_PAIR')).toBe(
      PLAN_FAILURE_LABELS['MATRIX_UNREACHABLE_PAIR'],
    );
    expect(failureLabel('SOLVER_TIME_WINDOW')).not.toContain('SOLVER');
  });

  it('неизвестный код не прячется: дежурный должен его назвать', () => {
    expect(failureLabel('НЕЧТО_НОВОЕ')).toContain('НЕЧТО_НОВОЕ');
  });

  it('отсутствие кода не превращается в текст', () => {
    expect(failureLabel(null)).toBeNull();
  });
});

describe('единицы', () => {
  it('минуты от полуночи показываются временем', () => {
    expect(formatMinute(0)).toBe('00:00');
    expect(formatMinute(600)).toBe('10:00');
    expect(formatMinute(1439)).toBe('23:59');
    expect(formatMinute(null)).toBe('—');
  });

  it('секунды показываются часами и минутами, а не сырым числом', () => {
    expect(formatDuration(1200)).toBe('20 мин');
    expect(formatDuration(4500)).toBe('1 ч 15 мин');
    expect(formatDuration(null)).toBe('—');
  });

  it('метры показываются километрами: метровая точность в списке не нужна', () => {
    expect(formatDistance(12345)).toBe('12.3 км');
    expect(formatDistance(null)).toBe('—');
  });
});
