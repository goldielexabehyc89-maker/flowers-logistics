/**
 * Правила экрана «Склад», вынесенные из компонента.
 *
 * Здесь только чистые функции и типы: их проверяют тесты без браузера.
 * Состав полей намеренно узкий — он повторяет безопасный ответ сервера
 * и не оставляет места адресу, получателю, комментарию и деньгам.
 */

import type { StatusTone } from '../../ui/components';

export type ShipmentReadiness = 'NOT_READY' | 'READY';

export type ReadinessFilter = 'ALL' | ShipmentReadiness;

export interface WarehouseOrderView {
  id: string;
  number: string;
  deliveryDate: string | null;
  /** Внешний статус МоегоСклада — только контекст, состоянием не управляет. */
  externalStateName: string | null;
  readiness: ShipmentReadiness;
  readinessSetAt: string | null;
  version: number;
}

export interface WarehouseListResponse {
  items: WarehouseOrderView[];
  total: number;
  limit: number;
  offset: number;
}

export const READINESS_LABELS: Record<ShipmentReadiness, string> = {
  NOT_READY: 'Не готов',
  READY: 'Готов',
};

export const READINESS_FILTERS: readonly { value: ReadinessFilter; label: string }[] = [
  { value: 'ALL', label: 'Все' },
  { value: 'READY', label: 'Готовы' },
  { value: 'NOT_READY', label: 'Не готовы' },
];

/**
 * Цвет отметки.
 *
 * Неготовый заказ — не ошибка и не авария: это обычное начальное состояние,
 * поэтому он нейтральный, а не красный. Красным на складе должно быть только то,
 * что требует вмешательства.
 */
export function readinessTone(readiness: ShipmentReadiness): StatusTone {
  return readiness === 'READY' ? 'success' : 'neutral';
}

/** Действие, доступное для строки: противоположное текущему состоянию. */
export function nextReadiness(current: ShipmentReadiness): ShipmentReadiness {
  return current === 'READY' ? 'NOT_READY' : 'READY';
}

/** Подпись кнопки действия. Называет результат, а не текущее состояние. */
export function actionLabel(current: ShipmentReadiness): string {
  return READINESS_LABELS[nextReadiness(current)];
}

/** Пустое значение показывается прочерком, а не пустотой: иначе колонка «уехала». */
export const EMPTY_VALUE = '—';

/** `2026-08-07T10:15:00.000Z` → `07.08.2026, 13:15` по Москве. */
export function formatMoscowTime(value: string | null): string {
  if (value === null) {
    return EMPTY_VALUE;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return EMPTY_VALUE;
  }
  // Сдвиг на московские +03:00 выполняется явно: часовой пояс браузера
  // кладовщика к рабочему дню склада отношения не имеет.
  const moscow = new Date(parsed.getTime() + 3 * 60 * 60 * 1000);
  const iso = moscow.toISOString();
  const date = iso.slice(0, 10).split('-');
  return `${date[2]}.${date[1]}.${date[0]}, ${iso.slice(11, 16)}`;
}
