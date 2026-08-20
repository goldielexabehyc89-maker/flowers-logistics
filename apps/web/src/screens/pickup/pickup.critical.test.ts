/**
 * Критические проверки правил экрана «Самовывоз».
 *
 * Клиентские правила защитой не являются — решение принимает сервер. Но за
 * прилавком стоит человек с покупателем перед ним, и экран обязан называть
 * состояние честно: «уже выдан» вместо активной кнопки и «не принят» вместо
 * пустого места.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_LABELS,
  BLOCKER_LABELS,
  assemblyLabel,
  blockerLabel,
  canIssue,
  cellLabel,
  dayLabel,
  primaryBlocker,
  printLabel,
  type PickupCard,
} from './pickup';

function card(overrides: Partial<PickupCard> = {}): PickupCard {
  return {
    orderId: 'id',
    orderNumber: 'PU-1',
    deliveryDate: '2027-06-15',
    isPickup: true,
    assemblyState: 'ASSEMBLED',
    assembledAt: '2027-06-15T09:00:00.000Z',
    printJobs: 1,
    printedJobs: 1,
    cellId: 'cell',
    cellCode: 'S-01',
    issuedAt: null,
    issuedById: null,
    blockers: [],
    ...overrides,
  };
}

describe('готовность к выдаче', () => {
  it('выдавать можно ровно тогда, когда причин отказа нет', () => {
    expect(canIssue(card())).toBe(true);
    expect(canIssue(card({ blockers: ['NOT_PLACED'] }))).toBe(false);
    expect(canIssue(card({ blockers: ['ALREADY_ISSUED'] }))).toBe(false);
  });

  it('крупно показывается первая причина, а не «что-то не так»', () => {
    expect(primaryBlocker(card())).toBeNull();
    expect(primaryBlocker(card({ blockers: ['NOT_PICKUP', 'NOT_PLACED'] }))).toBe(
      BLOCKER_LABELS.NOT_PICKUP,
    );
  });

  it('неизвестная причина показывается как есть, а не теряется', () => {
    expect(blockerLabel('НЕЧТО_НОВОЕ')).toBe('НЕЧТО_НОВОЕ');
    expect(Object.keys(BLOCKER_LABELS).sort()).toEqual([
      'ALREADY_ISSUED',
      'NOT_PICKUP',
      'NOT_PLACED',
      'ORDER_BLOCKED',
      'ORDER_CANCELLED',
    ]);
  });
});

describe('состояние заказа на экране', () => {
  it('отсутствие ячейки называется честно и заказ из очереди не исчезает', () => {
    // «Нет ячейки» — состояние, а не причина спрятать строку: коробку унесли
    // со полки, и менеджер обязан это видеть, а не гадать.
    expect(cellLabel(card({ cellCode: null }))).toBe('Нет ячейки');
    expect(cellLabel(card({ cellCode: 'S-07' }))).toBe('S-07');
  });

  it('день заказа — подпись, а не отбор', () => {
    // День читается как дата, а не как машинная запись: так он написан
    // на всех остальных экранах.
    expect(dayLabel(card({ deliveryDate: '2027-06-15' }))).toBe('15.06.2027');
    // Заказ без даты так и называется: очередь общая, и прятать его незачем.
    expect(dayLabel(card({ deliveryDate: null }))).toBe('без даты');
  });

  it('отменённый заказ выдавать нельзя', () => {
    expect(canIssue(card({ blockers: ['ORDER_CANCELLED'] }))).toBe(false);
    expect(blockerLabel('ORDER_CANCELLED')).toBe('Заказ отменён — выдавать нельзя');
  });

  it('все состояния сборки названы по-человечески, а «вне производства» — отдельно', () => {
    expect(Object.keys(ASSEMBLY_LABELS).sort()).toEqual([
      'ASSEMBLED',
      'IN_ASSEMBLY',
      'NEEDS_REVIEW',
      'NEW',
    ]);
    expect(assemblyLabel('ASSEMBLED')).toBe('Собран');
    expect(assemblyLabel(null)).toBe('Вне производства');
  });

  it('печать различает «не печатался», «в очереди» и «напечатан»', () => {
    expect(printLabel({ printJobs: 0, printedJobs: 0 })).toBe('Бланк не печатался');
    expect(printLabel({ printJobs: 1, printedJobs: 0 })).toBe('Бланк в очереди печати');
    expect(printLabel({ printJobs: 2, printedJobs: 1 })).toBe('Бланк напечатан');
  });

  it('несобранный заказ выдаче не мешает: коробка важнее программного статуса', () => {
    // Сборка показывается как контекст. Условие выдачи — только причины отказа,
    // и «Не собран» среди них нет: физически заказ уже лежит на полке.
    expect(canIssue(card({ assemblyState: 'NEW', printJobs: 0, printedJobs: 0 }))).toBe(true);
  });
});
