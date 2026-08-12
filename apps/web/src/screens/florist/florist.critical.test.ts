/**
 * Критические проверки правил экрана флориста.
 *
 * Проверяется не вёрстка, а решения, ошибка в которых стоит дорого: показать
 * кнопку «Собран» тому, за кем заказ не закреплён, предложить «Взять в работу»
 * без смены или превратить точное время в выдуманный диапазон.
 *
 * Ни одна из этих функций защитой не является — право на действие проверяет
 * сервер. Но интерфейс, обещающий невозможное, приводит человека к отказу
 * после работы, а не до неё, и это тоже дефект.
 */

import { describe, expect, it } from 'vitest';
import {
  availableActions,
  formatInterval,
  latestJob,
  printStateLabel,
  processLabel,
  routeLabel,
  type OrderCardView,
  type QueueItemView,
} from './florist';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function card(overrides: Partial<OrderCardView> = {}): OrderCardView {
  return {
    id: 'order-1',
    number: 'FL-1',
    deliveryDate: '2027-03-10',
    startMinute: 600,
    endMinute: 840,
    cardText: null,
    description: null,
    positions: [],
    process: {
      state: 'NEW',
      version: 0,
      assignee: null,
      assignedAt: null,
      assembledAt: null,
      assembledById: null,
    },
    changedSinceClaim: false,
    print: { formId: null, jobs: [] },
    ...overrides,
  };
}

describe('доступные действия', () => {
  it('без активной смены «Взять в работу» не предлагается', () => {
    const actions = availableActions({
      card: card(),
      viewerId: VIEWER,
      isAdmin: false,
      hasActiveShift: false,
    });
    expect(actions.canClaim).toBe(false);

    const onShift = availableActions({
      card: card(),
      viewerId: VIEWER,
      isAdmin: false,
      hasActiveShift: true,
    });
    expect(onShift.canClaim).toBe(true);
  });

  it('«Собран» доступен только исполнителю, а не всякому, кто открыл карточку', () => {
    const mine = card({
      process: {
        state: 'IN_ASSEMBLY',
        version: 1,
        assignee: { id: VIEWER, fullName: 'Я' },
        assignedAt: null,
        assembledAt: null,
        assembledById: null,
      },
    });
    const foreign = card({
      process: {
        state: 'IN_ASSEMBLY',
        version: 1,
        assignee: { id: OTHER, fullName: 'Коллега' },
        assignedAt: null,
        assembledAt: null,
        assembledById: null,
      },
    });

    expect(
      availableActions({ card: mine, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canAssemble,
    ).toBe(true);
    // Даже администратору: завершать чужую сборку молча нельзя.
    expect(
      availableActions({ card: foreign, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canAssemble,
    ).toBe(false);
    // Но освободить чужой заказ администратор вправе.
    expect(
      availableActions({ card: foreign, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canRelease,
    ).toBe(true);
  });

  it('возврат в работу — только администратору и только для собранного', () => {
    const assembled = card({
      process: {
        state: 'ASSEMBLED',
        version: 2,
        assignee: { id: VIEWER, fullName: 'Я' },
        assignedAt: null,
        assembledAt: '2027-03-10T09:00:00.000Z',
        assembledById: VIEWER,
      },
    });

    expect(
      availableActions({ card: assembled, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canReopen,
    ).toBe(false);
    expect(
      availableActions({ card: assembled, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canReopen,
    ).toBe(true);
    expect(
      availableActions({ card: card(), viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canReopen,
    ).toBe(false);
  });

  it('действия печати появляются только вместе с бланком', () => {
    expect(
      availableActions({ card: card(), viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canPrint,
    ).toBe(false);

    const withForm = card({ print: { formId: 'form-1', jobs: [] } });
    expect(
      availableActions({ card: withForm, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canPrint,
    ).toBe(true);
  });
});

describe('показ значений', () => {
  it('точное время не превращается в диапазон', () => {
    expect(formatInterval({ startMinute: 840, endMinute: 840 })).toBe('14:00');
    expect(formatInterval({ startMinute: 840, endMinute: null })).toBe('14:00');
    expect(formatInterval({ startMinute: 600, endMinute: 840 })).toBe('10:00 – 14:00');
    expect(formatInterval({ startMinute: null, endMinute: null })).toBe('без времени');
  });

  it('состояния названы по-русски, неизвестное не скрывается', () => {
    expect(processLabel('NEEDS_REVIEW')).toBe('Требует проверки');
    expect(printStateLabel('ERROR')).toBe('Ошибка печати');
    // Неизвестное состояние показывается как есть: молчание хуже непонятного кода.
    expect(processLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('маршрут объясняет, почему заказ поднялся выше', () => {
    const item: QueueItemView = {
      id: 'o1',
      number: 'FL-1',
      deliveryDate: '2027-03-10',
      startMinute: 900,
      endMinute: 960,
      overdue: false,
      processState: 'NEW',
      assignee: null,
      route: { id: 'r1', number: 'R-2027-03-10-001', position: 2 },
      hasPrintForm: false,
      changedSinceClaim: false,
    };

    expect(routeLabel(item)).toBe('Маршрут R-2027-03-10-001, остановка 2');
    expect(routeLabel({ ...item, route: null })).toBeNull();
  });

  it('последнее задание печати — с наибольшим номером попытки', () => {
    const view = card({
      print: {
        formId: 'form-1',
        jobs: [
          {
            id: 'job-1',
            attempt: 1,
            state: 'ERROR',
            createdAt: '2027-03-10T09:00:00.000Z',
            completedAt: null,
            lastErrorCode: 'PRINTER_OFFLINE',
          },
          {
            id: 'job-2',
            attempt: 2,
            state: 'PENDING',
            createdAt: '2027-03-10T09:05:00.000Z',
            completedAt: null,
            lastErrorCode: null,
          },
        ],
      },
    });

    expect(latestJob(view)?.id).toBe('job-2');
    expect(latestJob(card())).toBeNull();
  });
});
