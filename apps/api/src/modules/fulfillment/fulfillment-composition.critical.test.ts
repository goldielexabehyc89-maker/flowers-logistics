/**
 * Критические проверки производственного состава заказа.
 *
 * К настоящему API обращений нет: используется поддельный `fetch` и управляемые
 * часы. Реальных пауз не бывает — ожидание инъецируется.
 *
 * Проверяется не «состав сохраняется», а то, что он не может сохраниться
 * НЕПРАВИЛЬНО: неполный состав не выглядит пустым, потерянный заказ возвращается
 * без нового изменения, идемпотентность считается по производственному снимку,
 * а данные заказа не утекают в аудит и realtime.
 */

import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestContext, createTestContext, type TestContext } from '../auth/testing/harness.js';
import { MoyskladClient, MoyskladError } from '../integrations/moysklad/client.js';
import { MOYSKLAD_BASE_URL, MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { CompositionSource } from '../integrations/moysklad/composition-source.js';
import {
  COMPOSITION_BACKFILL_LIMIT,
  PROVIDER,
  runCompositionBackfill,
  runSyncOnce,
  type SyncDeps,
} from '../integrations/moysklad/sync.js';
import {
  assortmentKindFrom,
  canonicalJson,
  quantityToDecimalString,
  snapshotHash,
  type FulfillmentSnapshot,
} from './composition.js';
import { applyFulfillmentSnapshot } from './service.js';
import { isVisibleToFlorist, visiblePositions } from './visibility.js';

let ctx: TestContext;
const logger = pino({ level: 'silent' });
const IDS = MOYSKLAD_IDS;
const NOW = new Date('2026-08-20T09:00:00.000Z');

/**
 * Квота очереди в сценариях дозагрузки.
 *
 * Заведомо больше числа заказов в общей тестовой базе. Маленькая квота
 * зависела бы от того, сколько заказов оставили соседние файлы: они физически
 * не удаляются (запрещено триггером), и очередь брала бы их раньше наших.
 * Тогда проверка доказывала бы не поведение очереди, а порядок запуска файлов.
 */
const BACKFILL_ALL = 100_000;

const href = (kind: string, id: string): string => `${MOYSKLAD_BASE_URL}/entity/${kind}/${id}`;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

beforeEach(async () => {
  await ctx.db.integrationCursor.deleteMany({ where: { provider: PROVIDER } });
});

// --- Фикстуры ---------------------------------------------------------------

interface PositionSpec {
  id?: string;
  quantity?: number;
  assortmentId?: string;
  type?: string;
  name?: string;
  /** Версия номенклатуры: для бандла это ключ кэша компонентов. */
  updated?: string | null;
  /**
   * Ссылка на единицу измерения — ровно так, как её отдаёт живой API:
   * `meta.href` без названия. Название приходит только справочником.
   */
  uomId?: string;
  /** Лишние ключи ответа: они не должны никуда попасть. */
  extra?: Record<string, unknown>;
}

function positionRow(spec: PositionSpec = {}): Record<string, unknown> {
  const type = spec.type ?? 'product';
  const assortmentId = spec.assortmentId ?? randomUUID();
  const assortment: Record<string, unknown> = {
    id: assortmentId,
    name: spec.name ?? 'Роза красная',
    meta: { href: href(type, assortmentId), type },
    ...(spec.updated === null ? {} : { updated: spec.updated ?? '2026-08-01 10:00:00.000' }),
    ...(spec.uomId === undefined
      ? {}
      : { uom: { meta: { href: href('uom', spec.uomId), type: 'uom' } } }),
  };

  return {
    id: spec.id ?? randomUUID(),
    quantity: spec.quantity ?? 1,
    assortment,
    ...(spec.extra ?? {}),
  };
}

function componentRow(spec: PositionSpec = {}): Record<string, unknown> {
  return positionRow(spec);
}

/**
 * Неизменная позиция для сценариев идемпотентности.
 *
 * `positionRow()` каждый раз выдаёт новые идентификаторы, поэтому «тот же
 * заказ» с ней получался бы разным. Здесь позиция строится один раз и
 * переиспользуется, иначе проверка «изменился только текст» проверяла бы совсем
 * не то, что заявлено.
 */
function stablePosition(): Record<string, unknown> {
  return positionRow({ id: randomUUID(), assortmentId: randomUUID(), name: 'Роза' });
}

/** JSON без падения на bigint: денежные поля аудита хранятся именно так. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

interface OrderSpec {
  id?: string;
  updated?: string;
  description?: string | null;
  cardText?: string | null;
  deliveryComment?: string | null;
  positions?: Record<string, unknown>[] | null;
  /** Заявленный размер состава: расхождение с числом строк — неполнота. */
  positionsSize?: number;
  pickup?: boolean;
}

function orderRow(spec: OrderSpec = {}): Record<string, unknown> {
  const attributes: Record<string, unknown>[] = [
    {
      id: IDS.deliveryMethodAttribute,
      value: {
        name: spec.pickup === true ? 'Самовывоз' : 'Доставка',
        meta: {
          href: href(
            'customentity',
            spec.pickup === true
              ? '76f4977e-d33e-11ef-0a80-03b6000e555e'
              : IDS.deliveryMethodDelivery,
          ),
        },
      },
    },
    { id: IDS.intervalAttribute, value: 'с 16:00 по 19:00' },
    { id: IDS.recipientAttribute, value: 'Получатель Тестовый' },
  ];

  if (spec.cardText !== null && spec.cardText !== undefined) {
    attributes.push({ id: IDS.cardTextAttribute, value: spec.cardText });
  }
  if (spec.deliveryComment !== null && spec.deliveryComment !== undefined) {
    attributes.push({ id: IDS.commentAttribute, value: spec.deliveryComment });
  }

  const rows = spec.positions;
  const positions =
    rows === null
      ? undefined
      : { meta: { size: spec.positionsSize ?? (rows ?? []).length }, rows: rows ?? [] };

  return {
    id: spec.id ?? randomUUID(),
    name: `F-${process.hrtime.bigint() % 1_000_000n}`,
    updated: spec.updated ?? '2026-08-20 10:00:00.000',
    shipmentAddress: 'Москва, тестовый адрес',
    deliveryPlannedMoment: '2026-08-21 12:00:00.000',
    sum: 499000,
    payedSum: 0,
    ...(spec.description === null ? {} : { description: spec.description ?? 'Состав уточнён' }),
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes,
    ...(positions === undefined ? {} : { positions }),
  };
}

/**
 * Поддельный API с маршрутизацией по пути.
 *
 * Отдельные ответы для списка заказов, позиций и компонентов нужны потому, что
 * очередь дозагрузки и бандлы ходят по своим адресам, а не по страницам списка.
 */
interface FakeApi {
  calls: { path: string; expand: string; limit: string; offset: string }[];
  fetch: typeof globalThis.fetch;
  /** Сколько раз запрошены компоненты конкретного бандла. */
  bundleCalls: (bundleId: string) => number;
  /** Сколько раз запрошен справочник единиц измерения за весь проход. */
  unitCalls: () => number;
}

interface FakeApiSpec {
  pages?: Record<string, unknown>[][];
  /** Позиции по идентификатору заказа для резервного пути. */
  positions?: Record<string, { rows: Record<string, unknown>[]; size?: number }>;
  /** Компоненты по идентификатору бандла. */
  components?: Record<string, { rows: Record<string, unknown>[]; size?: number }>;
  /**
   * Справочник единиц измерения. По умолчанию пуст: у большинства проверок
   * единицы нет, и это штатное состояние состава.
   */
  units?: { rows: Record<string, unknown>[]; size?: number };
  /** Пути, отвечающие ошибкой. */
  failPath?: (path: string) => boolean;
}

function fakeApi(spec: FakeApiSpec): FakeApi {
  const calls: FakeApi['calls'] = [];
  const pages = spec.pages ?? [[]];
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  let listCalls = 0;

  const fetchImpl = (async (url: string) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const params = parsed.searchParams;
    calls.push({
      path,
      expand: params.get('expand') ?? '',
      limit: params.get('limit') ?? '',
      offset: params.get('offset') ?? '0',
    });

    if (spec.failPath?.(path) === true) {
      return new Response('{}', { status: 500 });
    }

    const positionsMatch = /\/entity\/customerorder\/([0-9a-f-]+)\/positions$/i.exec(path);
    if (positionsMatch !== null) {
      const entry = spec.positions?.[positionsMatch[1] ?? ''];
      if (entry === undefined) {
        return new Response('{}', { status: 404 });
      }
      return json({ rows: entry.rows, meta: { size: entry.size ?? entry.rows.length } });
    }

    const componentsMatch = /\/entity\/bundle\/([0-9a-f-]+)\/components$/i.exec(path);
    if (componentsMatch !== null) {
      const entry = spec.components?.[componentsMatch[1] ?? ''];
      if (entry === undefined) {
        return new Response('{}', { status: 404 });
      }
      return json({ rows: entry.rows, meta: { size: entry.size ?? entry.rows.length } });
    }

    // Справочник единиц — СВОЙ адрес. Без этой ветки он попадал бы в общую
    // выдачу страниц заказов и молча съедал очередную страницу списка.
    if (/\/entity\/uom$/i.test(path)) {
      const entry = spec.units ?? { rows: [] };
      return json({ rows: entry.rows, meta: { size: entry.size ?? entry.rows.length } });
    }

    const page = pages[listCalls] ?? [];
    listCalls += 1;
    return json({ rows: page, meta: { size: total } });
  }) as unknown as typeof globalThis.fetch;

  return {
    calls,
    fetch: fetchImpl,
    bundleCalls: (bundleId) =>
      calls.filter((call) => call.path === `/api/remap/1.2/entity/bundle/${bundleId}/components`)
        .length,
    unitCalls: () => calls.filter((call) => call.path === '/api/remap/1.2/entity/uom').length,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const heldLocks = new Set<string>();

function fakeLock() {
  return {
    connectionString: 'postgres://fake',
    connect: async () => ({
      tryLock: async (key: bigint) => {
        if (heldLocks.has(key.toString())) return false;
        heldLocks.add(key.toString());
        return true;
      },
      unlock: async (key: bigint) => {
        heldLocks.delete(key.toString());
      },
      close: async () => undefined,
    }),
  };
}

function deps(api: FakeApi, now: Date = NOW, overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    db: ctx.db,
    client: new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
      fetch: api.fetch,
      now: () => 0,
      sleep: async () => undefined,
      minIntervalMs: 0,
    }),
    logger,
    ids: IDS,
    now: () => now,
    sleep: async () => undefined,
    overlapSeconds: 300,
    lock: fakeLock(),
    compositionBackfillLimit: 0,
    ...overrides,
  };
}

async function storedOrder(externalId: string) {
  return ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { externalId },
    select: {
      id: true,
      comment: true,
      fulfillmentDescription: true,
      fulfillmentCardText: true,
      fulfillmentSnapshotHash: true,
      fulfillmentCompositionState: true,
      fulfillmentCompositionAttempts: true,
      fulfillmentCompositionFailure: true,
      fulfillmentCompositionSyncedAt: true,
      fulfillmentPendingDescription: true,
      fulfillmentPendingCardText: true,
      fulfillmentPendingExternalUpdated: true,
    },
  });
}

async function storedPositions(orderId: string) {
  return ctx.db.deliveryOrderPosition.findMany({
    where: { orderId },
    orderBy: { ordinal: 'asc' },
    include: { components: { orderBy: { ordinal: 'asc' } } },
  });
}

// --- Снимок и хеш -----------------------------------------------------------

describe('канонический производственный снимок', () => {
  const base = (): FulfillmentSnapshot => ({
    externalId: '11111111-1111-4111-8111-111111111111',
    description: 'нижний комментарий',
    cardText: 'текст открытки',
    positions: [
      {
        externalPositionId: '22222222-2222-4222-8222-222222222222',
        ordinal: 0,
        assortmentId: '33333333-3333-4333-8333-333333333333',
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Роза',
        quantity: '2.5',
        characteristicLabel: null,
        components: [],
      },
    ],
  });

  it('в снимок входят тексты, а не только позиции', () => {
    const withoutDescription = { ...base(), description: null };
    const withoutCard = { ...base(), cardText: null };

    expect(snapshotHash(base())).not.toBe(snapshotHash(withoutDescription));
    expect(snapshotHash(base())).not.toBe(snapshotHash(withoutCard));
  });

  it('порядок ключей канонический и не зависит от порядка полей объекта', () => {
    const shuffled: FulfillmentSnapshot = {
      positions: base().positions,
      cardText: base().cardText,
      externalId: base().externalId,
      description: base().description,
    } as FulfillmentSnapshot;

    expect(canonicalJson(shuffled)).toBe(canonicalJson(base()));
    expect(snapshotHash(shuffled)).toBe(snapshotHash(base()));
  });

  it('количество хранится десятичной строкой без потери дробной части', () => {
    expect(quantityToDecimalString(2)).toBe('2');
    expect(quantityToDecimalString(2.5)).toBe('2.5');
    expect(quantityToDecimalString(0.125)).toBe('0.125');
    expect(quantityToDecimalString(0)).toBe('0');
  });

  it('нечисловое и запредельное количество отвергается, а не округляется', () => {
    expect(() => quantityToDecimalString(Number.NaN)).toThrow();
    expect(() => quantityToDecimalString(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => quantityToDecimalString(-1)).toThrow();
    expect(() => quantityToDecimalString(1e21)).toThrow();
  });

  it('незнакомый тип номенклатуры распознаётся как OTHER, а не теряется', () => {
    expect(assortmentKindFrom('product')).toBe('PRODUCT');
    expect(assortmentKindFrom('service')).toBe('SERVICE');
    expect(assortmentKindFrom('bundle')).toBe('BUNDLE');
    expect(assortmentKindFrom('variant')).toBe('VARIANT');
    expect(assortmentKindFrom('consignment')).toBe('OTHER');
    expect(assortmentKindFrom(null)).toBe('OTHER');
  });
});

// --- Видимость сервисных позиций -------------------------------------------

describe('показ сервисных позиций флористу', () => {
  const service = (assortmentId: string | null) => ({
    assortmentKind: 'SERVICE' as const,
    assortmentId,
  });

  it('три известные доставки скрыты по UUID', () => {
    for (const hidden of IDS.hiddenFulfillmentServices) {
      expect(isVisibleToFlorist(service(hidden), IDS)).toBe(false);
    }
  });

  it('«ЛФ-Выкладка Сердце» и неизвестная сервисная позиция показываются', () => {
    // Подтверждённый UUID производственной сервисной позиции.
    expect(isVisibleToFlorist(service('3de4c618-c232-11f0-0a80-031d001ce5be'), IDS)).toBe(true);
    expect(isVisibleToFlorist(service(randomUUID()), IDS)).toBe(true);
    expect(isVisibleToFlorist(service(null), IDS)).toBe(true);
  });

  it('товар со случайно совпавшим UUID не скрывается: фильтр ограничен типом service', () => {
    const hidden = IDS.hiddenFulfillmentServices[0] as string;
    expect(isVisibleToFlorist({ assortmentKind: 'PRODUCT', assortmentId: hidden }, IDS)).toBe(true);
    expect(isVisibleToFlorist({ assortmentKind: 'BUNDLE', assortmentId: hidden }, IDS)).toBe(true);
  });

  it('отбор сохраняет исходный порядок оставшихся позиций', () => {
    const positions = [
      { ordinal: 0, assortmentKind: 'PRODUCT' as const, assortmentId: randomUUID() },
      {
        ordinal: 1,
        assortmentKind: 'SERVICE' as const,
        assortmentId: IDS.hiddenFulfillmentServices[0] as string,
      },
      {
        ordinal: 2,
        assortmentKind: 'SERVICE' as const,
        assortmentId: '3de4c618-c232-11f0-0a80-031d001ce5be',
      },
    ];

    expect(visiblePositions(positions, IDS).map((p) => p.ordinal)).toEqual([0, 2]);
  });
});

// --- Сохранение состава -----------------------------------------------------

describe('сохранение производственного состава', () => {
  it('product, service и bundle сохраняются с идентичностью, количеством и порядком', async () => {
    const bundleId = randomUUID();
    const componentIds = [randomUUID(), randomUUID()];
    const order = orderRow({
      positions: [
        positionRow({ type: 'product', quantity: 3, name: 'Роза' }),
        positionRow({ type: 'bundle', assortmentId: bundleId, quantity: 1, name: 'Букет' }),
        positionRow({ type: 'service', quantity: 2.5, name: 'ЛФ-Выкладка Сердце' }),
      ],
    });

    const api = fakeApi({
      pages: [[order]],
      components: {
        [bundleId]: {
          rows: [
            componentRow({ assortmentId: componentIds[0], quantity: 7, name: 'Пион' }),
            componentRow({ assortmentId: componentIds[1], quantity: 0.5, name: 'Лента' }),
          ],
        },
      },
    });

    await runSyncOnce(deps(api));

    const stored = await storedOrder(order['id'] as string);
    expect(stored.fulfillmentCompositionState).toBe('READY');
    expect(stored.fulfillmentSnapshotHash).not.toBeNull();

    const positions = await storedPositions(stored.id);
    expect(positions.map((p) => p.ordinal)).toEqual([0, 1, 2]);
    expect(positions.map((p) => p.assortmentKind)).toEqual(['PRODUCT', 'BUNDLE', 'SERVICE']);
    expect(positions.map((p) => p.externalPositionId)).toEqual(
      (order['positions'] as { rows: Record<string, unknown>[] }).rows.map((r) => r['id']),
    );
    expect(positions[0]?.quantity.toString()).toBe('3');
    expect(positions[2]?.quantity.toString()).toBe('2.5');

    const components = positions[1]?.components ?? [];
    expect(components.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(components[0]?.quantity.toString()).toBe('7');
    // Дробное количество компонента переживает запись и чтение.
    expect(components[1]?.quantity.toString()).toBe('0.5');
    // Компоненты есть только у бандла.
    expect(positions[0]?.components).toHaveLength(0);
    expect(positions[2]?.components).toHaveLength(0);
  });

  it('три текста не смешиваются', async () => {
    const order = orderRow({
      description: 'нижний комментарий под товарами',
      cardText: 'поздравляем с праздником',
      deliveryComment: 'домофон не работает',
      positions: [positionRow()],
    });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    expect(stored.fulfillmentDescription).toBe('нижний комментарий под товарами');
    expect(stored.fulfillmentCardText).toBe('поздравляем с праздником');
    // Логистический комментарий — отдельный источник и остаётся прежним.
    expect(stored.comment).toBe('домофон не работает');
  });

  it('два заказа с одинаковой номенклатурой, но разными позициями не сливаются', async () => {
    const assortmentId = randomUUID();
    const first = orderRow({ positions: [positionRow({ assortmentId })] });
    const second = orderRow({ positions: [positionRow({ assortmentId })] });

    await runSyncOnce(deps(fakeApi({ pages: [[first, second]] })));

    const storedFirst = await storedOrder(first['id'] as string);
    const storedSecond = await storedOrder(second['id'] as string);
    const positionsFirst = await storedPositions(storedFirst.id);
    const positionsSecond = await storedPositions(storedSecond.id);

    expect(positionsFirst).toHaveLength(1);
    expect(positionsSecond).toHaveLength(1);
    expect(positionsFirst[0]?.assortmentId).toBe(assortmentId);
    expect(positionsSecond[0]?.assortmentId).toBe(assortmentId);
    // Идентичность позиции — своя у каждого заказа.
    expect(positionsFirst[0]?.externalPositionId).not.toBe(positionsSecond[0]?.externalPositionId);
  });

  it('позиция без номенклатуры сохраняется как OTHER, а не исчезает', async () => {
    const order = orderRow({
      positions: [{ id: randomUUID(), quantity: 1 }],
    });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    const positions = await storedPositions(stored.id);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.assortmentKind).toBe('OTHER');
    expect(positions[0]?.assortmentId).toBeNull();
  });
});

// --- Единицы измерения ------------------------------------------------------

/**
 * Единица измерения количества.
 *
 * Проверяется не «поле сохранилось», а три решения, ошибка в которых стоит
 * собранного не того букета либо потерянного дня общего лимита аккаунта:
 * единица приходит ССЫЛКОЙ и разворачивается ОДНИМ справочником на проход;
 * отказ справочника не отменяет состав; догадка вместо факта не подставляется.
 */
describe('единица измерения количества', () => {
  const PIECE = randomUUID();
  const METRE = randomUUID();

  const unitRows = [
    // Обозначение и полное название приходят разными полями: на бланке нужно
    // короткое обозначение.
    { id: PIECE, name: 'Штука', description: 'шт', code: '796', externalCode: 'PCS' },
    // У этой единицы обозначения нет вовсе — остаётся только название.
    { id: METRE, name: 'Метр' },
  ];

  it('единица приходит ссылкой, а название — одним справочником на весь проход', async () => {
    const bundleId = randomUUID();
    const order = orderRow({
      positions: [
        positionRow({ quantity: 2, name: 'Роза', uomId: PIECE }),
        positionRow({ quantity: 0.5, name: 'Лента', uomId: METRE }),
        positionRow({ type: 'bundle', assortmentId: bundleId, quantity: 1, uomId: PIECE }),
        // Позиция без единицы вовсе: состав от этого неполным не становится.
        positionRow({ quantity: 3, name: 'Упаковка' }),
      ],
    });

    const api = fakeApi({
      pages: [[order]],
      units: { rows: unitRows },
      components: {
        [bundleId]: {
          rows: [
            componentRow({ quantity: 11, name: 'Пион', uomId: PIECE }),
            componentRow({ quantity: 1.5, name: 'Фоамиран', uomId: METRE }),
          ],
        },
      },
    });

    await runSyncOnce(deps(api));

    const stored = await storedOrder(order['id'] as string);
    const positions = await storedPositions(stored.id);

    // Обозначение предпочитается названию, а название берётся только тогда,
    // когда обозначения нет. Отсутствующая единица остаётся пустой.
    expect(positions.map((p) => p.uomName)).toEqual(['шт', 'Метр', 'шт', null]);
    expect(positions.map((p) => p.uomId)).toEqual([PIECE, METRE, PIECE, null]);
    expect(positions[3]?.quantity.toString()).toBe('3');

    // Компоненты бандла получают единицу по тем же правилам: половина состава
    // с единицами и половина без них читалась бы как разные документы.
    const components = positions[2]?.components ?? [];
    expect(components.map((c) => c.uomName)).toEqual(['шт', 'Метр']);
    expect(components.map((c) => c.uomId)).toEqual([PIECE, METRE]);

    // ГЛАВНОЕ: справочник прочитан ОДИН раз на шесть строк состава. Запрос на
    // строку превратил бы день мастерской в тысячи обращений к общему лимиту.
    expect(api.unitCalls()).toBe(1);
  });

  it('отказ справочника сохраняет количество без единицы и не повторяет запрос', async () => {
    const order = orderRow({
      positions: [
        positionRow({ quantity: 2, name: 'Роза', uomId: PIECE }),
        positionRow({ quantity: 4, name: 'Хризантема', uomId: PIECE }),
        positionRow({ quantity: 6, name: 'Гвоздика', uomId: METRE }),
      ],
    });

    const api = fakeApi({
      pages: [[order]],
      units: { rows: unitRows },
      failPath: (path) => path.endsWith('/entity/uom'),
    });

    await runSyncOnce(deps(api));

    const stored = await storedOrder(order['id'] as string);
    // Состав ПРИГОДЕН: единица — уточнение, а не условие существования заказа.
    expect(stored.fulfillmentCompositionState).toBe('READY');

    const positions = await storedPositions(stored.id);
    expect(positions.map((p) => p.quantity.toString())).toEqual(['2', '4', '6']);
    expect(positions.map((p) => p.uomName)).toEqual([null, null, null]);
    // Ссылка сохраняется даже без названия: следующий успешный проход
    // достроит обозначение, не потеряв связь с каталогом.
    expect(positions.map((p) => p.uomId)).toEqual([PIECE, PIECE, METRE]);

    // Заведомо неудачный запрос не повторяется на каждой позиции прохода.
    expect(api.unitCalls()).toBe(1);
  });

  it('следующий успешный проход достраивает единицу новой ревизией', async () => {
    const orderId = randomUUID();
    const position = positionRow({ quantity: 2, name: 'Роза', uomId: PIECE });

    const failing = fakeApi({
      pages: [[orderRow({ id: orderId, positions: [position] })]],
      units: { rows: unitRows },
      failPath: (path) => path.endsWith('/entity/uom'),
    });
    await runSyncOnce(deps(failing));

    const first = await storedOrder(orderId);
    const firstHash = first.fulfillmentSnapshotHash;

    const working = fakeApi({
      pages: [
        [orderRow({ id: orderId, updated: '2026-08-20 12:00:00.000', positions: [position] })],
      ],
      units: { rows: unitRows },
    });
    await runSyncOnce(deps(working, new Date('2026-08-20T12:30:00.000Z')));

    const second = await storedOrder(orderId);
    // Появившаяся единица — изменение позиции: канонический хеш обязан
    // измениться, иначе «2» и «2 шт» считались бы одним и тем же составом.
    expect(second.fulfillmentSnapshotHash).not.toBe(firstHash);
    expect((await storedPositions(second.id))[0]?.uomName).toBe('шт');

    const revisions = await ctx.db.orderFulfillmentRevision.findMany({
      where: { orderId: second.id },
      orderBy: { receivedAt: 'asc' },
      select: { snapshot: true },
    });
    expect(revisions).toHaveLength(2);
  });

  it('из справочника сохраняются только ссылка и обозначение', async () => {
    const order = orderRow({ positions: [positionRow({ quantity: 1, uomId: PIECE })] });
    await runSyncOnce(deps(fakeApi({ pages: [[order]], units: { rows: unitRows } })));

    const stored = await storedOrder(order['id'] as string);
    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: stored.id },
      select: { snapshot: true },
    });

    const snapshot = revision.snapshot as unknown as FulfillmentSnapshot;
    // Порядок ключей в `jsonb` не сохраняется — его доказывает канонический
    // JSON. Здесь важен СОСТАВ: лишнего поля каталога в снимке быть не должно.
    expect([...Object.keys(snapshot.positions[0] ?? {})].sort()).toEqual(
      [
        'externalPositionId',
        'ordinal',
        'assortmentId',
        'assortmentKind',
        'assortmentKindRaw',
        'name',
        'quantity',
        'uomId',
        'uomName',
        'characteristicLabel',
        'components',
      ].sort(),
    );

    // Ни кода ОКЕИ, ни внешнего кода, ни полного названия каталога в снимке
    // нет: хранить непоказываемое — значит однажды показать его случайно.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('796');
    expect(serialized).not.toContain('PCS');
    expect(serialized).not.toContain('Штука');
  });
});

// --- Кэш бандлов ------------------------------------------------------------

describe('кэш компонентов бандла', () => {
  it('один бандл в нескольких заказах загружается один раз и не теряет привязку', async () => {
    const bundleId = randomUUID();
    const first = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: 'v1' })],
    });
    const second = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: 'v1' })],
    });

    const api = fakeApi({
      pages: [[first, second]],
      components: { [bundleId]: { rows: [componentRow({ name: 'Пион' })] } },
    });

    await runSyncOnce(deps(api));

    expect(api.bundleCalls(bundleId)).toBe(1);

    for (const order of [first, second]) {
      const stored = await storedOrder(order['id'] as string);
      const positions = await storedPositions(stored.id);
      expect(positions[0]?.components).toHaveLength(1);
      expect(positions[0]?.components[0]?.name).toBe('Пион');
    }
  });

  it('другая версия того же бандла кэш не переиспользует', async () => {
    const bundleId = randomUUID();
    const first = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: 'v1' })],
    });
    const second = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: 'v2' })],
    });

    const api = fakeApi({
      pages: [[first, second]],
      components: { [bundleId]: { rows: [componentRow()] } },
    });

    await runSyncOnce(deps(api));

    expect(api.bundleCalls(bundleId)).toBe(2);
  });

  it('бандл без подтверждённой версии кэшем не считается неизменным', async () => {
    const bundleId = randomUUID();
    const first = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: null })],
    });
    const second = orderRow({
      positions: [positionRow({ type: 'bundle', assortmentId: bundleId, updated: null })],
    });

    const api = fakeApi({
      pages: [[first, second]],
      components: { [bundleId]: { rows: [componentRow()] } },
    });

    await runSyncOnce(deps(api));

    // Без версии переиспользование выдало бы старое содержимое за текущее.
    expect(api.bundleCalls(bundleId)).toBe(2);
  });
});

// --- Fail closed ------------------------------------------------------------

describe('неполный и неподтверждённый состав', () => {
  it('страница больше 100 отвергается до сетевого обращения', async () => {
    let requested = 0;
    const client = new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
      fetch: (async () => {
        requested += 1;
        return json({ rows: [], meta: { size: 0 } });
      }) as unknown as typeof globalThis.fetch,
      minIntervalMs: 0,
    });

    await expect(
      client.listCustomerOrders({ limit: 101, withPositions: true }),
    ).rejects.toBeInstanceOf(MoyskladError);
    expect(requested).toBe(0);
  });

  it('усечённый вложенный состав не считается пустым и не затирает подтверждённый', async () => {
    const orderId = randomUUID();
    const good = orderRow({ id: orderId, positions: [positionRow({ name: 'Роза' })] });
    await runSyncOnce(deps(fakeApi({ pages: [[good]] })));

    const before = await storedOrder(orderId);
    expect(before.fulfillmentCompositionState).toBe('READY');
    expect(await storedPositions(before.id)).toHaveLength(1);

    // Тот же заказ приходит снова, но состав усечён: строк меньше, чем meta.size.
    const truncated = orderRow({
      id: orderId,
      updated: '2026-08-20 11:00:00.000',
      positions: [],
      positionsSize: 3,
    });
    await runSyncOnce(
      deps(fakeApi({ pages: [[truncated]] }), new Date('2026-08-20T10:00:00.000Z')),
    );

    const after = await storedOrder(orderId);
    // Подтверждённая проекция цела, а заказ ушёл в очередь дозагрузки.
    expect(await storedPositions(after.id)).toHaveLength(1);
    expect(after.fulfillmentCompositionState).toBe('PENDING');
    expect(after.fulfillmentCompositionFailure).toBe('POSITIONS_NOT_EXPANDED');
    expect(after.fulfillmentSnapshotHash).toBe(before.fulfillmentSnapshotHash);
  });

  it('молча неразвёрнутый состав уводит заказ в очередь, а не создаёт пустой', async () => {
    const order = orderRow({ positions: null });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    expect(stored.fulfillmentCompositionState).toBe('PENDING');
    expect(stored.fulfillmentSnapshotHash).toBeNull();
    expect(await storedPositions(stored.id)).toHaveLength(0);
  });

  it('подтверждённо пустой состав отличается от неподтверждённого', async () => {
    const order = orderRow({ positions: [] });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    expect(stored.fulfillmentCompositionState).toBe('READY');
    expect(stored.fulfillmentSnapshotHash).not.toBeNull();
    expect(await storedPositions(stored.id)).toHaveLength(0);
  });

  it('недоступные компоненты бандла не оставляют частичный состав', async () => {
    const bundleId = randomUUID();
    const order = orderRow({
      positions: [
        positionRow({ type: 'product', name: 'Роза' }),
        positionRow({ type: 'bundle', assortmentId: bundleId }),
      ],
    });

    const api = fakeApi({
      pages: [[order]],
      failPath: (path) => path.includes(`/entity/bundle/${bundleId}/components`),
    });

    await runSyncOnce(deps(api));

    const stored = await storedOrder(order['id'] as string);
    // Ни одной позиции: отказ на втором элементе не сохраняет первый.
    expect(await storedPositions(stored.id)).toHaveLength(0);
    expect(stored.fulfillmentCompositionState).toBe('PENDING');
    expect(stored.fulfillmentCompositionFailure).toBe('BUNDLE_UNAVAILABLE');
  });

  it('после порога неудач состояние становится FAILED и остаётся диагностируемым', async () => {
    const order = orderRow({ positions: null });
    const externalId = order['id'] as string;

    for (const [index, at] of [
      NOW,
      new Date('2026-08-20T10:00:00.000Z'),
      new Date('2026-08-20T11:00:00.000Z'),
    ].entries()) {
      const row = orderRow({
        id: externalId,
        positions: null,
        updated: `2026-08-20 1${index}:00:00.000`,
      });
      await runSyncOnce(deps(fakeApi({ pages: [[row]] }), at));
    }

    const stored = await storedOrder(externalId);
    expect(stored.fulfillmentCompositionState).toBe('FAILED');
    expect(stored.fulfillmentCompositionAttempts).toBeGreaterThanOrEqual(3);
    // Диагностика безопасна: только код, без данных заказа.
    expect(stored.fulfillmentCompositionFailure).toBe('POSITIONS_NOT_EXPANDED');
  });

  it('неполный ответ резервного пути отвергается, а не принимается за полный', async () => {
    const orderId = randomUUID();
    let call = 0;
    const client = new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
      // Обещано три строки; первая страница отдаёт одну, вторая — пусто.
      // Принять это за полный состав значило бы потерять две трети букета.
      fetch: (async () => {
        call += 1;
        return json({ rows: call === 1 ? [positionRow()] : [], meta: { size: 3 } });
      }) as unknown as typeof globalThis.fetch,
      minIntervalMs: 0,
    });

    await expect(client.listOrderPositions(orderId)).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('резервный путь дочитывает состав страницами и доказывает полноту', async () => {
    const orderId = randomUUID();
    const rows = Array.from({ length: 3 }, () => positionRow());
    let call = 0;
    const client = new MoyskladClient({
      config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
      fetch: (async () => {
        const page = rows.slice(call, call + 1);
        call += 1;
        return json({ rows: page, meta: { size: rows.length } });
      }) as unknown as typeof globalThis.fetch,
      minIntervalMs: 0,
    });

    const page = await client.listOrderPositions(orderId);
    expect(page.rows).toHaveLength(3);
    expect(page.size).toBe(3);
    expect(call).toBe(3);
  });
});

// --- Идемпотентность и ревизии ---------------------------------------------

describe('идемпотентность и история', () => {
  it('повтор того же снимка не создаёт ревизию, аудит и событие', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    const build = () => orderRow({ id: orderId, positions: [position] });

    await runSyncOnce(deps(fakeApi({ pages: [[build()]] })));
    const stored = await storedOrder(orderId);

    const revisionsBefore = await ctx.db.orderFulfillmentRevision.count({
      where: { orderId: stored.id },
    });
    const eventsBefore = await ctx.db.realtimeEvent.count({
      where: { topic: 'order.fulfillment_changed' },
    });

    await runSyncOnce(deps(fakeApi({ pages: [[build()]] }), new Date('2026-08-20T10:00:00.000Z')));

    expect(await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } })).toBe(
      revisionsBefore,
    );
    expect(
      await ctx.db.realtimeEvent.count({ where: { topic: 'order.fulfillment_changed' } }),
    ).toBe(eventsBefore);
  });

  it('изменение состава даёт ровно одну новую ревизию', async () => {
    const orderId = randomUUID();
    const first = orderRow({ id: orderId, positions: [positionRow({ quantity: 1 })] });
    await runSyncOnce(deps(fakeApi({ pages: [[first]] })));

    const stored = await storedOrder(orderId);
    const before = await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } });

    const second = orderRow({
      id: orderId,
      updated: '2026-08-20 11:00:00.000',
      positions: [positionRow({ quantity: 4 })],
    });
    await runSyncOnce(deps(fakeApi({ pages: [[second]] }), new Date('2026-08-20T10:00:00.000Z')));

    const after = await ctx.db.orderFulfillmentRevision.findMany({
      where: { orderId: stored.id },
      orderBy: { receivedAt: 'desc' },
    });
    expect(after).toHaveLength(before + 1);
    expect(after[0]?.changedFields).toContain('positions');
    expect(after[0]?.reason).toBe('EXTERNAL_UPDATE');
  });

  it('изменился только description — производственная ревизия создаётся', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [[orderRow({ id: orderId, description: 'первый', positions: [position] })]],
        }),
      ),
    );

    const stored = await storedOrder(orderId);
    const before = await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } });

    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                description: 'второй',
                positions: [position],
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    const revisions = await ctx.db.orderFulfillmentRevision.findMany({
      where: { orderId: stored.id },
      orderBy: { receivedAt: 'desc' },
    });
    expect(revisions).toHaveLength(before + 1);
    expect(revisions[0]?.changedFields).toEqual(['description']);
  });

  it('изменился только «Текст открытки» — производственная ревизия создаётся', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [[orderRow({ id: orderId, cardText: 'первый', positions: [position] })]],
        }),
      ),
    );

    const stored = await storedOrder(orderId);
    const before = await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } });

    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                cardText: 'второй',
                positions: [position],
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    const revisions = await ctx.db.orderFulfillmentRevision.findMany({
      where: { orderId: stored.id },
      orderBy: { receivedAt: 'desc' },
    });
    expect(revisions).toHaveLength(before + 1);
    expect(revisions[0]?.changedFields).toEqual(['cardText']);
  });

  it('изменился только логистический комментарий — производственной ревизии нет', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                deliveryComment: 'первый',
                positions: [position],
              }),
            ],
          ],
        }),
      ),
    );

    const stored = await storedOrder(orderId);
    const before = await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } });

    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                deliveryComment: 'второй',
                positions: [position],
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    // Логистическое поле изменилось и `updated` тоже, но производственный
    // снимок прежний: ложной ревизии и ложного «Заказ изменён» быть не должно.
    expect(await ctx.db.orderFulfillmentRevision.count({ where: { orderId: stored.id } })).toBe(
      before,
    );
    const refreshed = await storedOrder(orderId);
    expect(refreshed.comment).toBe('второй');
  });

  it('ревизия неизменяема: UPDATE и DELETE отвергает база', async () => {
    const order = orderRow({ positions: [positionRow()] });
    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: stored.id },
    });

    await expect(
      ctx.db.orderFulfillmentRevision.update({
        where: { id: revision.id },
        data: { snapshotHash: 'подмена' },
      }),
    ).rejects.toThrow();

    await expect(
      ctx.db.orderFulfillmentRevision.delete({ where: { id: revision.id } }),
    ).rejects.toThrow();
  });
});

// --- Очередь дозагрузки -----------------------------------------------------

describe('очередь дозагрузки состава', () => {
  it('заказ, потерявший состав после сдвига курсора, дочитывается без нового изменения', async () => {
    const orderId = randomUUID();

    // Первый проход: заказ пришёл, состав не развернулся, курсор ушёл вперёд.
    const first = orderRow({ id: orderId, positions: null });
    await runSyncOnce(deps(fakeApi({ pages: [[first]] })));

    const stored = await storedOrder(orderId);
    expect(stored.fulfillmentCompositionState).toBe('PENDING');
    expect(await storedPositions(stored.id)).toHaveLength(0);

    // Второй проход: заказ БОЛЬШЕ НЕ ПРИХОДИТ — он не менялся, delta его
    // не принесёт. Состав обязан дочитаться очередью.
    const api = fakeApi({
      pages: [[]],
      positions: {
        [orderId]: { rows: [positionRow({ name: 'Роза' }), positionRow({ name: 'Пион' })] },
      },
    });
    const result = await runSyncOnce(
      deps(api, new Date('2026-08-20T10:00:00.000Z'), { compositionBackfillLimit: BACKFILL_ALL }),
    );

    expect(result.compositionBackfilled).toBeGreaterThanOrEqual(1);

    const after = await storedOrder(orderId);
    expect(after.fulfillmentCompositionState).toBe('READY');
    expect(after.fulfillmentCompositionAttempts).toBe(0);
    expect(await storedPositions(after.id)).toHaveLength(2);
  });

  it('дозагрузка сохраняет тексты, прочитанные вместе с заказом', async () => {
    const orderId = randomUUID();
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [orderRow({ id: orderId, positions: null, description: 'низ', cardText: 'открытка' })],
          ],
        }),
      ),
    );

    const pending = await storedOrder(orderId);
    // Тексты сохранены в ОЖИДАЮЩИХ полях: подтверждённых у заказа ещё нет,
    // и выдавать новые тексты за подтверждённый снимок нельзя.
    expect(pending.fulfillmentPendingDescription).toBe('низ');
    expect(pending.fulfillmentPendingCardText).toBe('открытка');
    expect(pending.fulfillmentDescription).toBeNull();
    expect(pending.fulfillmentCardText).toBeNull();

    const api = fakeApi({ pages: [[]], positions: { [orderId]: { rows: [positionRow()] } } });
    await runSyncOnce(
      deps(api, new Date('2026-08-20T10:00:00.000Z'), { compositionBackfillLimit: BACKFILL_ALL }),
    );

    const ready = await storedOrder(orderId);
    expect(ready.fulfillmentCompositionState).toBe('READY');

    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: ready.id },
      orderBy: { receivedAt: 'desc' },
    });
    const snapshot = revision.snapshot as unknown as FulfillmentSnapshot;
    // Тексты попали в снимок и хеш, а не потерялись при дозагрузке.
    expect(snapshot.description).toBe('низ');
    expect(snapshot.cardText).toBe('открытка');
  });

  it('отказ одного заказа не прекращает очередь', async () => {
    const failing = randomUUID();
    const healthy = randomUUID();

    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({ id: failing, positions: null }),
              orderRow({ id: healthy, positions: null }),
            ],
          ],
        }),
      ),
    );

    const api = fakeApi({
      pages: [[]],
      positions: { [healthy]: { rows: [positionRow()] } },
      failPath: (path) => path.includes(`/entity/customerorder/${failing}/positions`),
    });
    await runSyncOnce(
      deps(api, new Date('2026-08-20T10:00:00.000Z'), { compositionBackfillLimit: BACKFILL_ALL }),
    );

    expect((await storedOrder(healthy)).fulfillmentCompositionState).toBe('READY');
    const stillPending = await storedOrder(failing);
    expect(stillPending.fulfillmentCompositionState).not.toBe('READY');
    expect(stillPending.fulfillmentCompositionFailure).toBe('POSITIONS_UNAVAILABLE');
  });

  it('квота прохода ограничена и по умолчанию не безгранична', async () => {
    expect(COMPOSITION_BACKFILL_LIMIT).toBeGreaterThan(0);
    expect(COMPOSITION_BACKFILL_LIMIT).toBeLessThanOrEqual(100);

    const api = fakeApi({ pages: [[]] });
    const result = {
      kind: 'delta' as const,
      pages: 0,
      processed: 0,
      created: 0,
      updated: 0,
      skippedOutOfScope: 0,
      missing: 0,
      compositionConfirmed: 0,
      compositionUnconfirmed: 0,
      compositionBackfilled: 0,
      bundleRequests: 0,
    };

    // Нулевая квота выключает очередь целиком и не делает ни одного обращения.
    await runCompositionBackfill(
      deps(api, NOW, { compositionBackfillLimit: 0 }),
      new CompositionSource(
        new MoyskladClient({
          config: { baseUrl: MOYSKLAD_BASE_URL, token: 'test-token', ids: IDS },
          fetch: api.fetch,
          minIntervalMs: 0,
        }),
        IDS,
      ),
      result,
    );

    expect(api.calls).toHaveLength(0);
  });
});

// --- Область и запрос состава ----------------------------------------------

// --- Согласованность подтверждённого снимка ---------------------------------

describe('подтверждённый снимок не смешивается с ожидающей версией', () => {
  /** Заказ с подтверждённым снимком A. */
  async function confirmed(orderId: string, position: Record<string, unknown>) {
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                description: 'низ A',
                cardText: 'открытка A',
                positions: [position],
              }),
            ],
          ],
        }),
      ),
    );
    return storedOrder(orderId);
  }

  it('новая версия с неполным составом не трогает подтверждённые тексты, хеш и позиции', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    const before = await confirmed(orderId, position);
    expect(before.fulfillmentCompositionState).toBe('READY');

    const revisionsBefore = await ctx.db.orderFulfillmentRevision.count({
      where: { orderId: before.id },
    });

    // Версия B: оба текста изменились, но состав пришёл усечённым.
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                description: 'низ B',
                cardText: 'открытка B',
                positions: [],
                positionsSize: 2,
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    const after = await storedOrder(orderId);
    // Подтверждённая версия A цела целиком: тексты, хеш, позиции и история.
    expect(after.fulfillmentDescription).toBe('низ A');
    expect(after.fulfillmentCardText).toBe('открытка A');
    expect(after.fulfillmentSnapshotHash).toBe(before.fulfillmentSnapshotHash);
    expect(await storedPositions(after.id)).toHaveLength(1);
    expect(await ctx.db.orderFulfillmentRevision.count({ where: { orderId: after.id } })).toBe(
      revisionsBefore,
    );

    // Новая версия existует только как ожидающая подтверждения.
    expect(after.fulfillmentCompositionState).toBe('PENDING');
    expect(after.fulfillmentPendingDescription).toBe('низ B');
    expect(after.fulfillmentPendingCardText).toBe('открытка B');
    expect(after.fulfillmentPendingExternalUpdated).not.toBeNull();
  });

  it('успешная дозагрузка делает версию подтверждённой целиком и очищает ожидающую', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    const before = await confirmed(orderId, position);
    const revisionsBefore = await ctx.db.orderFulfillmentRevision.count({
      where: { orderId: before.id },
    });

    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                description: 'низ B',
                cardText: 'открытка B',
                positions: null,
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    const newPosition = stablePosition();
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [[]],
          positions: { [orderId]: { rows: [newPosition, stablePosition()] } },
        }),
        new Date('2026-08-20T11:00:00.000Z'),
        { compositionBackfillLimit: BACKFILL_ALL },
      ),
    );

    const after = await storedOrder(orderId);
    expect(after.fulfillmentCompositionState).toBe('READY');
    expect(after.fulfillmentDescription).toBe('низ B');
    expect(after.fulfillmentCardText).toBe('открытка B');
    expect(after.fulfillmentSnapshotHash).not.toBe(before.fulfillmentSnapshotHash);
    expect(await storedPositions(after.id)).toHaveLength(2);

    // Ожидающие поля очищены в той же транзакции.
    expect(after.fulfillmentPendingDescription).toBeNull();
    expect(after.fulfillmentPendingCardText).toBeNull();
    expect(after.fulfillmentPendingExternalUpdated).toBeNull();

    // Ровно одна новая ревизия, и в ней изменились оба текста и состав.
    const revisions = await ctx.db.orderFulfillmentRevision.findMany({
      where: { orderId: after.id },
      orderBy: { receivedAt: 'desc' },
    });
    expect(revisions).toHaveLength(revisionsBefore + 1);
    expect(revisions[0]?.changedFields.sort()).toEqual(['cardText', 'description', 'positions']);
  });

  it('повторное подтверждение того же снимка не создаёт ревизию, аудит и событие', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    const before = await confirmed(orderId, position);

    const revisionsBefore = await ctx.db.orderFulfillmentRevision.count({
      where: { orderId: before.id },
    });
    // Считаются только производственные записи: логистический `ORDER_SYNCED`
    // здесь ожидаем — у заказа действительно изменился `updated`.
    const fulfillmentAudit = {
      entityId: before.id,
      action: {
        in: [
          'ORDER_FULFILLMENT_IMPORTED',
          'ORDER_FULFILLMENT_CHANGED',
          'ORDER_FULFILLMENT_UNAVAILABLE',
        ] as const,
      },
    };
    const auditBefore = await ctx.db.auditLog.count({ where: fulfillmentAudit });
    const eventsBefore = await ctx.db.realtimeEvent.count({
      where: { topic: 'order.fulfillment_changed' },
    });
    const positionsBefore = await storedPositions(before.id);

    // Временный отказ: та же версия, но состав не развернулся.
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                description: 'низ A',
                cardText: 'открытка A',
                positions: null,
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );
    expect((await storedOrder(orderId)).fulfillmentCompositionState).toBe('PENDING');

    // Дозагрузка возвращает ТОТ ЖЕ состав — снимок совпадает с подтверждённым.
    await runSyncOnce(
      deps(
        fakeApi({ pages: [[]], positions: { [orderId]: { rows: [position] } } }),
        new Date('2026-08-20T11:00:00.000Z'),
        { compositionBackfillLimit: BACKFILL_ALL },
      ),
    );

    const after = await storedOrder(orderId);
    expect(after.fulfillmentCompositionState).toBe('READY');
    expect(after.fulfillmentSnapshotHash).toBe(before.fulfillmentSnapshotHash);

    // Продуктовых изменений не было — значит, не было и следов изменения.
    expect(await ctx.db.orderFulfillmentRevision.count({ where: { orderId: after.id } })).toBe(
      revisionsBefore,
    );
    expect(await ctx.db.auditLog.count({ where: fulfillmentAudit })).toBe(auditBefore);
    expect(
      await ctx.db.realtimeEvent.count({ where: { topic: 'order.fulfillment_changed' } }),
    ).toBe(eventsBefore);

    // Проекция не пересоздавалась: строки те же самые.
    const positionsAfter = await storedPositions(after.id);
    expect(positionsAfter.map((p) => p.id)).toEqual(positionsBefore.map((p) => p.id));

    // Изменились только технические поля состояния.
    expect(after.fulfillmentCompositionAttempts).toBe(0);
    expect(after.fulfillmentCompositionFailure).toBeNull();
    expect(after.fulfillmentPendingExternalUpdated).toBeNull();
  });

  it('поздний результат версии B не подтверждается как пришедшая следом версия C', async () => {
    const orderId = randomUUID();
    const position = stablePosition();
    await confirmed(orderId, position);

    // Версия B встала в очередь.
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 11:00:00.000',
                description: 'низ B',
                positions: null,
              }),
            ],
          ],
        }),
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );

    const pendingB = await storedOrder(orderId);
    expect(pendingB.fulfillmentPendingDescription).toBe('низ B');

    // Пока «шло чтение позиций B», delta записала версию C.
    await runSyncOnce(
      deps(
        fakeApi({
          pages: [
            [
              orderRow({
                id: orderId,
                updated: '2026-08-20 12:00:00.000',
                description: 'низ C',
                positions: null,
              }),
            ],
          ],
        }),
        new Date('2026-08-20T11:00:00.000Z'),
      ),
    );
    const pendingC = await storedOrder(orderId);
    expect(pendingC.fulfillmentPendingDescription).toBe('низ C');

    // Результат B приходит с уже устаревшей ожидаемой версией.
    const applied = await ctx.db.$transaction((tx) =>
      applyFulfillmentSnapshot(
        tx,
        {
          externalId: orderId,
          externalUpdated: pendingB.fulfillmentPendingExternalUpdated as Date,
          texts: { description: 'низ B', cardText: null },
          snapshot: {
            externalId: orderId,
            description: 'низ B',
            cardText: null,
            positions: [],
          },
          failure: null,
          expectedPendingVersion: pendingB.fulfillmentPendingExternalUpdated,
        },
        new Date('2026-08-20T11:30:00.000Z'),
      ),
    );

    expect(applied.outcome).toBe('STALE');

    const after = await storedOrder(orderId);
    // Ни подтверждения B, ни затирания ожидающей C.
    expect(after.fulfillmentDescription).toBe('низ A');
    expect(after.fulfillmentPendingDescription).toBe('низ C');
    expect(after.fulfillmentCompositionState).not.toBe('READY');
  });

  it('прежняя версия приложения работает поверх расширенной схемы', async () => {
    // Код версии `269ad6ef` о производственных колонках не знает вовсе:
    // он вставляет и обновляет заказ только прежним набором полей. Расширяющая
    // миграция и новый CHECK не должны этому мешать — иначе откат приложения
    // остановил бы импорт заказов.
    const externalId = randomUUID();
    await ctx.db.$executeRaw`
      INSERT INTO "DeliveryOrder" ("id", "externalId", "externalName", "externalUpdated", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${externalId}::uuid, 'F-ROLLBACK', ${NOW}, ${NOW})
    `;

    const inserted = await storedOrder(externalId);
    // Умолчания честны: состав не подтверждён, а не «подтверждённо пуст».
    expect(inserted.fulfillmentCompositionState).toBe('PENDING');
    expect(inserted.fulfillmentSnapshotHash).toBeNull();
    expect(inserted.fulfillmentPendingExternalUpdated).toBeNull();

    // Обновление прежним набором полей проходит.
    await ctx.db.$executeRaw`
      UPDATE "DeliveryOrder"
      SET "address" = 'Москва, другой адрес', "inScope" = true, "updatedAt" = ${NOW}
      WHERE "externalId" = ${externalId}::uuid
    `;

    // Заказ без ожидающей версии очередь не берёт: текстов у неё взять неоткуда,
    // и подтвердить снимок с пустыми текстами она не имеет права.
    const api = fakeApi({ pages: [[]] });
    await runSyncOnce(
      deps(api, new Date('2026-08-20T10:00:00.000Z'), { compositionBackfillLimit: BACKFILL_ALL }),
    );
    expect(api.calls.some((call) => call.path.includes(externalId))).toBe(false);
    expect((await storedOrder(externalId)).fulfillmentCompositionState).toBe('PENDING');
  });

  it('база не позволяет оставить READY вместе с ожидающей версией или кодом отказа', async () => {
    const orderId = randomUUID();
    const stored = await confirmed(orderId, stablePosition());
    expect(stored.fulfillmentCompositionState).toBe('READY');

    // Каждое из трёх ожидающих полей и код отказа несовместимы с READY.
    for (const data of [
      { fulfillmentPendingDescription: 'низ' },
      { fulfillmentPendingCardText: 'открытка' },
      { fulfillmentPendingExternalUpdated: new Date('2026-08-20T12:00:00.000Z') },
      { fulfillmentCompositionFailure: 'POSITIONS_NOT_EXPANDED' },
    ]) {
      await expect(
        ctx.db.deliveryOrder.update({ where: { id: stored.id }, data }),
      ).rejects.toThrow();
    }

    // И наоборот: READY без хеша тоже невозможен — прежняя гарантия сохранена.
    await expect(
      ctx.db.deliveryOrder.update({
        where: { id: stored.id },
        data: { fulfillmentSnapshotHash: null },
      }),
    ).rejects.toThrow();
  });
});

describe('область и запрос состава', () => {
  it('состав запрашивается на всех путях чтения заказов', async () => {
    const expandOf = (api: FakeApi) =>
      api.calls
        .filter((call) => call.path.endsWith('/entity/customerorder'))
        .map((call) => call.expand);

    // Полная загрузка.
    const initial = fakeApi({ pages: [[orderRow({ positions: [] })]] });
    await runSyncOnce(deps(initial));
    expect(expandOf(initial).length).toBeGreaterThan(0);
    expect(expandOf(initial).every((e) => e === 'state,positions.assortment')).toBe(true);

    // Delta.
    const delta = fakeApi({ pages: [[orderRow({ positions: [] })]] });
    await runSyncOnce(deps(delta, new Date('2026-08-20T10:00:00.000Z')));
    expect(expandOf(delta).every((e) => e === 'state,positions.assortment')).toBe(true);

    // Контрольная сверка.
    const reconciliation = fakeApi({ pages: [[orderRow({ positions: [] })]] });
    await runSyncOnce(deps(reconciliation, new Date('2026-08-21T12:00:00.000Z')), {
      allowReconciliation: true,
    });
    expect(expandOf(reconciliation).every((e) => e === 'state,positions.assortment')).toBe(true);
  });

  it('самовывоз утверждённого склада получает состав наравне с доставкой', async () => {
    const order = orderRow({ pickup: true, positions: [positionRow({ name: 'Роза' })] });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    expect(stored.fulfillmentCompositionState).toBe('READY');
    expect(await storedPositions(stored.id)).toHaveLength(1);
  });
});

// --- Утечки -----------------------------------------------------------------

describe('данные заказа не утекают', () => {
  it('лишние ключи ответа не попадают ни в таблицы, ни в ревизию', async () => {
    const order = orderRow({
      positions: [
        positionRow({
          name: 'Роза',
          extra: {
            price: 123456,
            discount: 10,
            vat: 20,
            reserve: 1,
            shipped: 0,
            secretField: 'нельзя хранить',
          },
        }),
      ],
    });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    const positions = await storedPositions(stored.id);
    const serializedRow = JSON.stringify(positions);
    expect(serializedRow).not.toContain('123456');
    expect(serializedRow).not.toContain('secretField');
    expect(serializedRow).not.toContain('нельзя хранить');

    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: stored.id },
    });
    const serializedRevision = JSON.stringify(revision.snapshot);
    expect(serializedRevision).not.toContain('123456');
    expect(serializedRevision).not.toContain('secretField');
    expect(serializedRevision).not.toContain('price');
    expect(serializedRevision).not.toContain('discount');
  });

  it('аудит и realtime не содержат названий, количеств и текстов', async () => {
    const order = orderRow({
      description: 'СЕКРЕТНЫЙ-КОММЕНТАРИЙ',
      cardText: 'СЕКРЕТНАЯ-ОТКРЫТКА',
      positions: [positionRow({ name: 'СЕКРЕТНАЯ-РОЗА' })],
    });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));
    const stored = await storedOrder(order['id'] as string);

    const audit = await ctx.db.auditLog.findMany({
      where: {
        entityId: stored.id,
        action: { in: ['ORDER_FULFILLMENT_IMPORTED', 'ORDER_FULFILLMENT_CHANGED'] },
      },
    });
    expect(audit.length).toBeGreaterThan(0);
    const serializedAudit = serialize(audit);
    expect(serializedAudit).not.toContain('СЕКРЕТНАЯ-РОЗА');
    expect(serializedAudit).not.toContain('СЕКРЕТНЫЙ-КОММЕНТАРИЙ');
    expect(serializedAudit).not.toContain('СЕКРЕТНАЯ-ОТКРЫТКА');

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'order.fulfillment_changed' },
      orderBy: { id: 'desc' },
      take: 5,
    });
    const serializedEvents = serialize(events);
    expect(serializedEvents).not.toContain('СЕКРЕТНАЯ-РОЗА');
    expect(serializedEvents).not.toContain('СЕКРЕТНЫЙ-КОММЕНТАРИЙ');
    expect(serializedEvents).not.toContain('СЕКРЕТНАЯ-ОТКРЫТКА');
  });

  it('фотографии и ссылки на изображения в базу не попадают', async () => {
    const order = orderRow({
      positions: [
        positionRow({
          extra: {
            assortment: {
              id: randomUUID(),
              name: 'Роза',
              meta: { href: href('product', randomUUID()), type: 'product' },
              images: {
                meta: { href: 'https://api.moysklad.ru/секретная-ссылка', size: 3 },
              },
              files: { meta: { href: 'https://api.moysklad.ru/файлы', size: 1 } },
            },
          },
        }),
      ],
    });

    await runSyncOnce(deps(fakeApi({ pages: [[order]] })));

    const stored = await storedOrder(order['id'] as string);
    const positions = await storedPositions(stored.id);
    const revision = await ctx.db.orderFulfillmentRevision.findFirstOrThrow({
      where: { orderId: stored.id },
    });

    const serialized = `${JSON.stringify(positions)}${JSON.stringify(revision.snapshot)}`;
    expect(serialized).not.toContain('секретная-ссылка');
    expect(serialized).not.toContain('images');
    expect(serialized).not.toContain('files');
    expect(serialized).not.toContain('https://');
  });
});
