/**
 * Критические проверки раздела флориста (этап 6.3).
 *
 * Проверяется не «открывается ли экран», а то, нарушение чего опасно:
 *
 *  * два флориста не могут взять один заказ;
 *  * без активной смены заказ не берётся, а принудительно закрытая смена
 *    не теряет незавершённую работу;
 *  * «Собран» либо происходит целиком, либо не происходит вовсе;
 *  * бланк неизменяем, повтор печати выдаёт ТОТ ЖЕ документ побайтово,
 *    а QR читается чужим декодером и содержит ровно номер заказа;
 *  * изменение состава после сборки переводит заказ в «Требует проверки»
 *    и не стирает ревизию, по которой его собирали;
 *  * очередь не смешивает дни, поднимает просроченные и ведёт маршрут целой
 *    группой;
 *  * фото проксируется без сохранения и с безопасными отказами;
 *  * права закрыты, а московский результат не зависит от часового пояса среды.
 *
 * Инварианты проверяются и через сервис, и напрямую в базе: правило, которое
 * держится только кодом, однажды обойдут скриптом или консолью.
 *
 * ВЛАДЕНИЕ ДАТАМИ: файл забронировал март 2027 года
 * (`platform/testing/test-days.ts`). Заказы других месяцев здесь не создаются.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import jsQR from 'jsqr';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { MoyskladClient } from '../integrations/moysklad/client.js';
import { applyFulfillmentSnapshot } from './service.js';
import { snapshotHash as compositionHash, type FulfillmentSnapshot } from './composition.js';
import {
  MAX_SEARCH_LENGTH,
  readQueue,
  resolveQueueDate,
  type QueueQuery,
  type QueueResult,
} from './queue-service.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, takePage } from './paging.js';
import { readOrderCard } from './card.js';
import { renderPrintFormPdf, qrPayload, formatQuantity } from './pdf.js';
import {
  PRINT_TEMPLATE_VERSION,
  buildPrintFormSnapshot,
  canonicalJson as printFormCanonicalJson,
  snapshotHash as printFormHash,
  type PrintFormSnapshot,
} from './print-form.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { requirePhoto, MAX_PHOTO_BYTES } from './photo.js';
import { assembleOrder, claimOrder, reassignOrder, releaseOrder, reopenOrder } from './assembly.js';
import { listPrintJobs, markPrinted, renderJobDocument, retryPrint } from './print.js';
import { closeOwnShift, forceCloseShift, listAssignableFlorists, startShift } from './shifts.js';

/** Забронированный этим файлом день и следующий за ним. */
const DAY = '2027-03-10';
const NEXT_DAY = '2027-03-11';
/** Момент «сейчас» внутри забронированного дня: 12:00 Москвы. */
const NOW = new Date('2027-03-10T09:00:00.000Z');

const CONTEXT = { ip: null, userAgent: null };

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function uniqueNumber(prefix = 'FL'): string {
  sequence += 1;
  return `${prefix}-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-000000000063',
    fullName: 'Тестовый пользователь',
    phone: user.phone,
  } as AuthenticatedActor;
}

async function tokenFor(roles: Role[]): Promise<string> {
  const { hashSecretCode } = await import('../auth/crypto.js');
  const { login } = await import('../auth/service.js');
  const pin = '1234';
  const pinHash = await hashSecretCode(pin, TEST_SECRETS.AUTH_PIN_PEPPER);
  const user = await seedUser(ctx.db, { roles, pinHash });
  const session = await login(
    ctx,
    { phone: user.phone, pin },
    { ip: null, userAgent: 'vitest', deviceLabel: null },
  );
  return session.accessToken;
}

interface Injected {
  statusCode: number;
  json: () => unknown;
  body: string;
  rawPayload: Buffer;
  headers: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: unknown,
): Promise<Injected> {
  return ctx.app.inject({
    method,
    url,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  }) as unknown as Promise<Injected>;
}

interface SeedOptions {
  day?: string;
  startMinute?: number | null;
  endMinute?: number | null;
  /** Номер заказа: часть проверок сравнивает его с содержимым бланка. */
  number?: string;
  cardText?: string | null;
  description?: string | null;
  positions?: {
    name: string;
    quantity: string;
    kind?: 'PRODUCT' | 'BUNDLE' | 'SERVICE';
    assortmentId?: string;
    /** Обозначение единицы, замороженное в снимке. Отсутствие — штатное. */
    uomName?: string;
    components?: { name: string; quantity: string; assortmentId?: string; uomName?: string }[];
  }[];
}

/**
 * Заказ производственной области с подтверждённым составом.
 *
 * `inScope` намеренно `false`: логистические экраны в этих проверках не
 * участвуют, а производственная область шире логистической и существует
 * независимо от неё.
 */
async function seedOrder(options: SeedOptions = {}): Promise<{ id: string; number: string }> {
  const number = options.number ?? uniqueNumber();
  const positions = options.positions ?? [
    {
      name: 'Букет «Весна»',
      quantity: '1',
      kind: 'BUNDLE' as const,
      components: [{ name: 'Роза красная', quantity: '11' }],
    },
  ];

  const snapshot: FulfillmentSnapshot = {
    externalId: crypto.randomUUID(),
    description: options.description ?? 'Нижний комментарий заказа',
    cardText: options.cardText ?? 'С днём рождения!',
    positions: positions.map((position, index) => ({
      externalPositionId: crypto.randomUUID(),
      ordinal: index,
      assortmentId: position.assortmentId ?? crypto.randomUUID(),
      assortmentKind: position.kind ?? 'PRODUCT',
      assortmentKindRaw: (position.kind ?? 'PRODUCT').toLowerCase(),
      name: position.name,
      quantity: position.quantity,
      uomId: position.uomName === undefined ? null : crypto.randomUUID(),
      uomName: position.uomName ?? null,
      characteristicLabel: null,
      components: (position.components ?? []).map((component, componentIndex) => ({
        externalComponentId: crypto.randomUUID(),
        ordinal: componentIndex,
        assortmentId: component.assortmentId ?? crypto.randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: component.name,
        quantity: component.quantity,
        uomId: component.uomName === undefined ? null : crypto.randomUUID(),
        uomName: component.uomName ?? null,
      })),
    })),
  };

  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: snapshot.externalId,
      externalName: number,
      externalUpdated: new Date('2027-03-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(options.day ?? DAY),
      intervalKind: options.startMinute === null ? 'MISSING' : 'RANGE',
      intervalStartMinute: options.startMinute === undefined ? 600 : options.startMinute,
      intervalEndMinute: options.endMinute === undefined ? 840 : options.endMinute,
      address: 'Москва, проверочный адрес 7',
      recipient: 'Проверочный Получатель +79990000000',
      comment: 'Комментарий по доставке: не показывать флористу',
      inScope: false,
      fulfillmentInScope: true,
      fulfillmentDescription: snapshot.description,
      fulfillmentCardText: snapshot.cardText,
      fulfillmentSnapshotHash: compositionHash(snapshot),
      fulfillmentCompositionState: 'READY',
      fulfillmentCompositionSyncedAt: new Date(),
      fulfillmentPositions: {
        create: snapshot.positions.map((position) => ({
          externalPositionId: position.externalPositionId,
          ordinal: position.ordinal,
          assortmentId: position.assortmentId,
          assortmentKind: position.assortmentKind,
          assortmentKindRaw: position.assortmentKindRaw,
          name: position.name,
          quantity: position.quantity,
          uomId: position.uomId,
          uomName: position.uomName,
          characteristicLabel: position.characteristicLabel,
          components: {
            create: position.components.map((component) => ({
              externalComponentId: component.externalComponentId,
              ordinal: component.ordinal,
              assortmentId: component.assortmentId,
              assortmentKind: component.assortmentKind,
              assortmentKindRaw: component.assortmentKindRaw,
              name: component.name,
              quantity: component.quantity,
              uomId: component.uomId,
              uomName: component.uomName,
            })),
          },
        })),
      },
      fulfillmentRevisions: {
        create: {
          externalUpdated: new Date('2027-03-01T00:00:00.000Z'),
          snapshot: snapshot as never,
          snapshotHash: compositionHash(snapshot),
          changedFields: ['externalId', 'description', 'cardText', 'positions'],
          reason: 'INITIAL_IMPORT',
        },
      },
    },
    select: { id: true, externalName: true },
  });

  return { id: order.id, number: order.externalName };
}

/** Флорист с открытой сменой: обычное состояние рабочего дня. */
async function floristOnShift(): Promise<AuthenticatedActor> {
  const actor = await actorFor(['FLORIST']);
  await startShift(ctx.db, actor, CONTEXT);
  return actor;
}

async function claimAndAssemble(
  actor: AuthenticatedActor,
  orderId: string,
): Promise<{ printFormId: string; printJobId: string }> {
  const claimed = await claimOrder(ctx.db, actor, orderId, CONTEXT);
  const assembled = await assembleOrder(
    ctx.db,
    actor,
    { orderId, expectedProcessVersion: claimed.processVersion },
    CONTEXT,
  );
  return { printFormId: assembled.printFormId, printJobId: assembled.printJobId };
}

// --- 1. Смена ----------------------------------------------------------------

describe('смена флориста', () => {
  it('повторный старт возвращает ту же смену, а не вторую', async () => {
    const actor = await actorFor(['FLORIST']);

    const first = await startShift(ctx.db, actor, CONTEXT);
    const second = await startShift(ctx.db, actor, CONTEXT);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.shift.id).toBe(first.shift.id);

    const open = await ctx.db.floristShift.count({
      where: { userId: actor.userId, closedAt: null },
    });
    expect(open).toBe(1);
  });

  it('две активные смены одного человека запрещает база, а не код', async () => {
    const actor = await actorFor(['FLORIST']);
    await startShift(ctx.db, actor, CONTEXT);

    // Запись мимо сервиса: правило обязано держаться уникальным индексом.
    await expect(
      ctx.db.floristShift.create({ data: { userId: actor.userId, activeKey: actor.userId } }),
    ).rejects.toThrow();
  });

  it('закрытая смена освобождает ключ и позволяет начать новую', async () => {
    const actor = await actorFor(['FLORIST']);
    const started = await startShift(ctx.db, actor, CONTEXT);
    await closeOwnShift(ctx.db, actor, CONTEXT);

    const next = await startShift(ctx.db, actor, CONTEXT);
    expect(next.created).toBe(true);
    expect(next.shift.id).not.toBe(started.shift.id);
  });

  it('принудительное завершение требует причины и не теряет назначения', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();
    const order = await seedOrder();
    await claimOrder(ctx.db, florist, order.id, CONTEXT);

    const shift = await ctx.db.floristShift.findUniqueOrThrow({
      where: { activeKey: florist.userId },
      select: { id: true },
    });

    await expect(
      forceCloseShift(ctx.db, admin, { shiftId: shift.id, reason: ' ' }, CONTEXT),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const result = await forceCloseShift(
      ctx.db,
      admin,
      { shiftId: shift.id, reason: 'Сотрудник ушёл, смена не закрыта' },
      CONTEXT,
    );

    // Заказ остался за флористом и назван явно: администратор обязан решить,
    // что с ним делать, а не обнаружить его пропажу.
    expect(result.orphanedOrderIds).toEqual([order.id]);
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(stored.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(stored.fulfillmentAssigneeId).toBe(florist.userId);

    // Причина сохранена: это единственное объяснение для флориста.
    const closed = await ctx.db.floristShift.findUniqueOrThrow({
      where: { id: shift.id },
      select: { closeKind: true, closeReason: true, activeKey: true },
    });
    expect(closed.closeKind).toBe('ADMIN_FORCED');
    expect(closed.closeReason).toContain('Сотрудник ушёл');
    expect(closed.activeKey).toBeNull();
  });

  it('база не принимает принудительное закрытие без причины', async () => {
    const actor = await actorFor(['FLORIST']);
    const started = await startShift(ctx.db, actor, CONTEXT);

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "FloristShift"
            SET "closedAt" = now(), "activeKey" = NULL,
                "closeKind" = 'ADMIN_FORCED', "closedById" = $1, "closeReason" = '   '
          WHERE "id" = $2::uuid`,
        actor.userId,
        started.shift.id,
      ),
    ).rejects.toThrow();
  });

  it('назначать можно только флористам в активной смене', async () => {
    const onShift = await floristOnShift();
    const offShift = await actorFor(['FLORIST']);

    const assignable = await listAssignableFlorists(ctx.db);
    const ids = assignable.map((item) => item.userId);
    expect(ids).toContain(onShift.userId);
    expect(ids).not.toContain(offShift.userId);
  });
});

// --- 2. Захват ---------------------------------------------------------------

describe('захват заказа', () => {
  it('без активной смены заказ не берётся', async () => {
    const florist = await actorFor(['FLORIST']);
    const order = await seedOrder();

    await expect(claimOrder(ctx.db, florist, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'FLORIST_SHIFT_REQUIRED' },
    });
  });

  it('конкурентный захват: один выигрывает, второй получает 409 и не оставляет следов', async () => {
    const first = await floristOnShift();
    const second = await floristOnShift();
    const order = await seedOrder();

    const results = await Promise.allSettled([
      claimOrder(ctx.db, first, order.id, CONTEXT),
      claimOrder(ctx.db, second, order.id, CONTEXT),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      conflict: { kind: 'ORDER_ALREADY_CLAIMED' },
    });

    // Ровно одна запись аудита и ровно одно событие: проигравший молчит.
    const audits = await ctx.db.auditLog.count({
      where: { entityId: order.id, action: 'ORDER_FULFILLMENT_CLAIMED' },
    });
    expect(audits).toBe(1);

    const events = await ctx.db.realtimeEvent.findMany({
      where: { topic: 'order.fulfillment_process_changed' },
      select: { payload: true },
    });
    const mine = events.filter(
      (event) => (event.payload as { orderId?: string }).orderId === order.id,
    );
    expect(mine).toHaveLength(1);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentAssigneeId: true, fulfillmentProcessVersion: true },
    });
    expect(stored.fulfillmentProcessVersion).toBe(1);
    expect([first.userId, second.userId]).toContain(stored.fulfillmentAssigneeId);
  });

  it('заказ без подтверждённого состава взять нельзя', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { fulfillmentCompositionState: 'PENDING' },
    });

    await expect(claimOrder(ctx.db, florist, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_NOT_ASSEMBLABLE' },
    });
  });

  it('отказ возвращает заказ в очередь, чужой заказ отпустить нельзя', async () => {
    const owner = await floristOnShift();
    const stranger = await floristOnShift();
    const order = await seedOrder();
    await claimOrder(ctx.db, owner, order.id, CONTEXT);

    await expect(releaseOrder(ctx.db, stranger, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'ORDER_NOT_ASSIGNED_TO_YOU' },
    });

    const released = await releaseOrder(ctx.db, owner, order.id, CONTEXT);
    expect(released.processState).toBe('NEW');
    expect(released.assigneeId).toBeNull();
  });

  it('администратор переназначает заказ, но только флористу на смене', async () => {
    const admin = await actorFor(['ADMIN']);
    const owner = await floristOnShift();
    const target = await floristOnShift();
    const offShift = await actorFor(['FLORIST']);
    const order = await seedOrder();
    await claimOrder(ctx.db, owner, order.id, CONTEXT);

    await expect(
      reassignOrder(ctx.db, admin, { orderId: order.id, floristId: offShift.userId }, CONTEXT),
    ).rejects.toMatchObject({ conflict: { kind: 'FLORIST_NOT_ON_SHIFT' } });

    const result = await reassignOrder(
      ctx.db,
      admin,
      { orderId: order.id, floristId: target.userId, reason: 'Первый флорист занят' },
      CONTEXT,
    );
    expect(result.assigneeId).toBe(target.userId);

    // Прежний исполнитель получает личное событие, а не узнаёт случайно.
    const personal = await ctx.db.realtimeEvent.count({
      where: { topic: 'order.fulfillment_process_changed', audienceUserId: owner.userId },
    });
    expect(personal).toBeGreaterThan(0);
  });
});

// --- 3. «Собран» -------------------------------------------------------------

describe('завершение сборки', () => {
  it('создаёт ровно один бланк и ровно одно первоначальное задание печати', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);

    const result = await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      CONTEXT,
    );

    const forms = await ctx.db.orderPrintForm.count({ where: { orderId: order.id } });
    const jobs = await ctx.db.orderPrintJob.findMany({
      where: { orderId: order.id },
      select: { attempt: true, state: true, printFormId: true },
    });

    expect(forms).toBe(1);
    expect(jobs).toEqual([{ attempt: 1, state: 'PENDING', printFormId: result.printFormId }]);

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        fulfillmentProcessState: true,
        fulfillmentAssembledAt: true,
        fulfillmentAssembledById: true,
        fulfillmentAssembledRevisionId: true,
      },
    });
    expect(stored.fulfillmentProcessState).toBe('ASSEMBLED');
    expect(stored.fulfillmentAssembledById).toBe(florist.userId);
    expect(stored.fulfillmentAssembledAt).not.toBeNull();
    expect(stored.fulfillmentAssembledRevisionId).not.toBeNull();
  });

  it('устаревшая версия процесса отклоняется и ничего не создаёт', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);

    await expect(
      assembleOrder(
        ctx.db,
        florist,
        { orderId: order.id, expectedProcessVersion: claimed.processVersion + 5 },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'STALE_VERSION' } });

    expect(await ctx.db.orderPrintForm.count({ where: { orderId: order.id } })).toBe(0);
    expect(await ctx.db.orderPrintJob.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('чужой заказ завершить нельзя, повторное завершение отклоняется', async () => {
    const owner = await floristOnShift();
    const stranger = await floristOnShift();
    const order = await seedOrder();
    const claimed = await claimOrder(ctx.db, owner, order.id, CONTEXT);

    await expect(
      assembleOrder(
        ctx.db,
        stranger,
        { orderId: order.id, expectedProcessVersion: claimed.processVersion },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_NOT_ASSIGNED_TO_YOU' } });

    const done = await assembleOrder(
      ctx.db,
      owner,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      CONTEXT,
    );

    await expect(
      assembleOrder(
        ctx.db,
        owner,
        { orderId: order.id, expectedProcessVersion: done.processVersion },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_PROCESS_STATE_MISMATCH' } });

    expect(await ctx.db.orderPrintForm.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('снимок бланка неизменяем: база отвергает и UPDATE, и DELETE', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printFormId } = await claimAndAssemble(florist, order.id);

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPrintForm" SET "templateVersion" = 99 WHERE "id" = $1::uuid`,
        printFormId,
      ),
    ).rejects.toThrow();

    await expect(
      ctx.db.$executeRawUnsafe(`DELETE FROM "OrderPrintForm" WHERE "id" = $1::uuid`, printFormId),
    ).rejects.toThrow();
  });

  it('возврат в работу возможен только администратору и только с причиной', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();
    const order = await seedOrder();
    await claimAndAssemble(florist, order.id);

    await expect(
      reopenOrder(ctx.db, admin, { orderId: order.id, reason: '' }, CONTEXT),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const result = await reopenOrder(
      ctx.db,
      admin,
      { orderId: order.id, reason: 'Клиент попросил переделать' },
      CONTEXT,
    );
    expect(result.processState).toBe('IN_ASSEMBLY');

    // История не теряется: бланк и задание печати остаются.
    expect(await ctx.db.orderPrintForm.count({ where: { orderId: order.id } })).toBe(1);
    const audit = await ctx.db.auditLog.findFirst({
      where: { entityId: order.id, action: 'ORDER_FULFILLMENT_REOPENED' },
      select: { newValue: true },
    });
    expect((audit?.newValue as { reason?: string }).reason).toContain('переделать');
  });

  it('инвариант базы не допускает собранный заказ без ревизии', async () => {
    const order = await seedOrder();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "DeliveryOrder"
            SET "fulfillmentProcessState" = 'ASSEMBLED'
          WHERE "id" = $1::uuid`,
        order.id,
      ),
    ).rejects.toThrow();
  });
});

// --- 4. PDF и QR -------------------------------------------------------------

/**
 * Модули QR, прочитанные ИЗ ГОТОВОГО PDF.
 *
 * Разбирается фактический поток содержимого документа: он распаковывается
 * стандартным zlib, из него берутся нарисованные квадраты, и уже они
 * растеризуются. Это не «проверить генератор его же матрицей» — из PDF
 * читается то же, что увидит любой просмотрщик и любой сканер.
 */
function rasterizeQrFromPdf(pdf: Uint8Array): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const buffer = Buffer.from(pdf);
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');

  let content = '';
  let index = 0;
  for (;;) {
    const at = buffer.indexOf(marker, index);
    if (at === -1) break;
    let start = at + marker.length;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) break;
    try {
      const inflated = inflateSync(buffer.subarray(start, end)).toString('latin1');
      if (inflated.includes(' cm')) {
        content += inflated;
      }
    } catch {
      // Не сжатый поток: шрифт или метаданные. Разбирать его здесь нечего.
    }
    index = end + endMarker.length;
  }

  // pdf-lib рисует квадрат как перенос системы координат и замкнутый путь.
  const square =
    /1 0 0 1 ([\d.]+) ([\d.]+) cm[\s\S]{0,80}?0 0 m\s+0 ([\d.]+) l\s+([\d.]+) \3 l\s+\4 0 l\s+h\s+f/g;

  const modules: { x: number; y: number; size: number }[] = [];
  let match = square.exec(content);
  while (match !== null) {
    modules.push({
      x: Number(match[1]),
      y: Number(match[2]),
      size: Number(match[3]),
    });
    match = square.exec(content);
  }

  if (modules.length === 0) {
    throw new Error('в документе нет ни одного модуля QR');
  }

  const size = modules[0]?.size ?? 1;
  const minX = Math.min(...modules.map((module) => module.x));
  const minY = Math.min(...modules.map((module) => module.y));
  const maxX = Math.max(...modules.map((module) => module.x));
  const maxY = Math.max(...modules.map((module) => module.y));

  // Тихая зона обязательна: без неё сканер не находит код.
  const quiet = 4;
  const columns = Math.round((maxX - minX) / size) + 1;
  const rows = Math.round((maxY - minY) / size) + 1;
  const scale = 4;
  const width = (columns + quiet * 2) * scale;
  const height = (rows + quiet * 2) * scale;

  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const module of modules) {
    const column = Math.round((module.x - minX) / size) + quiet;
    // PDF считает координаты снизу вверх, растр — сверху вниз.
    const row = rows - 1 - Math.round((module.y - minY) / size) + quiet;
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((row * scale + dy) * width + (column * scale + dx)) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
  }

  return { data: pixels, width, height };
}

describe('печатный бланк', () => {
  it('один и тот же снимок даёт побайтово одинаковый файл', async () => {
    const snapshot = buildPrintFormSnapshot({
      orderNumber: 'FL-000001',
      deliveryDate: DAY,
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      cardText: 'С праздником!',
      description: 'Комментарий',
      positions: [],
      ids: MOYSKLAD_IDS,
    });

    const first = await renderPrintFormPdf(snapshot);
    const second = await renderPrintFormPdf(snapshot);

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first.subarray(0, 8)).toString('latin1')).toContain('%PDF-1.7');
  });

  it('QR читается независимым декодером и содержит ровно номер заказа', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder({ number: uniqueNumber('QR') });
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const document = await renderJobDocument(ctx.db, printJobId);
    const image = rasterizeQrFromPdf(document.bytes);
    const decoded = jsQR(image.data, image.width, image.height);

    expect(decoded).not.toBeNull();
    expect(decoded?.data).toBe(order.number);

    const form = await ctx.db.orderPrintForm.findFirstOrThrow({
      where: { orderId: order.id },
      select: { snapshot: true },
    });
    expect(qrPayload(form.snapshot as never)).toBe(order.number);
  });

  it('бланк не содержит адреса, получателя и логистического комментария', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const document = await renderJobDocument(ctx.db, printJobId);
    const form = await ctx.db.orderPrintForm.findFirstOrThrow({
      where: { orderId: order.id },
      select: { snapshot: true },
    });

    const stored = JSON.stringify(form.snapshot);
    expect(stored).not.toContain('проверочный адрес');
    expect(stored).not.toContain('Проверочный Получатель');
    expect(stored).not.toContain('не показывать флористу');
    expect(document.fileName).toBe(`order-${order.number}.pdf`);
  });

  it('повтор печати выдаёт ТОТ ЖЕ документ, даже если заказ успел измениться', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder({ number: uniqueNumber('RE') });
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const before = await renderJobDocument(ctx.db, printJobId);

    // Заказ меняется уже после сборки: живые данные другие, бумага прежняя.
    await ctx.db.deliveryOrderPosition.updateMany({
      where: { orderId: order.id },
      data: { name: 'Совсем другой букет' },
    });
    await ctx.db.deliveryOrder.update({
      where: { id: order.id },
      data: { fulfillmentCardText: 'Другой текст открытки' },
    });

    const retried = await retryPrint(ctx.db, florist, printJobId, CONTEXT);
    const after = await renderJobDocument(ctx.db, retried.id);

    expect(retried.attempt).toBe(2);
    expect(retried.printFormId).toBe(
      (
        await ctx.db.orderPrintJob.findUniqueOrThrow({
          where: { id: printJobId },
          select: { printFormId: true },
        })
      ).printFormId,
    );
    expect(Buffer.from(after.bytes).equals(Buffer.from(before.bytes))).toBe(true);

    // Состояние «Собран» повтором не затронуто.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true },
    });
    expect(stored.fulfillmentProcessState).toBe('ASSEMBLED');
  });

  it('скачивание не означает печать, ручная отметка завершает задание', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printJobId } = await claimAndAssemble(florist, order.id);

    await renderJobDocument(ctx.db, printJobId);
    const afterDownload = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: printJobId },
      select: { state: true, completedAt: true },
    });
    expect(afterDownload.state).toBe('PENDING');
    expect(afterDownload.completedAt).toBeNull();

    const printed = await markPrinted(ctx.db, florist, printJobId, CONTEXT);
    expect(printed.state).toBe('PRINTED');
    expect(printed.completedById).toBe(florist.userId);

    await expect(markPrinted(ctx.db, florist, printJobId, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'PRINT_JOB_ALREADY_COMPLETED' },
    });

    // Задание только что создано, поэтому в порядке «новые сверху» оно
    // заведомо на первой странице любого подходящего фильтра.
    const attention = await listPrintJobs(ctx.db, { filter: 'attention', limit: 100 });
    expect(attention.items.map((job) => job.id)).not.toContain(printJobId);
    const history = await listPrintJobs(ctx.db, { filter: 'printed', limit: 100 });
    expect(history.items.map((job) => job.id)).toContain(printJobId);
  });

  it('база не принимает «напечатано» без автора и «ошибку» без кода', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printJobId } = await claimAndAssemble(florist, order.id);

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPrintJob" SET "state" = 'PRINTED' WHERE "id" = $1::uuid`,
        printJobId,
      ),
    ).rejects.toThrow();

    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPrintJob" SET "state" = 'ERROR' WHERE "id" = $1::uuid`,
        printJobId,
      ),
    ).rejects.toThrow();
  });

  it('HTTP отдаёт PDF с безопасными заголовками', async () => {
    const token = await tokenFor(['FLORIST']);
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const response = await call('GET', `/api/florist/print-jobs/${printJobId}/document.pdf`, token);

    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toBe('application/pdf');
    expect(String(response.headers['content-disposition'])).toBe(
      `attachment; filename="order-${order.number}.pdf"`,
    );
    expect(String(response.headers['cache-control'])).toBe('no-store');
    expect(String(response.headers['x-content-type-options'])).toBe('nosniff');
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

// --- 4а. Единица измерения на экране и на бумаге ------------------------------

/**
 * Единица измерения проходит весь путь: снимок → карточка → бланк.
 *
 * Проверяется не наличие поля, а два обещания, которые дороже всего нарушить:
 * старый бланк не меняется задним числом, а новый действительно печатает
 * единицу, а не молча теряет её по дороге.
 */
describe('единица измерения в карточке и бланке', () => {
  it('карточка показывает единицу позиций и компонентов, а её отсутствие — просто числом', async () => {
    const order = await seedOrder({
      number: uniqueNumber('UOM'),
      positions: [
        {
          name: 'Букет «Весна»',
          quantity: '1',
          uomName: 'шт',
          kind: 'BUNDLE',
          components: [
            { name: 'Роза', quantity: '11', uomName: 'шт' },
            { name: 'Лента', quantity: '0.5', uomName: 'м' },
          ],
        },
        // У этой позиции единицы нет вовсе: карточка обязана показать одно число.
        { name: 'Упаковка', quantity: '2' },
      ],
    });

    const card = await readOrderCard(ctx.db, order.id);

    expect(card.positions.map((position) => position.uomName)).toEqual(['шт', null]);
    expect(card.positions[0]?.components.map((component) => component.uomName)).toEqual([
      'шт',
      'м',
    ]);
    // Каноническое значение остаётся с точкой: запятая — дело показа.
    expect(card.positions[0]?.components[1]?.quantity).toBe('0.5');
    expect(card.positions[1]?.quantity).toBe('2');
  });

  it('новый бланк печатает единицу, а бланк без неё даёт другой документ', async () => {
    const florist = await floristOnShift();
    const withUnits = await seedOrder({
      number: uniqueNumber('UOMP'),
      positions: [{ name: 'Роза', quantity: '11', uomName: 'шт' }],
    });
    const withoutUnits = await seedOrder({
      number: uniqueNumber('UOMP'),
      positions: [{ name: 'Роза', quantity: '11' }],
    });

    const first = await claimAndAssemble(florist, withUnits.id);
    const second = await claimAndAssemble(florist, withoutUnits.id);

    const stored = await ctx.db.orderPrintForm.findFirstOrThrow({
      where: { orderId: withUnits.id },
      select: { snapshot: true, templateVersion: true },
    });
    expect(stored.templateVersion).toBe(PRINT_TEMPLATE_VERSION);
    expect((stored.snapshot as unknown as PrintFormSnapshot).positions[0]?.uomName).toBe('шт');

    // Байты двух бланков отличаются, значит единица действительно нарисована,
    // а не потерялась между снимком и документом. Номер заказа у обоих свой,
    // поэтому сравнивается размер строки состава, а не документ целиком.
    const printed = await renderJobDocument(ctx.db, first.printJobId);
    const plain = await renderJobDocument(ctx.db, second.printJobId);
    expect(Buffer.from(printed.bytes).equals(Buffer.from(plain.bytes))).toBe(false);
  });

  it('снимок версии 1 без единицы читается, печатается и не меняет свой хеш', async () => {
    // Ровно то, что лежит в базе от прежней версии приложения: ключа единицы
    // в JSON нет вовсе, а не «есть со значением null».
    const legacy = {
      orderNumber: 'FL-LEGACY-1',
      deliveryDate: DAY,
      intervalStartMinute: 600,
      intervalEndMinute: 840,
      cardText: 'С праздником!',
      description: 'Комментарий',
      positions: [
        {
          name: 'Роза',
          quantity: '11',
          characteristicLabel: null,
          isBundle: false,
          components: [{ name: 'Лента', quantity: '1' }],
        },
      ],
    } as unknown as PrintFormSnapshot;

    // Отсутствующий ключ в канонический JSON не попадает: хеш прежних бланков
    // не сдвигается от того, что у новых появилось новое поле.
    const canonical = printFormCanonicalJson(legacy);
    expect(canonical).not.toContain('uomName');
    expect(printFormHash(legacy)).toBe(createHash('sha256').update(canonical).digest('hex'));

    const before = await renderPrintFormPdf(legacy);
    const after = await renderPrintFormPdf(legacy);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
  });

  it('переименование единицы в каталоге не меняет уже напечатанный бланк', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder({
      number: uniqueNumber('UOMF'),
      positions: [
        {
          name: 'Роза',
          quantity: '11',
          uomName: 'шт',
          kind: 'BUNDLE',
          components: [{ name: 'Лента', quantity: '0.5', uomName: 'м' }],
        },
      ],
    });
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const before = await renderJobDocument(ctx.db, printJobId);

    // Каталог МоегоСклада переименовал единицу — состав в базе обновился.
    await ctx.db.deliveryOrderPosition.updateMany({
      where: { orderId: order.id },
      data: { uomName: 'штука' },
    });
    await ctx.db.deliveryOrderPositionComponent.updateMany({
      where: { position: { orderId: order.id } },
      data: { uomName: 'метр' },
    });

    const after = await renderJobDocument(ctx.db, printJobId);

    // Бумага уже приложена к букету: документ обязан остаться побайтово тем же.
    expect(Buffer.from(before.bytes).equals(Buffer.from(after.bytes))).toBe(true);
    const stored = await ctx.db.orderPrintForm.findFirstOrThrow({
      where: { orderId: order.id },
      select: { snapshot: true },
    });
    const snapshot = stored.snapshot as unknown as PrintFormSnapshot;
    expect(snapshot.positions[0]?.uomName).toBe('шт');
    expect(snapshot.positions[0]?.components[0]?.uomName).toBe('м');
  });

  it('число человеку получает запятую, единицу и ничего лишнего', () => {
    expect(formatQuantity('0.5', 'м')).toBe('0,5 м');
    expect(formatQuantity('2', 'шт')).toBe('2 шт');
    // Единицы нет — только число: ни «ед. не указана», ни подставленного «шт».
    expect(formatQuantity('2', null)).toBe('2');
    expect(formatQuantity('2', '  ')).toBe('2');
    expect(formatQuantity('2', undefined)).toBe('2');
  });
});

// --- 5. Изменение снимка -----------------------------------------------------

/** Тот же снимок с другим составом: имитация внешнего изменения заказа. */
async function applyChangedSnapshot(orderId: string): Promise<void> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { externalId: true },
  });

  const snapshot: FulfillmentSnapshot = {
    externalId: order.externalId,
    description: 'Изменённый комментарий',
    cardText: 'Изменённый текст открытки',
    positions: [
      {
        externalPositionId: crypto.randomUUID(),
        ordinal: 0,
        assortmentId: crypto.randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: 'Другой букет',
        quantity: '2',
        characteristicLabel: null,
        components: [],
      },
    ],
  };

  await ctx.db.$transaction(async (tx) => {
    await applyFulfillmentSnapshot(
      tx,
      {
        externalId: order.externalId,
        externalUpdated: new Date('2027-03-02T00:00:00.000Z'),
        texts: { description: snapshot.description, cardText: snapshot.cardText },
        snapshot,
        failure: null,
      },
      new Date(),
    );
  });
}

describe('изменение заказа во время и после сборки', () => {
  it('изменение ДО завершения показывает «Заказ изменён» и не меняет состояние', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    await claimOrder(ctx.db, florist, order.id, CONTEXT);

    await applyChangedSnapshot(order.id);

    const card = await readOrderCard(ctx.db, order.id);
    expect(card.changedSinceClaim).toBe(true);
    expect(card.process.state).toBe('IN_ASSEMBLY');
    // Карточка показывает уже новый состав: флорист собирает актуальное.
    expect(card.positions[0]?.name).toBe('Другой букет');
  });

  it('изменение ПОСЛЕ завершения переводит заказ в «Требует проверки»', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    await claimAndAssemble(florist, order.id);

    const before = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentAssembledRevisionId: true },
    });

    await applyChangedSnapshot(order.id);

    const after = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentAssembledRevisionId: true },
    });

    expect(after.fulfillmentProcessState).toBe('NEEDS_REVIEW');
    // Использованная ревизия сохранена: по ней построен уже напечатанный бланк.
    expect(after.fulfillmentAssembledRevisionId).toBe(before.fulfillmentAssembledRevisionId);

    const audit = await ctx.db.auditLog.count({
      where: { entityId: order.id, action: 'ORDER_FULFILLMENT_REVIEW_REQUIRED' },
    });
    expect(audit).toBe(1);

    // Бланк остался прежним: он относится к тому составу, который собирали.
    const form = await ctx.db.orderPrintForm.findFirstOrThrow({
      where: { orderId: order.id },
      select: { snapshot: true },
    });
    expect(JSON.stringify(form.snapshot)).not.toContain('Другой букет');
  });
});

// --- 6. Очередь --------------------------------------------------------------

/**
 * Общая метка заказов одной проверки.
 *
 * Тестовая база общая и ничего не удаляет: к моменту этих проверок на
 * забронированном дне уже лежат десятки заказов прежних сценариев. Пока
 * очередь отдавалась целиком, это было безразлично; со страницами по 50 строк
 * чужие заказы вытеснили бы свои за границу первой страницы, и проверка
 * доказывала бы порядок создания, а не порядок очереди.
 *
 * Поэтому каждая проверка помечает свои заказы уникальной меткой и просит
 * очередь ровно по ней. Метка — часть номера, то есть тот же серверный поиск,
 * которым пользуется человек.
 */
function queueTag(prefix: string): string {
  return uniqueNumber(prefix);
}

describe('очередь', () => {
  it('«Сегодня» и «Завтра» не смешиваются, просроченные сверху', async () => {
    const florist = await floristOnShift();
    const tag = queueTag('MIX');
    const today = await seedOrder({ number: `${tag}-TD`, startMinute: 660, endMinute: 780 });
    const overdue = await seedOrder({
      number: `${tag}-OV`,
      startMinute: 480,
      endMinute: 540,
    });
    const noTime = await seedOrder({
      number: `${tag}-NT`,
      startMinute: null,
      endMinute: null,
    });
    const tomorrow = await seedOrder({ number: `${tag}-TM`, day: NEXT_DAY });

    const queue = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false, search: tag },
      NOW,
    );

    const ids = queue.items.map((item) => item.id);
    expect(queue.deliveryDate).toBe(DAY);
    expect(ids).toContain(today.id);
    expect(ids).not.toContain(tomorrow.id);

    // Просроченный выше обычного, заказ без времени — ниже обоих.
    expect(ids.indexOf(overdue.id)).toBeLessThan(ids.indexOf(today.id));
    expect(ids.indexOf(today.id)).toBeLessThan(ids.indexOf(noTime.id));
    expect(queue.items.find((item) => item.id === overdue.id)?.overdue).toBe(true);
    expect(queue.items.find((item) => item.id === today.id)?.overdue).toBe(false);

    const next = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'tomorrow', scope: 'general', includeAssigned: false, search: tag },
      NOW,
    );
    expect(next.deliveryDate).toBe(NEXT_DAY);
    expect(next.items.map((item) => item.id)).toContain(tomorrow.id);
    expect(next.items.map((item) => item.id)).not.toContain(today.id);
    // У завтрашнего дня просрочки не бывает по определению.
    expect(next.items.every((item) => !item.overdue)).toBe(true);
  });

  it('назначенные заказы появляются только с галочкой «Все» и показывают флориста', async () => {
    const florist = await floristOnShift();
    const other = await floristOnShift();
    const tag = queueTag('ASG');
    const free = await seedOrder({ number: `${tag}-FR` });
    const taken = await seedOrder({ number: `${tag}-TK` });
    await claimOrder(ctx.db, other, taken.id, CONTEXT);

    const general = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false, search: tag },
      NOW,
    );
    expect(general.items.map((item) => item.id)).toContain(free.id);
    expect(general.items.map((item) => item.id)).not.toContain(taken.id);

    const all = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: true, search: tag },
      NOW,
    );
    const assigned = all.items.find((item) => item.id === taken.id);
    // Поиск не обедняет строку: назначенный заказ по-прежнему объясняет,
    // кем именно он занят.
    expect(assigned?.assignee?.id).toBe(other.userId);
    expect(assigned?.assignee?.fullName).not.toBe('');

    const mine = await readQueue(
      ctx.db,
      { userId: other.userId },
      { day: 'today', scope: 'mine', includeAssigned: false, search: tag },
      NOW,
    );
    expect(mine.items.map((item) => item.id)).toContain(taken.id);
    expect(mine.items.map((item) => item.id)).not.toContain(free.id);
  });

  it('подтверждённый маршрут идёт целой группой и в порядке остановок', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();

    // Ранний маршрут: поздняя остановка внутри него всё равно выше любого
    // заказа более позднего маршрута.
    const tag = queueTag('GRP');
    const earlyFirst = await seedOrder({ number: `${tag}-R1-A`, startMinute: 600, endMinute: 660 });
    const earlySecond = await seedOrder({
      number: `${tag}-R1-B`,
      startMinute: 900,
      endMinute: 960,
    });
    const lateFirst = await seedOrder({ number: `${tag}-R2-A`, startMinute: 700, endMinute: 760 });
    const loose = await seedOrder({ number: `${tag}-LOOSE`, startMinute: 610, endMinute: 620 });

    const early = await seedConfirmedRoute(admin.userId, 'R-EARLY', [
      earlyFirst.id,
      earlySecond.id,
    ]);
    const late = await seedConfirmedRoute(admin.userId, 'R-LATE', [lateFirst.id]);
    expect(early).not.toBe(late);

    const queue = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false, search: tag },
      NOW,
    );

    const ids = queue.items.map((item) => item.id);
    // Весь ранний маршрут, затем весь поздний, и только потом заказ без маршрута.
    expect(ids.indexOf(earlyFirst.id)).toBeLessThan(ids.indexOf(earlySecond.id));
    expect(ids.indexOf(earlySecond.id)).toBeLessThan(ids.indexOf(lateFirst.id));
    expect(ids.indexOf(lateFirst.id)).toBeLessThan(ids.indexOf(loose.id));

    expect(queue.items.find((item) => item.id === earlySecond.id)?.route?.position).toBe(2);
  });

  it('московский день не зависит от часового пояса процесса', () => {
    const previous = process.env['TZ'];
    // Момент 21:30 UTC — уже следующий день в Москве, но ещё вчерашний в США.
    const instant = new Date('2027-03-09T21:30:00.000Z');
    const expected = resolveQueueDate('today', instant);

    try {
      for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        process.env['TZ'] = zone;
        expect(resolveQueueDate('today', instant), zone).toBe(expected);
        expect(resolveQueueDate('tomorrow', instant), zone).toBe(NEXT_DAY);
      }
    } finally {
      if (previous === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = previous;
      }
    }

    expect(expected).toBe('2027-03-10');
  });
});

// --- 6а. «Мои заказы»: работа отдельно от собранных ---------------------------

/**
 * Разделение работы и собранных.
 *
 * Проверяется именно СЕРВЕРНОЕ разделение: счётчик и страница собранных
 * обязаны считаться базой. Отфильтруй список в браузере — и у флориста с
 * шестьюдесятью собранными заголовок показал бы пятьдесят, а заказ за
 * границей страницы перестал бы существовать.
 */
describe('«Мои заказы»: работа и собранные', () => {
  /** Заказ, взятый в работу и доведённый до нужного состояния. */
  async function mine(
    florist: AuthenticatedActor,
    tag: string,
    suffix: string,
    state: 'IN_ASSEMBLY' | 'ASSEMBLED' | 'NEEDS_REVIEW',
  ): Promise<{ id: string; number: string }> {
    const order = await seedOrder({ number: `${tag}-${suffix}` });
    if (state === 'IN_ASSEMBLY') {
      await claimOrder(ctx.db, florist, order.id, CONTEXT);
      return order;
    }
    await claimAndAssemble(florist, order.id);
    if (state === 'NEEDS_REVIEW') {
      // Заказ изменился ПОСЛЕ сборки: он снова требует работы.
      await applyChangedSnapshot(order.id);
    }
    return order;
  }

  function ask(
    florist: AuthenticatedActor,
    group: 'work' | 'assembled',
    search: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<QueueResult> {
    return readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'mine', group, includeAssigned: false, search, ...page },
      NOW,
    );
  }

  it('работа и собранные разделены сервером, NEEDS_REVIEW остаётся в работе', async () => {
    const florist = await floristOnShift();
    const tag = uniqueNumber('GRP');

    const inAssembly = await mine(florist, tag, 'WORK', 'IN_ASSEMBLY');
    const needsReview = await mine(florist, tag, 'REVIEW', 'NEEDS_REVIEW');
    const assembled = await mine(florist, tag, 'DONE', 'ASSEMBLED');

    const work = await ask(florist, 'work', tag);
    const workIds = work.items.map((item) => item.id);
    expect(workIds).toContain(inAssembly.id);
    // Изменившийся после сборки заказ не завершён и в свёрнутую группу
    // спрятан быть не может.
    expect(workIds).toContain(needsReview.id);
    expect(workIds).not.toContain(assembled.id);
    expect(work.group).toBe('work');
    expect(work.total).toBe(2);

    // Точное число собранных приходит ВМЕСТЕ с рабочим списком: заголовок
    // группы верен, пока сама группа свёрнута и ничего не загружено.
    expect(work.assembledTotal).toBe(1);

    const done = await ask(florist, 'assembled', tag);
    expect(done.group).toBe('assembled');
    expect(done.items.map((item) => item.id)).toEqual([assembled.id]);
    expect(done.total).toBe(1);
    expect(done.assembledTotal).toBe(1);
  });

  it('счётчик собранных считает базу, а не загруженную страницу', async () => {
    const florist = await floristOnShift();
    const tag = uniqueNumber('CNT');

    const numbers: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const order = await mine(florist, tag, `A${index}`, 'ASSEMBLED');
      numbers.push(order.number);
    }

    // Страница в две строки: счётчик обязан остаться пятёркой.
    const work = await ask(florist, 'work', tag, { limit: 2 });
    expect(work.items).toEqual([]);
    expect(work.assembledTotal).toBe(5);

    const first = await ask(florist, 'assembled', tag, { limit: 2, offset: 0 });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);

    const second = await ask(florist, 'assembled', tag, { limit: 2, offset: 2 });
    expect(second.items).toHaveLength(2);
    const third = await ask(florist, 'assembled', tag, { limit: 2, offset: 4 });
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);

    // Страницы не повторяют и не теряют строк.
    const collected = [...first.items, ...second.items, ...third.items].map((item) => item.number);
    expect(new Set(collected).size).toBe(5);
    expect([...collected].sort()).toEqual([...numbers].sort());
  });

  it('последний собранный сверху, при равном времени порядок устойчив', async () => {
    const florist = await floristOnShift();
    const tag = uniqueNumber('ORD');

    const early = await mine(florist, tag, 'EARLY', 'ASSEMBLED');
    const late = await mine(florist, tag, 'LATE', 'ASSEMBLED');
    const tieA = await mine(florist, tag, 'TIE-A', 'ASSEMBLED');
    const tieB = await mine(florist, tag, 'TIE-B', 'ASSEMBLED');

    // Время сборки задаётся явно: иначе четыре заказа одной миллисекунды
    // проверяли бы не порядок, а скорость машины.
    const at = (id: string, iso: string) =>
      ctx.db.deliveryOrder.update({
        where: { id },
        data: { fulfillmentAssembledAt: new Date(iso) },
      });
    await at(early.id, '2027-03-10T08:00:00.000Z');
    await at(late.id, '2027-03-10T09:00:00.000Z');
    await at(tieA.id, '2027-03-10T10:00:00.000Z');
    await at(tieB.id, '2027-03-10T10:00:00.000Z');

    const first = await ask(florist, 'assembled', tag);
    // Последний собранный сверху; равное время разводится номером заказа.
    expect(first.items.map((item) => item.number)).toEqual([
      `${tag}-TIE-A`,
      `${tag}-TIE-B`,
      `${tag}-LATE`,
      `${tag}-EARLY`,
    ]);

    // Повторный запрос даёт ТОТ ЖЕ порядок: строки не прыгают между запросами.
    const again = await ask(florist, 'assembled', tag);
    expect(again.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });

  it('сборка и возврат в работу переносят заказ между группами и счётчиками', async () => {
    const florist = await floristOnShift();
    const admin = await actorFor(['ADMIN']);
    const tag = uniqueNumber('MOVE');
    const order = await mine(florist, tag, 'ONE', 'IN_ASSEMBLY');

    const before = await ask(florist, 'work', tag);
    expect(before.items.map((item) => item.id)).toEqual([order.id]);
    expect(before.assembledTotal).toBe(0);

    const claimed = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessVersion: true },
    });
    await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: claimed.fulfillmentProcessVersion },
      CONTEXT,
    );

    const afterAssemble = await ask(florist, 'work', tag);
    expect(afterAssemble.items).toEqual([]);
    expect(afterAssemble.assembledTotal).toBe(1);
    expect((await ask(florist, 'assembled', tag)).items.map((item) => item.id)).toEqual([order.id]);

    // Администратор вернул заказ в работу: он обязан уйти из «Собранных».
    await reopenOrder(ctx.db, admin, { orderId: order.id, reason: 'Повреждена упаковка' }, CONTEXT);

    const afterReopen = await ask(florist, 'work', tag);
    expect(afterReopen.items.map((item) => item.id)).toEqual([order.id]);
    expect(afterReopen.assembledTotal).toBe(0);
    expect((await ask(florist, 'assembled', tag)).items).toEqual([]);
  });

  it('поиск ищет в обеих группах и не выходит за выбранный день', async () => {
    const florist = await floristOnShift();
    const tag = uniqueNumber('FIND');
    const working = await mine(florist, tag, 'WORK', 'IN_ASSEMBLY');
    const done = await mine(florist, tag, 'DONE', 'ASSEMBLED');

    // Номер собранного заказа: в работе его нет, но счётчик группы говорит,
    // что совпадение есть, — именно по нему экран и раскрывает группу.
    const byAssembled = await ask(florist, 'work', done.number);
    expect(byAssembled.items).toEqual([]);
    expect(byAssembled.assembledTotal).toBe(1);
    expect((await ask(florist, 'assembled', done.number)).items.map((i) => i.id)).toEqual([
      done.id,
    ]);

    // Номер рабочего заказа среди собранных не находится: группы не смешаны.
    const byWork = await ask(florist, 'work', working.number);
    expect(byWork.items.map((item) => item.id)).toEqual([working.id]);
    expect(byWork.assembledTotal).toBe(0);

    // Завтрашний день собранных этого дня не показывает вовсе.
    const tomorrow = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'tomorrow', scope: 'mine', group: 'assembled', includeAssigned: false, search: tag },
      NOW,
    );
    expect(tomorrow.items).toEqual([]);
    expect(tomorrow.assembledTotal).toBe(0);
  });

  it('общая очередь групп не знает: собранных в ней нет ни при какой галочке', async () => {
    const florist = await floristOnShift();
    const tag = uniqueNumber('GEN');
    const assembled = await mine(florist, tag, 'DONE', 'ASSEMBLED');

    for (const includeAssigned of [false, true]) {
      const general = await readQueue(
        ctx.db,
        { userId: florist.userId },
        { day: 'today', scope: 'general', group: 'assembled', includeAssigned, search: tag },
        NOW,
      );
      // Область собранных существует только у «Моих заказов»: запрос группы
      // из общей очереди не должен открывать собранные никому.
      expect(general.group).toBe('work');
      expect(general.assembledTotal).toBeNull();
      expect(general.items.map((item) => item.id)).not.toContain(assembled.id);
    }
  });

  it('чужие собранные заказы не попадают ни в счётчик, ни в группу', async () => {
    const florist = await floristOnShift();
    const other = await floristOnShift();
    const tag = uniqueNumber('OTH');
    const foreign = await mine(other, tag, 'FOREIGN', 'ASSEMBLED');

    const work = await ask(florist, 'work', tag);
    expect(work.assembledTotal).toBe(0);
    const done = await ask(florist, 'assembled', tag);
    expect(done.items.map((item) => item.id)).not.toContain(foreign.id);
    expect(done.total).toBe(0);
  });

  it('HTTP: группа приходит параметром, умолчание — работа, чужое значение отклоняется', async () => {
    const token = await tokenFor(['FLORIST']);

    const byDefault = (
      await call('GET', '/api/florist/queue?day=today&scope=mine', token)
    ).json() as QueueResult;
    expect(byDefault.group).toBe('work');
    expect(typeof byDefault.assembledTotal).toBe('number');

    const assembled = (
      await call('GET', '/api/florist/queue?day=today&scope=mine&group=assembled', token)
    ).json() as QueueResult;
    expect(assembled.group).toBe('assembled');

    // Общая очередь остаётся без счётчика собранных: там их не бывает.
    const general = (
      await call('GET', '/api/florist/queue?day=today', token)
    ).json() as QueueResult;
    expect(general.assembledTotal).toBeNull();

    expect(
      (await call('GET', '/api/florist/queue?day=today&scope=mine&group=all', token)).statusCode,
    ).toBe(400);
  });
});

/** Подтверждённый маршрут с заказами в заданном порядке остановок. */
async function seedConfirmedRoute(
  createdById: string,
  prefix: string,
  orderIds: string[],
  day: string = DAY,
): Promise<string> {
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `${prefix}-${process.hrtime.bigint() % 100_000n}`,
      deliveryDate: toDateColumn(day),
      state: 'CONFIRMED',
      vehicleType: 'CAR',
      createdById,
      orders: {
        create: orderIds.map((orderId, index) => ({
          orderId,
          position: index + 1,
          addedById: createdById,
        })),
      },
    },
    select: { id: true },
  });
  return route.id;
}

// --- 6.1. Страницы очереди ---------------------------------------------------

/**
 * День эксплуатационного объёма.
 *
 * Отдельный день внутри забронированного месяца: тысяча заказов на общем дне
 * замедлила бы все остальные проверки очереди и сделала бы их зависимыми от
 * порядка запуска.
 */
const SCALE_DAY = '2027-03-20';

/**
 * Тысяча заказов дешёвым способом.
 *
 * Полная фикстура `seedOrder` создаёт позиции, компоненты и ревизию — для
 * порядка очереди ничего из этого не нужно, а тысяча таких заказов заняла бы
 * минуты. Очередь читает область, день, состояние состава и время; ровно это
 * здесь и создаётся.
 */
async function seedBulkOrders(input: {
  tag: string;
  count: number;
  day: string;
  startMinuteOf: (index: number) => number | null;
}): Promise<{ id: string; number: string }[]> {
  const data = Array.from({ length: input.count }, (_, index) => {
    const startMinute = input.startMinuteOf(index);
    const externalId = crypto.randomUUID();
    /**
     * Подтверждённый, но пустой состав.
     *
     * База требует полноты подтверждённого состояния (`READY` без хеша она не
     * принимает), и хеш здесь настоящий — от снимка без позиций. Позиции
     * порядку очереди безразличны, а тысяча полных снимков стоила бы минут
     * ради данных, которые ни одна из этих проверок не читает.
     */
    const snapshot: FulfillmentSnapshot = {
      externalId,
      description: null,
      cardText: null,
      positions: [],
    };
    return {
      externalId,
      fulfillmentSnapshotHash: compositionHash(snapshot),
      // Ширина номера постоянная: сравнение строк не должно зависеть
      // от того, что «10» короче «9».
      externalName: `${input.tag}-${String(index).padStart(4, '0')}`,
      externalUpdated: new Date('2027-03-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(input.day),
      intervalKind: startMinute === null ? ('MISSING' as const) : ('RANGE' as const),
      intervalStartMinute: startMinute,
      intervalEndMinute: startMinute === null ? null : startMinute + 60,
      address: 'Москва, проверочный адрес 7',
      inScope: false,
      fulfillmentInScope: true,
      fulfillmentCompositionState: 'READY' as const,
      fulfillmentCompositionSyncedAt: new Date(),
    };
  });

  await ctx.db.deliveryOrder.createMany({ data });

  return ctx.db.deliveryOrder.findMany({
    where: { externalName: { startsWith: input.tag } },
    select: { id: true, externalName: true },
    orderBy: { externalName: 'asc' },
  });
}

/** Все страницы подряд: именно так их и накапливает клиент. */
async function readAllPages(
  viewerId: string,
  query: QueueQuery,
  limit: number,
  now: Date,
): Promise<{ ids: string[]; total: number; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  let page = await readQueue(ctx.db, { userId: viewerId }, { ...query, limit, offset: 0 }, now);

  for (;;) {
    pages += 1;
    ids.push(...page.items.map((item) => item.id));
    if (!page.hasMore) {
      break;
    }
    // Страховка от бесконечного цикла: неверный `hasMore` обязан провалить
    // проверку, а не подвесить её.
    expect(pages).toBeLessThan(100);
    page = await readQueue(
      ctx.db,
      { userId: viewerId },
      { ...query, limit, offset: page.offset + page.limit },
      now,
    );
  }

  return { ids, total: page.total, pages };
}

describe('страницы очереди', () => {
  it('склейка страниц равна полному упорядоченному списку', () => {
    // Чистое правило среза: он не переставляет, не теряет и не дублирует.
    const ordered = Array.from({ length: 1000 }, (_, index) => `item-${index}`);

    for (const limit of [1, 7, 50, 100]) {
      const glued: string[] = [];
      for (let offset = 0; offset < ordered.length; offset += limit) {
        const page = takePage(ordered, { limit, offset });
        expect(page.total, `limit=${limit}`).toBe(ordered.length);
        expect(page.hasMore, `limit=${limit} offset=${offset}`).toBe(
          offset + page.items.length < ordered.length,
        );
        glued.push(...page.items);
      }
      expect(glued, `limit=${limit}`).toEqual(ordered);
    }

    // Смещение за концом списка — пустая страница с честным total, а не ошибка.
    const beyond = takePage(ordered, { limit: 50, offset: 5000 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(1000);
    expect(beyond.hasMore).toBe(false);

    // Размер страницы ограничен сервером, а не доверием к клиенту.
    expect(takePage(ordered, { limit: 100_000, offset: 0 }).items).toHaveLength(PAGE_SIZE_MAX);
    expect(takePage(ordered, { limit: 0, offset: -5 }).limit).toBe(1);
    expect(takePage(ordered, { limit: 0, offset: -5 }).offset).toBe(0);
  });

  it('тысяча заказов: порядок до и после разбиения на страницы совпадает', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();
    const tag = queueTag('SCALE');

    /**
     * Ранний маршрут намеренно длиннее страницы, а его остановки — поздние.
     *
     * Это и есть та ловушка, ради которой срез делается ПОСЛЕ порядка. Если
     * бы страница набиралась в SQL по срочности, поздние остановки раннего
     * листа не попали бы в первую полусотню, и на их месте оказались бы
     * заказы позднего листа — флорист получил бы два наполовину собранных
     * маршрута вместо одного готового.
     */
    const ROUTE_A_STOPS = 60;
    const ROUTE_B_STOPS = 5;
    const TOTAL = 1000;

    const orders = await seedBulkOrders({
      tag,
      count: TOTAL,
      day: SCALE_DAY,
      startMinuteOf: (index) => {
        if (index === 0) return 540; // самая ранняя доставка дня — в листе A
        if (index < ROUTE_A_STOPS) return 1000; // остальной лист A — поздний
        if (index < ROUTE_A_STOPS + ROUTE_B_STOPS) return 600; // лист B — раньше
        // Заказы без листа: обычная срочность, часть без времени вовсе.
        return index % 7 === 0 ? null : 660 + (index % 120);
      },
    });
    expect(orders).toHaveLength(TOTAL);

    const routeA = orders.slice(0, ROUTE_A_STOPS).map((order) => order.id);
    const routeB = orders
      .slice(ROUTE_A_STOPS, ROUTE_A_STOPS + ROUTE_B_STOPS)
      .map((order) => order.id);
    await seedConfirmedRoute(admin.userId, 'R-SCALE-A', routeA, SCALE_DAY);
    await seedConfirmedRoute(admin.userId, 'R-SCALE-B', routeB, SCALE_DAY);

    const query = {
      day: 'tomorrow' as const,
      scope: 'general' as const,
      includeAssigned: false,
      search: tag,
    };
    // `SCALE_DAY` не «сегодня» и не «завтра» относительно NOW, поэтому
    // представление выбирается моментом, а не датой: день считает сервер.
    const scaleNow = new Date('2027-03-19T09:00:00.000Z');
    const readPage = (limit: number, offset: number): Promise<QueueResult> =>
      readQueue(ctx.db, { userId: florist.userId }, { ...query, limit, offset }, scaleNow);

    const first = await readPage(PAGE_SIZE_DEFAULT, 0);
    expect(first.deliveryDate).toBe(SCALE_DAY);
    expect(first.total).toBe(TOTAL);
    expect(first.items).toHaveLength(PAGE_SIZE_DEFAULT);
    expect(first.hasMore).toBe(true);
    expect(first.search).toBe(tag);

    // Полный порядок, собранный страницами двух разных размеров.
    const byFifty: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += PAGE_SIZE_DEFAULT) {
      byFifty.push(...(await readPage(PAGE_SIZE_DEFAULT, offset)).items.map((item) => item.id));
    }
    const byHundred: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += PAGE_SIZE_MAX) {
      byHundred.push(...(await readPage(PAGE_SIZE_MAX, offset)).items.map((item) => item.id));
    }

    // Размер страницы не влияет на канонический порядок.
    expect(byFifty).toEqual(byHundred);
    // Ни дублей, ни пропусков.
    expect(new Set(byFifty).size).toBe(TOTAL);
    expect(byFifty).toHaveLength(TOTAL);
    expect(new Set(byFifty)).toEqual(new Set(orders.map((order) => order.id)));

    // Первая страница целиком внутри раннего листа: граница страницы прошла
    // ВНУТРИ маршрута и не подняла следующий лист.
    const routeASet = new Set(routeA);
    expect(byFifty.slice(0, PAGE_SIZE_DEFAULT).every((id) => routeASet.has(id))).toBe(true);
    expect(byFifty.slice(0, ROUTE_A_STOPS)).toEqual(routeA);
    expect(byFifty.slice(ROUTE_A_STOPS, ROUTE_A_STOPS + ROUTE_B_STOPS)).toEqual(routeB);

    // Ни один заказ позднего листа не оказался выше оставшихся заказов раннего.
    const lastOfA = Math.max(...routeA.map((id) => byFifty.indexOf(id)));
    const firstOfB = Math.min(...routeB.map((id) => byFifty.indexOf(id)));
    expect(lastOfA).toBeLessThan(firstOfB);

    // Устойчивый добор: повторное чтение той же страницы даёт то же самое.
    const again = await readPage(PAGE_SIZE_DEFAULT, PAGE_SIZE_DEFAULT);
    expect(again.items.map((item) => item.id)).toEqual(
      byFifty.slice(PAGE_SIZE_DEFAULT, PAGE_SIZE_DEFAULT * 2),
    );

    // Смещение за концом: честный total и никакого обещания продолжения.
    const beyond = await readPage(PAGE_SIZE_DEFAULT, TOTAL + 10);
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(TOTAL);
    expect(beyond.hasMore).toBe(false);
  }, 120_000);

  it('поиск по номеру не смешивает дни и области видимости', async () => {
    const viewer = await floristOnShift();
    const other = await floristOnShift();
    const tag = queueTag('SRCH');

    const todayFree = await seedOrder({ number: `${tag}-TODAY-A` });
    const todayTaken = await seedOrder({ number: `${tag}-TODAY-B` });
    const tomorrow = await seedOrder({ number: `${tag}-TOMORROW`, day: NEXT_DAY });
    await claimOrder(ctx.db, other, todayTaken.id, CONTEXT);

    const ask = (
      day: 'today' | 'tomorrow',
      scope: 'general' | 'mine',
      search: string,
      includeAssigned = false,
    ): Promise<QueueResult> =>
      readQueue(ctx.db, { userId: viewer.userId }, { day, scope, includeAssigned, search }, NOW);

    // День остаётся условием: завтрашний заказ поиском в «Сегодня» не достать.
    const todayHits = await ask('today', 'general', tag);
    expect(todayHits.items.map((item) => item.id)).toEqual([todayFree.id]);
    expect(todayHits.total).toBe(1);

    const tomorrowHits = await ask('tomorrow', 'general', tag);
    expect(tomorrowHits.items.map((item) => item.id)).toEqual([tomorrow.id]);

    // Область видимости тоже остаётся: чужое назначение не раскрывается ни
    // в «Моих заказах», ни в общей очереди без галочки «Все».
    const mine = await ask('today', 'mine', tag);
    expect(mine.items).toEqual([]);
    expect(mine.total).toBe(0);
    const withAssigned = await ask('today', 'general', tag, true);
    expect(withAssigned.items.map((item) => item.id)).toContain(todayTaken.id);

    // Точный номер находит ровно один заказ; регистр значения не имеет.
    const exact = await ask('today', 'general', `${tag}-TODAY-A`);
    expect(exact.items.map((item) => item.number)).toEqual([`${tag}-TODAY-A`]);
    const lower = await ask('today', 'general', `${tag}-today-a`.toLowerCase());
    expect(lower.items.map((item) => item.id)).toEqual([todayFree.id]);

    // Пустой поиск — не фильтр: пробел не должен опустошать очередь.
    const blank = await readQueue(
      ctx.db,
      { userId: viewer.userId },
      { day: 'today', scope: 'general', includeAssigned: false, search: '   ' },
      NOW,
    );
    expect(blank.search).toBeNull();
    expect(blank.total).toBeGreaterThan(0);
  });

  it('HTTP: размер страницы по умолчанию 50, больше максимума отклоняется', async () => {
    const token = await tokenFor(['FLORIST']);

    const byDefault = (await call('GET', '/api/florist/queue?day=today', token)).json() as {
      limit: number;
      offset: number;
      total: number;
      hasMore: boolean;
      items: unknown[];
    };
    expect(byDefault.limit).toBe(PAGE_SIZE_DEFAULT);
    expect(byDefault.offset).toBe(0);
    expect(byDefault.items.length).toBeLessThanOrEqual(PAGE_SIZE_DEFAULT);
    expect(typeof byDefault.total).toBe('number');
    expect(typeof byDefault.hasMore).toBe('boolean');

    // Отказ, а не молчаливое урезание: клиент обязан узнать, что весь день
    // одним ответом ему не отдадут.
    for (const query of [
      `limit=${PAGE_SIZE_MAX + 1}`,
      'limit=100000',
      'limit=0',
      'offset=-1',
      `search=${'x'.repeat(MAX_SEARCH_LENGTH + 1)}`,
    ]) {
      const response = await call('GET', `/api/florist/queue?day=today&${query}`, token);
      expect(response.statusCode, query).toBe(400);
    }

    const jobs = (await call('GET', '/api/florist/print-jobs', token)).json() as {
      limit: number;
      total: number;
      hasMore: boolean;
    };
    expect(jobs.limit).toBe(PAGE_SIZE_DEFAULT);
    expect(typeof jobs.total).toBe('number');
    expect(typeof jobs.hasMore).toBe('boolean');
    expect(
      (await call('GET', `/api/florist/print-jobs?limit=${PAGE_SIZE_MAX + 1}`, token)).statusCode,
    ).toBe(400);
  });

  it('сто двадцать заданий печати: ошибка за пределами первой страницы достижима', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const { printFormId, printJobId } = await claimAndAssemble(florist, order.id);

    // 119 более НОВЫХ заданий поверх настоящего: искомая ошибка становится
    // самой старой из своих и уезжает за первую страницу.
    const base = Date.now();
    await ctx.db.orderPrintJob.createMany({
      data: Array.from({ length: 119 }, (_, index) => ({
        orderId: order.id,
        printFormId,
        attempt: index + 2,
        state: 'PENDING' as const,
        createdAt: new Date(base + (index + 1) * 1000),
      })),
    });

    // Ошибка ставится вместе с кодом: база не принимает её без причины.
    await ctx.db.orderPrintJob.update({
      where: { id: printJobId },
      data: { state: 'ERROR', lastErrorCode: 'PRINTER_OFFLINE', lastErrorAt: new Date(base) },
    });

    const seen: string[] = [];
    let page = await listPrintJobs(ctx.db, {
      filter: 'attention',
      limit: PAGE_SIZE_DEFAULT,
      offset: 0,
    });
    for (;;) {
      seen.push(...page.items.map((job) => job.id));
      if (seen.includes(printJobId) || !page.hasMore) {
        break;
      }
      const nextOffset = page.offset + page.limit;
      expect(nextOffset).toBeLessThan(10_000);
      page = await listPrintJobs(ctx.db, {
        filter: 'attention',
        limit: PAGE_SIZE_DEFAULT,
        offset: nextOffset,
      });
    }

    expect(page.total).toBeGreaterThanOrEqual(120);
    const position = seen.indexOf(printJobId);
    // Именно то, чего не умела прежняя версия: задание нашлось за пределами
    // первых 50 строк.
    expect(position).toBeGreaterThanOrEqual(PAGE_SIZE_DEFAULT);
    expect(new Set(seen).size).toBe(seen.length);

    // Найденное задание полноценно: его можно повторить и отметить вручную.
    const retried = await retryPrint(ctx.db, florist, printJobId, CONTEXT);
    expect(retried.printFormId).toBe(printFormId);
    expect(retried.state).toBe('PENDING');
    const printed = await markPrinted(ctx.db, florist, printJobId, CONTEXT);
    expect(printed.state).toBe('PRINTED');
  }, 60_000);

  it('очередь одного дня целиком доступна по страницам', async () => {
    const florist = await floristOnShift();
    const tag = queueTag('WALK');
    const orders = await seedBulkOrders({
      tag,
      count: 137,
      day: SCALE_DAY,
      startMinuteOf: (index) => 600 + (index % 60),
    });

    const walked = await readAllPages(
      florist.userId,
      { day: 'tomorrow', scope: 'general', includeAssigned: false, search: tag },
      PAGE_SIZE_DEFAULT,
      // Момент выбирает представление: `SCALE_DAY` — «завтра» для 19 марта.
      new Date('2027-03-19T09:00:00.000Z'),
    );

    expect(walked.total).toBe(137);
    expect(walked.ids).toHaveLength(137);
    expect(new Set(walked.ids).size).toBe(137);
    expect(new Set(walked.ids)).toEqual(new Set(orders.map((order) => order.id)));
    expect(walked.pages).toBe(3);
  }, 60_000);
});

// --- 7. Карточка и фото ------------------------------------------------------

describe('карточка сборки', () => {
  it('показывает состав и тексты, но не цену, адрес и логистический комментарий', async () => {
    const order = await seedOrder();
    const card = await readOrderCard(ctx.db, order.id);

    expect(card.number).toBe(order.number);
    expect(card.cardText).toBe('С днём рождения!');
    expect(card.description).toBe('Нижний комментарий заказа');
    expect(card.positions[0]?.isBundle).toBe(true);
    expect(card.positions[0]?.components[0]?.name).toBe('Роза красная');

    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('проверочный адрес');
    expect(serialized).not.toContain('Проверочный Получатель');
    expect(serialized).not.toContain('не показывать флористу');
    expect(serialized).not.toContain('sumMinor');
  });

  it('скрытая сервисная позиция доставки в карточку не попадает', async () => {
    const hidden = MOYSKLAD_IDS.hiddenFulfillmentServices[0];
    const order = await seedOrder({
      positions: [
        { name: 'Букет', quantity: '1' },
        { name: 'ЛФ-Доставка Москва', quantity: '1', kind: 'SERVICE', assortmentId: hidden },
      ],
    });

    const card = await readOrderCard(ctx.db, order.id);
    expect(card.positions.map((position) => position.name)).toEqual(['Букет']);
  });
});

describe('проксирование фотографии', () => {
  it('неизвестная номенклатура отвечает нейтральным «Фото отсутствует»', async () => {
    await expect(
      requirePhoto({ db: ctx.db, client: null }, crypto.randomUUID()),
    ).rejects.toMatchObject({ statusCode: 404, publicMessage: 'Фото отсутствует.' });
  });

  it('скрытая сервисная позиция доступа к файлам не даёт', async () => {
    const hidden = MOYSKLAD_IDS.hiddenFulfillmentServices[1];
    await seedOrder({
      positions: [
        { name: 'ЛФ-Доставка Москва', quantity: '1', kind: 'SERVICE', assortmentId: hidden },
      ],
    });

    await expect(requirePhoto({ db: ctx.db, client: null }, hidden)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('фото проходит насквозь и нигде не сохраняется', async () => {
    const assortmentId = crypto.randomUUID();
    await seedOrder({
      positions: [{ name: 'Букет с фото', quantity: '1', kind: 'BUNDLE', assortmentId }],
    });

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const client = stubbedClient({
      images: [{ meta: { downloadHref: `${BASE}/download/${assortmentId}` }, size: png.length }],
      file: { body: png, type: 'image/png' },
    });

    const photo = await requirePhoto({ db: ctx.db, client }, assortmentId);
    expect(photo.contentType).toBe('image/png');
    expect(Buffer.from(photo.bytes).equals(png)).toBe(true);

    // Ни адреса источника, ни байтов в базе: карточка каждый раз спрашивает заново.
    const stored = await ctx.db.deliveryOrderPosition.findFirstOrThrow({
      where: { assortmentId },
    });
    expect(JSON.stringify(stored)).not.toContain('download');
  });

  it('слишком большой файл и запрещённый тип отвергаются fail closed', async () => {
    const assortmentId = crypto.randomUUID();
    await seedOrder({
      positions: [{ name: 'Букет', quantity: '1', kind: 'BUNDLE', assortmentId }],
    });

    const huge = stubbedClient({
      images: [{ meta: { downloadHref: `${BASE}/download/${assortmentId}` } }],
      file: { body: Buffer.alloc(MAX_PHOTO_BYTES + 1), type: 'image/png' },
    });
    await expect(requirePhoto({ db: ctx.db, client: huge }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });

    const svg = stubbedClient({
      images: [{ meta: { downloadHref: `${BASE}/download/${assortmentId}` } }],
      file: { body: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/svg+xml' },
    });
    await expect(requirePhoto({ db: ctx.db, client: svg }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('адрес вне базового адреса API не загружается вовсе', async () => {
    const assortmentId = crypto.randomUUID();
    await seedOrder({
      positions: [{ name: 'Букет', quantity: '1', kind: 'BUNDLE', assortmentId }],
    });

    const outside: string[] = [];
    const client = stubbedClient({
      images: [{ meta: { downloadHref: 'https://evil.example.test/steal' } }],
      file: { body: Buffer.from('x'), type: 'image/png' },
      onRequest: (url) => {
        if (!url.startsWith(BASE)) {
          outside.push(url);
        }
      },
    });

    await expect(requirePhoto({ db: ctx.db, client }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });
    // Ни одного обращения за пределы API МоегоСклада.
    expect(outside).toEqual([]);
  });
});

const BASE = 'https://api.moysklad.ru/api/remap/1.2';

/** Клиент с подменённой сетью: ни одного настоящего обращения наружу. */
function stubbedClient(options: {
  images: unknown[];
  file: { body: Buffer; type: string };
  onRequest?: (url: string) => void;
}): MoyskladClient {
  return new MoyskladClient({
    config: { baseUrl: BASE, token: 'test-token', ids: MOYSKLAD_IDS },
    minIntervalMs: 0,
    sleep: async () => undefined,
    fetch: (async (input: string | URL) => {
      const url = String(input);
      options.onRequest?.(url);

      if (url.includes('/images')) {
        return new Response(
          JSON.stringify({ rows: options.images, meta: { size: options.images.length } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(options.file.body, {
        status: 200,
        headers: {
          'content-type': options.file.type,
          'content-length': String(options.file.body.length),
        },
      });
    }) as unknown as typeof globalThis.fetch,
  });
}

// --- 8. Пересборка, нумерация печати и смена как инвариант --------------------

/** Версия процесса заказа прямо сейчас: её требует «Собран». */
async function processVersionOf(orderId: string): Promise<number> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { fulfillmentProcessVersion: true },
  });
  return order.fulfillmentProcessVersion;
}

describe('аварийный путь пересборки', () => {
  /**
   * Полный сценарий восстановления.
   *
   * Именно он раньше не работал: вторая сборка снова пыталась занять
   * `attempt = 1`, и уникальный индекс закономерно отклонял всю транзакцию.
   * Заказ оставался в состоянии, из которого нет выхода без правки базы руками.
   */
  it('сборка → изменение → возврат в работу → пересборка: формы и попытки не конфликтуют', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();
    const order = await seedOrder({ number: uniqueNumber('RB') });

    // 1. Первая сборка: форма A и первоначальное задание печати.
    const first = await claimAndAssemble(florist, order.id);
    const jobA = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: first.printJobId },
      select: { attempt: true, printFormId: true },
    });
    expect(jobA.attempt).toBe(1);

    // 2. Документ A и его QR проверены независимо.
    const documentA = await renderJobDocument(ctx.db, first.printJobId);
    const decodedA = jsQR(
      rasterizeQrFromPdf(documentA.bytes).data,
      rasterizeQrFromPdf(documentA.bytes).width,
      rasterizeQrFromPdf(documentA.bytes).height,
    );
    expect(decodedA?.data).toBe(order.number);

    // 3. Внешнее изменение переводит собранный заказ в «Требует проверки».
    await applyChangedSnapshot(order.id);
    expect(await processStateOf(order.id)).toBe('NEEDS_REVIEW');

    // 4. Администратор возвращает заказ в работу с причиной.
    await reopenOrder(
      ctx.db,
      admin,
      { orderId: order.id, reason: 'Состав изменился, собираем заново' },
      CONTEXT,
    );

    // 5. Повторная сборка: новая форма по НОВОЙ ревизии и новое задание.
    const second = await assembleOrder(
      ctx.db,
      florist,
      { orderId: order.id, expectedProcessVersion: await processVersionOf(order.id) },
      CONTEXT,
    );

    const jobB = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: second.printJobId },
      select: { attempt: true, printFormId: true },
    });

    // Номер попытки продолжает общий ряд, а не возвращается к единице.
    expect(jobB.attempt).toBe(2);
    expect(second.printFormId).not.toBe(first.printFormId);

    // 6. Прежняя форма не тронута: те же байты, тот же хеш, то же имя файла.
    const documentAAgain = await renderJobDocument(ctx.db, first.printJobId);
    expect(Buffer.from(documentAAgain.bytes).equals(Buffer.from(documentA.bytes))).toBe(true);
    expect(documentAAgain.snapshotHash).toBe(documentA.snapshotHash);
    expect(documentAAgain.fileName).toBe(documentA.fileName);

    const documentB = await renderJobDocument(ctx.db, second.printJobId);
    expect(Buffer.from(documentB.bytes).equals(Buffer.from(documentA.bytes))).toBe(false);
    expect(documentB.snapshotHash).not.toBe(documentA.snapshotHash);

    // Новый бланк построен по новому составу, старый — по прежнему.
    const forms = await ctx.db.orderPrintForm.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, snapshot: true, revisionId: true },
    });
    expect(forms).toHaveLength(2);
    expect(JSON.stringify(forms[0]?.snapshot)).toContain('Букет «Весна»');
    expect(JSON.stringify(forms[1]?.snapshot)).toContain('Другой букет');
    expect(forms[0]?.revisionId).not.toBe(forms[1]?.revisionId);

    // Оба QR несут один и тот же номер заказа: физический ключ не меняется.
    const rasterB = rasterizeQrFromPdf(documentB.bytes);
    expect(jsQR(rasterB.data, rasterB.width, rasterB.height)?.data).toBe(order.number);

    // 7. Повтор каждой попытки использует ЕЁ форму, а не последнюю форму заказа.
    const retryA = await retryPrint(ctx.db, florist, first.printJobId, CONTEXT);
    const retryB = await retryPrint(ctx.db, florist, second.printJobId, CONTEXT);

    expect(retryA.attempt).toBe(3);
    expect(retryA.printFormId).toBe(jobA.printFormId);
    expect(retryB.attempt).toBe(4);
    expect(retryB.printFormId).toBe(jobB.printFormId);

    // 8. Каждая строка отдаёт СВОЙ документ.
    const retriedA = await renderJobDocument(ctx.db, retryA.id);
    const retriedB = await renderJobDocument(ctx.db, retryB.id);
    expect(Buffer.from(retriedA.bytes).equals(Buffer.from(documentA.bytes))).toBe(true);
    expect(Buffer.from(retriedB.bytes).equals(Buffer.from(documentB.bytes))).toBe(true);

    // 9. Карточка показывает последнюю форму — ту, по которой собран заказ сейчас.
    const card = await readOrderCard(ctx.db, order.id);
    expect(card.print.formId).toBe(second.printFormId);
    expect(card.process.state).toBe('ASSEMBLED');

    // Прежние задания и их авторы не изменились и не исчезли.
    const jobs = await ctx.db.orderPrintJob.findMany({
      where: { orderId: order.id },
      orderBy: { attempt: 'asc' },
      select: { attempt: true, printFormId: true },
    });
    expect(jobs.map((job) => job.attempt)).toEqual([1, 2, 3, 4]);
  });

  it('два одновременных повтора получают разные последовательные номера', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder({ number: uniqueNumber('PAR') });
    const { printJobId } = await claimAndAssemble(florist, order.id);

    const results = await Promise.allSettled([
      retryPrint(ctx.db, florist, printJobId, CONTEXT),
      retryPrint(ctx.db, florist, printJobId, CONTEXT),
    ]);

    // Оба повтора завершились штатно: сырой ошибки уникальности здесь быть
    // не должно — она пришла бы человеку как 500 без объяснимого смысла.
    for (const result of results) {
      expect(result.status, JSON.stringify(result)).toBe('fulfilled');
    }

    const attempts = await ctx.db.orderPrintJob.findMany({
      where: { orderId: order.id },
      orderBy: { attempt: 'asc' },
      select: { attempt: true },
    });
    expect(attempts.map((job) => job.attempt)).toEqual([1, 2, 3]);
  });
});

/** Текущее состояние процесса заказа. */
async function processStateOf(orderId: string): Promise<string> {
  const order = await ctx.db.deliveryOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { fulfillmentProcessState: true },
  });
  return order.fulfillmentProcessState;
}

describe('смена как серверный инвариант действия', () => {
  it('после закрытия смены прежний исполнитель не завершает и не отпускает заказ', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);

    await closeOwnShift(ctx.db, florist, CONTEXT);

    await expect(
      assembleOrder(
        ctx.db,
        florist,
        { orderId: order.id, expectedProcessVersion: claimed.processVersion },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'FLORIST_SHIFT_REQUIRED' } });

    await expect(releaseOrder(ctx.db, florist, order.id, CONTEXT)).rejects.toMatchObject({
      conflict: { kind: 'FLORIST_SHIFT_REQUIRED' },
    });

    // Назначение не потеряно: оно ждёт решения администратора.
    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentAssigneeId: true },
    });
    expect(stored.fulfillmentProcessState).toBe('IN_ASSEMBLY');
    expect(stored.fulfillmentAssigneeId).toBe(florist.userId);
  });

  it('новая смена не оживляет назначение прежней: его разбирает администратор', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();
    const claimed = await claimOrder(ctx.db, florist, order.id, CONTEXT);

    await closeOwnShift(ctx.db, florist, CONTEXT);
    // Тот же человек вышел в новую смену — но заказ закреплён за прежней.
    await startShift(ctx.db, florist, CONTEXT);

    await expect(
      assembleOrder(
        ctx.db,
        florist,
        { orderId: order.id, expectedProcessVersion: claimed.processVersion },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ conflict: { kind: 'ORDER_ASSIGNMENT_SHIFT_CLOSED' } });
  });

  it('после принудительного закрытия администратор переназначает или освобождает заказ', async () => {
    const admin = await actorFor(['ADMIN']);
    const florist = await floristOnShift();
    const other = await floristOnShift();

    const reassigned = await seedOrder();
    const released = await seedOrder();
    await claimOrder(ctx.db, florist, reassigned.id, CONTEXT);
    await claimOrder(ctx.db, florist, released.id, CONTEXT);

    const shift = await ctx.db.floristShift.findUniqueOrThrow({
      where: { activeKey: florist.userId },
      select: { id: true },
    });
    const forced = await forceCloseShift(
      ctx.db,
      admin,
      { shiftId: shift.id, reason: 'Флорист ушёл, смена осталась открытой' },
      CONTEXT,
    );
    expect(forced.orphanedOrderIds).toHaveLength(2);

    // Первый путь: переназначение активному флористу — заказ снова в работе.
    const moved = await reassignOrder(
      ctx.db,
      admin,
      { orderId: reassigned.id, floristId: other.userId, reason: 'Смена закрыта' },
      CONTEXT,
    );
    expect(moved.assigneeId).toBe(other.userId);

    // Новый исполнитель работает под СВОЕЙ сменой и завершает сборку.
    const assembled = await assembleOrder(
      ctx.db,
      other,
      { orderId: reassigned.id, expectedProcessVersion: moved.processVersion },
      CONTEXT,
    );
    expect(assembled.processState).toBe('ASSEMBLED');

    // Второй путь: возврат в общую очередь.
    const back = await releaseOrder(ctx.db, admin, released.id, CONTEXT);
    expect(back.processState).toBe('NEW');
    expect(back.assigneeId).toBeNull();
  });

  it('гонка захвата с закрытием смены даёт один согласованный результат', async () => {
    const florist = await floristOnShift();
    const order = await seedOrder();

    const [claim, close] = await Promise.allSettled([
      claimOrder(ctx.db, florist, order.id, CONTEXT),
      closeOwnShift(ctx.db, florist, CONTEXT),
    ]);

    // Закрытие смены выполняется всегда: человек уходит независимо от гонки.
    expect(close.status).toBe('fulfilled');

    const stored = await ctx.db.deliveryOrder.findUniqueOrThrow({
      where: { id: order.id },
      select: { fulfillmentProcessState: true, fulfillmentShiftId: true },
    });

    if (claim.status === 'fulfilled') {
      // Захват успел раньше: заказ закреплён и виден администратору как
      // требующий решения — но собрать его прежний исполнитель уже не может.
      expect(stored.fulfillmentProcessState).toBe('IN_ASSEMBLY');
      expect(stored.fulfillmentShiftId).not.toBeNull();
      await expect(
        assembleOrder(
          ctx.db,
          florist,
          { orderId: order.id, expectedProcessVersion: claim.value.processVersion },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    } else {
      // Закрытие успело раньше: заказ остался свободным, следов нет.
      expect(stored.fulfillmentProcessState).toBe('NEW');
      expect(stored.fulfillmentShiftId).toBeNull();
    }
  });
});

// --- 9. Ограниченная загрузка фотографии -------------------------------------

/**
 * Клиент с потоковым телом ответа.
 *
 * Отдельная заглушка нужна именно потому, что проверяется ТРАНСПОРТ: сколько
 * байт фактически прочитано, был ли отменён поток и сколько раз вызван `fetch`.
 * На готовом буфере ничего этого доказать нельзя.
 */
function streamingClient(options: {
  chunks: Buffer[];
  type: string;
  /** Что объявить в заголовке. `null` — не объявлять вовсе. */
  declaredLength: number | null;
  /** Ответ переадресации вместо файла. */
  redirectTo?: string;
  calls: { fetches: string[]; sent: number; cancelled: boolean; redirect: string | undefined };
}): MoyskladClient {
  const { calls } = options;

  return new MoyskladClient({
    config: { baseUrl: BASE, token: 'test-token', ids: MOYSKLAD_IDS },
    minIntervalMs: 0,
    sleep: async () => undefined,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.fetches.push(url);

      if (url.includes('/images')) {
        return new Response(
          JSON.stringify({
            rows: [{ meta: { downloadHref: `${BASE}/download/file` } }],
            meta: { size: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      // Политика переадресации — часть контракта, а не деталь реализации.
      calls.redirect = init?.redirect;

      if (options.redirectTo !== undefined) {
        return new Response(null, {
          status: 302,
          headers: { location: options.redirectTo },
        });
      }

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = options.chunks[calls.sent];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          calls.sent += 1;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          calls.cancelled = true;
        },
      });

      const headers: Record<string, string> = { 'content-type': options.type };
      if (options.declaredLength !== null) {
        headers['content-length'] = String(options.declaredLength);
      }

      return new Response(stream, { status: 200, headers });
    }) as unknown as typeof globalThis.fetch,
  });
}

describe('загрузка фотографии ограничена по-настоящему', () => {
  async function seedPhotoOrder(): Promise<string> {
    const assortmentId = crypto.randomUUID();
    await seedOrder({
      positions: [{ name: 'Букет с фото', quantity: '1', kind: 'BUNDLE', assortmentId }],
    });
    return assortmentId;
  }

  it('поток без Content-Length читается и ограничивается фактическими байтами', async () => {
    const assortmentId = await seedPhotoOrder();
    const calls = {
      fetches: [],
      sent: 0,
      cancelled: false,
      redirect: undefined as string | undefined,
    };

    const client = streamingClient({
      chunks: [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2)],
      type: 'image/png',
      declaredLength: null,
      calls,
    });

    const photo = await requirePhoto({ db: ctx.db, client }, assortmentId);
    expect(photo.bytes.byteLength).toBe(2048);
    expect(calls.cancelled).toBe(false);
    // Переадресации не следуем ни при каких обстоятельствах.
    expect(calls.redirect).toBe('manual');
  });

  it('заниженный Content-Length не обманывает: чтение прекращается у границы', async () => {
    const assortmentId = await seedPhotoOrder();
    const calls = {
      fetches: [],
      sent: 0,
      cancelled: false,
      redirect: undefined as string | undefined,
    };

    // Кусок в мегабайт: превышение наступает на шестом, а не на последнем.
    const chunk = () => Buffer.alloc(1024 * 1024, 7);
    const client = streamingClient({
      chunks: Array.from({ length: 20 }, chunk),
      type: 'image/png',
      // Ложное обещание «файл крошечный».
      declaredLength: 10,
      calls,
    });

    await expect(requirePhoto({ db: ctx.db, client }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Главное: прочитано НЕ всё. Чтение остановлено у предела, поток отменён.
    //
    // Допуск в два куска — не небрежность: поток читается с опережением,
    // и один-два куска успевают быть подготовлены до того, как сумма
    // перевалит за границу. Существенно другое: двадцать мегабайт в память
    // не попали, а отправитель получил отмену.
    expect(calls.cancelled).toBe(true);
    expect(calls.sent).toBeLessThanOrEqual(Math.ceil(MAX_PHOTO_BYTES / (1024 * 1024)) + 2);
    expect(calls.sent).toBeLessThan(20);
  });

  it('честный слишком большой Content-Length отвергается до чтения тела', async () => {
    const assortmentId = await seedPhotoOrder();
    const calls = {
      fetches: [],
      sent: 0,
      cancelled: false,
      redirect: undefined as string | undefined,
    };

    const client = streamingClient({
      chunks: Array.from({ length: 20 }, () => Buffer.alloc(1024 * 1024, 3)),
      type: 'image/png',
      declaredLength: MAX_PHOTO_BYTES + 1,
      calls,
    });

    await expect(requirePhoto({ db: ctx.db, client }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Тело не читалось: отказ произошёл по заголовку. Единственный возможный
    // кусок — опережающее чтение самого потока, наш код к нему не обращался.
    expect(calls.sent).toBeLessThanOrEqual(1);
  });

  it('переадресация на чужой хост не вызывает второго запроса', async () => {
    const assortmentId = await seedPhotoOrder();
    const calls = {
      fetches: [],
      sent: 0,
      cancelled: false,
      redirect: undefined as string | undefined,
    };

    const client = streamingClient({
      chunks: [],
      type: 'image/png',
      declaredLength: null,
      redirectTo: 'https://evil.example.test/steal',
      calls,
    });

    await expect(requirePhoto({ db: ctx.db, client }, assortmentId)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Ровно два обращения: список изображений и сам файл. Ни одного к чужому
    // хосту — токен туда не уходит.
    expect(calls.fetches).toHaveLength(2);
    for (const url of calls.fetches) {
      expect(url.startsWith(BASE)).toBe(true);
    }
    expect(calls.redirect).toBe('manual');
  });
});

// --- 10. Права ---------------------------------------------------------------

describe('права раздела', () => {
  const FOREIGN: Role[] = ['LOGISTICIAN', 'WAREHOUSE', 'MANAGER', 'COURIER'];

  it('аноним получает 401 на каждом маршруте', async () => {
    for (const url of ['/api/florist/queue', '/api/florist/shift', '/api/florist/print-jobs']) {
      const response = await call('GET', url, null);
      expect(response.statusCode, url).toBe(401);
    }
  });

  // Хеширование PIN у четырёх пользователей намеренно медленное: это argon2,
  // и ослаблять его ради скорости теста нельзя. Поэтому здесь свой предел.
  it('чужие роли получают 403', async () => {
    for (const role of FOREIGN) {
      const token = await tokenFor([role]);
      const response = await call('GET', '/api/florist/queue', token);
      expect(response.statusCode, role).toBe(403);
    }
  }, 30_000);

  it('флорист не выполняет административные действия', async () => {
    const token = await tokenFor(['FLORIST']);

    expect((await call('GET', '/api/florist/shifts', token)).statusCode).toBe(403);
    expect((await call('GET', '/api/florist/florists', token)).statusCode).toBe(403);

    const order = await seedOrder();
    const reopen = await call('POST', `/api/florist/orders/${order.id}/reopen`, token, {
      reason: 'Причина',
    });
    expect(reopen.statusCode).toBe(403);

    const assign = await call('POST', `/api/florist/orders/${order.id}/assign`, token, {
      floristId: crypto.randomUUID(),
    });
    expect(assign.statusCode).toBe(403);
  });

  it('флорист и администратор работают с очередью', async () => {
    for (const role of ['FLORIST', 'ADMIN'] as Role[]) {
      const token = await tokenFor([role]);
      const response = await call('GET', '/api/florist/queue?day=today', token);
      expect(response.statusCode, role).toBe(200);
    }
  });
});
