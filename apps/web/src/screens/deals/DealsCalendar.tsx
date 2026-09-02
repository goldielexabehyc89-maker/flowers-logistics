/**
 * Календарь дня в «Сделках».
 *
 * Главное правило экрана: ЛИСТАНИЕ МЕСЯЦА и ВЫБОР ДНЯ — разные действия.
 * Стрелки ‹ › меняют только отображаемый месяц (`view`) и не трогают ни
 * выбранную дату, ни запросы списка и карты: экран не мигает и общий индикатор
 * загрузки не появляется. Данные обновляются РОВНО один раз — по клику на
 * конкретный день (`onSelect`). После ответа сервера календарь сам к текущему
 * месяцу не возвращается: отображаемый месяц принадлежит тому, кто листает.
 *
 * Отображаемый месяц синхронизируется с выбранной датой только в момент
 * ОТКРЫТИЯ попапа — чтобы открыть на месяце выбранного дня, а не на «сегодня».
 */

import { useEffect, useRef, useState } from 'react';
import { formatCalendarDate, moscowToday } from '@fl/shared';
import {
  monthGrid,
  monthOf,
  monthTitle,
  stepMonth,
  WEEKDAY_LABELS,
  type CalendarMonth,
} from './deals-calendar';

function initialView(value: string, today: string): CalendarMonth {
  return monthOf(value) ?? monthOf(today) ?? { year: 2026, month: 1 };
}

export function DealsCalendar({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (date: string) => void;
}): React.JSX.Element {
  const today = moscowToday();
  const [open, setOpen] = useState(false);
  // Отображаемый месяц — СВОЁ состояние, отдельное от выбранной даты.
  const [view, setView] = useState<CalendarMonth>(() => initialView(value, today));
  const rootRef = useRef<HTMLDivElement>(null);

  // Открытие показывает месяц ВЫБРАННОГО дня (не «сегодня»). Пока попап открыт,
  // месяц пересинхронизацией не сбивается — им управляют только стрелки.
  const openPicker = (): void => {
    setView(initialView(value, today));
    setOpen(true);
  };

  // Закрытие по клику вне попапа и по Escape. Зависит только от `open` и
  // использует стабильный setter — лишних перерисовок и утечек нет.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cells = monthGrid(view).flat();

  return (
    <div className="deals__calendar" ref={rootRef} data-testid="deals-day">
      <button
        type="button"
        className="deals__calendar-trigger"
        data-testid="deals-day-trigger"
        aria-label="День"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        {formatCalendarDate(value)}
      </button>
      {open && (
        <div
          className="deals__calendar-pop"
          data-testid="deals-calendar"
          role="dialog"
          aria-label="Выбор рабочего дня"
        >
          <div className="deals__calendar-head">
            <button
              type="button"
              className="deals__calendar-nav"
              data-testid="deals-cal-prev"
              aria-label="Предыдущий месяц"
              onClick={() => setView((current) => stepMonth(current, -1))}
            >
              ‹
            </button>
            <span className="deals__calendar-month" data-testid="deals-cal-month">
              {monthTitle(view)}
            </span>
            <button
              type="button"
              className="deals__calendar-nav"
              data-testid="deals-cal-next"
              aria-label="Следующий месяц"
              onClick={() => setView((current) => stepMonth(current, 1))}
            >
              ›
            </button>
          </div>
          <div className="deals__calendar-grid">
            {WEEKDAY_LABELS.map((weekday) => (
              <span key={weekday} className="deals__calendar-weekday">
                {weekday}
              </span>
            ))}
            {cells.map((iso, index) =>
              iso === null ? (
                <span
                  key={`pad-${String(index)}`}
                  className="deals__calendar-cell deals__calendar-cell--empty"
                  aria-hidden="true"
                />
              ) : (
                <button
                  key={iso}
                  type="button"
                  className={[
                    'deals__calendar-cell',
                    iso === value ? 'is-selected' : '',
                    iso === today ? 'is-today' : '',
                  ]
                    .filter((cls) => cls !== '')
                    .join(' ')}
                  data-testid="deals-cal-day"
                  data-date={iso}
                  aria-pressed={iso === value}
                  onClick={() => {
                    // ЕДИНственное место, где меняется рабочая дата и идёт запрос.
                    onSelect(iso);
                    setOpen(false);
                  }}
                >
                  {Number(iso.slice(8, 10))}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
