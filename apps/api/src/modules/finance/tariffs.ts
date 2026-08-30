/**
 * Тарифы курьера и включение финансового учёта.
 *
 * Тариф выбирается по ДАТЕ ДОСТАВКИ маршрута и фиксируется снимком при
 * подтверждении: последующее изменение ставок не пересчитывает уже
 * подтверждённые маршруты. Версии неизменяемы — ошибка исправляется новой
 * версией того же вида, а не правкой старой.
 *
 * Учёт включается отдельным решением владельца с конкретной даты. До этой даты
 * начислений не существует вовсе: тарифного снимка у прошлых доставок никогда
 * не было, и придумывать ставку задним числом запрещено. Такие строки отчёта
 * помечаются словами «Расчёт отсутствует», а не нулём.
 */

import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { fromDateColumn, toDateColumn } from '../integrations/moysklad/delivery-date.js';
import type { Role } from '@fl/shared';
import type { TransactionClient } from '../auth/sessions.js';
import { writeAudit } from '../audit/service.js';

/** Ключ настройки включения учёта. Хранит только дату, без сумм. */
export const LEDGER_SETTING_KEY = 'finance.ledger';

export interface LedgerActivation {
  /** Московский день, с которого учёт ведётся. `null` — учёт выключен. */
  activeFrom: string | null;
}

export interface TariffView {
  id: string;
  kind: 'REGULAR' | 'HOLIDAY';
  effectiveFrom: string;
  effectiveTo: string | null;
  perOrderMinor: string;
  perKmMinor: string;
  note: string | null;
  createdAt: string;
}

export interface TariffRates {
  tariffVersionId: string;
  perOrderMinor: bigint;
  perKmMinor: bigint;
}

/**
 * Действует ли учёт для этой даты доставки.
 *
 * Строгое «раньше даты включения — нет» и никаких исключений: иначе один и тот
 * же день попадал бы в баланс то одним, то другим способом.
 */
export function ledgerCoversDate(activation: LedgerActivation, deliveryDate: string): boolean {
  return activation.activeFrom !== null && deliveryDate >= activation.activeFrom;
}

/** Текущее состояние включения учёта. Отсутствие настройки — выключен. */
export async function readLedgerActivation(db: Database): Promise<LedgerActivation> {
  const setting = await db.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    select: { value: true },
  });

  const value = (setting?.value ?? null) as { activeFrom?: unknown } | null;
  const raw = value?.activeFrom;
  return { activeFrom: typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null };
}

/**
 * Выбор тарифа на дату доставки.
 *
 * Праздничная версия имеет приоритет над обычной: она задаётся ровно на свои
 * дни и вводится именно затем, чтобы перекрыть обычную. Среди подходящих
 * побеждает более поздняя по дате начала, а при равенстве — созданная позже:
 * так исправление ошибочной ставки вводится новой версией.
 */
export async function resolveTariff(
  db: Database,
  deliveryDate: string,
): Promise<TariffRates | null> {
  const day = toDateColumn(deliveryDate);

  const candidates = await db.courierTariffVersion.findMany({
    where: {
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, kind: true, perOrderMinor: true, perKmMinor: true },
  });

  const chosen = candidates.find((item) => item.kind === 'HOLIDAY') ?? candidates[0];
  if (chosen === undefined) {
    return null;
  }

  return {
    tariffVersionId: chosen.id,
    perOrderMinor: chosen.perOrderMinor,
    perKmMinor: chosen.perKmMinor,
  };
}

export interface CreateTariffInput {
  kind: 'REGULAR' | 'HOLIDAY';
  effectiveFrom: string;
  effectiveTo: string | null;
  perOrderMinor: bigint;
  perKmMinor: bigint;
  note: string | null;
}

/**
 * Проверка периода до обращения к базе.
 *
 * База те же условия закрывает CHECK-ограничениями, но человеку нужна причина
 * словами, а не отказ ограничения.
 */
export function validateTariffPeriod(input: CreateTariffInput): void {
  if (input.effectiveTo !== null && input.effectiveTo < input.effectiveFrom) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Конец периода тарифа раньше его начала.',
    });
  }
  if (input.kind === 'HOLIDAY' && input.effectiveTo === null) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'У праздничного тарифа обязателен последний день периода.',
    });
  }
  if (input.perOrderMinor < 0n || input.perKmMinor < 0n) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: 'Ставка не может быть отрицательной.',
    });
  }
}

export function toTariffView(row: {
  id: string;
  kind: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  perOrderMinor: bigint;
  perKmMinor: bigint;
  note: string | null;
  createdAt: Date;
}): TariffView {
  return {
    id: row.id,
    kind: row.kind as 'REGULAR' | 'HOLIDAY',
    effectiveFrom: fromDateColumn(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : fromDateColumn(row.effectiveTo),
    perOrderMinor: row.perOrderMinor.toString(),
    perKmMinor: row.perKmMinor.toString(),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Включение учёта с даты — единый доменный путь с аудитом.
 *
 * Идемпотентно: если учёт уже включён ровно с этой даты, новая версия
 * настройки не создаётся и аудит не пишется — повторный запуск операторской
 * процедуры не оставляет следов. Значение хранит только дату, без сумм.
 */
export interface ActivateLedgerInput {
  activeFrom: string;
  actorUserId: string;
  actorRoles: Role[];
  ip: string | null;
  userAgent: string | null;
}

export async function activateLedger(
  tx: TransactionClient,
  input: ActivateLedgerInput,
): Promise<{ changed: boolean; previousActiveFrom: string | null }> {
  const current = await tx.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    select: { value: true },
  });
  const rawCurrent = (current?.value ?? null) as { activeFrom?: unknown } | null;
  const previousActiveFrom =
    typeof rawCurrent?.activeFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawCurrent.activeFrom)
      ? rawCurrent.activeFrom
      : null;

  if (previousActiveFrom === input.activeFrom) {
    return { changed: false, previousActiveFrom };
  }

  const previous = await tx.systemSetting.findFirst({
    where: { key: LEDGER_SETTING_KEY },
    orderBy: [{ version: 'desc' }],
    select: { version: true },
  });

  await tx.systemSetting.updateMany({
    where: { key: LEDGER_SETTING_KEY, currentKey: LEDGER_SETTING_KEY },
    data: { currentKey: null },
  });

  await tx.systemSetting.create({
    data: {
      key: LEDGER_SETTING_KEY,
      version: (previous?.version ?? 0) + 1,
      value: { activeFrom: input.activeFrom },
      currentKey: LEDGER_SETTING_KEY,
      updatedById: input.actorUserId,
    },
  });

  await writeAudit(tx, {
    action: 'FINANCE_LEDGER_ACTIVATED',
    entityType: 'SystemSetting',
    actorUserId: input.actorUserId,
    actorRoles: input.actorRoles,
    newValue: { activeFrom: input.activeFrom },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { changed: true, previousActiveFrom };
}
