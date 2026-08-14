/**
 * Критические проверки локального обработчика печати (`FUL-006`).
 *
 * Проверяется не «работает ли привязка», а то, нарушение чего означает
 * испорченный заказ или открытую дверь:
 *
 *  * код привязки одноразовый, живёт минуты и не переживает повторный обмен;
 *  * при одновременном обмене выигрывает ровно один — второй не получает
 *    ни устройства, ни токена;
 *  * перебор кода останавливается базой, а не добрым намерением клиента;
 *  * открытый токен и открытый код в базе не хранятся вовсе;
 *  * два контура не пересекаются: пользовательский JWT не работает как токен
 *    устройства, токен устройства не работает как пользовательский доступ;
 *  * отозванное устройство теряет доступ в тот же миг;
 *  * основной обработчик ровно один, и это держит БАЗА — уникальный индекс
 *    и CHECK, а не проверка в коде;
 *  * два обработчика не забирают одно задание;
 *  * повторное нажатие не создаёт второй бланк;
 *  * зависшее `PRINTING` НЕ печатается повторно автоматически;
 *  * существующая ручная печать и отметка «Напечатано» не сломаны.
 *
 * Инварианты проверяются и через сервис, и напрямую в базе: правило, которое
 * держится только кодом, однажды обойдут скриптом или консолью.
 *
 * ДАТ ДОСТАВКИ ЗДЕСЬ НЕТ. Заказы создаются с `deliveryDate: null`: этому файлу
 * календарь не нужен вовсе, и бронировать месяц в общей базе
 * (`platform/testing/test-days.ts`) незачем.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@fl/shared';
import {
  closeTestContext,
  createTestContext,
  seedUser,
  type TestContext,
} from '../auth/testing/harness.js';
import { TEST_SECRETS } from '../../platform/testing/secrets.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { AppError } from '../../platform/errors.js';
import {
  DEVICE_TOKEN_PREFIX,
  generatePairingCode,
  hashDeviceToken,
  isValidPairingCode,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
} from './crypto.js';
import { authenticateDevice } from './guard.js';
import { issuePairingCode, redeemPairingCode } from './pairing.js';
import { listDevices, revokeDevice, setPrimaryDevice, PRIMARY_SENTINEL } from './devices.js';
import {
  claimNextJob,
  createTestPrintJob,
  reportPrinting,
  reportResult,
  sweepStaleJobs,
  PRINTING_STALE_AFTER_MS,
  CLAIMED_STALE_AFTER_MS,
} from './queue.js';
import { cancelPrint, listPrintJobs, markPrinted, retryPrint } from '../fulfillment/print.js';
import { PRINT_TEMPLATE_VERSION, type PrintFormSnapshot } from '../fulfillment/print-form.js';

const CONTEXT = { ip: '10.0.0.1', userAgent: 'vitest' };

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await closeTestContext(ctx);
});

let sequence = 0;
function uniqueNumber(): string {
  sequence += 1;
  return `PA-${process.hrtime.bigint() % 1_000_000n}-${sequence}`;
}

async function actorFor(roles: Role[]): Promise<AuthenticatedActor> {
  const user = await seedUser(ctx.db, { roles });
  return {
    userId: user.id,
    roles,
    familyId: '00000000-0000-4000-8000-0000000000a1',
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
  headers: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST',
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

/**
 * Заказ с бланком и заданием печати.
 *
 * Создаётся напрямую в базе: этот файл проверяет очередь и обработчика,
 * а не путь сборки — он доказан в `florist.critical.test.ts`.
 */
async function seedPrintJob(): Promise<{ orderId: string; jobId: string; number: string }> {
  const number = uniqueNumber();

  const order = await ctx.db.deliveryOrder.create({
    data: {
      externalId: randomUUID(),
      externalName: number,
      externalUpdated: new Date(),
      deliveryDate: null,
      fulfillmentInScope: true,
    },
    select: { id: true },
  });

  const revision = await ctx.db.orderFulfillmentRevision.create({
    data: {
      orderId: order.id,
      externalUpdated: new Date(),
      snapshot: {},
      snapshotHash: `hash-${number}`,
      changedFields: [],
      reason: 'INITIAL_IMPORT',
    },
    select: { id: true },
  });

  const snapshot: PrintFormSnapshot = {
    orderNumber: number,
    deliveryDate: null,
    intervalStartMinute: null,
    intervalEndMinute: null,
    cardText: null,
    description: null,
    positions: [],
  };

  const form = await ctx.db.orderPrintForm.create({
    data: {
      orderId: order.id,
      revisionId: revision.id,
      templateVersion: PRINT_TEMPLATE_VERSION,
      snapshot: snapshot as unknown as object,
      snapshotHash: `form-${number}`,
    },
    select: { id: true },
  });

  const job = await ctx.db.orderPrintJob.create({
    data: {
      orderId: order.id,
      printFormId: form.id,
      attempt: 1,
      state: 'PENDING',
      documentKind: 'ORDER_FORM',
    },
    select: { id: true },
  });

  return { orderId: order.id, jobId: job.id, number };
}

/**
 * Привязывает устройство и возвращает его открытый токен.
 *
 * Ходит настоящим путём — выпуск кода администратором, обмен кода на токен, —
 * потому что именно этот путь и проверяется. Подстановка строки в базу
 * доказывала бы работоспособность подстановки.
 */
async function pairDevice(
  name: string,
): Promise<{ deviceId: string; token: string; isPrimary: boolean }> {
  const admin = await actorFor(['ADMIN']);
  const issued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

  const result = await redeemPairingCode(
    ctx.db,
    ctx.config,
    {
      code: issued.code,
      deviceName: name,
      os: 'Windows 11',
      agentVersion: '1.0.0',
      defaultPrinterName: 'HP LaserJet',
    },
    CONTEXT,
  );

  return { deviceId: result.deviceId, token: result.token, isPrimary: result.isPrimary };
}

/** Снимает блокировки перебора, накопленные предыдущими проверками. */
async function clearLockouts(): Promise<void> {
  await ctx.db.authLockout.deleteMany({ where: { key: { startsWith: 'print-pair:' } } });
}

/** Убирает основной признак у всех устройств: часть проверок начинается с нуля. */
async function clearPrimary(): Promise<void> {
  await ctx.db.printAgentDevice.updateMany({
    where: { primaryKey: { not: null } },
    data: { primaryKey: null },
  });
}

describe('код привязки', () => {
  it('имеет заявленную форму и не содержит неоднозначных знаков', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(isValidPairingCode(code)).toBe(true);
      // Ноль, единица и буквы I, L, O, U исключены: код переносят руками
      // с экрана на другую машину, и «ноль или буква O» — это провалившаяся
      // привязка, а не теоретическая придирка.
      expect(code).not.toMatch(/[01ILOU]/u);
    }
  });

  it('дефис и регистр — это ввод, а не другой код', () => {
    const code = generatePairingCode();
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(normalizePairingCode(typed)).toBe(code);
    // Неоднозначные знаки НЕ исправляются: такое «исправление» вдвое сузило бы
    // пространство кодов, а ошибку ввода честнее показать отказом.
    expect(normalizePairingCode('0AAAAAAA')).toBe('0AAAAAAA');
    expect(isValidPairingCode('0AAAAAAA')).toBe(false);
  });

  it('в базе лежит только хеш: открытый код не восстановим', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    const issued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    const rows = await ctx.db.printAgentPairingCode.findMany({
      select: { codeHash: true },
    });

    for (const row of rows) {
      expect(row.codeHash).not.toContain(issued.code);
      // Argon2id, а не быстрый хеш: код короткий и вводится человеком.
      expect(row.codeHash.startsWith('$argon2id$')).toBe(true);
    }

    // И в журнале кода тоже нет: журнал не должен быть местом, где код
    // можно прочитать после выдачи.
    const entries = await ctx.db.auditLog.findMany({
      where: { action: 'PRINT_AGENT_PAIRING_CODE_ISSUED' },
      select: { newValue: true },
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(JSON.stringify(entry.newValue ?? {})).not.toContain(issued.code);
    }
  });

  it('активный код один на всю систему: новый выпуск гасит прежний', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);

    const first = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);
    const second = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    const active = await ctx.db.printAgentPairingCode.count({
      where: { activeKey: { not: null } },
    });
    expect(active).toBe(1);

    // Прежний листок бумаги больше ничего не даёт.
    await expect(
      redeemPairingCode(
        ctx.db,
        ctx.config,
        { code: first.code, deviceName: 'Старый', os: null, agentVersion: null, defaultPrinterName: null },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(AppError);

    await clearLockouts();
    const paired = await redeemPairingCode(
      ctx.db,
      ctx.config,
      { code: second.code, deviceName: 'Новый', os: null, agentVersion: null, defaultPrinterName: null },
      CONTEXT,
    );
    expect(paired.deviceId).toBeTruthy();
  });

  it('истёкший код не подходит', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    const issued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    // Срок сдвигается в прошлое: ждать десять минут в тесте нельзя, а проверять
    // «через десять минут не сработает» подменой системных часов — значит
    // проверять часы, а не код.
    await ctx.db.printAgentPairingCode.updateMany({
      where: { activeKey: { not: null } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      redeemPairingCode(
        ctx.db,
        ctx.config,
        { code: issued.code, deviceName: 'Опоздавший', os: null, agentVersion: null, defaultPrinterName: null },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('погашенный код второй раз не работает', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    const issued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    const first = await redeemPairingCode(
      ctx.db,
      ctx.config,
      { code: issued.code, deviceName: 'Первый', os: null, agentVersion: null, defaultPrinterName: null },
      CONTEXT,
    );
    expect(first.token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);

    await clearLockouts();
    await expect(
      redeemPairingCode(
        ctx.db,
        ctx.config,
        { code: issued.code, deviceName: 'Второй', os: null, agentVersion: null, defaultPrinterName: null },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('при одновременном обмене выигрывает ровно один', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    const issued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    const before = await ctx.db.printAgentDevice.count();

    const attempts = await Promise.allSettled(
      ['Гонка A', 'Гонка B', 'Гонка C'].map((name) =>
        redeemPairingCode(
          ctx.db,
          ctx.config,
          { code: issued.code, deviceName: name, os: null, agentVersion: null, defaultPrinterName: null },
          CONTEXT,
        ),
      ),
    );

    const winners = attempts.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);

    // Проигравшие не оставили за собой НИЧЕГО: ни устройства, ни токена.
    // Транзакция откатывается целиком, а не частично.
    const after = await ctx.db.printAgentDevice.count();
    expect(after).toBe(before + 1);
  });

  it('перебор останавливается базой, и блокировка бьёт по перебиравшему', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    const attacker = { ip: '203.0.113.7', userAgent: 'vitest' };
    const workstation = { ip: '10.0.0.55', userAgent: 'vitest' };

    // Заведомо неверный код правильной формы: проверяется защита от подбора,
    // а не разбор мусора.
    const wrong = 'ZZZZZZZZ';
    let locked = false;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await redeemPairingCode(
          ctx.db,
          ctx.config,
          { code: wrong, deviceName: 'Перебор', os: null, agentVersion: null, defaultPrinterName: null },
          attacker,
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'RATE_LIMITED') {
          locked = true;
          break;
        }
      }
    }

    expect(locked).toBe(true);

    // Общий счётчик защищает КОНКРЕТНЫЙ секрет: попытки против отменённого
    // кода к новому отношения не имеют, и выпуск нового кода их сбрасывает.
    // Иначе посторонний мог бы навсегда запретить привязку чужими попытками.
    const reissued = await issuePairingCode(ctx.db, ctx.config, admin, CONTEXT);

    // Настоящее рабочее место привязывается: оно ничего не перебирало.
    const paired = await redeemPairingCode(
      ctx.db,
      ctx.config,
      { code: reissued.code, deviceName: 'Рабочее место', os: null, agentVersion: null, defaultPrinterName: null },
      workstation,
    );
    expect(paired.deviceId).toBeTruthy();

    // А перебиравший адрес остаётся заблокированным: сброс общего счётчика
    // не прощает того, кто подбирал.
    await expect(
      redeemPairingCode(
        ctx.db,
        ctx.config,
        { code: wrong, deviceName: 'Перебор', os: null, agentVersion: null, defaultPrinterName: null },
        attacker,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('токен устройства', () => {
  it('в базе лежит только SHA-256: открытый токен не хранится', async () => {
    await clearLockouts();
    const paired = await pairDevice('Хранение токена');

    const row = await ctx.db.printAgentDevice.findUniqueOrThrow({
      where: { id: paired.deviceId },
      select: { tokenHash: true },
    });

    expect(row.tokenHash).toBe(hashDeviceToken(paired.token));
    expect(row.tokenHash).not.toContain(paired.token);
    // Хеш, а не токен: 64 знака шестнадцатеричного SHA-256.
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/u);

    // Ни одна строка таблицы не содержит открытого токена ни в каком поле.
    const all = await ctx.db.printAgentDevice.findMany();
    expect(JSON.stringify(all)).not.toContain(paired.token);
  });

  it('пользовательский JWT не является токеном устройства', async () => {
    await clearLockouts();
    await pairDevice('Разделение контуров');
    const userToken = await tokenFor(['ADMIN']);

    // Настоящий, действующий пользовательский доступ — и он не открывает
    // машинный контур. Специальной проверки «а не JWT ли это» в охране нет
    // намеренно: его SHA-256 просто не встретится среди устройств.
    const response = await call('POST', '/api/print-agent/jobs/claim', userToken);
    expect(response.statusCode).toBe(401);

    await expect(
      authenticateDevice({ headers: { authorization: `Bearer ${userToken}` } }, { db: ctx.db }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('токен устройства не является пользовательским доступом', async () => {
    await clearLockouts();
    const paired = await pairDevice('Обратное направление');

    // Пользовательские маршруты разных контуров: производственный и настройки.
    for (const url of [
      '/api/florist/print-jobs?filter=attention',
      '/api/settings/print/devices',
      '/api/users',
    ]) {
      const response = await call('GET', url, paired.token);
      expect(response.statusCode).toBe(401);
    }
  });

  it('отозванное устройство теряет доступ немедленно', async () => {
    await clearLockouts();
    const admin = await actorFor(['ADMIN']);
    const paired = await pairDevice('Отзыв');

    // До отзыва токен работает.
    const before = await authenticateDevice(
      { headers: { authorization: `Bearer ${paired.token}` } },
      { db: ctx.db },
    );
    expect(before.deviceId).toBe(paired.deviceId);

    await revokeDevice(ctx.db, admin, paired.deviceId, CONTEXT);

    // Состояние перечитывается при каждом запросе, а не кешируется: отзыв
    // действует в тот же миг, а не когда истечёт какой-нибудь срок.
    await expect(
      authenticateDevice({ headers: { authorization: `Bearer ${paired.token}` } }, { db: ctx.db }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    const claim = await call('POST', '/api/print-agent/jobs/claim', paired.token);
    expect(claim.statusCode).toBe(401);
  });

  it('отзыв возвращает взятое в очередь и отправляет печатавшееся человеку', async () => {
    await clearLockouts();
    await clearPrimary();
    const admin = await actorFor(['ADMIN']);
    const paired = await pairDevice('Отзыв с заданиями');
    await setPrimaryDevice(ctx.db, admin, paired.deviceId, CONTEXT);

    const claimedJob = await seedPrintJob();
    const printingJob = await seedPrintJob();

    await ctx.db.orderPrintJob.update({
      where: { id: claimedJob.jobId },
      data: { state: 'CLAIMED', deviceId: paired.deviceId, claimedAt: new Date() },
    });
    await ctx.db.orderPrintJob.update({
      where: { id: printingJob.jobId },
      data: {
        state: 'PRINTING',
        deviceId: paired.deviceId,
        claimedAt: new Date(),
        printingAt: new Date(),
      },
    });

    await revokeDevice(ctx.db, admin, paired.deviceId, CONTEXT);

    // Взятое, но не отправленное на печать — точно не печаталось.
    const requeued = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: claimedJob.jobId },
      select: { state: true, deviceId: true },
    });
    expect(requeued.state).toBe('PENDING');
    expect(requeued.deviceId).toBeNull();

    // Отправленное — неоднозначно, и решает человек.
    const ambiguous = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: printingJob.jobId },
      select: { state: true, lastErrorCode: true },
    });
    expect(ambiguous.state).toBe('NEEDS_REVIEW');
    expect(ambiguous.lastErrorCode).toBe('DEVICE_REVOKED');
  });
});

describe('основной обработчик', () => {
  it('первое привязанное устройство становится основным, следующее — нет', async () => {
    await clearLockouts();
    await clearPrimary();
    // Все ранее привязанные устройства отозваны или лишены признака: система
    // начинает эту проверку без основного обработчика.
    const first = await pairDevice('Первый компьютер');
    expect(first.isPrimary).toBe(true);

    await clearLockouts();
    const second = await pairDevice('Второй компьютер');
    // Система, где привязан один компьютер и он ничего не печатает, потому что
    // «основной не назначен», — это лишний шаг, о котором никто не догадается.
    // А вот второй компьютер основным сам не становится.
    expect(second.isPrimary).toBe(false);
  });

  it('основной ровно один, и это держит база, а не проверка в коде', async () => {
    await clearLockouts();
    await clearPrimary();
    const admin = await actorFor(['ADMIN']);
    const first = await pairDevice('Основной A');
    await clearLockouts();
    const second = await pairDevice('Основной B');

    await setPrimaryDevice(ctx.db, admin, second.deviceId, CONTEXT);

    const primaries = await ctx.db.printAgentDevice.count({ where: { primaryKey: { not: null } } });
    expect(primaries).toBe(1);

    // Обход кода: прямая запись в базу, как это сделал бы скрипт или консоль.
    // Уникальный индекс не даёт появиться второму основному.
    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "PrintAgentDevice" SET "primaryKey" = '${PRIMARY_SENTINEL}' WHERE "id" = '${first.deviceId}'::uuid`,
      ),
    ).rejects.toThrow();

    // И произвольное значение тоже: CHECK разрешает только сам признак.
    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "PrintAgentDevice" SET "primaryKey" = 'SOMETHING_ELSE' WHERE "id" = '${first.deviceId}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('отозванное устройство не может быть основным — и это тоже держит база', async () => {
    await clearLockouts();
    await clearPrimary();
    const admin = await actorFor(['ADMIN']);
    const paired = await pairDevice('Отзываемый основной');
    await setPrimaryDevice(ctx.db, admin, paired.deviceId, CONTEXT);

    await revokeDevice(ctx.db, admin, paired.deviceId, CONTEXT);

    const row = await ctx.db.printAgentDevice.findUniqueOrThrow({
      where: { id: paired.deviceId },
      select: { primaryKey: true, state: true },
    });
    expect(row.state).toBe('REVOKED');
    expect(row.primaryKey).toBeNull();

    // Сервис отказывает понятно...
    await expect(setPrimaryDevice(ctx.db, admin, paired.deviceId, CONTEXT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // ...а база не пускает и в обход сервиса.
    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "PrintAgentDevice" SET "primaryKey" = '${PRIMARY_SENTINEL}' WHERE "id" = '${paired.deviceId}'::uuid`,
      ),
    ).rejects.toThrow();
  });

  it('новые задания получает только основной обработчик', async () => {
    await clearLockouts();
    await clearPrimary();
    const admin = await actorFor(['ADMIN']);
    const primary = await pairDevice('Основной получатель');
    await clearLockouts();
    const spare = await pairDevice('Запасной');
    await setPrimaryDevice(ctx.db, admin, primary.deviceId, CONTEXT);

    await seedPrintJob();

    // Запасной получает пустой ответ, а НЕ отказ: он привязан законно и просто
    // ждёт своей роли. Ошибка в его журнале была бы шумом, а не сигналом.
    const spareResponse = await call('POST', '/api/print-agent/jobs/claim', spare.token);
    expect(spareResponse.statusCode).toBe(200);
    expect((spareResponse.json() as { job: unknown }).job).toBeNull();

    const primaryResponse = await call('POST', '/api/print-agent/jobs/claim', primary.token);
    expect(primaryResponse.statusCode).toBe(200);
    expect((primaryResponse.json() as { job: unknown }).job).not.toBeNull();
  });
});

describe('очередь заданий', () => {
  it('два обработчика не забирают одно задание', async () => {
    await clearLockouts();
    await clearPrimary();
    const alpha = await pairDevice('Гонка захвата A');
    await clearLockouts();
    const beta = await pairDevice('Гонка захвата B');

    // Ровно одно свободное задание на двоих. Всё, что было в очереди раньше,
    // уводится из состояния PENDING: иначе оба обработчика честно получили бы
    // по заданию и гонка не воспроизвелась бы.
    await ctx.db.orderPrintJob.updateMany({
      where: { state: 'PENDING' },
      data: { state: 'CANCELLED', cancelledAt: new Date() },
    });
    const job = await seedPrintJob();

    const [first, second] = await Promise.all([
      claimNextJob(ctx.db, alpha.deviceId),
      claimNextJob(ctx.db, beta.deviceId),
    ]);

    const claimed = [first, second].filter((result) => result !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.jobId).toBe(job.jobId);

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, deviceId: true },
    });
    expect(row.state).toBe('CLAIMED');
    expect([alpha.deviceId, beta.deviceId]).toContain(row.deviceId);
  });

  it('исход печати идемпотентен: повтор после потери сети не ломает результат', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Потеря сети');
    const device = { deviceId: paired.deviceId, name: 'Потеря сети', isPrimary: true };
    const job = await seedPrintJob();

    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: { state: 'CLAIMED', deviceId: paired.deviceId, claimedAt: new Date() },
    });

    await reportPrinting(ctx.db, device, job.jobId);
    const first = await reportResult(
      ctx.db,
      device,
      job.jobId,
      { outcome: 'printed', errorCode: null, defaultPrinterName: 'HP LaserJet' },
      CONTEXT,
    );
    expect(first.state).toBe('PRINTED');

    // Обработчик не знает, дошёл ли предыдущий отчёт, и повторяет его.
    // Он обязан получить успех: конфликт заставил бы его либо счесть
    // напечатанное неудачей, либо напечатать заново.
    const repeated = await reportResult(
      ctx.db,
      device,
      job.jobId,
      { outcome: 'printed', errorCode: null, defaultPrinterName: 'HP LaserJet' },
      CONTEXT,
    );
    expect(repeated.state).toBe('PRINTED');

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, completedById: true },
    });
    // Автор — компьютер, а не человек: ручная отметка остаётся отличима.
    expect(row.state).toBe('PRINTED');
    expect(row.completedById).toBeNull();
  });

  it('однозначный отказ даёт ERROR, неоднозначный — NEEDS_REVIEW', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Разбор исходов');
    const device = { deviceId: paired.deviceId, name: 'Разбор исходов', isPrimary: true };

    // Принтер выключен: документ до него не дошёл. Повторять безопасно.
    const offline = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: offline.jobId },
      data: { state: 'CLAIMED', deviceId: paired.deviceId, claimedAt: new Date() },
    });
    const offlineResult = await reportResult(
      ctx.db,
      device,
      offline.jobId,
      { outcome: 'failed', errorCode: 'PRINTER_OFFLINE', defaultPrinterName: null },
      CONTEXT,
    );
    expect(offlineResult.state).toBe('ERROR');

    // Драйвер принял документ и отказал: часть страницы могла уже выйти.
    const driver = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: driver.jobId },
      data: { state: 'PRINTING', deviceId: paired.deviceId, printingAt: new Date() },
    });
    const driverResult = await reportResult(
      ctx.db,
      device,
      driver.jobId,
      { outcome: 'failed', errorCode: 'PRINTER_ERROR', defaultPrinterName: null },
      CONTEXT,
    );
    expect(driverResult.state).toBe('NEEDS_REVIEW');

    // Понятный текст выбирает СЕРВЕР по коду: строка с чужой машины могла бы
    // принести путь к файлу или имя пользователя Windows.
    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: offline.jobId },
      select: { lastErrorCode: true, lastErrorMessage: true },
    });
    expect(row.lastErrorCode).toBe('PRINTER_OFFLINE');
    expect(row.lastErrorMessage).toContain('Принтер не отвечает');
  });

  it('неизвестный код отказа не роняет подтверждение, а становится UNKNOWN', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Обработчик из будущего');
    const device = { deviceId: paired.deviceId, name: 'Обработчик из будущего', isPrimary: true };
    const job = await seedPrintJob();

    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: { state: 'CLAIMED', deviceId: paired.deviceId, claimedAt: new Date() },
    });

    await reportResult(
      ctx.db,
      device,
      job.jobId,
      { outcome: 'failed', errorCode: 'НЕЧТО_НЕИЗВЕСТНОЕ', defaultPrinterName: null },
      CONTEXT,
    );

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { lastErrorCode: true },
    });
    expect(row.lastErrorCode).toBe('UNKNOWN');
  });

  it('зависшее PRINTING уходит человеку и НЕ печатается повторно автоматически', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Зависший');
    const job = await seedPrintJob();

    // Принтер принял документ, обработчик закрылся до подтверждения.
    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: {
        state: 'PRINTING',
        deviceId: paired.deviceId,
        claimedAt: new Date(Date.now() - PRINTING_STALE_AFTER_MS - 60_000),
        printingAt: new Date(Date.now() - PRINTING_STALE_AFTER_MS - 60_000),
      },
    });

    const swept = await sweepStaleJobs(ctx.db);
    expect(swept.needsReview).toBeGreaterThanOrEqual(1);

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, lastErrorCode: true },
    });
    // Именно к человеку, а НЕ обратно в очередь: автоматический повтор здесь
    // означал бы второй бланк к тому же букету.
    expect(row.state).toBe('NEEDS_REVIEW');
    expect(row.lastErrorCode).toBe('PRINTING_TIMED_OUT');

    // И следующий опрос очереди его не выдаёт.
    const next = await claimNextJob(ctx.db, paired.deviceId);
    expect(next?.jobId).not.toBe(job.jobId);
  });

  it('зависшее CLAIMED возвращается в очередь: принтер документа не видел', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Взял и умолк');
    const job = await seedPrintJob();

    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: {
        state: 'CLAIMED',
        deviceId: paired.deviceId,
        claimedAt: new Date(Date.now() - CLAIMED_STALE_AFTER_MS - 60_000),
      },
    });

    await sweepStaleJobs(ctx.db);

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { state: true, deviceId: true },
    });
    expect(row.state).toBe('PENDING');
    expect(row.deviceId).toBeNull();
  });

  it('чужое задание обработчику не выдаётся и неотличимо от несуществующего', async () => {
    await clearLockouts();
    await clearPrimary();
    const owner = await pairDevice('Владелец задания');
    await clearLockouts();
    const stranger = await pairDevice('Посторонний');
    const strangerDevice = { deviceId: stranger.deviceId, name: 'Посторонний', isPrimary: false };

    const job = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: { state: 'CLAIMED', deviceId: owner.deviceId, claimedAt: new Date() },
    });

    await expect(reportPrinting(ctx.db, strangerDevice, job.jobId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const document = await call(
      'GET',
      `/api/print-agent/jobs/${job.jobId}/document.pdf`,
      stranger.token,
    );
    expect(document.statusCode).toBe(404);
  });
});

describe('идемпотентность действий человека', () => {
  it('повторное нажатие «Повторить» не создаёт второй бланк', async () => {
    const florist = await actorFor(['FLORIST']);
    const job = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: { state: 'ERROR', lastErrorCode: 'PRINTER_OFFLINE', lastErrorAt: new Date() },
    });

    const key = `retry-${randomUUID()}`;

    const [first, second] = await Promise.all([
      retryPrint(ctx.db, florist, job.jobId, CONTEXT, key),
      retryPrint(ctx.db, florist, job.jobId, CONTEXT, key),
    ]);

    // Один ключ — одно задание. К букету не должны приехать два бланка
    // с разными номерами попыток, каждый из которых выглядит законным.
    expect(first.id).toBe(second.id);

    const jobs = await ctx.db.orderPrintJob.count({ where: { orderId: job.orderId } });
    expect(jobs).toBe(2);
  });

  it('повторная тестовая печать по тому же ключу не создаёт второе задание', async () => {
    await clearLockouts();
    await clearPrimary();
    const admin = await actorFor(['ADMIN']);
    const paired = await pairDevice('Тестовая печать');
    expect(paired.isPrimary).toBe(true);

    const key = `test-${randomUUID()}`;
    const [first, second] = await Promise.all([
      createTestPrintJob(ctx.db, admin, key, CONTEXT),
      createTestPrintJob(ctx.db, admin, key, CONTEXT),
    ]);

    expect(first.jobId).toBe(second.jobId);

    const row = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: first.jobId },
      select: { documentKind: true, orderId: true, printFormId: true, attempt: true },
    });
    // Тестовая страница идёт ТОЙ ЖЕ очередью, но заказа и бланка у неё нет:
    // это запрещает CHECK базы, а не соглашение кода.
    expect(row.documentKind).toBe('TEST_PAGE');
    expect(row.orderId).toBeNull();
    expect(row.printFormId).toBeNull();
    expect(row.attempt).toBeNull();
  });

  it('база не даёт создать бланк без заказа и тестовую страницу с заказом', async () => {
    const job = await seedPrintJob();

    // Бланк без снимка — документ без содержимого.
    await expect(
      ctx.db.$executeRawUnsafe(
        `INSERT INTO "OrderPrintJob" ("id", "documentKind", "state", "updatedAt")
         VALUES (gen_random_uuid(), 'ORDER_FORM', 'PENDING', now())`,
      ),
    ).rejects.toThrow();

    // Тестовая страница с заказом — бланк, выданный за проверку принтера.
    await expect(
      ctx.db.$executeRawUnsafe(
        `INSERT INTO "OrderPrintJob" ("id", "documentKind", "state", "orderId", "updatedAt")
         VALUES (gen_random_uuid(), 'TEST_PAGE', 'PENDING', '${job.orderId}'::uuid, now())`,
      ),
    ).rejects.toThrow();
  });

  it('взятое задание обязано называть обработчика', async () => {
    const job = await seedPrintJob();

    // `CLAIMED` без устройства — взятое задание, которое некому вернуть.
    await expect(
      ctx.db.$executeRawUnsafe(
        `UPDATE "OrderPrintJob" SET "state" = 'CLAIMED' WHERE "id" = '${job.jobId}'::uuid`,
      ),
    ).rejects.toThrow();
  });
});

describe('существующая ручная печать не сломана', () => {
  it('отметка «Напечатано» человеком по-прежнему работает и остаётся отличима', async () => {
    const florist = await actorFor(['FLORIST']);
    const job = await seedPrintJob();

    const result = await markPrinted(ctx.db, florist, job.jobId, CONTEXT);
    expect(result.state).toBe('PRINTED');
    // Автор проставлен: это и отличает ручную отметку от машинной.
    expect(result.completedById).toBe(florist.userId);

    // Повторная отметка не переписывает чужую.
    await expect(markPrinted(ctx.db, florist, job.jobId, CONTEXT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('запасной режим доступен и для заданий, зависших у обработчика', async () => {
    await clearLockouts();
    await clearPrimary();
    const florist = await actorFor(['FLORIST']);
    const paired = await pairDevice('Зависшее задание');
    const job = await seedPrintJob();

    await ctx.db.orderPrintJob.update({
      where: { id: job.jobId },
      data: {
        state: 'NEEDS_REVIEW',
        deviceId: paired.deviceId,
        lastErrorCode: 'AGENT_RESTARTED',
        lastErrorAt: new Date(),
      },
    });

    // `NEEDS_REVIEW` — это ровно вопрос «вышел ли бланк», и ответить на него
    // может только человек, который посмотрел в лоток.
    const result = await markPrinted(ctx.db, florist, job.jobId, CONTEXT);
    expect(result.state).toBe('PRINTED');
    expect(result.completedById).toBe(florist.userId);
  });

  it('повтор печати выдаёт задание по ТОМУ ЖЕ снимку', async () => {
    const florist = await actorFor(['FLORIST']);
    const job = await seedPrintJob();

    const source = await ctx.db.orderPrintJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { printFormId: true },
    });

    const retried = await retryPrint(ctx.db, florist, job.jobId, CONTEXT);
    expect(retried.printFormId).toBe(source.printFormId);
    expect(retried.attempt).toBe(2);
    expect(retried.state).toBe('PENDING');
  });

  it('снятие доступно непечатающемуся и запрещено тому, что уже у принтера', async () => {
    await clearLockouts();
    await clearPrimary();
    const florist = await actorFor(['FLORIST']);
    const paired = await pairDevice('Снятие');

    const pending = await seedPrintJob();
    const cancelled = await cancelPrint(ctx.db, florist, pending.jobId, CONTEXT);
    expect(cancelled.state).toBe('CANCELLED');

    const printing = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: printing.jobId },
      data: { state: 'PRINTING', deviceId: paired.deviceId, printingAt: new Date() },
    });

    // Документ уже у драйвера: «отменено» было бы утверждением, которого
    // никто не проверял.
    await expect(cancelPrint(ctx.db, florist, printing.jobId, CONTEXT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('фильтр «Требуют внимания» показывает и то, что сейчас у обработчика', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Видимость в очереди');

    const claimed = await seedPrintJob();
    await ctx.db.orderPrintJob.update({
      where: { id: claimed.jobId },
      data: { state: 'CLAIMED', deviceId: paired.deviceId, claimedAt: new Date() },
    });

    const page = await listPrintJobs(ctx.db, { filter: 'attention', limit: 200, offset: 0 });
    const found = page.items.find((item) => item.id === claimed.jobId);

    // Задание, взятое компьютером и не вернувшееся, обязано остаться на виду —
    // иначе именно оно и потеряется.
    expect(found).toBeDefined();
    expect(found?.state).toBe('CLAIMED');
    expect(found?.deviceName).toBe('Видимость в очереди');
  });
});

describe('права', () => {
  it('устройствами управляет только ADMIN', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Проверка прав');

    for (const roles of [['FLORIST'], ['LOGISTICIAN'], ['WAREHOUSE'], ['MANAGER']] as Role[][]) {
      const token = await tokenFor(roles);

      const list = await call('GET', '/api/settings/print/devices', token);
      expect(list.statusCode).toBe(403);

      const code = await call('POST', '/api/settings/print/pairing-code', token);
      expect(code.statusCode).toBe(403);

      const primary = await call(
        'POST',
        `/api/settings/print/devices/${paired.deviceId}/primary`,
        token,
      );
      expect(primary.statusCode).toBe(403);

      const revoke = await call(
        'POST',
        `/api/settings/print/devices/${paired.deviceId}/revoke`,
        token,
      );
      expect(revoke.statusCode).toBe(403);

      const test = await call('POST', '/api/settings/print/test', token, {
        idempotencyKey: `k-${randomUUID()}`,
      });
      expect(test.statusCode).toBe(403);
    }

    // Аноним — 401, а не 403: он ещё не представился.
    const anonymous = await call('GET', '/api/settings/print/devices', null);
    expect(anonymous.statusCode).toBe(401);
  });

  it('код привязки выдаётся один раз и с запретом кэширования', async () => {
    await clearLockouts();
    const token = await tokenFor(['ADMIN']);

    const response = await call('POST', '/api/settings/print/pairing-code', token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.json() as { code: string; display: string; expiresAt: string };
    expect(isValidPairingCode(body.code)).toBe(true);
    expect(body.display).toBe(`${body.code.slice(0, 4)}-${body.code.slice(4)}`);

    // Реестр устройств кода не показывает никогда и ни в каком виде.
    const devices = await call('GET', '/api/settings/print/devices', token);
    expect(devices.body).not.toContain(body.code);
  });

  it('реестр устройств не отдаёт ни токена, ни его хеша', async () => {
    await clearLockouts();
    await clearPrimary();
    const paired = await pairDevice('Скрытность токена');
    const token = await tokenFor(['ADMIN']);

    const response = await call('GET', '/api/settings/print/devices', token);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(paired.token);
    expect(response.body).not.toContain(hashDeviceToken(paired.token));

    const view = await listDevices(ctx.db);
    expect(JSON.stringify(view)).not.toContain(paired.token);
  });

  it('тестовая печать без основного компьютера отказывает понятно', async () => {
    await clearLockouts();
    await clearPrimary();
    const token = await tokenFor(['ADMIN']);

    const response = await call('POST', '/api/settings/print/test', token, {
      idempotencyKey: `k-${randomUUID()}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('Основной компьютер не назначен');
  });
});
