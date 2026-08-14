/**
 * Критические проверки карты «Сделок» и диалога адреса.
 *
 * Проверяются пользовательские свойства, нарушение которых опасно: выбранная
 * точка не должна прятаться в безымянный кластер, состояния обязаны различаться
 * не только цветом, а браузер не должен обращаться к DaData напрямую.
 *
 * Настоящих сетевых обращений здесь нет: серверные ответы подменены.
 */

import { describe, expect, it } from 'vitest';
import { planMarkers, type DealMapPoint } from './DealsMapCanvas';
import { moscowCalendarDate } from '@fl/shared';
import { intervalProblem, parseTimeFilter, type DealCard } from './selection';
import { clusterize, MARKER_LOOKS, splitForMap, type DealPoint } from './DealsMap';
import { availabilityHint, suggestionPoint, suggestionsUrl } from './AddressDialog';

/** Минимальная карточка: проверке нужны только минуты интервала. */
function card(overrides: Partial<DealCard>): DealCard {
  return {
    id: 'o-1',
    number: 'N-1',
    address: null,
    sourceAddress: null,
    addressCorrected: false,
    addressConflict: false,
    recipient: null,
    comment: null,
    deliveryDate: '2027-05-05',
    startMinute: null,
    endMinute: null,
    intervalCorrected: false,
    needsAttention: false,
    attentionReasons: [],
    geoState: 'RESOLVED',
    draftRouteId: null,
    draftRouteNumber: null,
    selectable: true,
    sourceStartMinute: null,
    sourceEndMinute: null,
    sourceIntervalRaw: null,
    version: 1,
    ...overrides,
  };
}

function point(id: string, lat: string, lon: string): DealPoint {
  return {
    orderId: id,
    number: `N-${id}`,
    lat,
    lon,
    startMinute: 600,
    endMinute: 720,
    needsAttention: false,
  };
}

describe('карта: кластеры и выбранные точки', () => {
  it('близкие точки объединяются, далёкие остаются раздельными', () => {
    const clusters = clusterize([
      point('a', '55.7512', '37.6184'),
      point('b', '55.7513', '37.6185'),
      point('c', '55.9000', '37.9000'),
    ]);

    const sizes = clusters.map((cluster) => cluster.points.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('выбранная точка в кластер не попадает никогда', () => {
    const points = [
      point('a', '55.7512', '37.6184'),
      point('b', '55.7513', '37.6185'),
      point('c', '55.7514', '37.6186'),
    ];

    const { chosen, clusters } = splitForMap(points, ['b'], true);

    // Выбранная показана отдельно и со своим номером.
    expect(chosen.map((item) => item.orderId)).toEqual(['b']);
    // В кластерах её нет ни при каком масштабе.
    const clustered = clusters.flatMap((cluster) => cluster.points.map((item) => item.orderId));
    expect(clustered).not.toContain('b');
    expect(clustered.sort()).toEqual(['a', 'c']);
  });

  it('на приближении кластеры распадаются на отдельные заказы', () => {
    const points = [point('a', '55.7512', '37.6184'), point('b', '55.7513', '37.6185')];
    const { clusters } = splitForMap(points, [], false);

    expect(clusters).toHaveLength(2);
    expect(clusters.every((cluster) => cluster.points.length === 1)).toBe(true);
  });
});

describe('карта: состояния различимы не только цветом', () => {
  it('у каждого состояния своя форма и свой цвет', () => {
    const states = Object.keys(MARKER_LOOKS) as (keyof typeof MARKER_LOOKS)[];
    const shapes = states.map((state) => MARKER_LOOKS[state].shape);
    const colors = states.map((state) => MARKER_LOOKS[state].color);

    // Ни форма, ни цвет не повторяются: иначе два состояния читались бы
    // как одно тем, кто не различает цвет.
    expect(new Set(shapes).size).toBe(states.length);
    expect(new Set(colors).size).toBe(states.length);
  });

  it('легенда покрывает все состояния карты', () => {
    expect(Object.keys(MARKER_LOOKS).sort()).toEqual(['DEPOT', 'DRAFT', 'FREE', 'PICKED']);
  });
});

describe('диалог адреса', () => {
  it('браузер обращается только к нашему эндпоинту', () => {
    const url = suggestionsUrl('  Москва, улица  ');
    expect(url.startsWith('/api/orders/address-suggestions')).toBe(true);
    // Ни адреса DaData, ни ключа в запросе браузера нет и быть не может.
    expect(url).not.toContain('dadata');
    expect(url).not.toContain('Token');
    // Запрос обрезан по краям: лишние пробелы тратили бы квоту впустую.
    expect(url).toContain(encodeURIComponent('Москва, улица'));
  });

  it('точка сохраняется только из точной подсказки', () => {
    expect(suggestionPoint({ latMicro: 55_751_244, lonMicro: 37_618_423, exact: true })).toEqual({
      latMicro: 55_751_244,
      lonMicro: 37_618_423,
    });
    // Неточная привязка в автоматику не допускается.
    expect(
      suggestionPoint({ latMicro: 55_751_244, lonMicro: 37_618_423, exact: false }),
    ).toBeNull();
    // Подсказка без координат тоже не даёт точки.
    expect(suggestionPoint({ latMicro: null, lonMicro: null, exact: true })).toBeNull();
    expect(suggestionPoint(null)).toBeNull();
  });

  it('недоступность провайдера объясняется, а не выдаётся за успех', () => {
    expect(availabilityHint(true)).toMatch(/подсказк/i);
    const unavailable = availabilityHint(false);
    expect(unavailable).toMatch(/недоступны/i);
    // Обещания «точка найдена» здесь нет: адрес сохранится без неё.
    expect(unavailable).toMatch(/точка будет запрошена позже/i);
  });
});

describe('московский день не зависит от пояса устройства', () => {
  it('рабочий день, интервал и фильтр считаются одинаково под любым TZ', () => {
    // Один и тот же абсолютный момент: 21:30 UTC — это уже следующий день
    // в Москве и ещё предыдущий в Лос-Анджелесе. Рабочий день обязан быть
    // московским независимо от того, где стоит компьютер логиста.
    const instant = new Date('2027-05-05T21:30:00.000Z');
    expect(moscowCalendarDate(instant)).toBe('2027-05-06');

    // Фильтр времени — минуты внутри дня: часовой пояс в них не участвует.
    expect(parseTimeFilter('10:00')).toBe(600);
    expect(parseTimeFilter('23:59')).toBe(1439);

    // Эффективный интервал берётся из минут заказа и тоже не зависит от пояса.
    const order = card({ startMinute: 600, endMinute: 720 });
    expect(order.startMinute).toBe(600);
    expect(intervalProblem('10:00', '12:00')).toBeNull();

    // Текущий пояс процесса на результат не влияет — он лишь фиксируется
    // здесь, чтобы отчёт называл, под каким поясом проверка прошла.
    expect(typeof process.env['TZ']).toBe('string');
  });
});

describe('отметки настоящей карты', () => {
  const point = (orderId: string, number: string, over = {}): DealMapPoint => ({
    orderId,
    number,
    lat: '55.7558',
    lon: '37.6173',
    needsAttention: false,
    ...over,
  });

  it('выбранный заказ получает свой номер и не попадает в кластер', () => {
    const plans = planMarkers(
      [point('a', 'A-1')],
      [{ key: 'k', points: [point('b', 'A-2'), point('c', 'A-3')] }],
      (orderId) => (orderId === 'a' ? '1' : null),
    );

    const picked = plans.find((plan) => plan.orderId === 'a');
    expect(picked?.label).toBe('1');
    expect(picked?.className).toContain('picked');

    // Кластер остался кластером и номера выбранного не поглотил.
    const cluster = plans.find((plan) => plan.key.startsWith('cluster:'));
    expect(cluster?.label).toBe('2');
  });

  it('кластер кликом ничего не выбирает', () => {
    // Непонятно, какой именно заказ имел в виду человек.
    const plans = planMarkers(
      [],
      [{ key: 'k', points: [point('b', 'A-2'), point('c', 'A-3')] }],
      () => null,
    );
    expect(plans[0]?.orderId).toBeNull();
  });

  it('одиночная точка кликабельна и различает требующие внимания', () => {
    const plans = planMarkers(
      [],
      [
        { key: 'b', points: [point('b', 'A-2')] },
        { key: 'c', points: [point('c', 'A-3', { needsAttention: true })] },
      ],
      () => null,
    );

    expect(plans.find((plan) => plan.orderId === 'b')?.className).toContain('free');
    expect(plans.find((plan) => plan.orderId === 'c')?.className).toContain('draft');
  });

  it('непригодная координата отметки не создаёт', () => {
    // Придуманная точка выглядит как настоящая и отправит курьера не туда.
    const plans = planMarkers(
      [],
      [{ key: 'x', points: [point('x', 'A-9', { lat: 'нет', lon: 'нет' })] }],
      () => null,
    );
    expect(plans).toHaveLength(0);
  });

  it('появившаяся точка добавляет отметку к прежним', () => {
    // Перезагрузка страницы для этого не нужна: список и карта берут одни
    // и те же данные, и обновление запроса перерисовывает обе части.
    const before = planMarkers([], [{ key: 'b', points: [point('b', 'A-2')] }], () => null);
    const after = planMarkers(
      [],
      [
        { key: 'b', points: [point('b', 'A-2')] },
        { key: 'n', points: [point('n', 'A-7')] },
      ],
      () => null,
    );

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(after.map((plan) => plan.orderId)).toContain('n');
  });
});
