/**
 * Выгрузка сборок флористов в Excel (`GET /api/florist/statistics/assemblies.xlsx`).
 *
 * Защищаемое:
 *
 *  * строка — ФИО флориста, номер заказа и московское время последнего
 *    «Собрано» этого круга; повторное «Собрано» после переоткрытия строку не
 *    добавляет, пересборка (новый круг) — отдельная строка с пометкой;
 *  * сборка считается за каждым флористом отдельно: заказ, собранный в том же
 *    круге другим флористом после переназначения, даёт ему свою строку;
 *  * границы периода — московские сутки; сборка, завершённая окончательно
 *    после периода, уходит в тот период и не считается дважды;
 *  * настоящая сборка флористом попадает в выгрузку;
 *  * файл получает только администратор, и каждая выгрузка фиксируется в
 *    аудите — без имён и номеров заказов.
 *
 * ВЛАДЕНИЕ ДАТАМИ: июнь 2031 (`platform/testing/test-days.ts`). Записи о сборке
 * в этом файле датированы тем же июнем. Имена флористов и номера заказов
 * уникальны на прогон: в несброшенной базе остаются строки прошлых прогонов,
 * поэтому проверки отбирают строки только своих заказов.
 */

import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowToday, shiftCalendarDate, type Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { snapshotHash, type FulfillmentSnapshot } from './composition.js';
import { assembleOrder, claimOrder } from './assembly.js';
import { startShift } from './shifts.js';
import { readAssemblyExportRows } from './assemblies-export.js';

const DAY = '2031-06-10';
const CONTEXT = { ip: null, userAgent: null };
const EXPORT_URL = '/api/florist/statistics/assemblies.xlsx';

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

/** Момент московского дня `2031-06-DD чч:мм` (Москва = UTC+3). */
function at(day: string, hhmm: string): Date {
  return new Date(`2031-06-${day}T${hhmm}:00.000+03:00`);
}

interface Florist {
  id: string;
  name: string;
}

async function seedFlorist(label: string): Promise<Florist> {
  const name = `${label} ${unique('флорист')}`;
  const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
  return { id: user.id, name };
}

interface SeededOrder {
  id: string;
  number: string;
}

/** Заказ вне обеих областей: выгрузке нужен только его номер. */
async function seedOrder(): Promise<SeededOrder> {
  const number = unique('AX');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date('2031-06-01T00:00:00.000Z'),
      deliveryDate: toDateColumn(DAY),
      inScope: false,
      fulfillmentInScope: false,
      address: 'синтетический адрес',
      recipient: 'синтетический получатель',
    },
    select: { id: true },
  });
  return { id: order.id, number };
}

/** Запись «Букет собран» в той форме, в какой её пишет сборка. `null` — запись без круга. */
async function seedAssembled(
  florist: Florist,
  order: SeededOrder,
  occurredAt: Date,
  round: number | null,
): Promise<void> {
  await ctx.db.auditLog.create({
    data: {
      action: 'ORDER_FULFILLMENT_ASSEMBLED',
      entityType: 'DeliveryOrder',
      entityId: order.id,
      actorUserId: florist.id,
      actorRoles: ['FLORIST'],
      occurredAt,
      newValue: {
        processState: 'ASSEMBLED',
        ...(round === null ? {} : { assemblyRound: round }),
      },
    },
  });
}

async function rowsFor(
  period: { from: string; to: string },
  orders: readonly SeededOrder[],
): Promise<[string, string, string, boolean][]> {
  const numbers = new Set(orders.map((order) => order.number));
  const rows = await readAssemblyExportRows(ctx.db, period);
  return rows
    .filter((row) => numbers.has(row.orderNumber))
    .map((row) => [
      row.floristName,
      row.orderNumber,
      row.assembledAt.toISOString(),
      row.reassembly,
    ]);
}

async function loginAs(roles: Role[]): Promise<{ token: string; userId: string }> {
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
  return { token: session.accessToken, userId: user.id };
}

interface Injected {
  statusCode: number;
  headers: Record<string, string | undefined>;
  rawPayload: Buffer;
  body: string;
}

async function getExport(query: string, token: string | null): Promise<Injected> {
  return (await ctx.app.inject({
    method: 'GET',
    url: `${EXPORT_URL}?${query}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })) as unknown as Injected;
}

describe('строки выгрузки', () => {
  it('сборка — одна строка с последним «Собрано» круга; пересборка — отдельная строка', async () => {
    const anna = await seedFlorist('Анна');
    const maria = await seedFlorist('Мария');
    const first = await seedOrder();
    const reopened = await seedOrder();
    const reassembled = await seedOrder();
    const legacy = await seedOrder();
    const rework = await seedOrder();

    await seedAssembled(anna, first, at('10', '09:30'), 1);
    // Переоткрыта и собрана снова в том же круге — строка одна, время последнее.
    await seedAssembled(anna, reopened, at('10', '10:00'), 1);
    await seedAssembled(anna, reopened, at('10', '11:15'), 1);
    // Новый круг — отдельная работа другого флориста.
    await seedAssembled(anna, reassembled, at('10', '12:00'), 1);
    await seedAssembled(maria, reassembled, at('10', '15:00'), 2);
    // Новый круг у того же флориста — тоже отдельная строка, а не замена первой.
    await seedAssembled(anna, rework, at('10', '14:00'), 1);
    await seedAssembled(anna, rework, at('10', '17:00'), 2);
    // Запись сборки, сделанная до того, как начали записывать круг.
    await seedAssembled(maria, legacy, at('10', '13:00'), null);
    // Тот же круг после переназначения собран вторым флористом — его строка.
    await seedAssembled(maria, reopened, at('10', '16:00'), 1);

    expect(
      await rowsFor({ from: '2031-06-10', to: '2031-06-10' }, [
        first,
        reopened,
        reassembled,
        legacy,
        rework,
      ]),
    ).toEqual([
      [anna.name, first.number, at('10', '09:30').toISOString(), false],
      [anna.name, reopened.number, at('10', '11:15').toISOString(), false],
      [anna.name, reassembled.number, at('10', '12:00').toISOString(), false],
      [maria.name, legacy.number, at('10', '13:00').toISOString(), false],
      [anna.name, rework.number, at('10', '14:00').toISOString(), false],
      [maria.name, reassembled.number, at('10', '15:00').toISOString(), true],
      [maria.name, reopened.number, at('10', '16:00').toISOString(), false],
      [anna.name, rework.number, at('10', '17:00').toISOString(), true],
    ]);
  });

  it('границы периода — московские сутки', async () => {
    const florist = await seedFlorist('Граница');
    const midnight = await seedOrder();
    const lastSecond = await seedOrder();
    const nextDay = await seedOrder();
    await seedAssembled(florist, midnight, new Date('2031-06-11T00:00:00.000+03:00'), 1);
    await seedAssembled(florist, lastSecond, new Date('2031-06-11T23:59:59.999+03:00'), 1);
    await seedAssembled(florist, nextDay, new Date('2031-06-12T00:00:00.000+03:00'), 1);
    const orders = [midnight, lastSecond, nextDay];

    expect(
      (await rowsFor({ from: '2031-06-11', to: '2031-06-11' }, orders)).map((row) => row[1]),
    ).toEqual([midnight.number, lastSecond.number]);
    expect(
      (await rowsFor({ from: '2031-06-12', to: '2031-06-12' }, orders)).map((row) => row[1]),
    ).toEqual([nextDay.number]);
  });

  it('сборка, завершённая окончательно после периода, относится к последнему периоду', async () => {
    const florist = await seedFlorist('Переоткрыла');
    const order = await seedOrder();
    await seedAssembled(florist, order, at('13', '10:00'), 1);
    await seedAssembled(florist, order, at('14', '09:00'), 1);

    expect(await rowsFor({ from: '2031-06-13', to: '2031-06-13' }, [order])).toEqual([]);
    expect(await rowsFor({ from: '2031-06-14', to: '2031-06-14' }, [order])).toEqual([
      [florist.name, order.number, at('14', '09:00').toISOString(), false],
    ]);
    expect(await rowsFor({ from: '2031-06-13', to: '2031-06-14' }, [order])).toEqual([
      [florist.name, order.number, at('14', '09:00').toISOString(), false],
    ]);
  });

  it('настоящая сборка флористом попадает в выгрузку', async () => {
    const name = `Настоящая ${unique('флорист')}`;
    const user = await seedUser(ctx.db, { roles: ['FLORIST'], fullName: name });
    const actor = {
      userId: user.id,
      roles: ['FLORIST'],
      familyId: '00000000-0000-4000-8000-000000000071',
      fullName: name,
      phone: user.phone,
    } as AuthenticatedActor;
    await startShift(ctx.db, actor, CONTEXT);

    const number = unique('AX');
    const snapshot: FulfillmentSnapshot = {
      externalId: randomUUID(),
      description: 'Нижний комментарий заказа',
      cardText: null,
      positions: [
        {
          externalPositionId: randomUUID(),
          ordinal: 0,
          assortmentId: randomUUID(),
          assortmentKind: 'PRODUCT',
          assortmentKindRaw: 'product',
          name: 'Букет «Проверка выгрузки»',
          quantity: '1',
          uomId: null,
          uomName: null,
          characteristicLabel: null,
          components: [],
        },
      ],
    };
    const position = snapshot.positions[0] as FulfillmentSnapshot['positions'][number];
    const order = await ctx.db.deliveryOrder.create({
      data: {
        externalId: snapshot.externalId,
        externalName: number,
        externalUpdated: new Date('2031-06-01T00:00:00.000Z'),
        deliveryDate: toDateColumn(DAY),
        address: 'синтетический адрес',
        recipient: 'синтетический получатель',
        inScope: false,
        fulfillmentInScope: true,
        fulfillmentDescription: snapshot.description,
        fulfillmentCardText: snapshot.cardText,
        fulfillmentSnapshotHash: snapshotHash(snapshot),
        fulfillmentCompositionState: 'READY',
        fulfillmentCompositionSyncedAt: new Date(),
        fulfillmentPositions: {
          create: {
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
          },
        },
        fulfillmentRevisions: {
          create: {
            externalUpdated: new Date('2031-06-01T00:00:00.000Z'),
            snapshot: snapshot as never,
            snapshotHash: snapshotHash(snapshot),
            changedFields: ['externalId', 'description', 'cardText', 'positions'],
            reason: 'INITIAL_IMPORT',
          },
        },
      },
      select: { id: true },
    });

    const claimed = await claimOrder(ctx.db, actor, order.id, CONTEXT);
    const before = Date.now();
    await assembleOrder(
      ctx.db,
      actor,
      { orderId: order.id, expectedProcessVersion: claimed.processVersion },
      CONTEXT,
    );
    const after = Date.now();

    const today = moscowToday();
    const rows = await rowsFor(
      { from: shiftCalendarDate(today, -1), to: shiftCalendarDate(today, 1) },
      [{ id: order.id, number }],
    );
    expect(rows).toHaveLength(1);
    const [florist, orderNumber, assembledAt, reassembly] = rows[0] as [
      string,
      string,
      string,
      boolean,
    ];
    expect([florist, orderNumber, reassembly]).toEqual([name, number, false]);
    expect(Date.parse(assembledAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(assembledAt)).toBeLessThanOrEqual(after + 1000);
  });
});

describe('файл и права', () => {
  it('администратор получает файл: колонки, московское время, факт выгрузки в аудите', async () => {
    const admin = await loginAs(['ADMIN']);
    const florist = await seedFlorist('Файл');
    const order = await seedOrder();
    const again = await seedOrder();
    await seedAssembled(florist, order, at('20', '09:30'), 1);
    await seedAssembled(florist, again, at('20', '11:05'), 2);

    const response = await getExport('from=2031-06-20&to=2031-06-20', admin.token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="florist-assemblies-2031-06-20_2031-06-20.xlsx"',
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('Сборки');
    expect(sheet).toBeDefined();
    const header = sheet?.getRow(1);
    expect([1, 2, 3, 4].map((index) => header?.getCell(index).value)).toEqual([
      'ФИО',
      'Номер заказа',
      'Время сборки',
      'Пересборка',
    ]);

    const ours = new Map<
      string,
      { florist: unknown; at: unknown; numFmt: string; again: unknown }
    >();
    sheet?.eachRow((row, index) => {
      if (index === 1) {
        return;
      }
      const number = String(row.getCell(2).value ?? '');
      if (number === order.number || number === again.number) {
        ours.set(number, {
          florist: row.getCell(1).value,
          at: row.getCell(3).value,
          numFmt: row.getCell(3).numFmt,
          again: row.getCell(4).value,
        });
      }
    });
    // В ячейке — московские часы как есть: Excel поясов не знает.
    expect(ours.get(order.number)).toEqual({
      florist: florist.name,
      at: new Date('2031-06-20T09:30:00.000Z'),
      numFmt: 'dd.mm.yyyy hh:mm',
      again: 'нет',
    });
    expect(ours.get(again.number)).toEqual({
      florist: florist.name,
      at: new Date('2031-06-20T11:05:00.000Z'),
      numFmt: 'dd.mm.yyyy hh:mm',
      again: 'да',
    });

    const audit = await ctx.db.auditLog.findMany({
      where: { action: 'FLORIST_ASSEMBLIES_EXPORTED', actorUserId: admin.userId },
      select: { entityType: true, entityId: true, actorRoles: true, newValue: true },
    });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    expect(entry?.entityType).toBe('DeliveryOrder');
    expect(entry?.entityId).toBeNull();
    expect(entry?.actorRoles).toEqual(['ADMIN']);
    const value = entry?.newValue as { format: string; from: string; to: string; rows: number };
    expect([value.format, value.from, value.to]).toEqual(['xlsx', '2031-06-20', '2031-06-20']);
    expect(value.rows).toBeGreaterThanOrEqual(2);
    // Ни имён, ни номеров заказов в аудите нет: они остаются в файле.
    const written = JSON.stringify(entry?.newValue);
    expect(written).not.toContain(florist.name);
    expect(written).not.toContain(order.number);
  });

  it('кроме администратора файл не получает никто, и такая попытка в аудит не пишется', async () => {
    const others: Role[][] = [
      ['FLORIST'],
      ['SUPERVISOR'],
      ['LOGISTICIAN'],
      ['WAREHOUSE'],
      ['MANAGER'],
      ['COURIER'],
    ];
    for (const roles of others) {
      const user = await loginAs(roles);
      const response = await getExport('from=2031-06-20&to=2031-06-20', user.token);
      expect(response.statusCode, roles.join(',')).toBe(403);
      expect(
        await ctx.db.auditLog.count({
          where: { action: 'FLORIST_ASSEMBLIES_EXPORTED', actorUserId: user.userId },
        }),
      ).toBe(0);
    }

    expect((await getExport('from=2031-06-20&to=2031-06-20', null)).statusCode).toBe(401);
  });

  it('период проверяется: конец раньше начала, длиннее года, несуществующая дата', async () => {
    const admin = await loginAs(['ADMIN']);

    const reversed = await getExport('from=2031-06-20&to=2031-06-19', admin.token);
    expect(reversed.statusCode).toBe(400);
    expect(reversed.body).toContain('Конец периода раньше его начала.');

    const tooLong = await getExport('from=2031-06-01&to=2032-06-02', admin.token);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toContain('Период длиннее года');

    expect((await getExport('from=2031-06-31&to=2031-06-31', admin.token)).statusCode).toBe(400);

    // Год ровно в 366 дней допустим.
    expect((await getExport('from=2031-06-01&to=2032-05-31', admin.token)).statusCode).toBe(200);

    expect(
      await ctx.db.auditLog.count({
        where: { action: 'FLORIST_ASSEMBLIES_EXPORTED', actorUserId: admin.userId },
      }),
    ).toBe(1);
  });
});
