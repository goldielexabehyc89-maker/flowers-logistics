/**
 * Маршрутизация приложения.
 *
 * Пока сессия проверяется, показывается экран ожидания: административные разделы
 * не должны кратко мелькать у пользователя, которому они недоступны.
 * Неизвестный или запрещённый адрес ведёт на первый доступный раздел.
 */

import { Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { useAuth } from './auth/AuthContext';
import {
  firstAvailablePath,
  isSectionVisible,
  LEGACY_PATHS,
  LOGISTICS_DEFAULT_TAB,
} from './navigation/navigation';
import { FirstLoginScreen, LoginScreen } from './screens/LoginScreen';
import { NoSectionsScreen, PLACEHOLDERS, PlaceholderScreen } from './screens/PlaceholderScreen';
import { WarehouseScreen } from './screens/warehouse/WarehouseScreen';
import { ActiveScreen } from './screens/delivery/ActiveScreen';
import { HistoryScreen } from './screens/delivery/HistoryScreen';
/*
 * Курьерская «История доставок» и логистическая «История» — разные экраны
 * с разной аудиторией. Псевдоним оставлен намеренно: одинаковое имя в двух
 * местах однажды привело бы к подмене одного другим.
 */
import { HistoryScreen as LogisticsHistoryScreen } from './screens/logistics/HistoryScreen';
import { ReportsScreen } from './screens/logistics/ReportsScreen';
import { ResolutionsScreen } from './screens/logistics/ResolutionsScreen';
import { OrderHistoryScreen } from './screens/logistics/OrderHistoryScreen';
import { OrderHistorySearchScreen } from './screens/history/OrderHistorySearchScreen';
import { DealsWorkspace } from './screens/deals/DealsWorkspace';
import { FloristScreen } from './screens/florist/FloristScreen';
import { PickupScreen } from './screens/pickup/PickupScreen';
import { RoutingScreen } from './screens/routing/RoutingScreen';
import { RouteSheetsScreen } from './screens/routing/RouteSheetsScreen';
import { LogisticsLayout } from './shell/LogisticsLayout';
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

/**
 * Прежний адрес истории заказа ведёт в общий раздел.
 *
 * Перенаправление, а не копия экрана: два адреса одного экрана однажды
 * разошлись бы поведением, и чинить пришлось бы оба.
 */
function LegacyOrderHistoryRedirect(): React.JSX.Element {
  const { orderId = '' } = useParams<{ orderId: string }>();
  return <Navigate to={orderId === '' ? '/order-history' : `/order-history/${orderId}`} replace />;
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
        {/*
          Раздел «Логистика»: один пункт меню и пять вложенных вкладок.
          Прежняя отдельная вкладка «Планирование» из навигации убрана,
          её функция живёт в «Маршрутизации», а домен и история расчётов
          остались нетронутыми.
        */}
        <Route
          path="/logistics"
          element={
            <SectionRoute>
              <LogisticsLayout />
            </SectionRoute>
          }
        >
          <Route index element={<Navigate to={LOGISTICS_DEFAULT_TAB} replace />} />
          <Route path="deals" element={<DealsWorkspace />} />
          <Route path="routing" element={<RoutingScreen />} />
          <Route path="route-sheets" element={<RouteSheetsScreen />} />
          <Route path="resolutions" element={<ResolutionsScreen />} />
          <Route path="history" element={<LogisticsHistoryScreen />} />
          <Route path="reports" element={<ReportsScreen />} />
        </Route>
        {/*
          «История заказов» — самостоятельный раздел приложения.

          Поиск и лента живут рядом: сначала находят заказ по номеру за любую
          дату, потом читают его историю. Прямая ссылка на историю работает
          сама по себе: право проверяет сервер, а не переход по меню.
        */}
        <Route
          path="/order-history"
          element={
            <SectionRoute>
              <OrderHistorySearchScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/order-history/:orderId"
          element={
            <SectionRoute>
              <OrderHistoryScreen />
            </SectionRoute>
          }
        />

        {/*
          Прежний адрес истории продолжает работать.

          Ссылку могли сохранить в закладках или передать коллеге, и обрыв на
          ровном месте выглядел бы как пропавший раздел. Перенаправление
          сохраняет идентификатор заказа и ведёт в новый общий раздел.
        */}
        <Route path="/logistics/orders/:orderId/history" element={<LegacyOrderHistoryRedirect />} />

        {/* Прежние адреса верхнего уровня ведут в точный новый эквивалент. */}
        {Object.entries(LEGACY_PATHS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route
          path="/florist"
          element={
            <SectionRoute>
              <FloristScreen />
            </SectionRoute>
          }
        />
        <Route
          path="/pickup"
          element={
            <SectionRoute>
              <PickupScreen />
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
