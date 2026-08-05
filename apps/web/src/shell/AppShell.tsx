/**
 * Общий каркас приложения.
 *
 * Desktop: боковая панель и верхняя строка. Mobile: верхняя панель и нижняя
 * навигация не более чем из четырёх кнопок, последняя — «Ещё».
 *
 * Разделы, недоступные роли, не отображаются вовсе — в том числе на время загрузки:
 * пока сессия проверяется, показывается экран ожидания, а не пустой каркас с меню.
 */

import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ROLE_LABELS } from '@fl/shared';
import { useAuth } from '../auth/AuthContext';
import { splitMobileNavigation, visibleSections } from '../navigation/navigation';
import { Button, Modal } from '../ui/components';
import { useRealtime } from '../realtime/useRealtime';
import { ConnectionIndicator } from './ConnectionIndicator';
import './shell.css';

export function AppShell(): React.JSX.Element {
  const { user, client, logout, logoutEverywhere } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // Один канал обновлений на всё приложение.
  const realtime = useRealtime();

  const roles = user?.roles ?? [];
  const sections = visibleSections(roles);
  const mobile = splitMobileNavigation(roles);

  const currentTitle =
    sections.find((section) => location.pathname.startsWith(section.path))?.title ?? 'Логистика';

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        <div className="shell__brand">Логистика</div>
        <nav aria-label="Основные разделы">
          <ul className="shell__nav">
            {sections.map((section) => (
              <li key={section.key}>
                <NavLink
                  to={section.path}
                  className={({ isActive }) =>
                    isActive ? 'shell__link shell__link--active' : 'shell__link'
                  }
                >
                  {section.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <header className="shell__topbar">
        <h1 className="shell__title">{currentTitle}</h1>
        <div className="row">
          <ConnectionIndicator client={client} realtime={realtime} />
          <Button variant="ghost" onClick={() => setAccountOpen(true)}>
            {user?.fullName ?? 'Пользователь'}
          </Button>
        </div>
      </header>

      <main className="shell__content">
        <Outlet />
      </main>

      <nav className="shell__bottombar" aria-label="Навигация">
        {mobile.primary.map((section) => (
          <NavLink
            key={section.key}
            to={section.path}
            className={({ isActive }) =>
              isActive ? 'shell__tab shell__tab--active' : 'shell__tab'
            }
          >
            {section.shortTitle}
          </NavLink>
        ))}
        {mobile.extra.length > 0 && (
          <button type="button" className="shell__tab" onClick={() => setMenuOpen(true)}>
            Ещё
          </button>
        )}
      </nav>

      <Modal open={menuOpen} title="Разделы" onClose={() => setMenuOpen(false)}>
        <ul className="shell__nav">
          {mobile.extra.map((section) => (
            <li key={section.key}>
              <NavLink to={section.path} className="shell__link" onClick={() => setMenuOpen(false)}>
                {section.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={accountOpen}
        title="Учётная запись"
        onClose={() => setAccountOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => void logoutEverywhere()}>
              Выйти на всех устройствах
            </Button>
            <Button variant="primary" onClick={() => void logout()}>
              Выйти
            </Button>
          </>
        }
      >
        <div className="stack">
          <div>
            <div className="field__label">Сотрудник</div>
            <div>{user?.fullName}</div>
          </div>
          <div>
            <div className="field__label">Телефон</div>
            <div>{user?.phone}</div>
          </div>
          <div>
            <div className="field__label">Роли</div>
            <div>{roles.map((role) => ROLE_LABELS[role]).join(', ')}</div>
          </div>
          <p className="muted text-sm">
            «Выйти на всех устройствах» немедленно завершает сессии на всех устройствах и требует
            повторного входа.
          </p>
        </div>
      </Modal>
    </div>
  );
}
