/**
 * Проверки предложенного расчёта.
 *
 * Защищаемые свойства: превью показывает заказы по-человечески, называет
 * причину для каждого неразмещённого и не позволяет применить пустой план.
 * Ошибка здесь стоит необратимо созданных черновиков.
 */

import { describe, expect, it } from 'vitest';
import {
  assignedCount,
  canApply,
  formatDistance,
  formatDuration,
  formatMinute,
  formatWindow,
  needsPartialConsent,
  orderOf,
  plannedRoutes,
  unassignedLabel,
  unassignedWithReasons,
  type PlanRunView,
  type PreviewPlan,
} from './preview';

function plan(patch: Partial<PreviewPlan> = {}): PreviewPlan {
  return {
    routes: [
      {
        slotId: 'slot-1',
        slotIndex: 1,
        vehicleType: 'CAR',
        stops: [
          { orderId: 'a', position: 1, arrivalMinute: 12 * 60 },
          { orderId: 'b', position: 2, arrivalMinute: 13 * 60 },
        ],
        travelSeconds: 1800,
        serviceSeconds: 1200,
        distanceMeters: 12_000,
      },
    ],
    unassignedOrderIds: [],
    ...patch,
  };
}

function view(patch: Partial<PlanRunView> = {}): PlanRunView {
  return {
    id: 'run-1',
    deliveryDate: '2026-08-15',
    state: 'PREVIEW',
    version: 1,
    failureCode: null,
    createdAt: '2026-08-15T09:00:00.000Z',
    preview: plan(),
    orders: [
      {
        id: 'a',
        number: 'A-1024',
        address: 'Москва, улица 1',
        addressDetails: null,
        intervalStartMinute: 12 * 60,
        intervalEndMinute: 18 * 60,
      },
    ],
    routeIds: [],
    ...patch,
  };
}

describe('предложение читается человеком', () => {
  it('заказ показывается номером и адресом, а не идентификатором', () => {
    const order = orderOf(view(), 'a');
    expect(order.number).toBe('A-1024');
    expect(order.address).toBe('Москва, улица 1');
  });

  it('неизвестный заказ не роняет превью', () => {
    // Обрезанный идентификатор ничего не говорит логисту, но и падать нельзя.
    expect(orderOf(view(), 'нет-такого').number).toBe('—');
  });

  it('пустые машины в предложении не показываются', () => {
    const withEmpty = plan({
      routes: [
        ...plan().routes,
        {
          slotId: 'slot-2',
          slotIndex: 2,
          vehicleType: 'FOOT',
          stops: [],
          travelSeconds: 0,
          serviceSeconds: 0,
          distanceMeters: 0,
        },
      ],
    });
    expect(plannedRoutes(withEmpty)).toHaveLength(1);
    expect(assignedCount(withEmpty)).toBe(2);
  });

  it('окно доставки и время показаны, а отсутствие названо прямо', () => {
    expect(formatWindow(orderOf(view(), 'a'))).toBe('12:00–18:00');
    expect(formatWindow(orderOf(view(), 'нет'))).toBe('время не задано');
    expect(formatMinute(13 * 60 + 5)).toBe('13:05');
    expect(formatMinute(null)).toBe('—');
  });

  it('время в пути и расстояние округляются не в пользу оптимизма', () => {
    // План не должен выглядеть быстрее, чем посчитано.
    expect(formatDuration(1801)).toBe('31 мин');
    expect(formatDuration(3600)).toBe('1 ч 0 мин');
    expect(formatDuration(null)).toBe('—');
    expect(formatDistance(900)).toBe('900 м');
    expect(formatDistance(12_000)).toBe('12.0 км');
    expect(formatDistance(null)).toBe('—');
  });
});

describe('неразмещённые заказы названы с причиной', () => {
  it('причина решателя доходит до человека', () => {
    const result = unassignedWithReasons(
      plan({
        unassignedOrderIds: ['c'],
        unassigned: [{ orderId: 'c', reason: 'CAPACITY' }],
      }),
    );

    expect(result).toEqual([{ orderId: 'c', reason: 'CAPACITY' }]);
    expect(unassignedLabel('CAPACITY')).toMatch(/мест/i);
    expect(unassignedLabel('TIME_WINDOW')).toMatch(/время/i);
  });

  it('старый расчёт без причин не теряет заказы', () => {
    // Прежние снимки причин не хранят: тогда решатель их сообщал, а мы
    // отбрасывали. Заказ обязан остаться в списке с честным «неизвестно».
    const result = unassignedWithReasons(plan({ unassignedOrderIds: ['c', 'd'] }));

    expect(result.map((item) => item.orderId)).toEqual(['c', 'd']);
    expect(result.every((item) => item.reason === 'UNKNOWN')).toBe(true);
    expect(unassignedLabel('UNKNOWN')).toMatch(/не назвал/i);
  });
});

describe('применение предложения', () => {
  it('готовое превью с маршрутами применимо', () => {
    expect(canApply(view())).toBe(true);
  });

  it('пустой план применить нельзя', () => {
    // Ноль черновиков — это не «работа сделана».
    expect(canApply(view({ preview: plan({ routes: [] }) }))).toBe(false);
  });

  it('уже применённый и отклонённый расчёт применить нельзя', () => {
    expect(canApply(view({ state: 'APPLIED' }))).toBe(false);
    expect(canApply(view({ state: 'EXPIRED' }))).toBe(false);
    expect(canApply(view({ state: 'COMPUTING', preview: null }))).toBe(false);
  });

  it('неразмещённые требуют отдельного согласия', () => {
    expect(needsPartialConsent(view())).toBe(false);
    expect(needsPartialConsent(view({ preview: plan({ unassignedOrderIds: ['c'] }) }))).toBe(true);
  });
});
