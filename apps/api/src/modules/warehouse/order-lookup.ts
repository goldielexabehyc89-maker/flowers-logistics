/**
 * Разрешение отсканированного номера заказа.
 *
 * Номер заказа — человеческий и QR-идентификатор (`FUL-002`), но первичным
 * ключом он не является: `DeliveryOrder.externalName` уникальностью не защищён.
 * Поэтому неоднозначность обязана давать явный отказ, а не выбор «первого
 * попавшегося»: кладовщик положил бы в ячейку не тот букет и узнал бы об этом
 * только у клиента.
 *
 * Внутренний UUID остаётся техническим ключом строки и всех связей.
 */

import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';

/** Предел длины отсканированного номера: защищает от мусора со сканера. */
export const MAX_ORDER_NUMBER_LENGTH = 64;

export interface ResolvedOrder {
  id: string;
  number: string;
  deliveryDate: Date | null;
  inScope: boolean;
  sourceArchived: boolean;
  sourceMissing: boolean;
  needsAttention: boolean;
  cancelledInSource: boolean;
  cancelledByLogistAt: Date | null;
}

const ORDER_SELECT = {
  id: true,
  externalName: true,
  deliveryDate: true,
  inScope: true,
  sourceArchived: true,
  sourceMissing: true,
  needsAttention: true,
  cancelledInSource: true,
  cancelledByLogistAt: true,
} as const;

/**
 * Нормализация номера: обрезка краёв и приведение регистра.
 *
 * Сканер добавляет перевод строки, а человек — пробелы. Регистр приводится
 * по той же причине, что и у кода ячейки: одна физическая наклейка не должна
 * давать два разных значения.
 */
export function normalizeOrderNumber(input: string): string {
  const value = input.normalize('NFKC').trim();

  if (value === '') {
    throw new AppError('VALIDATION_FAILED', {
      message: 'order number is empty',
      publicMessage: 'Отсканируйте или введите номер заказа.',
    });
  }
  if (value.length > MAX_ORDER_NUMBER_LENGTH) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'order number is too long',
      publicMessage: 'Номер заказа слишком длинный.',
    });
  }
  return value;
}

/**
 * Находит РОВНО один заказ по отсканированному номеру.
 *
 * Совпадение регистронезависимое: наклейка и база могут различаться написанием,
 * но полка от этого другой не становится. Два и более совпадения — отказ.
 */
export async function resolveOrderByNumber(
  client: Database | TransactionClient,
  scanned: string,
): Promise<ResolvedOrder> {
  const number = normalizeOrderNumber(scanned);

  // Берём до трёх строк: одной мало, чтобы обнаружить неоднозначность,
  // а больше трёх для решения «отказать» не нужно.
  const matches = await client.deliveryOrder.findMany({
    where: { externalName: { equals: number, mode: 'insensitive' } },
    select: ORDER_SELECT,
    take: 3,
  });

  if (matches.length === 0) {
    throw new AppError('NOT_FOUND', {
      message: 'order not found by number',
      publicMessage: 'Заказ с таким номером не найден.',
    });
  }

  if (matches.length > 1) {
    throw new AppError('CONFLICT', {
      message: 'order number is ambiguous',
      publicMessage:
        'Номер заказа не однозначен: в системе несколько таких заказов. Обратитесь к администратору.',
      conflict: { kind: 'ORDER_NUMBER_AMBIGUOUS', orderIds: matches.map((row) => row.id) },
    });
  }

  const order = matches[0];
  if (order === undefined) {
    throw new AppError('NOT_FOUND', { message: 'order not found by number' });
  }

  return {
    id: order.id,
    number: order.externalName,
    deliveryDate: order.deliveryDate,
    inScope: order.inScope,
    sourceArchived: order.sourceArchived,
    sourceMissing: order.sourceMissing,
    needsAttention: order.needsAttention,
    cancelledInSource: order.cancelledInSource,
    cancelledByLogistAt: order.cancelledByLogistAt,
  };
}

/**
 * Требует ли заказ внимания человека перед обычной работой.
 *
 * Физический заказ при этом НЕ теряется: разместить его можно всегда — он уже
 * лежит на складе, и притвориться, что его нет, значило бы потерять коробку.
 * Блокируются только комплектование и выдача.
 */
export function blockingFlags(order: ResolvedOrder): string[] {
  const flags: string[] = [];
  if (!order.inScope) {
    flags.push('OUT_OF_SCOPE');
  }
  if (order.sourceArchived) {
    flags.push('SOURCE_ARCHIVED');
  }
  if (order.sourceMissing) {
    flags.push('SOURCE_MISSING');
  }
  /*
   * Отменённый заказ комплектовать и выдавать нельзя.
   *
   * Разместить его по-прежнему можно — он физически на складе, и отказ
   * в приёмке означал бы потерянную коробку. А вот уехать к клиенту он
   * не должен ни в каком виде.
   */
  if (order.cancelledInSource || order.cancelledByLogistAt !== null) {
    flags.push('CANCELLED');
  }
  return flags;
}
