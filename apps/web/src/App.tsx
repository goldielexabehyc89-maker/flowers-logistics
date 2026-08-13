/**
 * Маршрутизация приложения.
 *
 * Пока сессия проверяется, показывается экран ожидания: административные разделы
 * не должны кратко мелькать у пользователя, которому они недоступны.
 * Неизвестный или запрещённый адрес ведёт на первый доступный раздел.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { firstAvailablePath, isSectionVisible } from './navigation/navigation';
import { FirstLoginScreen, LoginScreen } from './screens/LoginScreen';
import { NoSectionsScreen, PLACEHOLDERS, PlaceholderScreen } from './screens/PlaceholderScreen';
import { WarehouseScreen } from './screens/warehouse/WarehouseScreen';
import { ActiveScreen } from './screens/delivery/ActiveScreen';
import { HistoryScreen } from './screens/delivery/HistoryScreen';
import { DealsScreen } from './screens/deals/DealsScreen';
import { FloristScreen } from './screens/florist/FloristScreen';
import { RoutingScreen } from './screens/routing/RoutingScreen';
import { RouteSheetsScreen } from './screens/routing/RouteSheetsScreen';
import { PlanningScreen } from './screens/planning/PlanningScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { UsersScreen } from './screens/users/UsersScreen';
import { AppShell } from './shell/AppShell';

function CheckingSession(): React.JSX.Element {
  return (
    <main className="auth">
      <section className="auth__card" role="status" aria-live="polite">
        <h1>Проверяем сессию…</h1>
        <p className="muted text-sm">Это займёт мгновение.</p>
      </section>
    </main>
  );
}

/** Раздел, доступный только определённым ролям; иначе — на первый доступный. */
function SectionRoute({ children }: { children: React.JSX.Element }): React.JSX.Element {
  const { user } = useAuth();
  const location = useLocation();
  const roles = user?.roles ?? [];

  if (!isSectionVisible(roles, location.pathname)) {
    const fallback = firstAvailablePath(roles);
    return fallback === null ? <NoSectionsScreen /> : <Navigate to={fallback} replace />;
  }

  return children;
}

export function App(): React.JSX.Element {
  const { status, user } = useAuth();

  if (status === 'checking') {
    return <CheckingSession />;
  }

  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/first-login" element={<FirstLoginScreen />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const roles = user?.roles ?? [];
  const home = firstAvailablePath(roles);

  // Набор ролей без единого раздела получает нейтральный экран с выходом.
  if (home === null) {
    return <NoSectionsScreen />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route
          path="/warehouse"
          element={
            <SectionRoute>
              <WarehouseScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/active"
          element={
            <SectionRoute>
              <ActiveScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/history"
          element={
            <SectionRoute>
              <HistoryScreen />
            </SectionRoute>
          }
        />
        {Object.entries(PLACEHOLDERS).map(([key, placeholder]) => (
          <Route
            key={key}
            path={`/${key}`}
            element={
              <SectionRoute>
                <PlaceholderScreen {...placeholder} />
              </SectionRoute>
            }
          />
        ))}
        <Route
          path="/deals"
          element={
            <SectionRoute>
              <DealsScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/florist"
          element={
            <SectionRoute>
              <FloristScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/routing"
          element={
            <SectionRoute>
              <RoutingScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/planning"
          element={
            <SectionRoute>
              <PlanningScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/route-sheets"
          element={
            <SectionRoute>
              <RouteSheetsScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/couriers"
          element={
            <SectionRoute>
              <UsersScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <SectionRoute>
              <SettingsScreen />
            </SectionRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to={home} replace />} />
    </Routes>
  );
}
