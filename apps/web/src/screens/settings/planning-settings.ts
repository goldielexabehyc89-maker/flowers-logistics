/**
 * Правила форм настроек планирования.
 *
 * Вынесены из компонентов: проверяются без браузера и отвечают на вопросы,
 * от которых зависит, попадёт ли в систему бессмысленное значение — смена,
 * заканчивающаяся раньше начала, или координата вне Земли.
 *
 * Клиентская проверка не защита: решение всегда принимает сервер. Она нужна,
 * чтобы человек увидел ошибку рядом с полем, а не в виде отказа после отправки.
 */

export const MINUTES_IN_DAY = 24 * 60;

/** `«09:30»` → 570. `null` — значение не является временем суток. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/** 570 → `«09:30»`. Единственное место, где минуты превращаются во время. */
export function formatTimeOfDay(minute: number): string {
  const normalized = ((minute % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hours = String(Math.floor(normalized / 60)).padStart(2, '0');
  const minutes = String(normalized % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export interface ShiftDraft {
  start: string;
  end: string;
}

/** Ошибка формы смены. `null` — значения пригодны. */
export function shiftError(draft: ShiftDraft): string | null {
  const start = parseTimeOfDay(draft.start);
  const end = parseTimeOfDay(draft.end);

  if (start === null || end === null) {
    return 'Укажите время в формате ЧЧ:ММ';
  }
  if (end <= start) {
    // Смена, заканчивающаяся раньше начала, — это не «ночная смена», а опечатка:
    // переход через полночь система не поддерживает и не притворяется, что умеет.
    return 'Окончание смены должно быть позже начала';
  }
  return null;
}

/** Ошибка формы времени обслуживания. `null` — значения пригодны. */
export function serviceTimeError(carMinutes: string, footMinutes: string): string | null {
  for (const value of [carMinutes, footMinutes]) {
    // Пустое поле проверяется отдельно: `Number('')` равно нулю, и без этой
    // проверки незаполненная форма молча сохранила бы нулевое обслуживание.
    const parsed = value.trim() === '' ? Number.NaN : Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 120) {
      return 'Время обслуживания — целое число минут от 0 до 120';
    }
  }
  return null;
}

/**
 * Черновик склада.
 *
 * Точка не набирается руками: она приходит вместе с выбранной подсказкой
 * адреса. Набранные вручную координаты ничем не связаны с адресом — именно
 * так склад оказывался в Гвинейском заливе, не показывался на карте и ронял
 * расчёт без внятной причины.
 */
export interface DepotDraft {
  name: string;
  /** Текст в поле адреса. Может отличаться от выбранной подсказки. */
  address: string;
  /** Точка из выбранной подсказки. `null` — подсказка не выбрана. */
  point: { value: string; lat: number; lon: number } | null;
}

export const EMPTY_DEPOT_DRAFT: DepotDraft = { name: '', address: '', point: null };

/**
 * Выбранная точка действительна, только пока текст адреса ей соответствует.
 *
 * Логист мог выбрать подсказку и дописать «, подъезд 2»: координаты остались бы
 * от прежней строки, и склад молча указывал бы не туда.
 */
export function activePoint(draft: DepotDraft): { lat: number; lon: number } | null {
  if (draft.point === null || draft.point.value !== draft.address) {
    return null;
  }
  return { lat: draft.point.lat, lon: draft.point.lon };
}

/**
 * Подпись под полем адреса склада.
 *
 * Когда подсказки не настроены, склад сохранить нельзя — и предлагать ввести
 * координаты руками тоже нельзя: это и есть та поломка, от которой уходим.
 * Честнее сказать, что подсказки не настроены.
 */
export function depotSuggestHint(available: boolean): string {
  return available
    ? 'Начните вводить адрес и выберите подсказку — точка определится сама'
    : 'Подсказки адреса не настроены: без них склад не получит точку';
}

/** Ошибка формы склада. `null` — значения пригодны. */
export function depotError(draft: DepotDraft): string | null {
  if (draft.name.trim() === '') {
    return 'Укажите название склада';
  }
  if (draft.address.trim() === '') {
    return 'Укажите адрес склада';
  }
  if (activePoint(draft) === null) {
    // Напечатанный, но не выбранный адрес координат не даёт. Предлагать ввести
    // их руками здесь нельзя: это возвращает ровно ту поломку, от которой уходим.
    return 'Выберите адрес из подсказок: без точки склад не будет работать';
  }
  return null;
}
