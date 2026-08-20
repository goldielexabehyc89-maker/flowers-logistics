/**
 * Минимальный набор переиспользуемых компонентов.
 *
 * Это не универсальный UI-kit: здесь ровно то, что нужно текущим экранам.
 * Доступность обязательна — подписи связаны с полями, у кнопок явный type,
 * сообщения объявляются через aria-live.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './components.css';

/**
 * Размер иконки интерфейса.
 *
 * Одно значение на всё приложение: иконка в меню, в кнопке и в заголовке — это
 * один и тот же знак, и разнобой в один-два пикселя заметен именно там, где
 * они стоят рядом.
 */
export const ICON_SIZE = 17;

// ---------------------------------------------------------------------------
// Кнопка
// ---------------------------------------------------------------------------

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  children,
  // Явный type обязателен: кнопка без него внутри формы отправляет её.
  type = 'button',
  className,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={['btn', `btn--${variant}`, className].filter(Boolean).join(' ')}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? 'Подождите…' : children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Поля ввода
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (fieldProps: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
}

/**
 * Обёртка поля: связывает подпись, подсказку и сообщение об ошибке.
 *
 * `aria-invalid` выставляется здесь же, вместе с сообщением. Раньше о негодном
 * значении говорил только текст под полем: экранный диктор произносил его лишь
 * тогда, когда до него доходила очередь, а само поле считалось исправным.
 * Признак нужен и глазам — по нему поле получает контур, и ошибка перестаёт
 * держаться на одном красном оттенке.
 */
export function Field({ label, hint, error, children }: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error === undefined ? undefined : true,
      })}
      {hint !== undefined && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Пропсы поля ввода.
 *
 * `ComponentProps<'input'>` вместо `InputHTMLAttributes` намеренно: он включает
 * `ref`, а складским полям нужен фокус после каждого успешного скана. В React 19
 * `ref` передаётся обычным пропом, поэтому обёртка `forwardRef` не требуется.
 */
export type TextInputProps = React.ComponentProps<'input'>;

export function TextInput(props: TextInputProps): React.JSX.Element {
  return <input {...props} className={['input', props.className].filter(Boolean).join(' ')} />;
}

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export function Select(props: SelectProps): React.JSX.Element {
  return <select {...props} className={['input', props.className].filter(Boolean).join(' ')} />;
}

// ---------------------------------------------------------------------------
// Статусы
// ---------------------------------------------------------------------------

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export function StatusBadge({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}): React.JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Состояния списков
// ---------------------------------------------------------------------------

export function LoadingState({ title = 'Загрузка…' }: { title?: string }): React.JSX.Element {
  return (
    <div className="state" role="status" aria-live="polite">
      {title}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <div className="state">
      <strong>{title}</strong>
      {description !== undefined && <p className="muted text-sm">{description}</p>}
    </div>
  );
}

export function ErrorState({
  title = 'Не удалось загрузить данные',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div className="state state--error" role="alert">
      <strong>{title}</strong>
      {description !== undefined && <p className="text-sm">{description}</p>}
      {onRetry !== undefined && (
        <Button variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Модальное окно
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Закрытие по Escape и крестиком. Отключается там, где нужен явный выбор. */
  dismissible?: boolean;
  /**
   * Закрытие кликом по затемнению.
   *
   * По умолчанию выключено: окно с наполовину заполненной формой не должно
   * исчезать от промаха мимо поля. Включается там, где окно только показывает
   * данные и случайное закрытие ничего не теряет.
   */
  dismissOnBackdrop?: boolean;
  /** Дополнительный класс окна: ширина зависит от содержимого, а не от компонента. */
  className?: string;
  /** Метка для браузерных проверок: они обязаны отличать одно окно от другого. */
  testId?: string;
}

/**
 * Модальное окно на native <dialog>: браузер сам обеспечивает фокус-ловушку,
 * закрытие по Escape, верхний слой поверх остальной страницы и корректную роль
 * для программ чтения с экрана.
 *
 * ВЕРХНИЙ СЛОЙ ВАЖЕН НЕ КАК ЭФФЕКТ. Окно, вставленное обычным блоком в конец
 * страницы, оказывается ниже всего списка: человек нажимает кнопку и не видит
 * ничего. `showModal()` кладёт окно в top layer поверх текущей прокрутки, и
 * оно появляется там, куда человек смотрит.
 *
 * ОКНО В ОКНЕ ДОПУСТИМО. Второй `showModal()` встаёт поверх первого, и Escape
 * закрывает только верхнее: фотографию можно закрыть, не потеряв карточку.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  dismissible = true,
  dismissOnBackdrop = false,
  className,
  testId,
}: ModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      // Запоминаем элемент, вызвавший окно, чтобы вернуть ему фокус после закрытия.
      openerRef.current = document.activeElement;
      dialog.showModal();
    }

    if (!open && dialog.open) {
      dialog.close();
      if (openerRef.current instanceof HTMLElement) {
        openerRef.current.focus();
      }
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    const handleCancel = (event: Event): void => {
      event.preventDefault();
      if (dismissible) {
        onClose();
      }
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [dismissible, onClose]);

  /**
   * Клик по затемнению.
   *
   * Затемнение — псевдоэлемент самого `<dialog>`, поэтому событие приходит с
   * `target === dialog`. Проверка именно такая: клик по любому содержимому
   * окна имеет другую цель и закрытием не считается.
   */
  function handleBackdropClick(event: React.MouseEvent<HTMLDialogElement>): void {
    if (dismissible && dismissOnBackdrop && event.target === dialogRef.current) {
      onClose();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={['modal', className].filter(Boolean).join(' ')}
      aria-label={title}
      data-testid={testId}
      onClick={handleBackdropClick}
    >
      <div className="modal__header">
        <h2>{title}</h2>
        {dismissible && (
          <Button variant="ghost" onClick={onClose} aria-label="Закрыть">
            <X size={ICON_SIZE} aria-hidden />
          </Button>
        )}
      </div>
      <div className="modal__body">{children}</div>
      {footer !== undefined && <div className="modal__footer">{footer}</div>}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      // Пока операция выполняется, окно нельзя закрыть ни крестиком, ни Escape:
      // её результат может содержать значение, которое показывается один раз.
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description}
    </Modal>
  );
}

/**
 * Шторка рабочего процесса.
 *
 * На телефоне открывается снизу, на широком экране — тем же окном по центру.
 * Это НЕ второй вид модального окна: разница только в геометрии, поэтому
 * компонент построен на том же `Modal`, а не на собственном `<dialog>`.
 * Второй реализацией пришлось бы заново получать фокус-ловушку, Escape,
 * верхний слой и возврат фокуса — всё то, что здесь уже работает.
 *
 * Ширина ограничена: шторка ведёт ОДНО действие — заголовок, короткий контекст,
 * текущий шаг. Широкие формы остаются обычным `Modal`.
 */
export type DrawerProps = Omit<ModalProps, 'className'>;

export function Drawer(props: DrawerProps): React.JSX.Element | null {
  return <Modal {...props} className="modal--drawer" />;
}

// ---------------------------------------------------------------------------
// Заголовок страницы, фильтры и переключатель режима
// ---------------------------------------------------------------------------

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Основное действие раздела или переключатель режима. */
  actions?: ReactNode;
}

/**
 * Заголовок страницы: белая закреплённая панель над содержимым.
 *
 * Заголовок здесь `<h2>`, а не `<h1>`: имя раздела уже объявлено оболочкой
 * в верхней строке, и второй `<h1>` на странице сделал бы структуру документа
 * неоднозначной для программ чтения с экрана.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps): React.JSX.Element {
  return (
    <div className="page-header">
      <div className="page-header__title">
        <h2>{title}</h2>
        {description !== undefined && <p className="muted text-sm">{description}</p>}
      </div>
      {actions !== undefined && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}

/**
 * Панель фильтров.
 *
 * На широком экране поля выстраиваются в строку, на телефоне складываются
 * в столбец. Отдельная поверхность нужна, чтобы фильтры не читались как часть
 * данных: иначе строка поиска выглядит первой строкой таблицы.
 */
export function FilterPanel({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="filters">
      <div className="filters__fields">{children}</div>
      {actions !== undefined && <div className="filters__actions">{actions}</div>}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Метка для браузерных проверок. */
  testId?: string;
  /**
   * Число рядом с подписью: количество активных заказов, непрочитанных заданий.
   *
   * Живёт на самом переключателе, а не в заголовке раздела: переключатель виден
   * на всех режимах, и число не исчезает при уходе на соседний.
   */
  badge?: ReactNode;
  badgeTestId?: string;
  /** Что означает число. Без этого программа чтения с экрана называет голую цифру. */
  badgeLabel?: string;
}

/**
 * Компактный переключатель режима.
 *
 * Одновременно активен строго один вариант, поэтому кнопки объявлены группой
 * с `aria-pressed`, а не набором независимых переключателей: программа чтения
 * с экрана обязана сообщать, какой режим выбран сейчас.
 *
 * Значение приходит извне и НЕ хранится внутри: у режима, как правило, есть
 * query-параметр, и внутреннее состояние разошлось бы с адресом страницы.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={active ? 'segmented__item segmented__item--active' : 'segmented__item'}
            aria-pressed={active}
            data-testid={option.testId}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.badge !== undefined && option.badge !== null && (
              <span
                className="segmented__badge"
                data-testid={option.badgeTestId}
                aria-label={option.badgeLabel}
              >
                {option.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Таблица и постраничная навигация
// ---------------------------------------------------------------------------

/**
 * Поверхность таблицы или списка.
 *
 * Класс `table-wrap` сохранён: на него уже ссылаются существующие разделы,
 * и переименование потребовало бы одновременной правки каждого из них.
 *
 * Адаптивность живёт в стилях поверхности, а не во второй разметке: на телефоне
 * строки таблицы разворачиваются в компактные карточки. Два набора DOM на одну
 * таблицу означали бы два источника правды и удвоенные совпадения в браузерных
 * проверках. Раздел добавляет ячейкам `data-label`, чтобы в карточке осталась
 * подпись столбца; без него поведение прежнее.
 */
/**
 * Меню редких действий.
 *
 * Появилось потому, что четыре кнопки в строке списка превращают её в блок
 * высотой с карточку: строка перестаёт просматриваться взглядом, а список —
 * сравниваться. В строке остаётся то, что делают каждый день, остальное живёт
 * здесь.
 *
 * Меню закрывается по Escape и по нажатию снаружи, и в обоих случаях фокус
 * возвращается на кнопку: человек, вызвавший меню с клавиатуры, иначе оказался
 * бы в начале страницы. `aria-expanded` обязателен — без него кнопка не
 * сообщает, раскрыта она или нет.
 */
export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean | undefined;
  testId?: string | undefined;
}

export function ActionMenu({
  label = 'Ещё',
  items,
  testId,
}: {
  label?: string;
  items: readonly ActionMenuItem[];
  testId?: string | undefined;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Пустое меню не рисуется вовсе: кнопка, за которой ничего нет, обманывает.
  if (items.length === 0) {
    return null;
  }

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="btn btn--ghost action-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          className="action-menu__list"
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              /*
               * Останавливаем всплытие: тот же Escape внутри модального окна
               * закрыл бы окно целиком, и человек потерял бы форму, всего лишь
               * свернув меню.
               */
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="action-menu__item"
              disabled={item.disabled === true}
              data-testid={item.testId}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DataSurface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={['table-wrap', className].filter(Boolean).join(' ')}>{children}</div>;
}

export function Pagination({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}): React.JSX.Element | null {
  if (total <= limit) {
    return null;
  }

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="pagination">
      <Button onClick={() => onChange(Math.max(0, offset - limit))} disabled={offset === 0}>
        Назад
      </Button>
      <span className="text-sm muted">
        Страница {page} из {pages} · всего {total}
      </span>
      <Button onClick={() => onChange(offset + limit)} disabled={offset + limit >= total}>
        Вперёд
      </Button>
    </div>
  );
}
