/**
 * API обработчика печати.
 *
 * ДВА НЕПЕРЕСЕКАЮЩИХСЯ КОНТУРА В ОДНОМ ФАЙЛЕ — намеренно: так видно, что
 * ни один маршрут не проверяет доступ «как-нибудь ещё».
 *
 *   `/api/print-agent/*`  — машинный контур. Охрана `authenticateDevice`,
 *                           актор — компьютер, ролей нет. Пользовательский JWT
 *                           здесь не принимается.
 *   `/api/settings/print/*` — человеческий контур. Охрана `authenticateWithRoles`,
 *                           только `ADMIN`. Токен устройства здесь не принимается.
 *
 * ПРОИЗВОЛЬНЫХ АДРЕСОВ, КОМАНД И ПУТЕЙ ОБРАБОТЧИК НЕ ПОЛУЧАЕТ. Всё, что он
 * узнаёт о документе, — идентификатор задания и путь на этом же сервере.
 * Ни имени файла на диске, ни строки запуска, ни внешней ссылки в протоколе нет.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { getDevice, listDevices, revokeDevice, setPrimaryDevice } from './devices.js';
import { authenticateDevice } from './guard.js';
import { issuePairingCode, redeemPairingCode } from './pairing.js';
import {
  claimNextJob,
  createTestPrintJob,
  renderDeviceDocument,
  reportPrinting,
  reportResult,
  sweepStaleJobs,
} from './queue.js';
import { AppError } from '../../platform/errors.js';

/**
 * Устройствами управляет только администратор.
 *
 * Логист сюда не допущен, хотя настройки планирования читать может: печать —
 * не его контур, а право выпустить код привязки равносильно праву завести
 * компьютер, печатающий чужие бланки.
 */
const PRINT_AGENT_ADMIN_ROLES = ['ADMIN'] as const;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

/**
 * Длины полей, сообщаемых обработчиком.
 *
 * Ограничены жёстко: это данные с чужой машины, и они попадают на экран
 * администратора. Имя принтера в Windows бывает длинным, но не таким.
 */
const reportedName = z.string().trim().min(1).max(120);
const reportedOptional = z.string().trim().max(120).nullish();

const pairSchema = z.object({
  code: z.string().trim().min(1).max(32),
  deviceName: reportedName,
  os: reportedOptional,
  agentVersion: reportedOptional,
  defaultPrinterName: reportedOptional,
});

const heartbeatSchema = z.object({
  os: reportedOptional,
  agentVersion: reportedOptional,
  defaultPrinterName: reportedOptional,
});

const resultSchema = z.object({
  outcome: z.enum(['printed', 'failed', 'ambiguous']),
  /** Код из закрытого перечня. Свободный текст обработчика не принимается. */
  errorCode: z.string().trim().max(64).nullish(),
  defaultPrinterName: reportedOptional,
});

/**
 * Ключ идемпотентности действия человека.
 *
 * Присылает клиент: одно нажатие — один ключ. Повторная отправка того же
 * запроса (двойной клик, повтор при потерянном ответе) обязана вернуть то же
 * задание, а не создать второе.
 */
const idempotencySchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(120),
});

export interface PrintAgentRouteDeps {
  db: Database;
  config: AppConfig;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): { ip: string; userAgent: string | null } {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

export async function registerPrintAgentRoutes(
  app: AppServer,
  deps: PrintAgentRouteDeps,
): Promise<void> {
  // --- Машинный контур ------------------------------------------------------

  /**
   * Обмен кода привязки на токен устройства.
   *
   * Единственный маршрут контура без токена — иначе привязать компьютер было
   * бы нечем. Защищён ограничением перебора на уровне базы (`pairing.ts`).
   * Ответ не кэшируется: в нём открытый токен, который больше не повторится.
   */
  app.post('/api/print-agent/pair', async (request, reply) => {
    const body = pairSchema.parse(request.body);

    const result = await redeemPairingCode(
      deps.db,
      deps.config,
      {
        code: body.code,
        deviceName: body.deviceName,
        os: body.os ?? null,
        agentVersion: body.agentVersion ?? null,
        defaultPrinterName: body.defaultPrinterName ?? null,
      },
      contextOf(request),
    );

    return reply.header('cache-control', 'no-store').send(result);
  });

  /**
   * Состояние обработчика и заодно отметка «на связи».
   *
   * Сообщённые сведения ПЕРЕЗАПИСЫВАЮТСЯ каждым обращением: принтер по
   * умолчанию меняют в Windows, и настройки обязаны показывать текущий,
   * а не тот, что был при привязке.
   */
  app.post('/api/print-agent/heartbeat', async (request) => {
    const device = await authenticateDevice(request, deps);
    const body = heartbeatSchema.parse(request.body ?? {});

    await deps.db.printAgentDevice.update({
      where: { id: device.deviceId },
      data: {
        lastSeenAt: new Date(),
        ...(body.os === undefined || body.os === null ? {} : { os: body.os }),
        ...(body.agentVersion === undefined || body.agentVersion === null
          ? {}
          : { agentVersion: body.agentVersion }),
        ...(body.defaultPrinterName === undefined
          ? {}
          : { defaultPrinterName: body.defaultPrinterName }),
      },
    });

    return {
      deviceId: device.deviceId,
      name: device.name,
      isPrimary: device.isPrimary,
      /** Обработчик сверяет часы для собственных таймаутов, но решает сервер. */
      serverTime: new Date().toISOString(),
    };
  });

  /**
   * Очередное задание.
   *
   * НОВЫЕ ЗАДАНИЯ ПОЛУЧАЕТ ТОЛЬКО ОСНОВНОЙ ОБРАБОТЧИК. Неосновной получает
   * пустой ответ, а не отказ: он привязан законно и просто ждёт своей роли —
   * ошибка в журнале запасного компьютера была бы шумом, а не сигналом.
   */
  app.post('/api/print-agent/jobs/claim', async (request) => {
    const device = await authenticateDevice(request, deps);

    if (!device.isPrimary) {
      return { job: null };
    }

    // Разбор зависших делается перед выдачей, а не отдельным расписанием:
    // так поведение очереди не зависит от того, работает ли фоновой процесс.
    await sweepStaleJobs(deps.db);

    return { job: await claimNextJob(deps.db, device.deviceId) };
  });

  /**
   * Документ задания.
   *
   * Отдаётся только устройству, которое это задание забрало. Заголовки —
   * те же, что у человеческих бланков: без кэширования и без угадывания типа.
   */
  app.get('/api/print-agent/jobs/:id/document.pdf', async (request, reply) => {
    const device = await authenticateDevice(request, deps);
    const { id } = idParamSchema.parse(request.params);

    const document = await renderDeviceDocument(deps.db, device, id);

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${document.fileName}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(document.bytes));
  });

  /** Отчёт «передаю документ драйверу». Приходит ДО передачи. */
  app.post('/api/print-agent/jobs/:id/printing', async (request) => {
    const device = await authenticateDevice(request, deps);
    const { id } = idParamSchema.parse(request.params);
    return reportPrinting(deps.db, device, id);
  });

  /** Исход задания. Идемпотентен: повтор после потери сети — успех. */
  app.post('/api/print-agent/jobs/:id/result', async (request) => {
    const device = await authenticateDevice(request, deps);
    const { id } = idParamSchema.parse(request.params);
    const body = resultSchema.parse(request.body);

    return reportResult(
      deps.db,
      device,
      id,
      {
        outcome: body.outcome,
        errorCode: body.errorCode ?? null,
        defaultPrinterName: body.defaultPrinterName ?? null,
      },
      contextOf(request),
    );
  });

  // --- Человеческий контур: Настройки → Печать -------------------------------

  /** Реестр устройств. Токенов и кодов здесь нет и быть не может. */
  app.get('/api/settings/print/devices', async (request) => {
    await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    return listDevices(deps.db);
  });

  /**
   * Выпуск кода привязки.
   *
   * Открытый код возвращается ОДИН раз и больше не восстановим. Ответ не
   * кэшируется — как и всё, что содержит одноразовый секрет.
   */
  app.post('/api/settings/print/pairing-code', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    const issued = await issuePairingCode(deps.db, deps.config, actor, contextOf(request));
    return reply.header('cache-control', 'no-store').send(issued);
  });

  app.post('/api/settings/print/devices/:id/primary', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { device: await setPrimaryDevice(deps.db, actor, id, contextOf(request)) };
  });

  app.post('/api/settings/print/devices/:id/revoke', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { device: await revokeDevice(deps.db, actor, id, contextOf(request)) };
  });

  app.get('/api/settings/print/devices/:id', async (request) => {
    await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { device: await getDevice(deps.db, id) };
  });

  /**
   * Тестовая печать.
   *
   * Ставит задание в НАСТОЯЩУЮ очередь: тот же захват, тот же документ, те же
   * отчёты. Отдельный «проверочный» путь доказывал бы работоспособность пути,
   * которым не пойдёт ни один настоящий бланк.
   */
  app.post('/api/settings/print/test', async (request) => {
    const actor = await authenticateWithRoles(request, deps, PRINT_AGENT_ADMIN_ROLES);
    const body = idempotencySchema.parse(request.body);

    const primary = await deps.db.printAgentDevice.findFirst({
      where: { primaryKey: { not: null } },
      select: { id: true },
    });
    if (primary === null) {
      throw new AppError('CONFLICT', {
        message: 'no primary print agent device',
        publicMessage: 'Основной компьютер не назначен. Подключите его и повторите.',
      });
    }

    return createTestPrintJob(deps.db, actor, body.idempotencyKey, contextOf(request));
  });
}
