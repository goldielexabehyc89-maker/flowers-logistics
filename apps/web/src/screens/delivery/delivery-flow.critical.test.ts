/**
 * Критические проверки правил экрана курьера.
 *
 * Здесь проверяется то, из-за чего курьер сделал бы неверный вывод: досрочность
 * и опоздание, которые НЕ блокируют результат, обязательный комментарий для
 * «Другого», остаток пятиминутного окна и группировка объединённого списка.
 *
 * Часовой пояс устройства подменяется намеренно: московская граница обязана
 * считаться одинаково у курьера в любом поясе.
 */

import { describe, expect, it } from 'vitest';
import {
  CANCEL_WINDOW_MS,
  cancelWindowLeftMs,
  formatCash,
  groupRoutes,
  intervalPosition,
  moscowMinutesOfDay,
  remainingOf,
  resultDraftProblem,
  selectableReasons,
  routeAccent,
  type ActiveRouteView,
  type FailureReasonView,
} from './delivery-flow';

const REASONS: FailureReasonView[] = [
  {
    id: 'r-1',
    code: 'NO_ANSWER',
    name: 'Нет ответа',
    requiresComment: false,
    isActive: true,
    version: 1,
  },
  { id: 'r-2', code: 'OTHER', name: 'Другое', requiresComment: true, isActive: true, version: 1 },
  {
    id: 'r-3',
    code: 'DAMAGE',
    name: 'Повреждение',
    requiresComment: false,
    isActive: false,
    version: 1,
  },
];

describe('интервал доставки', () => {
  it('досрочность видна, но результат ею не запрещается', () => {
    const order = { intervalStartMinute: 600, intervalEndMinute: 720 };

    expect(intervalPosition(order, 540)).toBe('early');
    expect(intervalPosition(order, 660)).toBe('inside');
    expect(intervalPosition(order, 800)).toBe('late');

    // Ни одно положение не мешает отправить результат: это предупреждение,
    // а не запрет. Продукт разрешает подтвердить досрочно и после срока.
    expect(
      resultDraftProblem({ outcome: 'DELIVERED', reasonId: null, comment: '' }, REASONS),
    ).toBeNull();
  });

  it('заказ без интервала не объявляется ни ранним, ни опоздавшим', () => {
    expect(intervalPosition({ intervalStartMinute: null, intervalEndMinute: null }, 700)).toBe(
      'unknown',
    );
  });

  it('граница включительна с обеих сторон', () => {
    const order = { intervalStartMinute: 600, intervalEndMinute: 720 };
    expect(intervalPosition(order, 600)).toBe('inside');
    expect(intervalPosition(order, 720)).toBe('inside');
  });
});

describe('московские минуты не зависят от пояса устройства', () => {
  it('один и тот же момент даёт одни и те же минуты', () => {
    // 09:30 UTC — это 12:30 в Москве независимо от того, где находится курьер.
    const instant = new Date('2027-07-19T09:30:00.000Z');
    expect(moscowMinutesOfDay(instant)).toBe(12 * 60 + 30);
  });
});

describe('черновик результата', () => {
  it('без выбранного результата отправлять нечего', () => {
    expect(resultDraftProblem({ outcome: null, reasonId: null, comment: '' }, REASONS)).toMatch(
      /результат/i,
    );
  });

  it('недоставка без причины не отправляется', () => {
    expect(
      resultDraftProblem({ outcome: 'NOT_DELIVERED', reasonId: null, comment: '' }, REASONS),
    ).toMatch(/причину/i);
  });

  it('причина, требующая пояснения, курьеру не предлагается', () => {
    /*
     * Поля комментария в окне нет: у двери человек нажимает кнопку, а не
     * пишет текст. Поэтому «Другое» отфильтровано из выбора, а проверка
     * черновика остаётся защитой от несогласованного состояния — например,
     * если справочник изменили, пока окно было открыто.
     */
    expect(selectableReasons(REASONS).map((reason) => reason.id)).not.toContain('r-2');
    expect(selectableReasons(REASONS).every((reason) => reason.isActive)).toBe(true);

    expect(
      resultDraftProblem({ outcome: 'NOT_DELIVERED', reasonId: 'r-2', comment: '' }, REASONS),
    ).toMatch(/недоступна/i);
  });

  it('выключенная причина не принимается', () => {
    expect(
      resultDraftProblem({ outcome: 'NOT_DELIVERED', reasonId: 'r-3', comment: '' }, REASONS),
    ).toMatch(/недоступна/i);
  });

  it('обычная причина принимается одной кнопкой, без пояснения', () => {
    // В окне остались только кнопки причин: комментарий не собирается вовсе
    // и не отправляется даже пустой строкой.
    expect(
      resultDraftProblem({ outcome: 'NOT_DELIVERED', reasonId: 'r-1', comment: '' }, REASONS),
    ).toBeNull();
  });

  it('у «Доставлен» ни причины, ни комментария не требуется', () => {
    expect(
      resultDraftProblem({ outcome: 'DELIVERED', reasonId: null, comment: '' }, REASONS),
    ).toBeNull();
  });
});

describe('окно исправления', () => {
  it('остаток уменьшается и не уходит ниже нуля', () => {
    const at = new Date('2027-07-19T10:00:00.000Z');
    const attempt = { occurredAt: at.toISOString() };

    expect(cancelWindowLeftMs(attempt, at)).toBe(CANCEL_WINDOW_MS);
    expect(cancelWindowLeftMs(attempt, new Date(at.getTime() + 60_000))).toBe(
      CANCEL_WINDOW_MS - 60_000,
    );
    expect(cancelWindowLeftMs(attempt, new Date(at.getTime() + CANCEL_WINDOW_MS + 5_000))).toBe(0);
  });
});

describe('объединённый список', () => {
  const route = (
    id: string,
    number: string,
    date: string,
    results: (string | null)[],
  ): ActiveRouteView => ({
    routeId: id,
    number,
    deliveryDate: date,
    state: 'ACTIVE',
    vehicleType: 'CAR',
    courier: { id: 'c-1', fullName: 'Курьер' },
    orders: results.map((result, index) => ({
      routeOrderId: `${id}-ro-${index}`,
      orderId: `${id}-o-${index}`,
      position: results.length - index,
      number: `N-${index}`,
      address: null,
      point: null,
      cancelled: false,
      recipient: null,
      comment: null,
      intervalStartMinute: null,
      intervalEndMinute: null,
      cashToCollectMinor: '0',
      cashCollectable: false,
      result:
        result === null
          ? null
          : {
              id: result,
              outcome: 'DELIVERED',
              reasonId: null,
              reasonName: null,
              comment: null,
              occurredAt: '2027-07-19T10:00:00.000Z',
              courier: { id: 'c-1', fullName: 'Курьер' },
              cancellable: true,
            },
    })),
  });

  it('заказы внутри маршрута идут по позиции: порядок рекомендательный, но стабильный', () => {
    const grouped = groupRoutes([route('a', 'R-1', '2027-07-19', [null, null, null])], null);
    expect(grouped[0]?.orders.map((order) => order.position)).toEqual([1, 2, 3]);
  });

  it('маршруты с незавершёнными заказами идут первыми', () => {
    const done = route('a', 'R-1', '2027-07-19', ['x']);
    const pending = route('b', 'R-2', '2027-07-19', [null]);

    const grouped = groupRoutes([done, pending], null);
    expect(grouped.map((entry) => entry.routeId)).toEqual(['b', 'a']);
  });

  it('фильтр маршрута сужает список', () => {
    const grouped = groupRoutes(
      [route('a', 'R-1', '2027-07-19', [null]), route('b', 'R-2', '2027-07-19', [null])],
      'b',
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.routeId).toBe('b');
  });

  it('остаток считается по заказам без результата', () => {
    expect(remainingOf(route('a', 'R-1', '2027-07-19', [null, 'x', null]))).toBe(2);
    expect(remainingOf(route('a', 'R-1', '2027-07-19', ['x']))).toBe(0);
  });

  it('цвет маршрута устойчив и зависит от номера, а не от порядка', () => {
    expect(routeAccent('R-2026-08-13-001')).toBe(routeAccent('R-2026-08-13-001'));
    expect(routeAccent('R-2026-08-13-001')).not.toBe(routeAccent('R-2026-08-13-002'));
  });
});

describe('сумма к получению', () => {
  it('копейки показываются рублями, мусор — прочерком', () => {
    expect(formatCash('123450')).toBe('1234.50 ₽');
    expect(formatCash('0')).toBe('0.00 ₽');
    expect(formatCash('не число')).toBe('—');
  });
});
