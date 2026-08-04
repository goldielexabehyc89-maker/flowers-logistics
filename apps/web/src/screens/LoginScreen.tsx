/**
 * Экраны входа и первого входа.
 *
 * Ошибки показываются понятным текстом от сервера. При блокировке перебора
 * используется заголовок Retry-After: пользователь видит обратный отсчёт,
 * а интерфейс не блокируется навсегда.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { Button, Field, TextInput } from '../ui/components';
import './login.css';

/** Обратный отсчёт до конца блокировки. */
function useCountdown(seconds: number | null): number {
  const [left, setLeft] = useState(seconds ?? 0);

  useEffect(() => {
    setLeft(seconds ?? 0);
    if (seconds === null || seconds <= 0) {
      return;
    }
    const timer = setInterval(() => {
      setLeft((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  return left;
}

interface FormState {
  error: string | null;
  retryAfter: number | null;
  submitting: boolean;
}

const initialState: FormState = { error: null, retryAfter: null, submitting: false };

function describeError(error: unknown): FormState {
  if (error instanceof ApiError) {
    return {
      error: error.message,
      retryAfter: error.retryAfterSeconds,
      submitting: false,
    };
  }
  return {
    error: 'Нет связи с сервисом. Проверьте подключение.',
    retryAfter: null,
    submitting: false,
  };
}

function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="auth">
      <section className="auth__card">
        <h1>{title}</h1>
        <p className="muted text-sm">{description}</p>
        {children}
        <div className="auth__footer">{footer}</div>
      </section>
    </main>
  );
}

export function LoginScreen(): React.JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [state, setState] = useState<FormState>(initialState);
  const secondsLeft = useCountdown(state.retryAfter);

  const blocked = secondsLeft > 0;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setState({ ...initialState, submitting: true });

    try {
      await login({ phone, pin });
      navigate('/', { replace: true });
    } catch (error) {
      setState(describeError(error));
    }
  };

  return (
    <AuthLayout
      title="Вход в систему"
      description="Телефон и четырёхзначный PIN."
      footer={<Link to="/first-login">Первый вход по временному коду</Link>}
    >
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field label="Телефон">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="tel"
              inputMode="tel"
              autoComplete="username"
              placeholder="+7 916 123-45-67"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          )}
        </Field>

        <Field label="PIN" hint="Четыре цифры">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
        </Field>

        {state.error !== null && (
          <p className="auth__error" role="alert">
            {state.error}
            {blocked && ` Повторить можно через ${secondsLeft} с.`}
          </p>
        )}

        <Button type="submit" variant="primary" loading={state.submitting} disabled={blocked}>
          Войти
        </Button>
      </form>
    </AuthLayout>
  );
}

export function FirstLoginScreen(): React.JSX.Element {
  const { activate } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [pinRepeat, setPinRepeat] = useState('');
  const [state, setState] = useState<FormState>(initialState);
  const secondsLeft = useCountdown(state.retryAfter);

  const blocked = secondsLeft > 0;
  const pinMismatch = pinRepeat.length === 4 && pin !== pinRepeat;

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    if (pin !== pinRepeat) {
      setState({ error: 'PIN и подтверждение не совпадают.', retryAfter: null, submitting: false });
      return;
    }

    setState({ ...initialState, submitting: true });

    try {
      await activate({ phone, code, pin });
      navigate('/', { replace: true });
    } catch (error) {
      setState(describeError(error));
    }
  };

  return (
    <AuthLayout
      title="Первый вход"
      description="Введите телефон, временный код и придумайте собственный PIN. Временный код действует 30 минут."
      footer={<Link to="/login">Обычный вход по PIN</Link>}
    >
      <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Field label="Телефон">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="tel"
              inputMode="tel"
              autoComplete="username"
              placeholder="+7 916 123-45-67"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          )}
        </Field>

        <Field label="Временный код" hint="Четыре цифры от администратора">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
        </Field>

        <Field label="Новый PIN" hint="Четыре цифры, которые вы будете вводить при входе">
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
        </Field>

        <Field
          label="Повторите PIN"
          error={pinMismatch ? 'PIN и подтверждение не совпадают' : undefined}
        >
          {(fieldProps) => (
            <TextInput
              {...fieldProps}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pinRepeat}
              onChange={(event) => setPinRepeat(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
        </Field>

        {state.error !== null && (
          <p className="auth__error" role="alert">
            {state.error}
            {blocked && ` Повторить можно через ${secondsLeft} с.`}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          loading={state.submitting}
          disabled={blocked || pinMismatch}
        >
          Установить PIN и войти
        </Button>
      </form>
    </AuthLayout>
  );
}
