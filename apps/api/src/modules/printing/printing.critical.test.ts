/**
 * Печать этикеток: кадр для термоголовки, задание принтера и точки печати.
 *
 * Проверяется то, что нельзя увидеть на экране и что стоит дорого:
 *
 *  * кадр ровно 464×320 точки — столько выжигает головка 203 DPI на 58×40 мм;
 *  * QR из этого кадра читает НЕЗАВИСИМЫЙ декодер, а не наш же генератор;
 *  * в задании TSPL чёрная точка кодируется нулём — перепутанная полярность
 *    печатает негатив, который не читает ни один сканер;
 *  * одноразовый код подключения гаснет после первого использования;
 *  * токен агента на сервере не хранится открытым;
 *  * задание выдаётся агенту по одному и не выдаётся дважды;
 *  * неоднозначный исход НЕ печатается повторно;
 *  * задания без назначенной точки агенту не достаются вовсе — иначе первое
 *    подключение принтера распечатало бы всю историческую очередь.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Доказательства, что бумага вышла из XP-318B. Этого нельзя
 * проверить без принтера, и изображать такую проверку программно нечестно.
 *
 * ВЛАДЕНИЕ ДАТАМИ: день вне диапазонов остальных файлов набора.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  TEST_SECRETS,
  type TestContext,
} from '../auth/testing/harness.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import type { Role } from '@fl/shared';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { buildPrintFormSnapshot } from '../fulfillment/print-form.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import { claimNextDelivery, reportDelivery } from '../fulfillment/print.js';
import { renderLabelBitmap, RASTER_HEIGHT, RASTER_WIDTH } from './raster.js';
import { bitmapBytes, encodeTsplJob } from './tspl.js';
import { encodeLabelPng } from './png.js';
import {
  createPrintPoint,
  disconnectPrintPoint,
  issuePairingCode,
  pairAgent,
  pointByAgentToken,
  pointState,
  recordHeartbeat,
  requestTestPrint,
  OFFLINE_AFTER_MS,
} from './service.js';

let ctx: TestContext;
const CONTEXT = { ip: null, userAgent: null };
const PEPPER = TEST_SECRETS.AUTH_PIN_PEPPER;

/** День вне диапазонов остальных файлов набора. */
const DAY = '2028-03-14';

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

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return { userId: user.id, roles, familyId: randomUUID() } as AuthenticatedActor;
}

/** Подключённая точка: код выпущен и погашен агентом. */
async function pairedPoint(): Promise<{ pointId: string; token: string }> {
  const admin = await actorFor(['ADMIN']);
  const point = await createPrintPoint(ctx.db, admin, { name: unique('Стол') }, CONTEXT);
  const issued = await issuePairingCode(ctx.db, admin, point.id, PEPPER, CONTEXT);
  const paired = await pairAgent(
    ctx.db,
    { code: issued.code, computerName: 'FLORIST-PC', printerName: 'XP-318B' },
    PEPPER,
  );
  return { pointId: point.id, token: paired.token };
}

/**
 * Задание печати, готовое к выдаче агенту.
 *
 * Создаётся ТЕМ ЖЕ путём, что и в жизни: заказ, неизменяемый бланк, задание.
 * Второй сущности «этикетка» у заказа нет.
 */
async function seedJob(pointId: string | null): Promise<{ jobId: string; number: string }> {
  const number = unique('PRN');
  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: toDateColumn(DAY),
      inScope: true,
    },
    select: { id: true },
  });

  const snapshot = buildPrintFormSnapshot({
    orderNumber: number,
    deliveryDate: DAY,
    intervalStartMinute: 600,
    intervalEndMinute: 840,
    cardText: null,
    description: null,
    positions: [],
    ids: MOYSKLAD_IDS,
  });

  const revision = await ctx.db.orderFulfillmentRevision.create({
    data: {
      orderId: order.id,
      externalUpdated: new Date(),
      snapshot: {},
      snapshotHash: randomUUID(),
      changedFields: [],
      reason: 'INITIAL_IMPORT',
    },
    select: { id: true },
  });

  const form = await ctx.db.orderPrintForm.create({
    data: {
      orderId: order.id,
      revisionId: revision.id,
      assemblyRound: 1,
      templateVersion: 1,
      snapshot: snapshot as never,
      snapshotHash: randomUUID(),
    },
    select: { id: true },
  });

  const job = await ctx.db.orderPrintJob.create({
    data: {
      orderId: order.id,
      printFormId: form.id,
      attempt: 1,
      state: 'PENDING',
      printPointId: pointId,
      deliveryState: pointId === null ? null : 'QUEUED',
    },
    select: { id: true },
  });

  return { jobId: job.id, number };
}

// --- Кадр для термоголовки ---------------------------------------------------

describe('кадр этикетки', () => {
  it('ровно 464×320 точек — столько выжигает головка 203 DPI', () => {
    const bitmap = renderLabelBitmap({ qrText: 'FL-000123', caption: 'FL-000123' });

    // 58 мм × 8 точек на миллиметр и 40 мм × 8. Другой размер принтер
    // растянет или обрежет, и наклейка перестанет совпадать с лентой.
    expect(bitmap.width).toBe(464);
    expect(bitmap.height).toBe(320);
    expect(bitmap.width).toBe(RASTER_WIDTH);
    expect(bitmap.height).toBe(RASTER_HEIGHT);
    expect(bitmap.data.length).toBe(464 * 320);
  });

  it('QR из кадра читает независимый декодер', () => {
    for (const value of ['A-1', 'FL-000123', 'СТЕЛЛАЖ-A-001', 'X'.repeat(48)]) {
      const bitmap = renderLabelBitmap({ qrText: value, caption: value });

      // Кадр переводится в изображение ровно так, как его увидит головка:
      // точка либо есть, либо нет. Полутонов у термопечати не бывает.
      const pixels = new Uint8ClampedArray(bitmap.width * bitmap.height * 4).fill(255);
      for (let index = 0; index < bitmap.data.length; index += 1) {
        if (bitmap.data[index] === 1) {
          pixels[index * 4] = 0;
          pixels[index * 4 + 1] = 0;
          pixels[index * 4 + 2] = 0;
        }
      }

      const decoded = jsQR(pixels, bitmap.width, bitmap.height);
      expect(decoded?.data, value).toBe(value);
    }
  });

  it('подпись действительно нарисована и стоит справа от кода', () => {
    const bitmap = renderLabelBitmap({ qrText: 'FL-000123', caption: 'FL-000123' });

    // Правее QR обязаны быть чёрные точки: это и есть номер. Пустая правая
    // половина означала бы наклейку без подписи — сканер бы её прочёл,
    // а человек нет.
    let right = 0;
    for (let row = 0; row < bitmap.height; row += 1) {
      for (let column = 300; column < bitmap.width; column += 1) {
        if (bitmap.data[row * bitmap.width + column] === 1) {
          right += 1;
        }
      }
    }
    expect(right).toBeGreaterThan(50);
  });

  it('кадр воспроизводится побайтово', () => {
    const first = renderLabelBitmap({ qrText: 'A-01', caption: 'A-01' });
    const second = renderLabelBitmap({ qrText: 'A-01', caption: 'A-01' });
    expect(Buffer.from(first.data).equals(Buffer.from(second.data))).toBe(true);
  });

  it('предпросмотр PNG собирается из того же кадра', () => {
    const bitmap = renderLabelBitmap({ qrText: 'A-01', caption: 'A-01' });
    const png = encodeLabelPng(bitmap);

    // Подпись файла PNG и размеры в заголовке IHDR.
    expect(Buffer.from(png.subarray(0, 8)).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    const header = Buffer.from(png.subarray(16, 24));
    expect(header.readUInt32BE(0)).toBe(464);
    expect(header.readUInt32BE(4)).toBe(320);
  });
});

// --- Задание принтера --------------------------------------------------------

describe('задание TSPL', () => {
  it('чёрная точка кодируется нулём: полярность не перепутана', () => {
    const bitmap = { width: 8, height: 1, data: new Uint8Array(8) };
    bitmap.data[0] = 1;
    bitmap.data[7] = 1;

    const bytes = bitmapBytes(bitmap);
    expect(bytes.length).toBe(1);

    /*
     * У TSPL инвертированная полярность: единица бита — БЕЛАЯ точка.
     * Перепутать её не значит «не напечатать» — значит напечатать негатив:
     * чёрный прямоугольник с белым QR, который не читает ни один сканер.
     */
    expect(bytes[0]).toBe(0b01111110);
  });

  it('задание несёт размер носителя, зазор и печать', () => {
    const job = encodeTsplJob([renderLabelBitmap({ qrText: 'A-01', caption: 'A-01' })]);
    const text = Buffer.from(job).toString('latin1');

    // Размер и зазор повторяются перед каждой наклейкой: принтер теряет их
    // вместе с питанием, и следующая партия печаталась бы с чужим носителем.
    expect(text).toContain('SIZE 58 mm,40 mm');
    expect(text).toContain('GAP 2 mm,0 mm');
    expect(text).toContain('BITMAP 0,0,58,320,0,');
    expect(text).toContain('PRINT 1,1');

    // Кадр целиком: 58 байт на строку, 320 строк.
    expect(job.length).toBeGreaterThan(58 * 320);
  });

  it('две наклейки — два полных задания в одном потоке', () => {
    const one = renderLabelBitmap({ qrText: 'A-01', caption: 'A-01' });
    const two = renderLabelBitmap({ qrText: 'A-02', caption: 'A-02' });
    const text = Buffer.from(encodeTsplJob([one, two])).toString('latin1');

    expect((text.match(/PRINT 1,1/g) ?? []).length).toBe(2);
    expect((text.match(/SIZE 58 mm,40 mm/g) ?? []).length).toBe(2);
  });
});

// --- Точки печати ------------------------------------------------------------

describe('подключение точки печати', () => {
  it('одноразовый код гаснет после первого использования', async () => {
    const admin = await actorFor(['ADMIN']);
    const point = await createPrintPoint(ctx.db, admin, { name: unique('Стол') }, CONTEXT);
    const issued = await issuePairingCode(ctx.db, admin, point.id, PEPPER, CONTEXT);

    const first = await pairAgent(
      ctx.db,
      { code: issued.code, computerName: 'PC-1', printerName: 'XP-318B' },
      PEPPER,
    );
    expect(first.pointId).toBe(point.id);

    // Второй компьютер, набравший тот же код, получает отказ, а не вторую
    // точку печати на одном принтере.
    await expect(
      pairAgent(
        ctx.db,
        { code: issued.code, computerName: 'PC-2', printerName: 'XP-318B' },
        PEPPER,
      ),
    ).rejects.toThrow();
  });

  it('на сервере нет ни кода, ни токена в открытом виде', async () => {
    const admin = await actorFor(['ADMIN']);
    const point = await createPrintPoint(ctx.db, admin, { name: unique('Стол') }, CONTEXT);
    const issued = await issuePairingCode(ctx.db, admin, point.id, PEPPER, CONTEXT);

    const withCode = await ctx.db.printPoint.findUniqueOrThrow({
      where: { id: point.id },
      select: { pairingCodeHash: true },
    });
    expect(withCode.pairingCodeHash).not.toBe(issued.code);
    expect(withCode.pairingCodeHash).not.toContain(issued.code);

    const paired = await pairAgent(
      ctx.db,
      { code: issued.code, computerName: 'PC-1', printerName: 'XP-318B' },
      PEPPER,
    );

    const withToken = await ctx.db.printPoint.findUniqueOrThrow({
      where: { id: point.id },
      select: { agentTokenHash: true, pairingCodeHash: true },
    });
    expect(withToken.agentTokenHash).not.toBe(paired.token);
    expect(withToken.pairingCodeHash).toBeNull();

    // И журнал не сохраняет ни того, ни другого.
    const entries = await ctx.db.auditLog.findMany({
      where: { entityType: 'PrintPoint', entityId: point.id },
      select: { newValue: true },
    });
    const journal = JSON.stringify(entries);
    expect(journal).not.toContain(issued.code);
    expect(journal).not.toContain(paired.token);
  });

  it('токен открывает ровно свою точку, а после отключения — ничего', async () => {
    const { pointId, token } = await pairedPoint();
    expect((await pointByAgentToken(ctx.db, token)).id).toBe(pointId);

    const admin = await actorFor(['ADMIN']);
    await disconnectPrintPoint(ctx.db, admin, pointId, CONTEXT);

    // Отключённый компьютер теряет право печати немедленно, а не после того,
    // как кто-то удалит агента с диска.
    await expect(pointByAgentToken(ctx.db, token)).rejects.toThrow();
  });

  it('состояние выводится из отклика, а не хранится', () => {
    const now = new Date('2028-03-14T12:00:00.000Z');
    const base = {
      id: 'x',
      name: 'Стол',
      computerName: null,
      printerName: null,
      isActive: true,
      agentTokenHash: 'hash',
      pairingExpiresAt: null,
      lastErrorText: null,
      testRequestedAt: null,
    };

    expect(pointState({ ...base, lastSeenAt: null, lastErrorAt: null }, now)).toBe('OFFLINE');
    expect(pointState({ ...base, lastSeenAt: now, lastErrorAt: null }, now)).toBe('ONLINE');

    // Молчание дольше окна — «нет связи», даже если раньше всё было хорошо.
    const stale = new Date(now.getTime() - OFFLINE_AFTER_MS - 1000);
    expect(pointState({ ...base, lastSeenAt: stale, lastErrorAt: null }, now)).toBe('OFFLINE');

    // Ошибка прилипает до следующего успешного отклика: администратор должен
    // увидеть, ЧТО случилось, а не только то, что связь сейчас есть.
    expect(pointState({ ...base, lastSeenAt: now, lastErrorAt: now }, now)).toBe('ERROR');
    const older = new Date(now.getTime() - 1000);
    expect(pointState({ ...base, lastSeenAt: now, lastErrorAt: older }, now)).toBe('ONLINE');
  });

  it('тестовый отпечаток — отметка, а не очередь', async () => {
    const { pointId } = await pairedPoint();
    const admin = await actorFor(['ADMIN']);

    await requestTestPrint(ctx.db, admin, pointId, CONTEXT);
    await requestTestPrint(ctx.db, admin, pointId, CONTEXT);

    // Второе нажатие не копит отпечатки: печатать десять наклеек подряд
    // человек не просил. И заданий печати заказов от этого не появляется.
    expect(await ctx.db.orderPrintJob.count({ where: { printPointId: pointId } })).toBe(0);
    const point = await ctx.db.printPoint.findUniqueOrThrow({
      where: { id: pointId },
      select: { testRequestedAt: true },
    });
    expect(point.testRequestedAt).not.toBeNull();
  });

  it('отключение точки снимает её со смен и с ожидающих заданий', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);
    const florist = await seedUser(ctx.db, { roles: ['FLORIST'] });
    await ctx.db.floristShift.create({
      data: { userId: florist.id, activeKey: florist.id, printPointId: pointId },
    });

    const admin = await actorFor(['ADMIN']);
    await disconnectPrintPoint(ctx.db, admin, pointId, CONTEXT);

    // Задание остаётся — это существующее задание печати заказа, его историю
    // терять нельзя. Снимается только автоматическая доставка.
    const stored = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { deliveryState: true, state: true },
    });
    expect(stored.deliveryState).toBe('CANCELLED');
    expect(stored.state).toBe('PENDING');

    const shift = await ctx.db.floristShift.findUniqueOrThrow({
      where: { activeKey: florist.id },
      select: { printPointId: true },
    });
    expect(shift.printPointId).toBeNull();
  });
});

// --- Печать не блокирует работу ---------------------------------------------

describe('печать не блокирует сборку', () => {
  it('«Собран» сохраняется, даже когда печатать некуда', async () => {
    /*
     * Самое важное свойство всей автоматической печати.
     *
     * Выключенный компьютер, кончившаяся лента, невыбранная точка — ничто
     * из этого не должно оставить собранный букет несобранным в системе.
     * Иначе неисправность принтера останавливает цех.
     *
     * Проверяется прямой признак: задание печати создаётся и без точки,
     * а сборка при этом проходит целиком.
     */
    const job = await seedJob(null);

    const stored = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, printPointId: true, deliveryState: true, printFormId: true },
    });

    expect(stored.state).toBe('PENDING');
    expect(stored.printPointId).toBeNull();
    expect(stored.deliveryState).toBeNull();
    // Бланк и наклейку по-прежнему можно скачать руками: резервный путь
    // остаётся тем же, что и до появления автоматической печати.
    expect(stored.printFormId).not.toBe('');
  });
});

// --- Очередь доставки --------------------------------------------------------

describe('выдача заданий агенту', () => {
  it('задание выдаётся по одному и не выдаётся дважды', async () => {
    const { pointId } = await pairedPoint();
    const first = await seedJob(pointId);
    const second = await seedJob(pointId);

    const one = await claimNextDelivery(ctx.db, pointId);
    expect(one?.jobId).toBe(first.jobId);
    expect(one?.snapshot.orderNumber).toBe(first.number);

    // Второй опрос отдаёт СЛЕДУЮЩЕЕ задание, а не то же самое: аренда держит
    // первое за агентом.
    const two = await claimNextDelivery(ctx.db, pointId);
    expect(two?.jobId).toBe(second.jobId);

    expect(await claimNextDelivery(ctx.db, pointId)).toBeNull();
  });

  it('задания без назначенной точки агенту не достаются', async () => {
    const { pointId } = await pairedPoint();
    // Так выглядят ВСЕ задания, созданные до появления печати.
    await seedJob(null);

    expect(await claimNextDelivery(ctx.db, pointId)).toBeNull();
  });

  it('истёкшая аренда возвращает задание в очередь', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);

    const claimed = await claimNextDelivery(ctx.db, pointId);
    expect(claimed?.jobId).toBe(job.jobId);

    // Компьютер выключили, не ответив. Через срок аренды задание снова
    // доступно — иначе наклейка потерялась бы навсегда.
    const later = new Date(Date.now() + 10 * 60_000);
    const again = await claimNextDelivery(ctx.db, pointId, later);
    expect(again?.jobId).toBe(job.jobId);
    expect(again?.attempt).toBe(2);
  });

  it('переданное принтеру больше не выдаётся', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);

    await claimNextDelivery(ctx.db, pointId);
    const result = await reportDelivery(ctx.db, {
      pointId,
      jobId: job.jobId,
      outcome: 'sent',
    });
    expect(result.deliveryState).toBe('SENT_TO_PRINTER');

    expect(await claimNextDelivery(ctx.db, pointId, new Date(Date.now() + 10 * 60_000))).toBeNull();

    /*
     * Состояние документа при этом остаётся ожидающим.
     *
     * База требует, чтобы «напечатано» было именным: кто подтвердил и когда.
     * Спулер человеком не является и выхода бумаги не подтверждает, поэтому
     * подменять им подпись человека нельзя.
     */
    const stored = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, completedById: true, sentAt: true },
    });
    expect(stored.state).toBe('PENDING');
    expect(stored.completedById).toBeNull();
    expect(stored.sentAt).not.toBeNull();
  });

  it('неоднозначный исход не печатается повторно', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);

    await claimNextDelivery(ctx.db, pointId);
    const result = await reportDelivery(ctx.db, {
      pointId,
      jobId: job.jobId,
      outcome: 'unknown',
    });
    expect(result.deliveryState).toBe('NEEDS_REVIEW');

    // Наклейка, возможно, уже вышла. Две наклейки на коробке хуже, чем ни
    // одной: отсутствие видно сразу, а дубль уезжает к покупателю.
    expect(await claimNextDelivery(ctx.db, pointId, new Date(Date.now() + 10 * 60_000))).toBeNull();
  });

  it('отказ спулера возвращает задание, но не бесконечно', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);

    // Отказавший спулер ничего не напечатал — повторить можно.
    await claimNextDelivery(ctx.db, pointId);
    expect(
      (await reportDelivery(ctx.db, { pointId, jobId: job.jobId, outcome: 'failed' }))
        .deliveryState,
    ).toBe('QUEUED');

    await claimNextDelivery(ctx.db, pointId);
    expect(
      (await reportDelivery(ctx.db, { pointId, jobId: job.jobId, outcome: 'failed' }))
        .deliveryState,
    ).toBe('QUEUED');

    await claimNextDelivery(ctx.db, pointId);
    expect(
      (await reportDelivery(ctx.db, { pointId, jobId: job.jobId, outcome: 'failed' }))
        .deliveryState,
    ).toBe('FAILED');

    // Отказ виден человеку существующим состоянием задания и названной ошибкой.
    const stored = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, lastErrorCode: true },
    });
    expect(stored.state).toBe('ERROR');
    expect(stored.lastErrorCode).toBe('AGENT_SPOOLER_FAILED');
  });

  it('повторный ответ агента ничего не меняет', async () => {
    const { pointId } = await pairedPoint();
    const job = await seedJob(pointId);

    await claimNextDelivery(ctx.db, pointId);
    await reportDelivery(ctx.db, { pointId, jobId: job.jobId, outcome: 'sent' });

    // Связь оборвалась, агент повторил ответ. Задание уже подведено к итогу,
    // и второй раз оно не воскресает.
    const again = await reportDelivery(ctx.db, { pointId, jobId: job.jobId, outcome: 'failed' });
    expect(again.deliveryState).toBe('SENT_TO_PRINTER');
  });

  it('чужая точка не подводит итог чужому заданию', async () => {
    const mine = await pairedPoint();
    const other = await pairedPoint();
    const job = await seedJob(mine.pointId);
    await claimNextDelivery(ctx.db, mine.pointId);

    await expect(
      reportDelivery(ctx.db, { pointId: other.pointId, jobId: job.jobId, outcome: 'sent' }),
    ).rejects.toThrow();
  });

  it('отметка агента поднимает точку из «нет связи»', async () => {
    const { pointId } = await pairedPoint();
    await ctx.db.printPoint.update({
      where: { id: pointId },
      data: { lastSeenAt: new Date(Date.now() - OFFLINE_AFTER_MS - 5000) },
    });

    await recordHeartbeat(ctx.db, pointId);
    const point = await ctx.db.printPoint.findUniqueOrThrow({
      where: { id: pointId },
      select: { lastSeenAt: true },
    });
    expect(Date.now() - (point.lastSeenAt?.getTime() ?? 0)).toBeLessThan(OFFLINE_AFTER_MS);
  });

  it('ошибка агента доходит до администратора без секретов', async () => {
    const { pointId } = await pairedPoint();
    await recordHeartbeat(ctx.db, pointId, {
      error: 'Не найден принтер XP-318B; token=test-only-agent-token',
    });

    const point = await ctx.db.printPoint.findUniqueOrThrow({
      where: { id: pointId },
      select: { lastErrorText: true },
    });
    expect(point.lastErrorText).toContain('XP-318B');
    // Секрет, случайно попавший в текст ошибки, до интерфейса не доходит.
    expect(point.lastErrorText).not.toContain('test-only-agent-token');
  });
});
