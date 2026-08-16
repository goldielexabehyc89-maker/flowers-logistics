/**
 * Выбор курьера.
 *
 * Один контрол на все три вкладки. Раньше в каждом месте был свой почти-комбобокс,
 * и вели они себя по-разному: где-то список открывался только после ввода, где-то
 * его приходилось звать отдельной ссылкой. Логист при этом всюду ждёт одного и
 * того же: нажал в поле — увидел список, начал печатать — список сузился.
 *
 * Поле и есть кнопка открытия. Список рисуется НАД содержимым и не растягивает
 * карточку: в маршрутном листе он иначе раздвигал бы заказы под собой.
 *
 * Правила отбора живут отдельно и проверяются без браузера (`courier-picker`):
 * поиск идёт и по имени, и по телефону, а произвольная строка никого не создаёт —
 * назначением становится только выбор существующего сотрудника.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { courierLabel, filterCouriers, type CourierOption } from '../deals/courier-picker';
import './courier-combobox.css';

/** Что показывает первая строка списка и пустое поле. */
export const UNASSIGNED_LABEL = '— Курьер не назначен —';

export interface CourierComboboxProps {
  options: readonly CourierOption[];
  /** Текущий курьер. `null` — не назначен. */
  value: CourierOption | null;
  disabled?: boolean;
  /** Подпись поля для чтения с экрана. */
  label?: string;
  testId?: string;
  onChange: (courier: CourierOption | null) => void;
}

export function CourierCombobox({
  options,
  value,
  disabled = false,
  label = 'Курьер',
  testId = 'courier-combobox',
  onChange,
}: CourierComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** Строка под клавиатурой. −1 — «Курьер не назначен». */
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const matching = filterCouriers(options, query);

  /*
   * Клик вне контрола закрывает список.
   *
   * Слушатель ставится только пока список открыт: постоянный обработчик на
   * документе стоил бы реакции на каждый клик страницы.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

  function close(): void {
    setOpen(false);
    setQuery('');
    setActive(-1);
  }

  function pick(courier: CourierOption | null): void {
    onChange(courier);
    close();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      /*
       * Escape закрывает список и НИЧЕГО не меняет: набранное не становится
       * выбором. Действие браузера отменяется намеренно — внутри модального
       * окна тот же Escape закрыл бы всё окно целиком, и человек потерял бы
       * заполненную форму, всего лишь свернув список.
       */
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const last = matching.length - 1;
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        return Math.min(Math.max(next, -1), last);
      });
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      pick(active === -1 ? null : (matching[active] ?? null));
    }
  }

  return (
    <div className="courier-combobox" ref={rootRef} data-testid={testId}>
      <input
        type="text"
        className="courier-combobox__field"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        disabled={disabled}
        placeholder={UNASSIGNED_LABEL}
        // Пока список открыт, в поле живёт запрос; закрытое поле показывает выбор.
        value={open ? query : value === null ? '' : courierLabel(value)}
        data-testid={`${testId}-field`}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />

      {open && (
        <ul
          className="courier-combobox__list"
          id={listId}
          role="listbox"
          data-testid={`${testId}-list`}
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={
                active === -1
                  ? 'courier-combobox__option courier-combobox__option--active courier-combobox__option--empty'
                  : 'courier-combobox__option courier-combobox__option--empty'
              }
              data-testid={`${testId}-clear`}
              onMouseEnter={() => setActive(-1)}
              onClick={() => pick(null)}
            >
              {UNASSIGNED_LABEL}
            </button>
          </li>

          {matching.length === 0 ? (
            <li className="courier-combobox__empty" data-testid={`${testId}-nothing`}>
              Подходящих курьеров нет. Новый сотрудник здесь не создаётся.
            </li>
          ) : (
            matching.map((option, index) => (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === value?.id}
                  className={
                    index === active
                      ? 'courier-combobox__option courier-combobox__option--active'
                      : 'courier-combobox__option'
                  }
                  data-testid={`${testId}-option`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(option)}
                >
                  {courierLabel(option)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
