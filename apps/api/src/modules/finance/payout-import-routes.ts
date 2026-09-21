/**
 * Маршруты импорта выплат из выписки ПланФакта.
 *
 * Все — только для администратора: импорт проводит деньги в журнал курьеров
 * по внешнему документу, и право на это такое же, как на начальный долг.
 * Роль проверяется на сервере при каждом запросе; кнопка в интерфейсе —
 * не защита.
 *
 * Файл приходит внутри JSON в base64: у приложения нет разбора multipart, а
 * выписка весит десятки килобайт. Предел тела маршрута поднят отдельно —
 * общий предел сервера в 1 МиБ рассчитан на формы, не на файлы.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { AppError } from '../../platform/errors.js';
import { authenticateWithRoles } from '../auth/guards.js';
import {
  confirmPayoutImport,
  listPayoutImports,
  payoutImportById,
  previewPayoutImport,
} from './payout-import.js';

const ADMIN_ONLY = ['ADMIN'] as const;

/** Наибольший размер файла выписки после раскодирования. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Предел тела запроса: файл в base64 плюс поля. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  /** Содержимое файла в base64. */
  content: z.string().min(1).max(MAX_BODY_BYTES),
});

/** Строка так, как её показал предпросмотр: сервер сверит, а не поверит. */
const approvedRowSchema = z.object({
  rowNo: z.number().int().min(1).max(1_000_000),
  state: z.enum(['ready', 'possible_duplicate']),
  courierUserId: z.string().uuid(),
  operationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.string().regex(/^\d{1,15}$/),
});

const confirmSchema = uploadSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(120),
  /** Показанные и подтверждённые строки: готовые плюс явно принятые повторы. */
  approved: z.array(approvedRowSchema).max(10_000),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Содержимое файла из base64 с проверкой, что это вообще файл .xlsx. */
function decodeFile(content: string): Buffer {
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Содержимое файла передано не в base64.',
    });
  }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.byteLength === 0) {
    throw new AppError('VALIDATION_FAILED', { publicMessage: 'Файл пуст.' });
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: `Файл больше ${MAX_FILE_BYTES / 1024 / 1024} МиБ: выписка такого размера не ожидается.`,
    });
  }
  // Книга .xlsx — это ZIP; любой другой формат отклоняется до разбора.
  if (bytes.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Ожидается книга Excel (.xlsx): файл другого формата.',
    });
  }
  return bytes;
}

function contextOf(request: { ip: string; headers: Record<string, unknown> }): {
  ip: string | null;
  userAgent: string | null;
} {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null };
}

export async function registerPayoutImportRoutes(
  app: AppServer,
  deps: { db: Database; config: AppConfig },
): Promise<void> {
  /** Предпросмотр: разбор, сопоставление и повторы — без единой записи в базу. */
  app.post(
    '/api/logistics/payout-imports/preview',
    { bodyLimit: MAX_BODY_BYTES },
    async (request) => {
      await authenticateWithRoles(request, deps, ADMIN_ONLY);
      const body = uploadSchema.parse(request.body);

      return previewPayoutImport(deps.db, {
        fileName: body.fileName,
        content: decodeFile(body.content),
      });
    },
  );

  /**
   * Подтверждение: файл разбирается и проверяется заново в общей очереди,
   * результат сверяется с показанными строками, записи получают ключ
   * «хеш файла + строка», повтор запроса возвращает тот же импорт.
   */
  app.post(
    '/api/logistics/payout-imports',
    { bodyLimit: MAX_BODY_BYTES },
    async (request, reply) => {
      const actor = await authenticateWithRoles(request, deps, ADMIN_ONLY);
      const body = confirmSchema.parse(request.body);

      const result = await confirmPayoutImport(deps.db, {
        actor,
        fileName: body.fileName,
        content: decodeFile(body.content),
        idempotencyKey: body.idempotencyKey,
        approved: body.approved,
        context: contextOf(request),
      });

      return reply.code(201).send(result);
    },
  );

  app.get('/api/logistics/payout-imports', async (request) => {
    await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const query = listSchema.parse(request.query);

    return { items: await listPayoutImports(deps.db, query.limit) };
  });

  app.get('/api/logistics/payout-imports/:id', async (request) => {
    await authenticateWithRoles(request, deps, ADMIN_ONLY);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const result = await payoutImportById(deps.db, id);
    if (result === null) {
      throw new AppError('NOT_FOUND', { publicMessage: 'Импорт не найден.' });
    }
    return result;
  });
}
