/**
 * Раздел «Логистика».
 *
 * Собственного ряда вкладок здесь больше нет: вкладки переехали в верхнюю
 * строку приложения и заняли место названия текущего раздела. Два ряда
 * навигации подряд отнимали у карты и списка высоту, ничего не добавляя,
 * а название раздела и так видно по выбранной вкладке.
 */

import { Outlet } from 'react-router';
import './shell.css';

export function LogisticsLayout(): React.JSX.Element {
  return (
    <div className="logistics">
      <div className="logistics__content">
        <Outlet />
      </div>
    </div>
  );
}
