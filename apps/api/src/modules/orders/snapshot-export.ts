/**
 * Односторонний обезличенный снимок заказов для staging.
 *
 * Зачем. Staging нужен, чтобы проверять экраны и маршруты на правдоподобном
 * объёме данных. Полный клон production-базы для этого недопустим: в нём
 * пользователи, PIN-хеши, сессии, аудит и настройки — вся чувствительная часть
 * системы сразу оказалась бы в менее защищённом окружении.
 *
 * Что переносится. Только заказы и только те поля, что нужны для планирования:
 * дата, интервал, суммы, признаки области и внимания. Персональные данные —
 * адрес, получатель, комментарий — заменяются устойчивыми псевдонимами: один
 * и тот же адрес всегда превращается в один и тот же псевдоним, поэтому
 * группировка по адресу на staging продолжает работать, а сам адрес не уезжает.
 *
 * Что НЕ переносится никогда: токен МоегоСклада и любые секреты, пользователи,
 * роли, PIN, сессии, коды активации, аудит, outbox, realtime-события, курсор
 * интеграции и внешние идентификаторы МоегоСклада. Направление строго одно:
 * production → staging. Обратного переноса нет и не будет.
 *
 * Реального production сейчас не существует, поэтому механизм проверяется
 * на тестовых базах. Ограничения зафиксированы в `docs/OPERATIONS.md`.
 */

import { createHash } from 'node:crypto';
import type { Database } from '../../platform/db.js';
import { fromDateColumn } from '../integrations/moysklad/delivery-date.js';

/**
 * Версия формата: staging обязан отказаться импортировать чужой формат.
 *
 * Поднята до `@2` вместе с ручным интервалом. В первой версии снимок нёс две
 * минуты и не нёс времени установки, а база требует все три поля вместе
 * (CHECK `DeliveryOrder_manual_interval_complete`) — снимок с ручным интервалом
 * был неимпортируем в принципе. Молча дописать третье поле в прежний формат
 * нельзя: получилось бы, что снимок утверждает время, которого в нём не было.
 */
export const SNAPSHOT_FORMAT = 'flowers-logistics/orders-snapshot@2';

export interface SnapshotOrder {
  /** Локальный идентификатор снимка. Внешний UUID МоегоСклада не переносится. */
  key: string;
  number: string;
  deliveryDate: string | null;
  intervalKind: string;
  intervalStartMinute: number | null;
  intervalEndMinute: number | null;
  manualIntervalStartMinute: number | null;
  manualIntervalEndMinute: number | null;
  /**
   * Когда логист задал ручной интервал. Передаётся вместе с минутами и только
   * полным комплектом: база не принимает половинчатое значение, а «интервал
   * есть, но неизвестно с каких пор» — не факт, а его видимость.
   */
  manualIntervalSetAt: string | null;
  /** Псевдонимы вместо персональных данных. */
  addressAlias: string | null;
  recipientAlias: string | null;
  hasComment: boolean;
  externalStateName: string | null;
  externalStateType: string | null;
  sumMinor: string;
  payedSumMinor: string;
  cashCollectable: boolean;
  cashToCollectMinor: string;
  cashAnomaly: boolean;
  inScope: boolean;
  needsAttention: boolean;
  attentionReasons: string[];
}

export interface OrdersSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  /** Момент выгрузки: staging показывает его, чтобы не принять старый снимок за свежий. */
  takenAt: string;
  /** Соль псевдонимов. Без неё псевдоним обратим перебором известных адресов. */
  aliasSaltId: string;
  orders: SnapshotOrder[];
}

export interface ExportOptions {
  /** Нижняя граница даты доставки. Старые заказы для проверок не нужны. */
  since: Date;
  limit: number;
  /**
   * Секрет псевдонимизации. На production генерируется отдельно и хранится там же,
   * где остальные секреты; в снимок попадает только его отпечаток.
   */
  aliasSalt: string;
  now: Date;
}

/**
 * Устойчивый псевдоним значения.
 *
 * Хеш с солью, а не случайная строка: одинаковые адреса обязаны совпасть и после
 * переноса, иначе проверка группировки по адресу теряет смысл. Обратный переход
 * к исходному значению без соли невозможен, а соль на staging не передаётся.
 */
export function alias(prefix: string, value: string | null, salt: string): string | null {
  if (value === null) {
    return null;
  }
  const digest = createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 10);
  return `${prefix}-${digest}`;
}

/**
 * Собирает снимок заказов.
 *
 * Функция только читает и ничего не изменяет. К МоемуСкладу не обращается:
 * данные берутся из уже импортированной копии.
 */
export async function exportOrdersSnapshot(
  db: Database,
  options: ExportOptions,
): Promise<OrdersSnapshot> {
  const rows = await db.deliveryOrder.findMany({
    // Заказы без даты включаются намеренно: именно они наполняют «Требует
    // внимания», ради проверки которого снимок и нужен. Фильтр по нижней
    // границе отсекал бы их вместе со старыми заказами.
    where: { OR: [{ deliveryDate: { gte: options.since } }, { deliveryDate: null }] },
    orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }],
    take: options.limit,
    select: {
      id: true,
      externalName: true,
      deliveryDate: true,
      intervalKind: true,
      intervalStartMinute: true,
      intervalEndMinute: true,
      manualIntervalStartMinute: true,
      manualIntervalEndMinute: true,
      manualIntervalSetAt: true,
      address: true,
      recipient: true,
      comment: true,
      externalStateName: true,
      externalStateType: true,
      sumMinor: true,
      payedSumMinor: true,
      cashCollectable: true,
      cashToCollectMinor: true,
      cashAnomaly: true,
      inScope: true,
      needsAttention: true,
      attentionReasons: true,
    },
  });

  return {
    format: SNAPSHOT_FORMAT,
    takenAt: options.now.toISOString(),
    // В снимок уезжает только отпечаток соли: по нему видно, что два снимка
    // сделаны одним ключом, но саму соль восстановить нельзя.
    aliasSaltId: createHash('sha256').update(options.aliasSalt).digest('hex').slice(0, 12),
    orders: rows.map((row) => ({
      key: alias('order', row.id, options.aliasSalt) ?? row.id,
      number: row.externalName,
      deliveryDate: row.deliveryDate === null ? null : fromDateColumn(row.deliveryDate),
      intervalKind: row.intervalKind,
      intervalStartMinute: row.intervalStartMinute,
      intervalEndMinute: row.intervalEndMinute,
      manualIntervalStartMinute: row.manualIntervalStartMinute,
      manualIntervalEndMinute: row.manualIntervalEndMinute,
      manualIntervalSetAt: row.manualIntervalSetAt?.toISOString() ?? null,
      addressAlias: alias('addr', row.address, options.aliasSalt),
      recipientAlias: alias('rcpt', row.recipient, options.aliasSalt),
      // Сам текст комментария не нужен даже в псевдониме: важно лишь, был ли он.
      hasComment: row.comment !== null,
      externalStateName: row.externalStateName,
      externalStateType: row.externalStateType,
      sumMinor: row.sumMinor.toString(),
      payedSumMinor: row.payedSumMinor.toString(),
      cashCollectable: row.cashCollectable,
      cashToCollectMinor: row.cashToCollectMinor.toString(),
      cashAnomaly: row.cashAnomaly,
      inScope: row.inScope,
      needsAttention: row.needsAttention,
      attentionReasons: row.attentionReasons,
    })),
  };
}

/**
 * Проверка снимка перед импортом на staging.
 *
 * Fail closed: неизвестный формат, следы секретов или похожие на настоящие
 * персональные данные останавливают импорт целиком. Частичный импорт хуже
 * отказа: он оставил бы в staging реальные данные без следа в отчёте.
 */
export function assertSnapshotIsSafe(snapshot: OrdersSnapshot): void {
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error('Неизвестный формат снимка заказов');
  }

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['token', 'secret', 'password', 'pinHash', 'Authorization']) {
    if (serialized.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error('Снимок содержит признаки секрета и не может быть импортирован');
    }
  }

  for (const order of snapshot.orders) {
    if (order.addressAlias !== null && !order.addressAlias.startsWith('addr-')) {
      throw new Error('Снимок содержит адрес вместо псевдонима');
    }
    if (order.recipientAlias !== null && !order.recipientAlias.startsWith('rcpt-')) {
      throw new Error('Снимок содержит получателя вместо псевдонима');
    }
  }
}
