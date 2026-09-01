/**
 * Критические проверки приёмки из «Ожидают приёмки».
 *
 * Защищаемые свойства двухэтапной приёмки по карточке:
 *
 *  * первый скан обязан совпасть с ВЫБРАННЫМ заказом по устойчивому
 *    идентификатору (`orderId`), а не по похожей строке номера;
 *  * не тот заказ — цепочка остаётся на первом шаге, в базу ничего не уходит,
 *    а человеку показаны оба номера;
 *  * запись происходит только на втором шаге (ячейка) и ровно одним запросом;
 *  * ручной ввод и камера идут одним и тем же путём машины, поэтому проходят
 *    ту же проверку (это свойство машины — см. scan-machine.critical.test).
 */

import { describe, expect, it } from 'vitest';
import { createReceiveIntent } from './receive-intent';
import type { ScanContext } from './warehouse-flow';
import { initialState, reduce } from '../../scan/scan-machine';
import type { ScanEvent } from '../../scan/scan-machine';

type Client = Parameters<typeof createReceiveIntent>[0]['client'];

interface Recorded {
  gets: string[];
  posts: { url: string; body: unknown }[];
}

function fakeClient(
  context: ScanContext,
  postResult: unknown = { orderNumber: context.orderNumber, cellCode: 'A-1' },
): { client: Client; log: Recorded } {
  const log: Recorded = { gets: [], posts: [] };
  const client = {
    get: async (url: string) => {
      log.gets.push(url);
      return context;
    },
    post: async (url: string, body: unknown) => {
      log.posts.push({ url, body });
      return postResult;
    },
  } as unknown as Client;
  return { client, log };
}

function context(overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    orderId: 'id-selected',
    orderNumber: 'FUL-100',
    blockedBy: [],
    needsAttention: false,
    currentCell: null,
    route: null,
    ...overrides,
  };
}

const noop = async (): Promise<void> => {};

describe('совпадение отсканированного заказа с карточкой', () => {
  it('другой заказ отвергается по устойчивому id, ничего не записывая', async () => {
    // Тот же НОМЕР, но другой orderId — это другой заказ. Сравнение по строке
    // номера пропустило бы его, сравнение по устойчивому id — нет.
    const scanned = context({ orderId: 'id-other', orderNumber: 'FUL-100' });
    const { client, log } = fakeClient(scanned);
    const handler = createReceiveIntent({
      client,
      onPlaced: noop,
      guard: (ctx) =>
        ctx.orderId === 'id-selected'
          ? null
          : {
              type: 'failed',
              text: `Отсканирован заказ ${ctx.orderNumber}, а нужен FUL-100-selected. Отсканируйте заказ с карточки.`,
            },
    });

    const event = await handler({ kind: 'resolveOrder', code: 'FUL-100' });
    expect(event.type).toBe('failed');
    // Показаны оба номера — выбранного и отсканированного.
    if (event.type === 'failed') {
      expect(event.text).toContain('FUL-100');
      expect(event.text).toContain('FUL-100-selected');
    }
    // Ни одной записи: отказ до второго шага.
    expect(log.posts).toEqual([]);
  });

  it('совпадение по id пропускает даже при другой строке номера', async () => {
    // id совпал, номер отличается (перевыпуск наклейки) — это тот же заказ.
    const scanned = context({ orderId: 'id-selected', orderNumber: 'FUL-100-alt' });
    const { client } = fakeClient(scanned);
    const handler = createReceiveIntent({
      client,
      onPlaced: noop,
      guard: (ctx) => (ctx.orderId === 'id-selected' ? null : { type: 'failed', text: 'не тот' }),
    });

    const event = await handler({ kind: 'resolveOrder', code: 'FUL-100-alt' });
    expect(event.type).toBe('orderResolved');
  });
});

describe('две ступени и единственная запись', () => {
  it('до скана ячейки записи нет, на ячейке — ровно один запрос', async () => {
    const scanned = context({ orderId: 'id-selected', orderNumber: 'FUL-100' });
    const { client, log } = fakeClient(scanned);
    const handler = createReceiveIntent({
      client,
      onPlaced: noop,
      guard: (ctx) => (ctx.orderId === 'id-selected' ? null : { type: 'failed', text: 'не тот' }),
    });

    // Шаг заказа: код уходит на разрешение, но НИЧЕГО не записывает.
    let state = initialState('RECEIVE');
    const orderStep = reduce(state, { type: 'scanned', code: 'FUL-100' });
    state = orderStep.state;
    expect(orderStep.intent.kind).toBe('resolveOrder');
    const resolved = await handler({ kind: 'resolveOrder', code: 'FUL-100' });
    expect(resolved.type).toBe('orderResolved');
    expect(log.posts).toEqual([]); // до ячейки записи нет

    // Машина переходит к ячейке и показывает короткое уведомление «заказ
    // отсканирован». Пока оно открыто, ввод заблокирован — как и на экране;
    // уведомление гаснет само (в тесте — событием `noticeExpired`).
    state = reduce(state, resolved as ScanEvent).state;
    expect(state.step).toBe('CELL');
    state = reduce(state, { type: 'noticeExpired' }).state;

    // Шаг ячейки: собрана пара — только теперь один запрос.
    const cellStep = reduce(state, { type: 'scanned', code: 'A-1' });
    expect(cellStep.intent.kind).toBe('submitPair');
    const done = await handler(cellStep.intent);
    expect(done.type).toBe('succeeded');
    expect(log.posts).toHaveLength(1);
    expect(log.posts[0]?.url).toBe('/api/warehouse/placements');
    expect(log.posts[0]?.body).toMatchObject({ orderNumber: 'FUL-100', cellCode: 'A-1' });
  });

  it('повторная пара снова идёт в тот же идемпотентный запрос приёмки', async () => {
    const scanned = context();
    const { client, log } = fakeClient(scanned, {
      orderNumber: 'FUL-100',
      cellCode: 'A-1',
    });
    const handler = createReceiveIntent({ client, onPlaced: noop });

    const pair = {
      kind: 'submitPair' as const,
      orderNumber: 'FUL-100',
      cellCode: 'A-1',
      target: 'STORAGE' as const,
      routeId: null,
      allowNewCell: false,
    };
    await handler(pair);
    await handler(pair);
    // Клиент не хранит блокирующего состояния: обе пары идут в один и тот же
    // серверный путь приёмки, который сам идемпотентен.
    expect(log.posts.map((post) => post.url)).toEqual([
      '/api/warehouse/placements',
      '/api/warehouse/placements',
    ]);
  });
});
