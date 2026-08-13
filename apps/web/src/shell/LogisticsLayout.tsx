/**
 * Раздел «Логистика» с вложенными вкладками.
 *
 * Вкладки горизонтальные и в фиксированном порядке — решение владельца.
 * На телефоне это одна прокручиваемая по горизонтали строка, а не выпадающий
 * список: список прячет соседние вкладки и превращает переключение в два
 * действия вместо одного.
 */

import { NavLink, Outlet } from 'react-router';
import { LOGISTICS_TABS } from '../navigation/navigation';
import './shell.css';

export function LogisticsLayout(): React.JSX.Element {
  return (
    <div className="logistics">
      <nav className="logistics__tabs" aria-label="Разделы логистики">
        {LOGISTICS_TABS.map((tab) => (
          <NavLink
            key={tab.key}
            to={tab.path}
            className={({ isActive }) =>
              isActive ? 'logistics__tab logistics__tab--active' : 'logistics__tab'
            }
          >
            {tab.title}
          </NavLink>
        ))}
      </nav>

      <div className="logistics__content">
        <Outlet />
      </div>
    </div>
  );
}
