/**
 * API складов.
 *
 * Права разделены намеренно. Читать список нужно и логисту: он видит, откуда
 * поедут курьеры, и должен понимать, почему планирование считает именно так.
 * Менять состав складов и признак по умолчанию может только администратор:
 * от координат склада зависит каждый посчитанный план, и это решение уровня
 * организации, а не смены.
 *
 * `DELETE` нет и не будет: склад деактивируется, но не стирается.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import { MICRO } from '../orders/geo.js';
import {
  createDepot,
  hasConfirmedPoint,
  listDepots,
  setDefaultDepot,
  setDepotActive,
  updateDepot,
  type DepotRow,
  type RequestContext,
} from './service.js';

/** Читают склады логист и администратор; меняет — только администратор. */
export const DEPOT_READ_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
export const DEPOT_WRITE_ROLES = ['ADMIN'] as const;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Некорректный id');

const idParamSchema = z.object({ id: uuid });

/**
 * Точка склада приходит ТОЛЬКО вместе с выбранной подсказкой адреса.
 *
 * Отдельного ввода широты и долготы нет: набранные руками координаты ничем
 * не связаны с адресом и молча уводят расчёт не туда. `null` — адрес сохранён,
 * но точка не определена; складом по умолчанию такой склад стать не может.
 */
const pointSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .nullable()
  .default(null);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  point: pointSchema,
});

const updateSchema = createSchema.extend({
  expectedVersion: z.number().int().min(1),
});

const defaultSchema = z.object({
  expectedVersion: z.number().int().min(1),
  /**
   * Склад, который клиент видел складом по умолчанию, вместе с его версией.
   *
   * Идентификатор обязателен наравне с версией: номера версий разных строк
   * независимы и совпадают случайно, а совпавшая версия чужого склада
   * пропустила бы смену, которой клиент не видел.
   */
  expectedCurrentDefaultId: uuid.nullable(),
  expectedCurrentDefaultVersion: z.number().int().min(1).nullable(),
});

const activeSchema = z.object({
  isActive: z.boolean(),
  expectedVersion: z.number().int().min(1),
});

interface DepotDeps {
  db: Database;
  config: AppConfig;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

/** Наружу координаты отдаются градусами: микроградусы — внутренняя единица хранения. */
function toView(depot: DepotRow) {
  return {
    id: depot.id,
    name: depot.name,
    address: depot.address,
    // `null` — точка не определена. Ноль здесь означал бы Гвинейский залив.
    lat: depot.latMicro === null ? null : depot.latMicro / MICRO,
    lon: depot.lonMicro === null ? null : depot.lonMicro / MICRO,
    /**
     * Пригоден ли склад для расчёта.
     *
     * Интерфейс обязан отличать «адрес есть, точки нет» от рабочего склада:
     * иначе логист не поймёт, почему расчёт отказывает, и полезет вводить
     * координаты руками — ровно то, от чего мы уходим.
     */
    hasPoint: hasConfirmedPoint(depot),
    isActive: depot.isActive,
    isDefault: depot.defaultKey !== null,
    version: depot.version,
  };
}

export async function registerDepotRoutes(app: AppServer, deps: DepotDeps): Promise<void> {
  app.get('/api/depots', async (request) => {
    await authenticateWithRoles(request, deps, DEPOT_READ_ROLES);
    const depots = await listDepots(deps.db);
    return { items: depots.map(toView) };
  });

  app.post('/api/depots', async (request, reply) => {
    const actor = await authenticateWithRoles(request, deps, DEPOT_WRITE_ROLES);
    const body = createSchema.parse(request.body);

    const created = await createDepot(deps.db, actor, body, contextOf(request));
    return reply.code(201).send(toView(created));
  });

  app.put('/api/depots/:id', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DEPOT_WRITE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = updateSchema.parse(request.body);

    return toView(await updateDepot(deps.db, actor, id, body, contextOf(request)));
  });

  app.put('/api/depots/:id/default', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DEPOT_WRITE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = defaultSchema.parse(request.body);

    return toView(await setDefaultDepot(deps.db, actor, id, body, contextOf(request)));
  });

  app.put('/api/depots/:id/active', async (request) => {
    const actor = await authenticateWithRoles(request, deps, DEPOT_WRITE_ROLES);
    const { id } = idParamSchema.parse(request.params);
    const body = activeSchema.parse(request.body);

    return toView(await setDepotActive(deps.db, actor, id, body, contextOf(request)));
  });
}
