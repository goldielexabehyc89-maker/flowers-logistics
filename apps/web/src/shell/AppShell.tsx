/**
 * Общий каркас приложения.
 *
 * Desktop: постоянная боковая панель слева и закреплённая строка заголовка над
 * содержимым. Mobile: верхняя панель с бургером, содержимое и нижняя навигация
 * не более чем из четырёх кнопок, последняя — «Ещё».
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
import {
  Flower2,
  History,
  LogOut,
  Menu,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Route,
  Settings,
  Store,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { ROLE_LABELS } from '@fl/shared';
import { useAuth } from '../auth/AuthContext';
import {
  LOGISTICS_TABS,
  isWideLayout,
  splitMobileNavigation,
  visibleSections,
} from '../navigation/navigation';
import { Button, ICON_SIZE, Modal } from '../ui/components';
import { useRealtime } from '../realtime/useRealtime';
import { ConnectionIndicator } from './ConnectionIndicator';
import './shell.css';

/**
 * Иконка раздела.
 *
 * Карта лежит здесь, а не в `navigation.ts`: там чистая конфигурация разделов
 * и прав, которую читает и логика доступа. Иконка — оформление, и тянуть
 * React-зависимость в модуль правил незачем.
 *
 * Свёрнутое меню показывает ТОЛЬКО иконку, поэтому раздел без своей иконки
 * стал бы неотличим от соседнего. Значение по умолчанию не задаётся намеренно:
 * новый раздел обязан получить знак осознанно.
 */
const SECTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  logistics: Route,
  active: PackageCheck,
  history: History,
  couriers: Users,
  florist: Flower2,
  warehouse: Warehouse,
  pickup: Store,
  settings: Settings,
};

/**
 * Ключ сохранённого состояния меню.
 *
 * Состояние живёт в браузере, а не в профиле: это привычка на конкретном
 * устройстве, а не свойство сотрудника. На большом мониторе меню держат
 * раскрытым, на ноутбуке — свёрнутым, и один и тот же человек ожидает разного.
 */
const SIDEBAR_STORAGE_KEY = 'fl.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    // Приватный режим и заблокированное хранилище — не повод не открыть меню.
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Настройка не сохранилась — интерфейс всё равно обязан работать.
  }
}

export function AppShell(): React.JSX.Element {
  const { user, client, logout, logoutEverywhere } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /**
   * Свёрнуто ли боковое меню на широком экране.
   *
   * Состояние сохраняется между входами — решение владельца. Свёрнутое меню
   * остаётся полосой с иконками: полное исчезновение оставляло бы человека без
   * ориентира, где он находится.
   */
  const [collapsed, setCollapsed] = useState(readCollapsed);
  /**
   * Открыт ли drawer на телефоне.
   *
   * Отдельное состояние, и оно НЕ сохраняется: на узком экране меню перекрывает
   * страницу, и восстановленное после входа открытое меню закрывало бы работу.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  // Карты и крупные рабочие таблицы занимают всю ширину; обычная страница
  // остаётся колонкой. Решение принимается по адресу, а не экраном: иначе
  // каждый раздел договаривался бы о ширине сам.
  const wide = isWideLayout(location.pathname);

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
  // Свёрнутость на широком экране этим не затрагивается: там меню занимает свою
  // колонку и ничего не перекрывает.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape закрывает overlay. Это доступность, а не новый смысл: без клавиатуры
  // выход из меню оставался бы только мышью.
  useEffect(() => {
    if (!drawerOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function toggleCollapsed(): void {
    setCollapsed((current) => {
      const next = !current;
      writeCollapsed(next);
      return next;
    });
  }

  return (
    <div
      className={[
        'shell',
        collapsed ? 'shell--collapsed' : null,
        drawerOpen ? 'shell--drawer-open' : null,
        singleSection ? 'shell--single-section' : null,
      ]
        .filter((name) => name !== null)
        .join(' ')}
    >
      <aside className="shell__sidebar" id="shell-sidebar">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden>
            Л
          </span>
          <span className="shell__brand-text">Логистика</span>
        </div>
        <nav className="shell__nav-area" aria-label="Основные разделы">
          <ul className="shell__nav">
            {sections.map((section) => {
              const Icon = SECTION_ICONS[section.key];
              return (
                <li key={section.key}>
                  <NavLink
                    to={section.path}
                    className={({ isActive }) =>
                      isActive ? 'shell__link shell__link--active' : 'shell__link'
                    }
                    // В свёрнутом состоянии подпись скрыта, и подсказка остаётся
                    // единственным способом узнать раздел, не разворачивая меню.
                    title={section.title}
                  >
                    {Icon !== undefined && (
                      <Icon className="shell__link-icon" size={ICON_SIZE} aria-hidden />
                    )}
                    <span className="shell__link-text">{section.title}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        {/*
          Состояние связи на телефоне живёт здесь, а не в верхней строке.
          Постоянная надпись «Переподключение…» занимала место рядом с именем
          раздела и обрезала его, сообщая при этом то, что человеку нужно
          от силы раз в смену. Механизм переподключения от переезда не
          меняется: индикатор только показывает его состояние.

          На широком экране этот блок скрыт — там индикатор остаётся
          в верхней строке, как и был.
        */}
        <div className="shell__connection">
          <ConnectionIndicator client={client} realtime={realtime} />
        </div>

        {/*
          Имя сотрудника и выход закреплены внизу панели. Кнопка подписана
          «Выход», а не «Выйти»: рядом, в окне учётной записи, живёт настоящее
          завершение сессии, и два одинаково подписанных элемента на одной
          странице человек различал бы только по месту.
        */}
        <div className="shell__account">
          <button
            type="button"
            className="shell__account-name"
            title={user?.fullName ?? ''}
            onClick={() => setAccountOpen(true)}
          >
            {user?.fullName ?? 'Пользователь'}
          </button>
          <Button
            variant="ghost"
            className="btn--icon"
            aria-label="Выход"
            title="Выход"
            onClick={() => void logout()}
          >
            <LogOut size={ICON_SIZE} aria-hidden />
          </Button>
        </div>
      </aside>

      {/*
        Подложка overlay: закрывает меню кликом мимо него. На широком экране
        она не показывается — там меню занимает свою колонку, а не перекрывает
        содержимое.
      */}
      {drawerOpen && (
        <button
          type="button"
          className="shell__scrim"
          aria-label="Закрыть меню"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <header className="shell__topbar">
        {/*
          Две разные кнопки, а не одна с поведением «смотря какой экран».
          На телефоне бургер открывает drawer, на широком экране — сворачивает
          колонку до полосы с иконками. Это разные действия, и подписаны они
          по-разному; лишняя в текущей раскладке скрыта стилями.
        */}
        <button
          type="button"
          className="shell__drawer-button"
          aria-expanded={drawerOpen}
          aria-controls="shell-sidebar"
          aria-label="Меню"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          <Menu size={ICON_SIZE} aria-hidden />
        </button>
        <button
          type="button"
          className="shell__menu-button"
          aria-expanded={!collapsed}
          aria-controls="shell-sidebar"
          aria-label={collapsed ? 'Показать меню' : 'Свернуть меню'}
          title={collapsed ? 'Показать меню' : 'Свернуть меню'}
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={ICON_SIZE} aria-hidden />
          ) : (
            <PanelLeftClose size={ICON_SIZE} aria-hidden />
          )}
        </button>
        <h1 className="shell__title">{currentTitle}</h1>
        <div className="shell__topbar-right">
          <ConnectionIndicator client={client} realtime={realtime} />
          <Button variant="ghost" onClick={() => setAccountOpen(true)}>
            {user?.fullName ?? 'Пользователь'}
          </Button>
        </div>
      </header>

      <main className="shell__content">
        <div className={wide ? 'shell__page shell__page--wide' : 'shell__page'}>
          <Outlet />
        </div>
      </main>

      {!singleSection && (
        <nav className="shell__bottombar" aria-label="Навигация">
          {mobile.primary.map((section) => {
            const Icon = SECTION_ICONS[section.key];
            return (
              <NavLink
                key={section.key}
                to={section.path}
                className={({ isActive }) =>
                  isActive ? 'shell__tab shell__tab--active' : 'shell__tab'
                }
              >
                {Icon !== undefined && <Icon size={20} aria-hidden />}
                {section.shortTitle}
              </NavLink>
            );
          })}
          {mobile.extra.length > 0 && (
            <button type="button" className="shell__tab" onClick={() => setMenuOpen(true)}>
              <Menu size={20} aria-hidden />
              Ещё
            </button>
          )}
        </nav>
      )}

      <Modal open={menuOpen} title="Разделы" onClose={() => setMenuOpen(false)}>
        <ul className="shell__nav">
          {mobile.extra.map((section) => {
            const Icon = SECTION_ICONS[section.key];
            return (
              <li key={section.key}>
                <NavLink
                  to={section.path}
                  className="shell__link"
                  onClick={() => setMenuOpen(false)}
                >
                  {Icon !== undefined && (
                    <Icon className="shell__link-icon" size={ICON_SIZE} aria-hidden />
                  )}
                  <span className="shell__link-text">{section.title}</span>
                </NavLink>
              </li>
            );
          })}
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
