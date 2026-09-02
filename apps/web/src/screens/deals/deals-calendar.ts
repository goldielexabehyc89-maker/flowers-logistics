/**
 * Чистая арифметика календаря «Сделок».
 *
 * Отдельно от React, потому что здесь легко ошибиться на границах месяца и года,
 * а такие ошибки видно только руками. Всё считается на UTC-датах: часовой пояс
 * тут не участвует — календарь оперирует КАЛЕНДАРНЫМИ днями (строки YYYY-MM-DD),
 * а не моментами времени. «Сегодня» приходит извне готовой строкой (московский
 * день), чтобы и оно не зависело от пояса браузера.
 *
 * Ключевая идея экрана: ОТОБРАЖАЕМЫЙ месяц (`CalendarMonth`) и ВЫБРАННАЯ рабочая
 * дата — разные величины. Стрелки листают месяц и дату не трогают; выбор дня —
 * отдельное действие. Поэтому здесь нет ни «сегодня по умолчанию», ни возврата
 * к текущему месяцу: месяц задаёт только тот, кто листает.
 */

export interface CalendarMonth {
  /** Полный год, например 2026. */
  year: number;
  /** Месяц 1–12 (не 0–11: ноль-индекс — источник ошибок на границе года). */
  month: number;
}

const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

/** Дни недели с понедельника: рабочая неделя начинается с него. */
export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

/** Месяц выбранной даты. Пустая/битая строка — null: вызывающий подставит сегодня. */
export function monthOf(iso: string): CalendarMonth | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

/**
 * Сдвиг отображаемого месяца на `delta` месяцев (обычно ±1).
 *
 * Год переносится сам: декабрь+1 → январь следующего, январь−1 → декабрь
 * предыдущего. Ровно ради этого — отдельная функция с прямыми проверками.
 */
export function stepMonth(view: CalendarMonth, delta: number): CalendarMonth {
  // Считаем в «абсолютных месяцах» от нулевого года: перенос года выходит сам.
  const total = view.year * 12 + (view.month - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month };
}

/** Человеческий заголовок месяца: «Сентябрь 2026». */
export function monthTitle(view: CalendarMonth): string {
  return `${MONTH_NAMES[view.month - 1]} ${view.year}`;
}

/** Двузначная строка: 3 → «03». */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO-строка дня месяца: (2026, 9, 1) → «2026-09-01». */
export function isoOf(view: CalendarMonth, day: number): string {
  return `${view.year}-${pad2(view.month)}-${pad2(day)}`;
}

/** Сколько дней в месяце. День 0 следующего месяца — последний день этого. */
export function daysInMonth(view: CalendarMonth): number {
  return new Date(Date.UTC(view.year, view.month, 0)).getUTCDate();
}

/**
 * Индекс дня недели 1-го числа, где 0 = понедельник … 6 = воскресенье.
 *
 * `getUTCDay` даёт 0 = воскресенье; сдвигаем к понедельнику. UTC — чтобы пояс
 * браузера не сдвинул день.
 */
function firstWeekdayMondayZero(view: CalendarMonth): number {
  const dow = new Date(Date.UTC(view.year, view.month - 1, 1)).getUTCDay();
  return (dow + 6) % 7;
}

/**
 * Сетка месяца: недели по 7 ячеек, каждая — ISO-день или null (добивка до сетки).
 *
 * Пустые ячейки в начале и в конце нужны, чтобы дни стояли под своими днями
 * недели. Полных недель столько, сколько нужно ровно этому месяцу, — лишних
 * строк не рисуем.
 */
export function monthGrid(view: CalendarMonth): (string | null)[][] {
  const total = daysInMonth(view);
  const lead = firstWeekdayMondayZero(view);
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i += 1) {
    cells.push(null);
  }
  for (let day = 1; day <= total; day += 1) {
    cells.push(isoOf(view, day));
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}
