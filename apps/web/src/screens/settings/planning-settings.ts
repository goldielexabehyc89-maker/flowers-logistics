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

export interface DepotDraft {
  name: string;
  address: string;
  lat: string;
  lon: string;
}

/** Ошибка формы склада. `null` — значения пригодны. */
export function depotError(draft: DepotDraft): string | null {
  if (draft.name.trim() === '') {
    return 'Укажите название склада';
  }
  if (draft.address.trim() === '') {
    return 'Укажите адрес склада';
  }

  // Пустое поле — не нулевая координата: `Number('')` равно нулю, и без этой
  // проверки склад молча оказался бы в Гвинейском заливе.
  if (draft.lat.trim() === '' || draft.lon.trim() === '') {
    return 'Укажите широту и долготу склада';
  }

  const lat = parseCoordinate(draft.lat);
  const lon = parseCoordinate(draft.lon);

  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    return 'Широта — число от −90 до 90';
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    return 'Долгота — число от −180 до 180';
  }
  return null;
}

/** Координата из поля: запятая допускается наравне с точкой. */
export function parseCoordinate(value: string): number {
  return Number(value.replace(',', '.'));
}
