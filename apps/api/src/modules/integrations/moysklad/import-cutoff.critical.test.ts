/**
 * Нижняя граница даты доставки при импорте.
 *
 * Новый контур не должен получить историю чужих сделок: заказы старше
 * названной даты в нём просто не создаются. Проверяется не арифметика
 * сравнения, а то, из-за чего пришлось бы разбирать последствия руками:
 *
 *  * заказ до границы не создаётся НИ ОДНИМ путём — даже если внешний API
 *    вернул лишнюю страницу, а delta-проход ходит по окну `updated` и приносит
 *    заказы с любой датой;
 *  * заказ на самой границе создаётся: граница включительная;
 *  * заказ без даты и с нераспознанной датой не создаётся, но считается —
 *    иначе пропуск был бы неотличим от того, что заказа не было вовсе;
 *  * УЖЕ созданный заказ продолжает получать обновления: без этого новый
 *    контур потерял бы отмену или смену интервала у заказа, который везут;
 *  * повтор прохода ничего не добавляет, а отсутствие переменной сохраняет
 *    прежнее поведение — так работают local и staging.
 *
 * Дата сравнивается как МОСКОВСКАЯ календарная: обе стороны — строки
 * `ГГГГ-ММ-ДД`, и переводить их в абсолютное время нельзя. Полночь Москвы
 * и полночь UTC — разные моменты, и заказ на границе попадал бы то в одну
 * сторону, то в другую в зависимости от часа запуска.
 *
 * ВЛАДЕНИЕ ДАТАМИ: файл забронировал декабрь 2028 года
 * (`platform/testing/test-days.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  closeTestContext,
  createTestContext,
  type TestContext,
} from '../../auth/testing/harness.js';
import { MOYSKLAD_IDS } from './config.js';
import { mapOrder } from './mapper.js';
import type { MoyskladOrderDto } from './dto.js';
import { applyOrderSnapshot, beforeImportCutoff } from './import-service.js';
import { approvedStoreFilter } from './filters.js';
import { passFingerprint } from './sync.js';

const IDS = MOYSKLAD_IDS;
/** Граница отбора: заказы этого дня импортируются, предыдущего — нет. */
const CUTOFF = '2028-12-10';
const NOW = new Date('2028-12-09T09:00:00.000Z');

const href = (kind: string, id: string): string =>
  `https://api.moysklad.ru/api/remap/1.2/entity/${kind}/${id}`;

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

/** Синтетический ответ МоегоСклада того же вида, что приходит по сети. */
function dto(input: {
  externalId: string;
  number: string;
  /** `null` — поля нет вовсе; строка — то, что прислал источник как есть. */
  planned: string | null;
  interval?: string;
}): MoyskladOrderDto {
  return {
    id: input.externalId,
    name: input.number,
    updated: '2028-12-09 10:00:00.000',
    shipmentAddress: 'Москва, Русаковская улица, 26',
    ...(input.planned === null ? {} : { deliveryPlannedMoment: input.planned }),
    sum: 499000,
    payedSum: 0,
    store: { meta: { href: href('store', IDS.store) } },
    state: {
      meta: { href: href('state', '22222222-2222-4222-8222-222222222222') },
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Новый',
      stateType: 'Regular',
    },
    attributes: [
      {
        id: IDS.deliveryMethodAttribute,
        value: {
          name: 'Доставка',
          meta: { href: href('customentity', IDS.deliveryMethodDelivery) },
        },
      },
      { id: IDS.intervalAttribute, value: input.interval ?? 'с 10:00 по 14:00' },
      { id: IDS.recipientAttribute, value: 'Получатель Проверочный' },
    ],
  } as MoyskladOrderDto;
}

/** Импорт настоящим путём. `cutoff` — значение переменной в этот момент. */
async function importOrder(
  order: MoyskladOrderDto,
  cutoff: string | undefined,
): Promise<{ outcome: string }> {
  const { snapshot } = mapOrder(order, IDS);
  return ctx.db.$transaction((tx) =>
    applyOrderSnapshot(tx, snapshot, NOW, {
      importDeliveryDateFrom: cutoff,
      geocoding: false,
    }),
  );
}

async function stored(number: string) {
  return ctx.db.deliveryOrder.findFirst({
    where: { externalName: number },
    select: {
      id: true,
      deliveryDate: true,
      deliveryDateRaw: true,
      intervalKind: true,
      intervalStartMinute: true,
      version: true,
    },
  });
}

describe('граница отбора решает судьбу только новых заказов', () => {
  it('заказ за день до границы не создаётся', async () => {
    const number = unique('BEFORE');
    const result = await importOrder(
      dto({ externalId: randomUUID(), number, planned: '2028-12-09 12:00:00.000' }),
      CUTOFF,
    );

    expect(result.outcome).toBe('SKIPPED_BEFORE_CUTOFF');
    // Строки в базе нет вовсе: ни адреса, ни получателя, ни суммы.
    expect(await stored(number)).toBeNull();
  });

  it('заказ на самой границе создаётся: она включительная', async () => {
    const number = unique('ON');
    const result = await importOrder(
      dto({ externalId: randomUUID(), number, planned: `${CUTOFF} 12:00:00.000` }),
      CUTOFF,
    );

    expect(result.outcome).toBe('CREATED');
    const order = await stored(number);
    // Дата доставки осталась ровно той, что пришла из источника: граница —
    // это отбор, а не подмена значения.
    expect(order?.deliveryDate?.toISOString().slice(0, 10)).toBe(CUTOFF);
    expect(order?.deliveryDateRaw).toBe(`${CUTOFF} 12:00:00.000`);
  });

  it('заказ позже границы создаётся', async () => {
    const number = unique('AFTER');
    const result = await importOrder(
      dto({ externalId: randomUUID(), number, planned: '2028-12-25 12:00:00.000' }),
      CUTOFF,
    );

    expect(result.outcome).toBe('CREATED');
    expect((await stored(number))?.deliveryDate?.toISOString().slice(0, 10)).toBe('2028-12-25');
  });

  it('заказ без даты и с нераспознанной датой не создаётся', async () => {
    /*
     * Границу к такому заказу применить не к чему. Создать его «на всякий
     * случай» значит однажды завести в новом контуре сделку прошлого года,
     * а удаления заказов в системе нет.
     */
    const missing = unique('NODATE');
    expect(
      (await importOrder(dto({ externalId: randomUUID(), number: missing, planned: null }), CUTOFF))
        .outcome,
    ).toBe('SKIPPED_BEFORE_CUTOFF');
    expect(await stored(missing)).toBeNull();

    const broken = unique('BADDATE');
    expect(
      (
        await importOrder(
          dto({ externalId: randomUUID(), number: broken, planned: 'когда получится' }),
          CUTOFF,
        )
      ).outcome,
    ).toBe('SKIPPED_BEFORE_CUTOFF');
    expect(await stored(broken)).toBeNull();
  });

  it('уже созданный заказ продолжает получать обновления', async () => {
    /*
     * Самое опасное место границы. Заказ уже везут; в МоёмСкладе его отменили
     * или перенесли интервал. Отсеки мы обновление вместе с созданием —
     * новый контур показывал бы отменённый заказ как действующий.
     */
    const number = unique('LIVE');
    const externalId = randomUUID();
    await importOrder(dto({ externalId, number, planned: '2028-12-20 12:00:00.000' }), CUTOFF);
    const created = await stored(number);
    expect(created).not.toBeNull();

    const changed = await importOrder(
      dto({
        externalId,
        number,
        planned: '2028-12-20 12:00:00.000',
        interval: 'с 16:00 по 19:00',
      }),
      CUTOFF,
    );

    expect(changed.outcome).toBe('UPDATED');
    const after = await stored(number);
    expect(after?.intervalStartMinute).toBe(16 * 60);
    expect(after?.version).toBe((created?.version ?? 0) + 1);
  });

  it('перенос даты назад существующий заказ не удаляет', async () => {
    // Граница не пересматривает уже принятые решения: заказ создан, и его
    // судьбу дальше решает источник, а не дата отбора.
    const number = unique('MOVED');
    const externalId = randomUUID();
    await importOrder(dto({ externalId, number, planned: '2028-12-15 12:00:00.000' }), CUTOFF);

    const moved = await importOrder(
      dto({ externalId, number, planned: '2028-12-01 12:00:00.000' }),
      CUTOFF,
    );

    expect(moved.outcome).toBe('UPDATED');
    expect((await stored(number))?.deliveryDate?.toISOString().slice(0, 10)).toBe('2028-12-01');
  });

  it('повтор прохода ничего не добавляет и старого заказа не заводит', async () => {
    const before = dto({
      externalId: randomUUID(),
      number: unique('REPEAT-OLD'),
      planned: '2028-12-05 12:00:00.000',
    });
    const after = dto({
      externalId: randomUUID(),
      number: unique('REPEAT-NEW'),
      planned: '2028-12-18 12:00:00.000',
    });

    expect((await importOrder(before, CUTOFF)).outcome).toBe('SKIPPED_BEFORE_CUTOFF');
    expect((await importOrder(after, CUTOFF)).outcome).toBe('CREATED');

    // Второй проход: старый по-прежнему не создаётся, новый не меняется.
    expect((await importOrder(before, CUTOFF)).outcome).toBe('SKIPPED_BEFORE_CUTOFF');
    expect((await importOrder(after, CUTOFF)).outcome).toBe('UNCHANGED');

    expect(await ctx.db.deliveryOrder.count({ where: { externalId: before.id } })).toBe(0);
    expect(await ctx.db.deliveryOrder.count({ where: { externalId: after.id } })).toBe(1);
  });

  it('без переменной поведение прежнее: создаётся любой заказ', async () => {
    // local и staging работают именно так, и менять их этот пакет не должен.
    const number = unique('NOCUTOFF');
    const result = await importOrder(
      dto({ externalId: randomUUID(), number, planned: '2028-12-01 12:00:00.000' }),
      undefined,
    );

    expect(result.outcome).toBe('CREATED');
    expect(await stored(number)).not.toBeNull();
  });
});

describe('правило сравнения дат', () => {
  it('сравнение календарное и московское, а не по абсолютному времени', () => {
    // Чистая функция проверяется отдельно: она — единственное место решения,
    // и её ошибку в базе видно уже последствиями.
    expect(beforeImportCutoff('2028-12-09', CUTOFF)).toBe(true);
    expect(beforeImportCutoff('2028-12-10', CUTOFF)).toBe(false);
    expect(beforeImportCutoff('2028-12-11', CUTOFF)).toBe(false);

    // Границы года и месяца сравниваются как даты, а не как числа.
    expect(beforeImportCutoff('2027-12-31', '2028-01-01')).toBe(true);
    expect(beforeImportCutoff('2028-01-01', '2028-01-01')).toBe(false);
    expect(beforeImportCutoff('2028-02-29', '2028-03-01')).toBe(true);

    // Дата отсутствует — заказ не создаётся.
    expect(beforeImportCutoff(null, CUTOFF)).toBe(true);

    // Границы нет — не создаётся ничего: прежнее поведение сохраняется.
    expect(beforeImportCutoff(null, undefined)).toBe(false);
    expect(beforeImportCutoff('2000-01-01', undefined)).toBe(false);
  });
});

describe('контрольная точка прохода', () => {
  it('отпечаток различает правила отбора', () => {
    /*
     * Продолжать незавершённый проход можно только с теми же правилами.
     * Смени кто-то границу импорта между запусками — «уже прочитанные»
     * страницы относились бы к другой выборке, и продолжение молча
     * пропустило бы заказы, которых прежний проход не видел.
     */
    const filter = approvedStoreFilter(IDS, NOW, CUTOFF);

    // Тот же вид, тот же фильтр, та же граница — точка подходит.
    expect(passFingerprint('initial', filter, CUTOFF)).toBe(
      passFingerprint('initial', filter, CUTOFF),
    );

    // Другая граница — другая выборка.
    expect(passFingerprint('initial', filter, CUTOFF)).not.toBe(
      passFingerprint('initial', filter, '2028-12-01'),
    );

    // Появление границы там, где её не было, — тоже другая выборка.
    expect(passFingerprint('initial', filter, undefined)).not.toBe(
      passFingerprint('initial', filter, CUTOFF),
    );

    // И другой вид прохода: delta читает иное окно, чем первоначальная загрузка.
    expect(passFingerprint('initial', filter, CUTOFF)).not.toBe(
      passFingerprint('delta', filter, CUTOFF),
    );
  });
});

describe('запрос к МоемуСкладу сужается, но защитой не является', () => {
  it('граница поднимает нижний край выборки до московской полуночи', () => {
    const since = new Date('2028-12-01T00:00:00.000Z');
    const withCutoff = approvedStoreFilter(IDS, since, CUTOFF);

    // Московская полночь 10 декабря — это 21:00 UTC девятого числа. В фильтр
    // уходит московское время, потому что МойСклад сравнивает в московском.
    expect(withCutoff).toContain('deliveryPlannedMoment>=2028-12-10 00:00:00');
    expect(withCutoff).toContain(`store=`);
  });

  it('более позднее окно прохода границей не расширяется', () => {
    // Выбирается ПОЗДНЕЙШАЯ из двух границ: сужение не должно возвращать
    // проходу заказы, которых он и так не просил.
    const later = new Date('2029-01-15T00:00:00.000Z');
    expect(approvedStoreFilter(IDS, later, CUTOFF)).toContain(
      'deliveryPlannedMoment>=2029-01-15 03:00:00',
    );
  });

  it('без границы фильтр прежний', () => {
    const since = new Date('2028-12-01T00:00:00.000Z');
    expect(approvedStoreFilter(IDS, since)).toBe(approvedStoreFilter(IDS, since, undefined));
  });
});
