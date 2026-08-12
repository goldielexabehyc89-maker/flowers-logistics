/**
 * Минимальный набор переиспользуемых компонентов.
 *
 * Это не универсальный UI-kit: здесь ровно то, что нужно текущим экранам.
 * Доступность обязательна — подписи связаны с полями, у кнопок явный type,
 * сообщения объявляются через aria-live.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import './components.css';

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
  children: (fieldProps: { id: string; 'aria-describedby': string | undefined }) => ReactNode;
}

/** Обёртка поля: связывает подпись, подсказку и сообщение об ошибке. */
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
      {children({ id, 'aria-describedby': describedBy })}
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
  /** Закрытие по Escape и клику вне окна. Отключается там, где нужен явный выбор. */
  dismissible?: boolean;
}

/**
 * Модальное окно на native <dialog>: браузер сам обеспечивает фокус-ловушку,
 * закрытие по Escape и корректную роль для программ чтения с экрана.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  dismissible = true,
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

  return (
    <dialog ref={dialogRef} className="modal" aria-label={title}>
      <div className="modal__header">
        <h2>{title}</h2>
        {dismissible && (
          <Button variant="ghost" onClick={onClose} aria-label="Закрыть">
            ✕
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

// ---------------------------------------------------------------------------
// Таблица и постраничная навигация
// ---------------------------------------------------------------------------

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
