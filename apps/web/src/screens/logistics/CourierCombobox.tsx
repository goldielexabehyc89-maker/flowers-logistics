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
 * Рисуется он в портале на `body`, а не рядом с полем. Внутри модального окна
 * список обрезался его нижней границей: окно ограничено высотой экрана и
 * прокручивает середину, поэтому всё, что вылезает за неё, просто исчезает —
 * последний курьер был не виден и недоступен для выбора. Портал этой границы
 * не знает; положение и высота считаются от места поля на экране, а при
 * нехватке места снизу список открывается вверх.
 *
 * Правила отбора живут отдельно и проверяются без браузера (`courier-picker`):
 * поиск идёт и по имени, и по телефону, а произвольная строка никого не создаёт —
 * назначением становится только выбор существующего сотрудника.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  /**
   * Как называется пустой выбор.
   *
   * В карточке маршрута пусто означает «курьер не назначен», а в строке
   * отбора — «любой курьер»: это разные утверждения, и одно вместо другого
   * читается как ошибка.
   */
  emptyLabel?: string;
  testId?: string;
  onChange: (courier: CourierOption | null) => void;
}

export function CourierCombobox({
  options,
  value,
  emptyLabel = UNASSIGNED_LABEL,
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
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const listId = useId();

  /*
   * Куда рисовать список.
   *
   * `document.body` не годится, когда контрол стоит в модальном окне: открытый
   * `<dialog>` живёт в верхнем слое браузера и перехватывает указатель у всего,
   * что лежит под ним. Список в `body` был бы виден, но не нажимаем. Поэтому
   * целью становится сам диалог, если он есть; `position: fixed` при этом всё
   * равно выводит список из-под его прокрутки — обрезка шла именно оттуда.
   */
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const field = fieldRef.current;
    setHost(field?.closest('dialog') ?? document.body);
  }, [open]);

  /** Где и какой высоты рисовать список. Считается от места поля на экране. */
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const matching = filterCouriers(options, query);

  /*
   * Пересчёт положения.
   *
   * `useLayoutEffect`, а не `useEffect`: список уже в разметке, и один кадр
   * в неверном месте виден как рывок. Пересчитывается и при прокрутке любого
   * предка (`capture`), иначе список остаётся висеть там, где поле было.
   */
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }

    const measure = (): void => {
      const field = fieldRef.current;
      if (field === null) {
        return;
      }
      const rect = field.getBoundingClientRect();
      const gap = 4;
      const margin = 12;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      // Снизу тесно — открываемся вверх, но только если сверху действительно
      // просторнее: иначе список прыгал бы при каждом лишнем пикселе.
      const dropUp = below < 160 && above > below;
      const maxHeight = Math.max(120, Math.floor(dropUp ? above : below));
      setBox({
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        top: Math.round(dropUp ? rect.top - gap - maxHeight : rect.bottom + gap),
        maxHeight,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, matching.length]);

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
      const list = listRef.current;
      if (!(event.target instanceof Node)) {
        return;
      }
      // Список живёт в портале и в `rootRef` не входит: без явной проверки
      // нажатие по собственному варианту закрывало бы список до выбора.
      const inside =
        (root !== null && root.contains(event.target)) ||
        (list !== null && list.contains(event.target));
      if (!inside) {
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
        ref={fieldRef}
        type="text"
        className="courier-combobox__field"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        disabled={disabled}
        placeholder={emptyLabel}
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

      {open &&
        box !== null &&
        host !== null &&
        createPortal(
          <ul
            ref={listRef}
            className="courier-combobox__list"
            id={listId}
            role="listbox"
            data-testid={`${testId}-list`}
            style={{
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              maxHeight: `${box.maxHeight}px`,
            }}
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
                {emptyLabel}
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
          </ul>,
          host,
        )}
    </div>
  );
}
