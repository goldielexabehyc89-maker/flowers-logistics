/**
 * Действующие причины «Требует внимания».
 *
 * Причины приходят из снимка МоегоСклада, но часть из них логист может закрыть
 * локально: если интервал задан вручную, заказ уже спланировать можно, и держать
 * его в «Требует внимания» из-за пустого или нераспознанного текста источника
 * незачем — иначе список никогда не разгребается.
 *
 * Снимаются РОВНО две причины. Остальные — отсутствующая дата, адрес, получатель,
 * переплата — ручным интервалом не решаются и остаются: тихо гасить их означало бы
 * выпустить в маршрут заказ, который некуда везти.
 *
 * Функция чистая и общая для импорта и ручного исправления: иначе после первой же
 * синхронизации восстановленные причины разошлись бы с тем, что видит логист.
 */

import type { $Enums } from '../../generated/prisma/client.js';

export type AttentionReason = $Enums.OrderAttentionReason;

/** Причины, которые закрывает корректный ручной интервал. */
const INTERVAL_REASONS: readonly AttentionReason[] = ['MISSING_INTERVAL', 'UNRECOGNIZED_INTERVAL'];

export interface ManualInterval {
  startMinute: number | null;
  endMinute: number | null;
}

/**
 * Состояние адреса, влияющее на «Требует внимания».
 *
 * Обе величины локальные: снимок МоегоСклада о них не знает и знать не может,
 * поэтому они приходят отдельным аргументом, а не через набор причин снимка.
 */
export interface AddressAttention {
  /** Есть действующая локальная правка. */
  corrected: boolean;
  /** Источник разошёлся с правкой и человек ещё не выбрал значение. */
  conflict: boolean;
}

/** Задан ли пригодный ручной интервал. */
export function hasManualInterval(manual: ManualInterval | null | undefined): boolean {
  if (manual === null || manual === undefined) {
    return false;
  }
  const { startMinute, endMinute } = manual;
  return startMinute !== null && endMinute !== null && endMinute > startMinute;
}

/**
 * Причины, которые попадают в карточку заказа.
 * Исходный набор из снимка не изменяется: ревизия хранит его как есть.
 */
export function effectiveAttentionReasons(
  snapshotReasons: readonly AttentionReason[],
  manual: ManualInterval | null | undefined,
  address?: AddressAttention | null,
): AttentionReason[] {
  let reasons = [...snapshotReasons];

  if (hasManualInterval(manual)) {
    reasons = reasons.filter((reason) => !INTERVAL_REASONS.includes(reason));
  }

  // Локальная правка закрывает «Не указан адрес»: адрес у заказа теперь есть,
  // просто его источник — логист, а не МойСклад. Держать заказ в «Требует
  // внимания» после того, как человек уже вписал адрес, значит не давать
  // разгрести список.
  if (address?.corrected === true) {
    reasons = reasons.filter((reason) => reason !== 'MISSING_ADDRESS');
  }

  // Конфликт источника, наоборот, добавляет БЛОКИРУЮЩУЮ причину: пока человек
  // не решил, какой адрес верен, заказ нельзя ни везти, ни ставить в маршрут.
  if (address?.conflict === true && !reasons.includes('ADDRESS_CONFLICT')) {
    reasons.push('ADDRESS_CONFLICT');
  }

  return reasons;
}
