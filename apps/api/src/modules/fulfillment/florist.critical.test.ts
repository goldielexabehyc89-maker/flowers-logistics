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
import { readQueue, resolveQueueDate } from './queue-service.js';
import { readOrderCard } from './card.js';
import { renderPrintFormPdf, qrPayload } from './pdf.js';
import { buildPrintFormSnapshot } from './print-form.js';
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
    components?: { name: string; quantity: string; assortmentId?: string }[];
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
      characteristicLabel: null,
      components: (position.components ?? []).map((component, componentIndex) => ({
        externalComponentId: crypto.randomUUID(),
        ordinal: componentIndex,
        assortmentId: component.assortmentId ?? crypto.randomUUID(),
        assortmentKind: 'PRODUCT',
        assortmentKindRaw: 'product',
        name: component.name,
        quantity: component.quantity,
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

    const attention = await listPrintJobs(ctx.db, { filter: 'attention', limit: 100 });
    expect(attention.map((job) => job.id)).not.toContain(printJobId);
    const history = await listPrintJobs(ctx.db, { filter: 'printed', limit: 100 });
    expect(history.map((job) => job.id)).toContain(printJobId);
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

describe('очередь', () => {
  it('«Сегодня» и «Завтра» не смешиваются, просроченные сверху', async () => {
    const florist = await floristOnShift();
    const today = await seedOrder({ number: uniqueNumber('TD'), startMinute: 660, endMinute: 780 });
    const overdue = await seedOrder({
      number: uniqueNumber('OV'),
      startMinute: 480,
      endMinute: 540,
    });
    const noTime = await seedOrder({
      number: uniqueNumber('NT'),
      startMinute: null,
      endMinute: null,
    });
    const tomorrow = await seedOrder({ number: uniqueNumber('TM'), day: NEXT_DAY });

    const queue = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false },
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
      { day: 'tomorrow', scope: 'general', includeAssigned: false },
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
    const free = await seedOrder({ number: uniqueNumber('FR') });
    const taken = await seedOrder({ number: uniqueNumber('TK') });
    await claimOrder(ctx.db, other, taken.id, CONTEXT);

    const general = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false },
      NOW,
    );
    expect(general.items.map((item) => item.id)).toContain(free.id);
    expect(general.items.map((item) => item.id)).not.toContain(taken.id);

    const all = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: true },
      NOW,
    );
    const assigned = all.items.find((item) => item.id === taken.id);
    expect(assigned?.assignee?.id).toBe(other.userId);

    const mine = await readQueue(
      ctx.db,
      { userId: other.userId },
      { day: 'today', scope: 'mine', includeAssigned: false },
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
    const earlyFirst = await seedOrder({ number: 'FL-R1-A', startMinute: 600, endMinute: 660 });
    const earlySecond = await seedOrder({ number: 'FL-R1-B', startMinute: 900, endMinute: 960 });
    const lateFirst = await seedOrder({ number: 'FL-R2-A', startMinute: 700, endMinute: 760 });
    const loose = await seedOrder({ number: 'FL-LOOSE', startMinute: 610, endMinute: 620 });

    const early = await seedConfirmedRoute(admin.userId, 'R-EARLY', [
      earlyFirst.id,
      earlySecond.id,
    ]);
    const late = await seedConfirmedRoute(admin.userId, 'R-LATE', [lateFirst.id]);
    expect(early).not.toBe(late);

    const queue = await readQueue(
      ctx.db,
      { userId: florist.userId },
      { day: 'today', scope: 'general', includeAssigned: false },
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

/** Подтверждённый маршрут с заказами в заданном порядке остановок. */
async function seedConfirmedRoute(
  createdById: string,
  prefix: string,
  orderIds: string[],
): Promise<string> {
  const route = await ctx.db.deliveryRoute.create({
    data: {
      number: `${prefix}-${process.hrtime.bigint() % 100_000n}`,
      deliveryDate: toDateColumn(DAY),
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

// --- 8. Права ----------------------------------------------------------------

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
