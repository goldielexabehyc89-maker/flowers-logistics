/**
 * Критические проверки правил складского экрана.
 *
 * Клиентские правила защитой не являются — решение принимает сервер. Но они
 * обязаны честно называть состояние: кладовщик действует по тому, что видит
 * на экране, и «не принят» вместо пустого места здесь важнее любой анимации.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_LABELS,
  CELL_KIND_LABELS,
  SCAN_HINTS,
  RELOCATION_WARNING,
  blockLabel,
  cellLabel,
  groupPlacements,
  issueCellLabel,
  issueLocationLabel,
  mergePlacementPages,
  nextPlacementOffset,
  nextStep,
  type PlacedOrderView,
} from './warehouse-flow';

function order(overrides: Partial<PlacedOrderView> = {}): PlacedOrderView {
  return {
    orderId: 'id',
    orderNumber: 'W-1',
    deliveryDate: '2027-05-04',
    cellId: 'cell',
    cellCode: 'S-01',
    cellKind: 'STORAGE',
    requiresRelocation: false,
    blockedBy: [],
    routeNumber: 'R-1',
    routeId: 'route',
    ...overrides,
  };
}

describe('двухсканный шаг', () => {
  it('до скана заказа ждём заказ, после — ячейку', () => {
    expect(nextStep(false)).toBe('ORDER');
    expect(nextStep(true)).toBe('CELL');
    expect(SCAN_HINTS.ORDER).toMatch(/заказ/i);
    expect(SCAN_HINTS.CELL).toMatch(/ячейк/i);
  });
});

describe('состояние заказа на экране', () => {
  it('отсутствие размещения называется честно, а не пустым местом', () => {
    expect(cellLabel(order({ cellCode: null, cellId: null }))).toBe('Не принят');
    expect(cellLabel(order({ cellCode: 'S-07' }))).toBe('S-07');
  });

  it('известный признак называется по-человечески, неизвестный — как есть', () => {
    expect(blockLabel('OUT_OF_SCOPE')).toBe(BLOCK_LABELS['OUT_OF_SCOPE']);
    // Признак, которого мы ещё не знаем, теряться не должен.
    expect(blockLabel('НЕЧТО_НОВОЕ')).toBe('НЕЧТО_НОВОЕ');
  });

  it('оба типа ячеек названы по-человечески', () => {
    expect(Object.keys(CELL_KIND_LABELS).sort()).toEqual(['ROUTE', 'STORAGE']);
  });
});

describe('дочитывание складского списка', () => {
  const page = (
    items: { orderId: string; cellId: string | null }[],
    meta: {
      total: number;
      limit: number;
      offset: number;
    },
  ): {
    items: { orderId: string; cellId: string | null }[];
    total: number;
    limit: number;
    offset: number;
  } => ({
    items,
    ...meta,
  });

  it('склеивает страницы по порядку и не повторяет одну коробку дважды', () => {
    const first = page(
      [
        { orderId: 'a', cellId: 'S-1' },
        { orderId: 'b', cellId: 'S-2' },
      ],
      { total: 3, limit: 2, offset: 0 },
    );
    // Пока читали вторую страницу, «a» сняли с хранения — смещение сдвинулось,
    // и «b» пришла второй раз.
    const second = page(
      [
        { orderId: 'b', cellId: 'S-2' },
        { orderId: 'c', cellId: 'S-3' },
      ],
      { total: 3, limit: 2, offset: 2 },
    );

    expect(mergePlacementPages([first, second]).map((row) => row.orderId)).toEqual(['a', 'b', 'c']);
  });

  it('один заказ в двух ячейках — это две разные коробки', () => {
    const only = page(
      [
        { orderId: 'a', cellId: 'S-1' },
        { orderId: 'a', cellId: 'S-2' },
      ],
      { total: 2, limit: 100, offset: 0 },
    );

    expect(mergePlacementPages([only])).toHaveLength(2);
  });

  it('дочитывает ровно до серверного total и потом останавливается', () => {
    expect(nextPlacementOffset({ items: new Array(100), total: 101, limit: 100, offset: 0 })).toBe(
      100,
    );
    expect(nextPlacementOffset({ items: new Array(1), total: 101, limit: 100, offset: 100 })).toBe(
      null,
    );
    // Короткая страница не повод остановиться: считается по полученным строкам.
    expect(nextPlacementOffset({ items: new Array(40), total: 101, limit: 100, offset: 0 })).toBe(
      40,
    );
    expect(nextPlacementOffset({ items: [], total: 0, limit: 100, offset: 0 })).toBe(null);
  });
});

describe('ячейка заказа в строке листа', () => {
  /*
   * Подпись стоит вплотную к статусу, поэтому берётся в скобки: без них она
   * читалась бы как часть его текста. Вид полки называется всегда — идти за
   * коробкой в хранение и на маршрутную полку это разная работа.
   */
  it('называет код и вид полки в скобках', () => {
    expect(issueCellLabel({ cellCode: 'R-01', cellKind: 'ROUTE' })).toBe('(R-01 · Маршрутная)');
    expect(issueCellLabel({ cellCode: 'S-14', cellKind: 'STORAGE' })).toBe('(S-14 · Хранение)');
  });

  it('прочерк остаётся только для заказа без размещения', () => {
    expect(issueCellLabel({ cellCode: null, cellKind: null })).toBe('—');
    // Полка без вида — это тоже «размещения нет»: гадать по коду нечего.
    expect(issueCellLabel({ cellCode: 'S-14', cellKind: null })).toBe('—');
  });
});

describe('место коробки в строке выдачи', () => {
  /*
   * Четыре честных варианта, и ни один из них не «не готов». Владельца чужой
   * полки называет сервер; номер своего листа передаётся отдельно — у заказа
   * его нет, он есть у листа.
   */
  const at = (over: Partial<Parameters<typeof issueLocationLabel>[0]>) => ({
    cellCode: 'R-05',
    cellKind: 'ROUTE' as const,
    inRouteCell: true,
    routeCellNumber: 'МЛ-100',
    ...over,
  });

  it('маршрутная ячейка своего листа', () => {
    expect(issueLocationLabel(at({ inRouteCell: true, routeCellNumber: 'МЛ-100' }), 'МЛ-100')).toBe(
      'Маршрутная ячейка №R-05 — МЛ МЛ-100',
    );
  });

  it('маршрутная ячейка чужого листа называет владельца', () => {
    expect(
      issueLocationLabel(
        at({ cellCode: 'R-09', inRouteCell: false, routeCellNumber: 'МЛ-200' }),
        'МЛ-100',
      ),
    ).toBe('Маршрутная ячейка №R-09 — другой МЛ МЛ-200');
  });

  it('ячейка хранения', () => {
    expect(
      issueLocationLabel(
        at({ cellCode: 'S-14', cellKind: 'STORAGE', inRouteCell: false, routeCellNumber: null }),
        'МЛ-100',
      ),
    ).toBe('Ячейка хранения №S-14');
  });

  it('без ячейки — не «не готов», а честное «без ячейки»', () => {
    expect(
      issueLocationLabel(
        at({ cellCode: null, cellKind: null, inRouteCell: false, routeCellNumber: null }),
        'МЛ-100',
      ),
    ).toBe('Без ячейки');
  });

  it('предупреждение о перемещении — отдельная неблокирующая подпись', () => {
    expect(RELOCATION_WARNING).toBe('Требовалось перемещение');
  });
});

describe('группы складского списка', () => {
  const item = (over: Partial<PlacedOrderView>): PlacedOrderView =>
    order({ requiresRelocation: false, blockedBy: [], cellKind: 'STORAGE', ...over });

  it('делит склад на четыре непересекающиеся группы', () => {
    const move = item({ orderNumber: 'A', requiresRelocation: true });
    const dead = item({ orderNumber: 'B', blockedBy: ['CANCELLED'] });
    const kept = item({ orderNumber: 'C' });
    const ready = item({ orderNumber: 'D', cellKind: 'ROUTE' });

    const groups = groupPlacements([move, dead, kept, ready]);

    expect(groups.relocation.map((row) => row.orderNumber)).toEqual(['A']);
    expect(groups.cancelled.map((row) => row.orderNumber)).toEqual(['B']);
    expect(groups.storage.map((row) => row.orderNumber)).toEqual(['C']);
    expect(groups.route.map((row) => row.orderNumber)).toEqual(['D']);
  });

  it('перемещение и отмена важнее типа полки', () => {
    /*
     * Коробка в маршрутной ячейке, которую надо переставить, попадает
     * в «Требует перемещения», а не в «В маршрутных ячейках»: сначала
     * решается то, что мешает работе.
     */
    const groups = groupPlacements([
      item({ orderNumber: 'A', cellKind: 'ROUTE', requiresRelocation: true }),
      item({ orderNumber: 'B', cellKind: 'ROUTE', blockedBy: ['CANCELLED'] }),
    ]);

    expect(groups.route).toHaveLength(0);
    expect(groups.relocation.map((row) => row.orderNumber)).toEqual(['A']);
    expect(groups.cancelled.map((row) => row.orderNumber)).toEqual(['B']);
  });

  it('коробка без ячейки считается хранением, а не маршрутом', () => {
    const groups = groupPlacements([item({ orderNumber: 'A', cellKind: null })]);
    expect(groups.storage).toHaveLength(1);
    expect(groups.route).toHaveLength(0);
  });
});
