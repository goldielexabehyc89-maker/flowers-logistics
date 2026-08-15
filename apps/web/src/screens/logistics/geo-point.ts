/**
 * Правила ручной установки точки заказа.
 *
 * Точка определяет, куда поедет курьер, поэтому молчаливый клик по карте такой
 * ответственности не несёт: нужна причина и отдельное подтверждение. Причина
 * уходит в неизменяемую историю заказа.
 *
 * Правила вынесены из компонента и проверяются без браузера: обязательность
 * причины, округление координат и текст отказа одинаково легко нарушить
 * незаметно.
 *
 * Логика взята из прежней панели карты «Маршрутизации» без изменения поведения —
 * это перенос, а не второй способ делать то же самое.
 */

import { ApiError } from '../../lib/api-client';
import { conflictMessage } from '../routing/routing';
import { roundCoordinate } from '../routing/geo';

/** Причина короче трёх символов ничего не объясняет тому, кто читает историю. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

export type ReasonCheck = { ok: true; reason: string } | { ok: false; error: string };

export function validateReason(raw: string): ReasonCheck {
  const reason = raw.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, error: 'Опишите причину: не меньше трёх символов.' };
  }
  return { ok: true, reason };
}

export interface PointPayload {
  /** Строки с шестью знаками: сервер принимает десятичные, а не микроградусы. */
  lat: string;
  lon: string;
  reason: string;
  expectedVersion: number;
}

/**
 * Тело запроса установки точки.
 *
 * Координаты округляются до того же знака, что и на сервере: иначе точка,
 * поставленная мышью, каждый раз считалась бы новой и плодила бы записи
 * в истории.
 */
export function pointPayload(input: {
  lat: number;
  lon: number;
  reason: string;
  version: number;
}): PointPayload {
  return {
    lat: roundCoordinate(input.lat),
    lon: roundCoordinate(input.lon),
    reason: input.reason,
    expectedVersion: input.version,
  };
}

/** Сообщение об успехе. Повторная установка той же точки — не ошибка. */
export function savedMessage(unchanged: boolean): string {
  return unchanged ? 'Точка уже стояла здесь' : 'Точка сохранена';
}

/**
 * Текст отказа.
 *
 * Конфликт версии или занятый заказ объясняются человеку, а не показываются
 * технической строкой.
 */
export function saveFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return conflictMessage(error.conflict?.kind ?? undefined, error.message);
  }
  return 'Не удалось сохранить точку. Повторите попытку.';
}
