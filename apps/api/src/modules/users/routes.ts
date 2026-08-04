/**
 * HTTP-слой управления пользователями и курьерами.
 *
 * DELETE-маршрутов здесь нет и быть не может: сотрудники и курьеры не удаляются,
 * только замораживаются. Это проверяется отдельным критическим тестом.
 */

import { z } from 'zod';
import { normalizePhone, tryNormalizePhone } from '@fl/shared';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles, type AuthenticatedActor } from '../auth/guards.js';
import {
  createUser,
  freezeUser,
  getUser,
  getUserHistory,
  listUsers,
  reissueActivationCode,
  resetPin,
  unfreezeUser,
  updateUser,
  type Actor,
  type RequestMeta,
} from './service.js';

const MAX_PAGE_SIZE = 100;
const MAX_HISTORY_SIZE = 200;

/** Разделы управления доступны только этим ролям. */
const MANAGEMENT_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;

const phoneSchema = z
  .string()
  .min(1)
  .refine((value) => tryNormalizePhone(value) !== null, 'Некорректный номер телефона')
  .transform((value) => normalizePhone(value));

const roleSchema = z.enum(['ADMIN', 'LOGISTICIAN', 'COURIER', 'WAREHOUSE']);
const vehicleSchema = z.enum(['CAR', 'FOOT']);
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const listQuerySchema = z.object({
  status: z.enum(['PENDING_ACTIVATION', 'ACTIVE', 'FROZEN']).optional(),
  role: roleSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().trim().min(1).max(200),
  roles: z.array(roleSchema).min(1),
  comment: z.string().max(2000).optional(),
  defaultVehicleType: vehicleSchema.optional(),
});

const updateSchema = z.object({
  version: z.number().int().min(0),
  fullName: z.string().trim().min(1).max(200).optional(),
  phone: phoneSchema.optional(),
  comment: z.string().max(2000).nullable().optional(),
  roles: z.array(roleSchema).min(1).optional(),
  defaultVehicleType: vehicleSchema.optional(),
});

const idParamSchema = z.object({ id: uuidSchema });
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_SIZE).default(50),
});

interface UsersDeps {
  db: Database;
  config: AppConfig;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function metaOf(request: IncomingRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

function toActor(actor: AuthenticatedActor): Actor {
  return { userId: actor.userId, roles: actor.roles };
}

export async function registerUserRoutes(app: AppServer, deps: UsersDeps): Promise<void> {
  app.get('/api/users', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const query = listQuerySchema.parse(request.query);
    return listUsers(deps, toActor(actor), query);
  });

  app.get('/api/users/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { user: await getUser(deps, toActor(actor), id) };
  });

  app.get('/api/users/:id/history', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const { limit } = historyQuerySchema.parse(request.query);
    return { items: await getUserHistory(deps, toActor(actor), id, limit) };
  });

  app.post('/api/users', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const input = createSchema.parse(request.body);

    // Ответ содержит одноразовый код активации — он не должен попасть в кэш.
    reply.header('Cache-Control', 'no-store');

    const result = await createUser(deps, toActor(actor), input, metaOf(request));
    return reply.code(201).send(result);
  });

  app.patch('/api/users/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const input = updateSchema.parse(request.body);
    return { user: await updateUser(deps, toActor(actor), id, input, metaOf(request)) };
  });

  app.post('/api/users/:id/freeze', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { user: await freezeUser(deps, toActor(actor), id, metaOf(request)) };
  });

  app.post('/api/users/:id/unfreeze', async (request) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    return { user: await unfreezeUser(deps, toActor(actor), id, metaOf(request)) };
  });

  app.post('/api/users/:id/activation-code/reissue', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return reissueActivationCode(deps, toActor(actor), id, metaOf(request));
  });

  app.post('/api/users/:id/reset-pin', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, MANAGEMENT_ROLES);
    const { id } = idParamSchema.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return resetPin(deps, toActor(actor), id, metaOf(request));
  });
}
