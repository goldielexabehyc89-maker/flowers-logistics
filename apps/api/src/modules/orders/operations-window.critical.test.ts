/**
 * Начало операционной работы: фиксированная граница даты доставки.
 *
 * Рабочие списки показывают заказы с датой доставки ОТ `OPERATIONS_START_DATE`
 * включительно. Заказы более раннего дня (29.08.2026) в «Самовывоз», очередь
 * флориста и «Сделки» не попадают — на серверном уровне, чтобы не возвращаться
 * после realtime или синхронизации. Физически заказы не трогаются и остаются
 * в истории.
 *
 * ВЛАДЕНИЕ ДАТАМИ: август 2026 года (граница и день до неё лежат в нём).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { OPERATIONS_START_DATE } from './operations-window.js';
import { listPickupQueue } from '../pickup/views.js';
import { dealsIds } from './deals-scope.js';
import { readQueue } from '../fulfillment/queue-service.js';

let ctx: TestContext;

/** День до границы и сама граница. Оба — в августе 2026, за файлом закреплённом. */
const BEFORE = '2026-08-29';
const FROM = OPERATIONS_START_DATE; // '2026-08-30'

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${seq}`;
}

async function seedOrder(fields: {
  day: string | null;
  pickup?: boolean;
  routable?: boolean;
  florist?: boolean;
}): Promise<{ id: string; number: string }> {
  const number = unique('OW');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date('2026-08-01T00:00:00.000Z'),
      deliveryDate: fields.day === null ? null : toDateColumn(fields.day),
      address: fields.routable ? 'Москва, проверочная улица, дом 1' : null,
      recipient: 'Проверочный Покупатель',
      storeId: MOYSKLAD_IDS.store,
      deliveryMethodId: fields.pickup
        ? MOYSKLAD_IDS.deliveryMethodPickup
        : MOYSKLAD_IDS.deliveryMethodDelivery,
      inScope: fields.routable ?? false,
      fulfillmentInScope: fields.florist ?? fields.pickup ?? false,
      sourceArchived: false,
      sourceMissing: false,
      ...(fields.routable
        ? {
            needsAttention: false,
            attentionReasons: [],
            geoState: 'RESOLVED',
            geoSource: 'DADATA',
            geoPrecision: 'EXACT_HOUSE',
            geoLatMicro: 55_751_244,
            geoLonMicro: 37_618_423,
            geoResolvedAt: new Date(),
          }
        : {}),
      ...(fields.florist
        ? {
            // База требует полноты подтверждённого состава: READY без хеша
            // и отметки синхронизации нарушает check-constraint. Позиции для
            // очереди не нужны — она смотрит только на состояние состава.
            fulfillmentCompositionState: 'READY' as const,
            fulfillmentSnapshotHash: 'ow-ready-hash',
            fulfillmentCompositionSyncedAt: new Date('2026-08-01T00:00:00.000Z'),
          }
        : {}),
    },
    select: { id: true, externalName: true },
  });
  return { id: order.id, number: order.externalName };
}

describe('граница начала работы от 30.08.2026', () => {
  it('граница зафиксирована на 30.08.2026', () => {
    expect(OPERATIONS_START_DATE).toBe('2026-08-30');
  });

  it('«Самовывоз»: 29.08 не показывается, 30.08 показывается, бездатный остаётся', async () => {
    const before = await seedOrder({ day: BEFORE, pickup: true });
    const from = await seedOrder({ day: FROM, pickup: true });
    const undated = await seedOrder({ day: null, pickup: true });

    const page = await listPickupQueue(ctx.db, { limit: 200 });
    const numbers = page.items.map((item) => item.orderNumber);
    expect(numbers).not.toContain(before.number);
    expect(numbers).toContain(from.number);
    // Заказ без даты границей не отсекается: у него нет дня «до 30.08».
    expect(numbers).toContain(undated.number);
  });

  it('«Сделки»: 29.08 не попадает даже при выборе этого дня, 30.08 попадает', async () => {
    const before = await seedOrder({ day: BEFORE, routable: true });
    const from = await seedOrder({ day: FROM, routable: true });

    // Даже выбрав 29.08, логист не увидит заказов: они за границей.
    expect(await dealsIds(ctx.db, { deliveryDate: BEFORE })).not.toContain(before.id);
    expect(await dealsIds(ctx.db, { deliveryDate: FROM })).toContain(from.id);
  });

  it('очередь флориста: 29.08 не попадает, 30.08 попадает', async () => {
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    const before = await seedOrder({ day: BEFORE, florist: true });
    const from = await seedOrder({ day: FROM, florist: true });

    const nowBefore = new Date('2026-08-29T12:00:00.000Z');
    const queueBefore = await readQueue(
      ctx.db,
      { userId: florist.id },
      { day: 'today', scope: 'general', includeAssigned: false, search: before.number },
      nowBefore,
    );
    expect(queueBefore.items.map((item) => item.number)).not.toContain(before.number);

    const nowFrom = new Date('2026-08-30T12:00:00.000Z');
    const queueFrom = await readQueue(
      ctx.db,
      { userId: florist.id },
      { day: 'today', scope: 'general', includeAssigned: false, search: from.number },
      nowFrom,
    );
    expect(queueFrom.items.map((item) => item.number)).toContain(from.number);
  });
});
