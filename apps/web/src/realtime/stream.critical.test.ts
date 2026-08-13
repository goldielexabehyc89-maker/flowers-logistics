/**
 * Критические проверки правил канала обновлений.
 *
 * Проверяется главное: событие заказа заставляет список перезапроситься сам,
 * без перезагрузки страницы, и при этом не тянет за собой чужие данные.
 */

import { describe, expect, it } from 'vitest';
import { collapseToFirstPage, invalidationKeysFor } from './stream';

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

  it('потеря сессии ничего не перезапрашивает', () => {
    // Запросы после отзыва сессии всё равно вернули бы 401 и только шумели бы.
    expect(invalidationKeysFor('session.revoked')).toEqual([]);
  });
});

/**
 * Списки с продолжением при событии.
 *
 * Событие означает, что выборка изменилась. Перезапросить все накопленные
 * страницы поверх сместившейся выборки — значит получить либо повтор строки,
 * либо пропуск, да ещё и вытянуть весь день целиком. Единственный честный
 * ответ — вернуться к первой странице.
 */
describe('сброс накопленных страниц', () => {
  it('оставляет ровно первую страницу и её параметр', () => {
    const collapsed = collapseToFirstPage({
      pages: [{ items: ['a'] }, { items: ['b'] }, { items: ['c'] }],
      pageParams: [0, 50, 100],
    });

    expect(collapsed.pages).toEqual([{ items: ['a'] }]);
    // Параметр обязан сократиться вместе со страницами: рассогласование
    // заставило бы следующий запрос уйти не на то смещение.
    expect(collapsed.pageParams).toEqual([0]);
  });

  it('не трогает обычные запросы и одиночную страницу', () => {
    // Под тот же ключ попадает и запрос без страниц: испортить его нельзя.
    const plain = { shift: null };
    expect(collapseToFirstPage(plain)).toBe(plain);
    expect(collapseToFirstPage(undefined)).toBeUndefined();
    expect(collapseToFirstPage(null)).toBeNull();

    // Одна страница уже является первой: лишняя замена ссылки вызвала бы
    // перерисовку списка на каждое чужое событие.
    const single = { pages: [{ items: ['a'] }], pageParams: [0] };
    expect(collapseToFirstPage(single)).toBe(single);
  });
});
