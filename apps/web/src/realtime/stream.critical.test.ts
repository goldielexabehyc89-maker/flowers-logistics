/**
 * Критические проверки правил канала обновлений.
 *
 * Проверяется главное: событие заказа заставляет список перезапроситься сам,
 * без перезагрузки страницы, и при этом не тянет за собой чужие данные.
 */

import { REALTIME_TOPICS } from '@fl/shared';
import { describe, expect, it } from 'vitest';
import { collapseToFirstPage, endsSession, invalidationKeysFor } from './stream';

describe('завершение сессии', () => {
  it('текущую сессию завершает ТОЛЬКО адресный session-closed', () => {
    expect(endsSession('session-closed')).toBe(true);
  });

  it('историческое журнальное session.revoked живой вход не завершает', () => {
    // Регрессия: доставка архива с прошлым session.revoked не должна выкидывать
    // новую действующую сессию.
    expect(endsSession('session.revoked')).toBe(false);
    // И оно не перезапрашивает клиент: ключей на обновление у него нет.
    expect(invalidationKeysFor('session.revoked')).toEqual([]);
  });

  it('обычные события сессию не трогают', () => {
    expect(endsSession('order.updated')).toBe(false);
    expect(endsSession('pickup.issued')).toBe(false);
  });
});

describe('обновление данных по событиям', () => {
  it('событие заказа обновляет рабочий список «Сделок»', () => {
    // Прежде здесь стоял ключ `orders`. Экрана с таким ключом уже нет: живой
    // список — это `deals`, и обновлять надо было именно его.
    for (const topic of ['order.created', 'order.updated', 'order.scope_changed']) {
      const keys = invalidationKeysFor(topic).map((key) => key.join('.'));
      expect(keys, topic).toContain('deals');
      expect(keys, topic).toContain('status');
      // Сотрудники к заказам отношения не имеют и перезапрашиваться не должны.
      expect(keys, topic).not.toContain('users');
    }
  });

  it('событие пользователя не трогает список заказов', () => {
    const keys = invalidationKeysFor('user.updated').map((key) => key.join('.'));
    expect(keys).toContain('users');
    expect(keys).not.toContain('deals');
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

describe('таблица событий и потребителей полна', () => {
  it('каждое объявленное событие названо явно, без общего запасного правила', () => {
    /*
     * Прежняя цепочка `startsWith` молча теряла целые разделы: `route_plan.`,
     * `depot.`, `storage_cell.` и `delivery.` не совпадали ни с одним префиксом
     * и попадали в общий запасной ответ. Экран расчёта, настройки складов,
     * справочник ячеек и курьерские списки не обновлялись вообще.
     */
    const fallback = JSON.stringify([['status']]);

    for (const topic of REALTIME_TOPICS) {
      const keys = JSON.stringify(invalidationKeysFor(topic));
      if (topic === 'integration.status_changed') {
        // Единственное событие, которому общий признак состояния и нужен.
        expect(keys, topic).toBe(fallback);
        continue;
      }
      expect(keys, topic).not.toBe(fallback);
    }
  });

  it('изменение адреса и точки обновляет «Сделки» вместе с их картой', () => {
    // Ровно этот разрыв делал чужую — и часть своей — правки невидимой до F5.
    for (const topic of ['order.address_changed', 'order.geo_changed'] as const) {
      const keys = invalidationKeysFor(topic).map((key) => key[0]);
      expect(keys, topic).toContain('deals');
      expect(keys, topic).toContain('deals-map');
    }
  });

  it('признак «Собран» обновляется от обоих источников', () => {
    // Флорист завершил сборку либо заказ разместили в ячейке: логист обязан
    // увидеть это в своём списке и на карте без перезагрузки.
    for (const topic of [
      'order.fulfillment_process_changed',
      'warehouse.placement_changed',
    ] as const) {
      const keys = invalidationKeysFor(topic).map((key) => key[0]);
      expect(keys, topic).toContain('deals');
    }
  });

  it('маршрутные события доходят до производства, а не только до логистики', () => {
    /*
     * Подтверждённый лист — это работа склада и флориста: он задаёт, что
     * комплектовать и в каком порядке собирать. Пока эти ключи сюда не
     * входили, обе роли узнавали об изменении состава только перезагрузкой
     * и продолжали собирать снятые заказы.
     */
    for (const topic of [
      'route.confirmed',
      'route.updated',
      'route.returned_to_draft',
      'route.cancelled',
    ] as const) {
      const keys = invalidationKeysFor(topic).map((key) => key[0]);
      expect(keys, topic).toContain('florist-queue');
      expect(keys, topic).toContain('warehouse-routes');
      expect(keys, topic).toContain('warehouse-route');
    }
  });

  it('смена курьера и складские переходы видны всем складским вкладкам', () => {
    const keys = invalidationKeysFor('warehouse.route_flow_changed').map((key) => key[0]);
    for (const expected of ['warehouse-routes', 'warehouse-route', 'warehouse-placements']) {
      expect(keys, expected).toContain(expected);
    }
    // И маршрутные листы логиста: отгрузка меняет их раздел.
    expect(keys).toContain('route-sheets');
  });

  it('правка заказа доходит до очереди флориста', () => {
    // Интервал задаёт порядок очереди: без этого ключа флорист собирал бы
    // по вчерашнему приоритету.
    for (const topic of ['order.created', 'order.updated'] as const) {
      expect(
        invalidationKeysFor(topic).map((key) => key[0]),
        topic,
      ).toContain('florist-queue');
    }
  });

  it('готовность заказа доходит до склада', () => {
    for (const topic of [
      'order.fulfillment_process_changed',
      'order.fulfillment_changed',
    ] as const) {
      const keys = invalidationKeysFor(topic).map((key) => key[0]);
      expect(keys, topic).toContain('warehouse-placements');
    }
  });

  it('расчёт, склады и ячейки перестали быть невидимыми', () => {
    expect(invalidationKeysFor('route_plan.updated').map((key) => key[0])).toContain('route-plan');
    expect(invalidationKeysFor('depot.changed').map((key) => key[0])).toContain('depots');
    expect(invalidationKeysFor('storage_cell.changed').map((key) => key[0])).toContain(
      'storage-cells',
    );
    expect(invalidationKeysFor('delivery.result_recorded').map((key) => key[0])).toContain(
      'delivery-active',
    );
  });

  it('незнакомое событие не перезапрашивает клиент целиком', () => {
    expect(invalidationKeysFor('нет.такого.события')).toEqual([['status']]);
  });
});
