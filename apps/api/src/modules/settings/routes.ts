/**
 * API общих настроек планирования.
 *
 * Читают настройки логист и администратор: логист должен понимать, из какой
 * смены и какого времени обслуживания сложился план. Меняет — только
 * администратор: смена определяет каждый расчёт и является решением уровня
 * организации.
 *
 * Секретов здесь нет и быть не может: токены и ключи интеграций живут
 * в переменных окружения и в этот модуль не попадают никогда.
 */

import { z } from 'zod';
import type { AppServer } from '../../platform/http/types.js';
import type { Database } from '../../platform/db.js';
import type { AppConfig } from '../../platform/config.js';
import { authenticateWithRoles } from '../auth/guards.js';
import {
  manualIssueSchema,
  warehouseManualEntrySchema,
  readManualIssue,
  readWarehouseManualEntry,
  readServiceTime,
  saveManualIssue,
  saveWarehouseManualEntry,
  readShift,
  saveServiceTime,
  saveShift,
  serviceTimeSchema,
  shiftSchema,
} from './service.js';

export const SETTINGS_READ_ROLES = ['ADMIN', 'LOGISTICIAN'] as const;
export const SETTINGS_WRITE_ROLES = ['ADMIN'] as const;

const shiftBodySchema = z.object({
  value: shiftSchema,
  /** Ноль означает «настройки ещё не было»: она создаётся впервые. */
  expectedVersion: z.number().int().min(0),
});

const warehouseManualEntryBodySchema = z.object({
  value: warehouseManualEntrySchema,
  expectedVersion: z.number().int().min(0),
});

const manualIssueBodySchema = z.object({
  value: manualIssueSchema,
  expectedVersion: z.number().int().min(0),
});

const serviceTimeBodySchema = z.object({
  value: serviceTimeSchema,
  expectedVersion: z.number().int().min(0),
});

interface SettingsDeps {
  db: Database;
  config: AppConfig;
}

interface IncomingRequest {
  ip: string;
  headers: { authorization?: string | undefined; 'user-agent'?: string | undefined };
}

function contextOf(request: IncomingRequest): { ip: string | null; userAgent: string | null } {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

export async function registerSettingsRoutes(app: AppServer, deps: SettingsDeps): Promise<void> {
  app.get('/api/settings/planning', async (request) => {
    await authenticateWithRoles(request, deps, SETTINGS_READ_ROLES);

    const [shift, serviceTime, manualIssue, warehouseManualEntry] = await Promise.all([
      readShift(deps.db),
      readServiceTime(deps.db),
      readManualIssue(deps.db),
      readWarehouseManualEntry(deps.db),
    ]);

    return {
      /*
       * Ручная отгрузка видна логисту, но меняется только администратором:
       * читать состояние обязаны оба, иначе кнопка появлялась бы и исчезала
       * без объяснения.
       */
      manualIssue: { value: manualIssue.value, version: manualIssue.version },
      /*
       * Ручной ввод на складе читают все, у кого есть доступ к настройкам,
       * а меняет администратор. Кладовщик получает то же значение отдельным
       * складским запросом: без него экран не знал бы, показывать поле
       * или нет.
       */
      warehouseManualEntry: {
        value: warehouseManualEntry.value,
        version: warehouseManualEntry.version,
      },
      // `null` — смена не настроена. Значения по умолчанию у неё нет:
      // придуманный рабочий день дал бы придуманный план.
      shift: { value: shift.value, version: shift.version },
      serviceTime: {
        value: serviceTime.value,
        version: serviceTime.version,
        isDefault: serviceTime.isDefault,
      },
    };
  });

  app.put('/api/settings/planning/shift', async (request) => {
    const actor = await authenticateWithRoles(request, deps, SETTINGS_WRITE_ROLES);
    const body = shiftBodySchema.parse(request.body);
    const context = contextOf(request);

    const saved = await saveShift(deps.db, actor, {
      value: body.value,
      expectedVersion: body.expectedVersion,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { value: body.value, version: saved.version };
  });

  /** Ручная отгрузка без сканирования. Переключает только администратор. */
  app.put('/api/settings/planning/manual-issue', async (request) => {
    const actor = await authenticateWithRoles(request, deps, SETTINGS_WRITE_ROLES);
    const body = manualIssueBodySchema.parse(request.body);
    const context = contextOf(request);

    const saved = await saveManualIssue(deps.db, actor, {
      value: body.value,
      expectedVersion: body.expectedVersion,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { value: body.value, version: saved.version };
  });

  /** Ручной ввод заказов и ячеек на складе. Переключает только администратор. */
  app.put('/api/settings/warehouse/manual-entry', async (request) => {
    const actor = await authenticateWithRoles(request, deps, SETTINGS_WRITE_ROLES);
    const body = warehouseManualEntryBodySchema.parse(request.body);
    const context = contextOf(request);

    const saved = await saveWarehouseManualEntry(deps.db, actor, {
      value: body.value,
      expectedVersion: body.expectedVersion,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { value: body.value, version: saved.version };
  });

  app.put('/api/settings/planning/service-time', async (request) => {
    const actor = await authenticateWithRoles(request, deps, SETTINGS_WRITE_ROLES);
    const body = serviceTimeBodySchema.parse(request.body);
    const context = contextOf(request);

    const saved = await saveServiceTime(deps.db, actor, {
      value: body.value,
      expectedVersion: body.expectedVersion,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { value: body.value, version: saved.version };
  });
}
