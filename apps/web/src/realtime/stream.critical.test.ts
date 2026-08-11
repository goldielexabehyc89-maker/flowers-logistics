/**
 * Критические проверки правил канала обновлений.
 *
 * Проверяется главное: событие заказа заставляет список перезапроситься сам,
 * без перезагрузки страницы, и при этом не тянет за собой чужие данные.
 */

import { describe, expect, it } from 'vitest';
import { invalidationKeysFor } from './stream';

describe('обновление данных по событиям', () => {
  it('событие заказа обновляет список заказов и состояние интеграции', () => {
    for (const topic of ['order.created', 'order.updated', 'order.scope_changed']) {
      const keys = invalidationKeysFor(topic).map((key) => key.join('.'));
      expect(keys, topic).toContain('orders');
      expect(keys, topic).toContain('status');
      // Сотрудники к заказам отношения не имеют и перезапрашиваться не должны.
      expect(keys, topic).not.toContain('users');
    }
  });

  it('событие пользователя не трогает список заказов', () => {
    const keys = invalidationKeysFor('user.updated').map((key) => key.join('.'));
    expect(keys).toContain('users');
    expect(keys).not.toContain('orders');
  });

  it('готовность к отгрузке обновляет только список склада', () => {
    const keys = invalidationKeysFor('order.shipment_readiness_changed').map((key) =>
      key.join('.'),
    );

    expect(keys).toEqual(['warehouse-orders']);
    // Неготовность пока ни на что у логиста не влияет, и гонять его тяжёлые
    // списки из-за складской отметки незачем.
    expect(keys).not.toContain('orders');
    expect(keys).not.toContain('unassigned-orders');
  });

  it('потеря сессии ничего не перезапрашивает', () => {
    // Запросы после отзыва сессии всё равно вернули бы 401 и только шумели бы.
    expect(invalidationKeysFor('session.revoked')).toEqual([]);
  });
});
