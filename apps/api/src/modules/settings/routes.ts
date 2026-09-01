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
  floristDispatchModeSchema,
  readManualIssue,
  readWarehouseManualEntry,
  readFloristDispatchMode,
  readServiceTime,
  saveManualIssue,
  saveWarehouseManualEntry,
  saveFloristDispatchMode,
  readShift,
  saveServiceTime,
  saveShift,
  serviceTimeSchema,
  shiftSchema,
} from './service.js';

/**
 * Чтение настроек планирования.
 *
 * Здесь только один GET — `/api/settings/planning`, и им пользуются РАБОЧИЕ
 * экраны (маршрутные листы читают флаг ручной отгрузки). Поэтому доступ шире
 * записи. «Управляющий» получает именно это чтение и ничего больше из общих
 * настроек: экран «Настройки» и любые изменения ему закрыты. В ответе нет ни
 * секретов, ни интеграционных реквизитов — только операционные значения.
 */
export const SETTINGS_READ_ROLES = ['ADMIN', 'LOGISTICIAN', 'SUPERVISOR'] as const;
/** Изменение любых настроек — только администратор. Управляющего здесь нет намеренно. */
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

const floristDispatchModeBodySchema = z.object({
  value: floristDispatchModeSchema,
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

    const [shift, serviceTime, manualIssue, warehouseManualEntry, floristDispatchMode] =
      await Promise.all([
        readShift(deps.db),
        readServiceTime(deps.db),
        readManualIssue(deps.db),
        readWarehouseManualEntry(deps.db),
        readFloristDispatchMode(deps.db),
      ]);

    return {
      // Режим распределения читают логист и управляющий, меняет администратор.
      floristDispatchMode: {
        value: floristDispatchMode.value,
        version: floristDispatchMode.version,
      },
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

  /** Режим распределения заказов флористам: меняет ТОЛЬКО администратор. */
  app.put('/api/settings/florist/dispatch-mode', async (request) => {
    const actor = await authenticateWithRoles(request, deps, SETTINGS_WRITE_ROLES);
    const body = floristDispatchModeBodySchema.parse(request.body);
    const context = contextOf(request);

    const saved = await saveFloristDispatchMode(deps.db, actor, {
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
