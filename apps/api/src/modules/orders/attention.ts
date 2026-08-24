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
import { blocksLogistics } from '@fl/shared';

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
  /**
   * Заказ живёт по новому контракту, но рабочего адреса из частей не вышло.
   *
   * Отдельный признак, а не причина из снимка: снимок не знает версию
   * контракта заказа — её выбирает импорт при создании нашей строки.
   */
  structuredIncomplete?: boolean;
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
/**
 * Ставить ли заказу признак «Требует внимания».
 *
 * Признак рабочий, а не описательный: он красит карточку, поднимает её вверх
 * и убирает заказ с карты. Поэтому его ставит только то, что мешает логисту
 * распределить заказ, — адрес, точка и интервал. Отсутствующий получатель,
 * вопросы к дате и денежные расхождения остаются в наборе причин как сведения,
 * но работу логиста не блокируют: разбираются они на других экранах.
 *
 * Разрешённый список лежит в `@fl/shared`, чтобы сервер и клиент не разошлись,
 * и новая причина импорта не становилась блокирующей молча.
 */
export function needsLogisticsAttention(reasons: readonly AttentionReason[]): boolean {
  return blocksLogistics(reasons);
}

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
    reasons = reasons.filter(
      // Та же правка снимает и «геокодеру адреса мало»: автоматическим
      // источником становится адрес логиста, и данных теперь достаточно.
      (reason) => reason !== 'MISSING_ADDRESS' && reason !== 'GEOCODING_ADDRESS_INCOMPLETE',
    );
  }

  /*
   * Новый контракт без города, улицы или дома — это тот же случай «геокодеру
   * адреса мало», что и у разобранного источника. Причина берётся
   * существующая: второе имя для одного и того же состояния заставило бы
   * логиста гадать, чем они различаются.
   *
   * Правка логиста снимает её выше по этой же функции — там же, где снимает
   * её у legacy-заказов.
   */
  if (
    address?.structuredIncomplete === true &&
    address.corrected !== true &&
    !reasons.includes('GEOCODING_ADDRESS_INCOMPLETE')
  ) {
    reasons.push('GEOCODING_ADDRESS_INCOMPLETE');
  }

  // Конфликт источника, наоборот, добавляет БЛОКИРУЮЩУЮ причину: пока человек
  // не решил, какой адрес верен, заказ нельзя ни везти, ни ставить в маршрут.
  if (address?.conflict === true && !reasons.includes('ADDRESS_CONFLICT')) {
    reasons.push('ADDRESS_CONFLICT');
  }

  return reasons;
}
