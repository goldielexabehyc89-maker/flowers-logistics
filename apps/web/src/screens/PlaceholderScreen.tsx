/**
 * Заглушки будущих разделов.
 *
 * Заглушка обязана прямо говорить, что раздел не реализован, и на каком этапе
 * появится. Никаких выдуманных заказов, маршрутов и графиков: показанный
 * «почти работающий» экран создаёт ложное представление о готовности продукта.
 */

import { useAuth } from '../auth/AuthContext';
import { Button } from '../ui/components';

export interface PlaceholderProps {
  title: string;
  stage: string;
  description: string;
  upcoming: readonly string[];
}

export function PlaceholderScreen({
  title,
  stage,
  description,
  upcoming,
}: PlaceholderProps): React.JSX.Element {
  return (
    <section className="card stack">
      <div>
        <h2>{title}</h2>
        <p className="muted text-sm">Раздел ещё не реализован. Плановый этап: {stage}.</p>
      </div>

      <p>{description}</p>

      <div>
        <div className="field__label">Что появится в разделе</div>
        <ul className="text-sm muted">
          {upcoming.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <p className="text-sm muted">
        Данные не показываются намеренно: пока раздел не реализован, любые заказы, ячейки и счётчики
        здесь были бы выдуманными.
      </p>
    </section>
  );
}

/** Вкладка «История» раздела «Логистика»: операционная история маршрутов. */
/** Вкладка «Отчёты» раздела «Логистика». */
export const PLACEHOLDERS: Record<string, PlaceholderProps> = {
  // Разделов «Флорист», «Склад», «Самовывоз», «Активные» и «История» здесь
  // больше нет: все пять реализованы (`screens/florist`, `screens/warehouse`,
  // `screens/pickup`, `screens/delivery`). Оставленная заглушка перехватывала бы
  // тот же адрес и показывала бы «раздел не реализован» поверх работающего
  // экрана.
};

/**
 * Экран для набора ролей, которому не соответствует ни один раздел.
 *
 * Роль здесь НЕ называется: прежняя версия объявляла такого пользователя
 * кладовщиком, и человек с любой другой ролью видел бы чужую подпись. Экран
 * говорит только о факте — доступных разделов нет, — и обязательно даёт выход:
 * без него нельзя завершить сессию на общем устройстве.
 *
 * Сейчас у каждой роли есть свой раздел, поэтому экран не должен появляться
 * в обычной работе. Он остаётся защитой от роли, заведённой раньше её раздела.
 */
export function NoSectionsScreen(): React.JSX.Element {
  const { user, logout, logoutEverywhere } = useAuth();

  return (
    <main className="shell__content">
      <section className="card stack">
        <h2>Доступных разделов нет</h2>
        <p>
          Для вашего набора ролей в приложении пока нет ни одного раздела. Это не ошибка входа:
          учётная запись активна, но работать в ней сейчас негде.
        </p>
        <p className="muted text-sm">
          Если вам нужен доступ к работе, попросите администратора добавить соответствующую роль.
        </p>

        <div>
          <div className="field__label">Вы вошли как</div>
          <div>{user?.fullName}</div>
          <div className="muted text-sm">{user?.phone}</div>
        </div>

        <div className="row">
          <Button variant="primary" onClick={() => void logout()}>
            Выйти
          </Button>
          <Button variant="ghost" onClick={() => void logoutEverywhere()}>
            Выйти на всех устройствах
          </Button>
        </div>
      </section>
    </main>
  );
}
