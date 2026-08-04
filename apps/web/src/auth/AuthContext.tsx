/**
 * Состояние авторизации на клиенте.
 *
 * Access-токен живёт только внутри ApiClient. Здесь хранится сам пользователь
 * и статус проверки сессии. При запуске приложения выполняется попытка обновления
 * сессии по httpOnly cookie: если она удалась, пользователь продолжает работу
 * после перезагрузки страницы без повторного входа.
 */

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, type SessionUser } from '../lib/api-client';

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous';

interface AuthApi {
  status: AuthStatus;
  user: SessionUser | null;
  client: ApiClient;
  login: (input: { phone: string; pin: string; deviceLabel?: string }) => Promise<void>;
  activate: (input: { phone: string; code: string; pin: string }) => Promise<void>;
  logout: () => Promise<void>;
  logoutEverywhere: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

interface AuthResponse {
  accessToken: string;
  user: SessionUser;
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<SessionUser | null>(null);

  // Клиент создаётся один раз: в нём живёт access-токен и single-flight refresh.
  const [client] = useState(
    () =>
      new ApiClient({
        onSessionLost: () => {
          setUser(null);
          setStatus('anonymous');
          queryClient.clear();
        },
      }),
  );

  useEffect(() => {
    let cancelled = false;

    void client.restoreSession().then((restored) => {
      if (cancelled) {
        return;
      }
      setUser(restored);
      setStatus(restored === null ? 'anonymous' : 'authenticated');
    });

    return () => {
      cancelled = true;
    };
  }, [client]);

  const login = useCallback<AuthApi['login']>(
    async (input) => {
      const result = await client.authenticate<AuthResponse>('/api/auth/login', input);
      setUser(result.user);
      setStatus('authenticated');
      queryClient.clear();
    },
    [client, queryClient],
  );

  const activate = useCallback<AuthApi['activate']>(
    async (input) => {
      const result = await client.authenticate<AuthResponse>('/api/auth/activate', input);
      setUser(result.user);
      setStatus('authenticated');
      queryClient.clear();
    },
    [client, queryClient],
  );

  const finishSession = useCallback(() => {
    client.clear();
    setUser(null);
    setStatus('anonymous');
    // Кэш очищается полностью: в нём могли остаться данные предыдущего пользователя.
    queryClient.clear();
  }, [client, queryClient]);

  const logout = useCallback(async () => {
    try {
      await client.post('/api/auth/logout');
    } finally {
      finishSession();
    }
  }, [client, finishSession]);

  const logoutEverywhere = useCallback(async () => {
    try {
      await client.post('/api/auth/logout-all');
    } finally {
      finishSession();
    }
  }, [client, finishSession]);

  const api = useMemo<AuthApi>(
    () => ({ status, user, client, login, activate, logout, logoutEverywhere }),
    [status, user, client, login, activate, logout, logoutEverywhere],
  );

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth используется вне AuthProvider');
  }
  return context;
}
