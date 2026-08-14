/**
 * Проверки ручной установки точки заказа.
 *
 * Точка определяет, куда поедет курьер. Защищаемые свойства: причина
 * обязательна, отмена ничего не записывает, координаты уходят округлёнными,
 * а отказ сервера объясняется человеку, а не показывается кодом.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api-client';
import {
  MIN_REASON_LENGTH,
  pointPayload,
  saveFailure,
  savedMessage,
  validateReason,
} from './geo-point';

describe('причина обязательна', () => {
  it('пустая и слишком короткая причина отклоняются', () => {
    // Причина уходит в неизменяемую историю заказа: «.» ничего не объяснит
    // тому, кто через месяц спросит, почему курьер поехал сюда.
    for (const raw of ['', '   ', 'а', 'аб']) {
      const result = validateReason(raw);
      expect(result.ok, `причина «${raw}»`).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/не меньше трёх символов/);
      }
    }
  });

  it('причина принимается и сохраняется без окружающих пробелов', () => {
    const result = validateReason('  дом за шлагбаумом  ');
    expect(result).toEqual({ ok: true, reason: 'дом за шлагбаумом' });
  });

  it('граница длины названа одним числом', () => {
    expect(validateReason('а'.repeat(MIN_REASON_LENGTH)).ok).toBe(true);
    expect(validateReason('а'.repeat(MIN_REASON_LENGTH - 1)).ok).toBe(false);
  });
});

describe('тело запроса', () => {
  it('координаты округляются, версия и причина уходят как есть', () => {
    // Без округления точка, поставленная мышью, каждый раз считалась бы новой
    // и плодила бы записи в истории.
    const payload = pointPayload({
      lat: 55.7512443219,
      lon: 37.6184229876,
      reason: 'дом за шлагбаумом',
      version: 7,
    });

    expect(payload.expectedVersion).toBe(7);
    expect(payload.reason).toBe('дом за шлагбаумом');
    expect(payload.lat).toBe('55.751244');
    expect(payload.lon).toBe('37.618423');
  });
});

describe('ответ сервера', () => {
  it('повторная установка той же точки не выдаётся за ошибку', () => {
    expect(savedMessage(true)).toMatch(/уже стояла/);
    expect(savedMessage(false)).toMatch(/сохранена/);
  });

  it('конфликт версии объясняется человеком, а не кодом', () => {
    const conflict = new ApiError(409, 'CONFLICT', 'stale version', null, {
      kind: 'STALE_VERSION',
    });

    const message = saveFailure(conflict);
    expect(message).not.toBe('stale version');
    expect(message.length).toBeGreaterThan(0);
  });

  it('сетевой сбой даёт понятный текст, а не пустоту', () => {
    expect(saveFailure(new Error('fetch failed'))).toMatch(/Не удалось сохранить точку/);
    expect(saveFailure(undefined)).toMatch(/Не удалось сохранить точку/);
  });
});
