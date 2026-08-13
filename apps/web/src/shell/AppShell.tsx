/**
 * Общий каркас приложения.
 *
 * Desktop: боковая панель и верхняя строка. Mobile: верхняя панель и нижняя
 * навигация не более чем из четырёх кнопок, последняя — «Ещё».
 *
 * Единственный доступный раздел нижнюю навигацию не получает вовсе. Кнопка,
 * ведущая на уже открытую страницу, ничего не даёт: она дублирует заголовок,
 * отнимает высоту у содержимого и выглядит как неработающая. Внутренние
 * вкладки раздела — «Очередь», «Мои заказы», «Печать» у флориста, рабочие
 * вкладки склада — к верхнеуровневой навигации отношения не имеют
 * и остаются на месте.
 *
 * Разделы, недоступные роли, не отображаются вовсе — в том числе на время загрузки:
 * пока сессия проверяется, показывается экран ожидания, а не пустой каркас с меню.
 */

import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ROLE_LABELS } from '@fl/shared';
import { useAuth } from '../auth/AuthContext';
import { LOGISTICS_TABS, splitMobileNavigation, visibleSections } from '../navigation/navigation';
import { Button, Modal } from '../ui/components';
import { useRealtime } from '../realtime/useRealtime';
import { ConnectionIndicator } from './ConnectionIndicator';
import './shell.css';

/**
 * Перекрывает ли меню содержимое.
 *
 * Порог совпадает с точкой в `shell.css`: одно правило в двух местах разошлось
 * бы, и меню закрывалось бы там, где оно ничего не перекрывает.
 */
const OVERLAY_QUERY = '(max-width: 900px)';

function isOverlayViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(OVERLAY_QUERY).matches;
}

export function AppShell(): React.JSX.Element {
  const { user, client, logout, logoutEverywhere } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /**
   * Раскрыто ли боковое меню.
   *
   * Начальное значение — «раскрыто», и оно НЕ запоминается: ни в профиле,
   * ни в local/session storage. Решение владельца: каждый новый вход и каждое
   * обновление страницы начинаются с раскрытого меню, поэтому состояние живёт
   * ровно столько, сколько живёт эта страница.
   */
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Один канал обновлений на всё приложение.
  const realtime = useRealtime();

  const roles = user?.roles ?? [];
  const sections = visibleSections(roles);
  const mobile = splitMobileNavigation(roles);

  /**
   * Ровно один верхнеуровневый раздел — навигации нет.
   *
   * Считается ПОСЛЕ проверки ролей: до неё список разделов пуст у любого
   * пользователя, и признак был бы ложным. Пустой список сюда тоже попадает:
   * показывать полосу без единой кнопки незачем.
   */
  const singleSection = sections.length <= 1;

  // Внутри «Логистики» заголовок страницы называет ОТКРЫТУЮ ВКЛАДКУ, а не
  // раздел: человек находится в «Сделках», и заголовок «Логистика» ничего
  // ему не сообщал бы.
  const currentTitle =
    LOGISTICS_TABS.find((tab) => location.pathname.startsWith(tab.path))?.title ??
    sections.find((section) => location.pathname.startsWith(section.path))?.title ??
    'Логистика';

  // На телефоне меню — overlay поверх страницы: после перехода в раздел оно
  // закрывается само, иначе пользователь остаётся смотреть на меню вместо
  // экрана, который только что выбрал.
  //
  // На широком экране меню НЕ закрывается: там оно занимает свою колонку и
  // ничего не перекрывает, а самопроизвольное схлопывание после каждого
  // перехода означало бы, что до соседнего раздела нужно два действия вместо
  // одного.
  useEffect(() => {
    if (isOverlayViewport()) {
      setSidebarOpen(false);
    }
  }, [location.pathname]);

  // Escape закрывает overlay. Это доступность, а не новый смысл: без клавиатуры
  // выход из меню оставался бы только мышью.
  useEffect(() => {
    if (!sidebarOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  return (
    <div
      className={[
        'shell',
        sidebarOpen ? null : 'shell--collapsed',
        singleSection ? 'shell--single-section' : null,
      ]
        .filter((name) => name !== null)
        .join(' ')}
    >
      <aside className="shell__sidebar" id="shell-sidebar" hidden={!sidebarOpen}>
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

      {/*
        Подложка overlay: закрывает меню кликом мимо него. На широком экране
        она не показывается — там меню занимает свою колонку, а не перекрывает
        содержимое.
      */}
      {sidebarOpen && (
        <button
          type="button"
          className="shell__scrim"
          aria-label="Закрыть меню"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <header className="shell__topbar">
        {/*
          Кнопка открытия доступна ВСЕГДА, а не только в свёрнутом состоянии:
          иначе меню, скрытое полностью, оставляло бы пользователя без входа
          обратно. Узкой полосы с иконками при этом не остаётся.
        */}
        <button
          type="button"
          className="shell__menu-button"
          aria-expanded={sidebarOpen}
          aria-controls="shell-sidebar"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {sidebarOpen ? 'Скрыть меню' : 'Показать меню'}
        </button>
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

      {!singleSection && (
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
      )}

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
