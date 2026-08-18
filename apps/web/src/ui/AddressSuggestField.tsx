/**
 * Поле адреса с выпадающим списком подсказок.
 *
 * Один компонент на все формы адреса. Раньше список рисовали в каждой форме
 * по-своему: в одной он раздвигал карточку, в другой оставался обычным
 * перечнем ссылок, клавиатурой не управлялся нигде. Разное поведение в двух
 * местах одной задачи — это два разных навыка для одного и того же действия.
 *
 * Поведение списка:
 *
 * - не больше четырёх строк: это выбор, а не чтение перечня;
 * - список лежит ПОВЕРХ содержимого и ровно под полем в его ширину, поэтому
 *   карточка не прыгает и не растягивается;
 * - работает и мышью, и клавиатурой: стрелки ведут по списку, Enter
 *   принимает, Escape закрывает;
 * - после выбора закрывается и сам собой не открывается, пока человек
 *   не начнёт править текст заново.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Field, TextInput } from './components';
import {
  visibleSuggestions,
  type AddressSuggestion,
} from '../screens/logistics/address-suggestions';
import './address-suggest.css';

export interface AddressSuggestFieldProps {
  label: string;
  hint?: string | undefined;
  value: string;
  onChange: (text: string) => void;
  onPick: (item: AddressSuggestion) => void;
  suggestions: readonly AddressSuggestion[];
  /** Показывать ли список. Решение принимает вызывающая форма. */
  open: boolean;
  inputTestId?: string;
  listTestId?: string;
  placeholder?: string;
}

export function AddressSuggestField({
  label,
  hint,
  value,
  onChange,
  onPick,
  suggestions,
  open,
  inputTestId,
  listTestId,
  placeholder,
}: AddressSuggestFieldProps): React.JSX.Element {
  const items = visibleSuggestions(suggestions);
  const listId = useId();
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  /*
   * Escape закрывает список, не трогая текст.
   *
   * Отдельное состояние, а не изменение текста: человек мог просто убрать
   * список с глаз, чтобы увидеть карточку под ним, и терять при этом набранное
   * он не должен.
   */
  const [dismissed, setDismissed] = useState(false);

  const visible = open && !dismissed && items.length > 0;

  // Новый набор подсказок начинает выбор заново: подсвеченной остаётся
  // первая строка, а не та, что случайно оказалась под тем же номером.
  useEffect(() => {
    setActive(0);
  }, [items.length, value]);

  useEffect(() => {
    setDismissed(false);
  }, [value]);

  // Клик мимо списка закрывает его: открытый поверх содержимого перечень,
  // который нельзя убрать мышью, ведёт себя как поломка.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const onDocumentClick = (event: MouseEvent): void => {
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target as Node)) {
        setDismissed(true);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [visible]);

  function pick(item: AddressSuggestion): void {
    setDismissed(true);
    onPick(item);
  }

  return (
    <div className="suggest" ref={containerRef}>
      <Field label={label} {...(hint === undefined ? {} : { hint })}>
        {(props) => (
          <TextInput
            {...props}
            value={value}
            role="combobox"
            aria-expanded={visible}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={visible ? `${listId}-${active}` : undefined}
            {...(placeholder === undefined ? {} : { placeholder })}
            {...(inputTestId === undefined ? {} : { 'data-testid': inputTestId })}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (!visible) {
                return;
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => (current + 1) % items.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => (current - 1 + items.length) % items.length);
                return;
              }
              if (event.key === 'Enter') {
                const item = items[active];
                if (item !== undefined) {
                  // Enter принимает подсказку, а не отправляет форму: иначе
                  // адрес сохранялся бы в том виде, в каком человек его набрал.
                  event.preventDefault();
                  pick(item);
                }
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(true);
              }
            }}
          />
        )}
      </Field>

      {visible && (
        <ul className="suggest__list" id={listId} role="listbox" data-testid={listTestId}>
          {items.map((item, index) => (
            <li key={item.value}>
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={
                  index === active ? 'suggest__item suggest__item--active' : 'suggest__item'
                }
                data-testid="suggest-item"
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(item)}
              >
                <span className="suggest__value">{item.value}</span>
                <span className="suggest__note">
                  {item.exact ? 'точка найдена' : 'без точной привязки'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
