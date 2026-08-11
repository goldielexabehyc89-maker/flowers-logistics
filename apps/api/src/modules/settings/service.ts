/**
 * Общие настройки планирования.
 *
 * Хранятся в версионируемой `SystemSetting`: у каждого ключа есть история
 * версий и ровно одна текущая (частичный признак `currentKey`). Секретов здесь
 * нет и быть не может — только числа, определяющие поведение планирования.
 *
 * Две настройки ведут себя по-разному, и это не случайность:
 *
 *  - СМЕНА обязательна и умолчания не имеет. Придуманный рабочий день —
 *    это придуманные временные окна и придуманный план: система, молча
 *    решившая за логиста, что курьеры работают с 9 до 18, построила бы
 *    правдоподобный и неверный маршрут. Пока администратор не сохранил смену,
 *    планирование честно отказывает кодом `SHIFT_NOT_CONFIGURED`.
 *
 *  - ВРЕМЯ ОБСЛУЖИВАНИЯ умолчание имеет: десять минут на заказ. Ошибка здесь
 *    не меняет состав маршрута, а лишь слегка смещает расчётное время, и
 *    требовать настройку до первого расчёта незачем.
 *
 * Фактически использованные значения попадают в неизменяемый снимок входа:
 * настройка меняется, и без снимка повторный расчёт того же дня дал бы другой
 * ответ, а объяснить расхождение было бы нечем.
 */

import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { TransactionClient } from '../auth/sessions.js';
import type { AuthenticatedActor } from '../auth/guards.js';
import { writeAudit } from '../audit/service.js';

/** Ключи настроек. Значение ключа — часть контракта базы, менять его нельзя. */
export const SETTING_KEYS = {
  shift: 'planning.shift',
  serviceTime: 'planning.serviceTime',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Минут в сутках. Смена задаётся минутами от полуночи. */
export const MINUTES_IN_DAY = 24 * 60;

export const shiftSchema = z
  .object({
    startMinute: z
      .number()
      .int()
      .min(0)
      .max(MINUTES_IN_DAY - 1),
    endMinute: z.number().int().min(1).max(MINUTES_IN_DAY),
  })
  .refine((value) => value.endMinute > value.startMinute, {
    message: 'Окончание смены должно быть строго позже начала',
  });

export type Shift = z.infer<typeof shiftSchema>;

/**
 * Время обслуживания одного ЗАКАЗА, минуты.
 *
 * Именно заказа, а не уникальной точки: два заказа в одном подъезде — это два
 * вручения, и складывать их в одно значило бы обещать курьеру время, которого
 * у него нет.
 */
export const serviceTimeSchema = z.object({
  carMinutes: z.number().int().min(0).max(120),
  footMinutes: z.number().int().min(0).max(120),
});

export type ServiceTime = z.infer<typeof serviceTimeSchema>;

/** Начальные значения времени обслуживания. Редактируются администратором. */
export const DEFAULT_SERVICE_TIME: ServiceTime = { carMinutes: 10, footMinutes: 10 };

interface CurrentSetting {
  version: number;
  value: unknown;
  updatedAt: Date;
}

async function readCurrent(
  client: Database | TransactionClient,
  key: SettingKey,
): Promise<CurrentSetting | null> {
  const row = await client.systemSetting.findUnique({
    where: { currentKey: key },
    select: { version: true, value: true, createdAt: true },
  });

  return row === null ? null : { version: row.version, value: row.value, updatedAt: row.createdAt };
}

export interface ShiftSetting {
  /** `null` — администратор смену ещё не сохранил. */
  value: Shift | null;
  version: number;
}

/**
 * Текущая смена.
 *
 * Некорректное сохранённое значение приравнивается к отсутствующему: настройка,
 * переставшая проходить проверку после изменения правил, не должна молча
 * попадать в расчёт.
 */
export async function readShift(client: Database | TransactionClient): Promise<ShiftSetting> {
  const current = await readCurrent(client, SETTING_KEYS.shift);
  if (current === null) {
    return { value: null, version: 0 };
  }

  const parsed = shiftSchema.safeParse(current.value);
  return { value: parsed.success ? parsed.data : null, version: current.version };
}

export interface ServiceTimeSetting {
  value: ServiceTime;
  version: number;
  /** Значение по умолчанию: администратор его ещё не менял. */
  isDefault: boolean;
}

export async function readServiceTime(
  client: Database | TransactionClient,
): Promise<ServiceTimeSetting> {
  const current = await readCurrent(client, SETTING_KEYS.serviceTime);
  if (current === null) {
    return { value: DEFAULT_SERVICE_TIME, version: 0, isDefault: true };
  }

  const parsed = serviceTimeSchema.safeParse(current.value);
  return parsed.success
    ? { value: parsed.data, version: current.version, isDefault: false }
    : { value: DEFAULT_SERVICE_TIME, version: current.version, isDefault: true };
}

/** Смена, без которой планирование не начинается. */
export async function requireShift(client: Database | TransactionClient): Promise<Shift> {
  const shift = await readShift(client);
  if (shift.value === null) {
    throw new AppError('CONFLICT', {
      message: 'shift setting is not configured',
      publicMessage:
        'Общая смена не настроена. Задайте начало и окончание рабочего дня в настройках.',
      conflict: { kind: 'SHIFT_NOT_CONFIGURED' },
    });
  }
  return shift.value;
}

/**
 * Сохраняет новую версию настройки.
 *
 * Прежняя версия остаётся в истории и перестаёт быть текущей. Конкурентная
 * запись отсекается дважды: ожидаемой версией и уникальностью пары
 * «ключ + версия» — второй писатель с тем же номером получает отказ базы,
 * а не молча перезаписывает чужое значение.
 */
async function writeSetting(
  db: Database,
  actor: AuthenticatedActor,
  input: {
    key: SettingKey;
    value: Record<string, number>;
    expectedVersion: number;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ version: number }> {
  try {
    return await db.$transaction(async (tx) => {
      const current = await readCurrent(tx, input.key);
      const currentVersion = current?.version ?? 0;

      if (currentVersion !== input.expectedVersion) {
        throw new AppError('CONFLICT', {
          message: 'stale setting version',
          publicMessage: 'Настройка изменена другим пользователем. Обновите страницу и повторите.',
          conflict: { kind: 'STALE_VERSION' },
        });
      }

      if (current !== null) {
        // Снятие признака текущей версии и вставка новой идут одной транзакцией:
        // состояния «текущей версии нет вовсе» снаружи не существует.
        await tx.systemSetting.updateMany({
          where: { currentKey: input.key },
          data: { currentKey: null },
        });
      }

      const created = await tx.systemSetting.create({
        data: {
          key: input.key,
          version: currentVersion + 1,
          value: input.value,
          currentKey: input.key,
          updatedById: actor.userId,
        },
        select: { version: true },
      });

      await writeAudit(tx, {
        action: 'SETTING_UPDATED',
        entityType: 'SystemSetting',
        entityId: input.key,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        source: 'api',
        oldValue: current === null ? null : { version: currentVersion, value: current.value },
        newValue: { version: created.version, value: input.value },
        ip: input.ip,
        userAgent: input.userAgent,
      });

      return { version: created.version };
    });
  } catch (error) {
    // Гонка двух писателей: оба прочитали одну версию и оба дошли до вставки.
    // Выигрывает один, второй нарушает уникальность пары «ключ + версия».
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT', {
        message: 'concurrent setting update',
        publicMessage: 'Настройка изменена другим пользователем. Обновите страницу и повторите.',
        conflict: { kind: 'STALE_VERSION' },
      });
    }
    throw error;
  }
}

export async function saveShift(
  db: Database,
  actor: AuthenticatedActor,
  input: { value: Shift; expectedVersion: number; ip: string | null; userAgent: string | null },
): Promise<{ version: number }> {
  return writeSetting(db, actor, {
    key: SETTING_KEYS.shift,
    value: { startMinute: input.value.startMinute, endMinute: input.value.endMinute },
    expectedVersion: input.expectedVersion,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

export async function saveServiceTime(
  db: Database,
  actor: AuthenticatedActor,
  input: {
    value: ServiceTime;
    expectedVersion: number;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<{ version: number }> {
  return writeSetting(db, actor, {
    key: SETTING_KEYS.serviceTime,
    value: { carMinutes: input.value.carMinutes, footMinutes: input.value.footMinutes },
    expectedVersion: input.expectedVersion,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

/** Время обслуживания заказа в СЕКУНДАХ по типу транспорта: язык решателя. */
export function serviceSecondsOf(value: ServiceTime): Record<'CAR' | 'FOOT', number> {
  return { CAR: value.carMinutes * 60, FOOT: value.footMinutes * 60 };
}
