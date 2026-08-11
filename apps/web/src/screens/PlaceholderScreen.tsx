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
        Данные не показываются намеренно: до подключения МоегоСклада и карт любые цифры здесь были
        бы выдуманными.
      </p>
    </section>
  );
}

export const PLACEHOLDERS: Record<string, PlaceholderProps> = {
  active: {
    title: 'Активные',
    stage: '6 — отгрузка и работа курьера',
    description: 'Отгруженные маршруты в работе и текущие результаты доставки.',
    upcoming: [
      'статусы «Доставлен» и «Не доставлен» с обязательной причиной',
      'передача заказов другому курьеру',
      'критические уведомления курьеру',
    ],
  },
  history: {
    title: 'История',
    stage: '6–7 — завершённые доставки и отчётность',
    description: 'Завершённые и отменённые заказы и маршруты с глобальным поиском.',
    upcoming: [
      'поиск заказа независимо от даты и статуса',
      'маскирование персональных данных курьера со следующего дня',
      'неизменяемая история операций',
    ],
  },
  reports: {
    title: 'Отчёты',
    stage: '7 — финансы и отчётность',
    description: 'Операционные и финансовые отчёты с выгрузками Excel и PDF.',
    upcoming: [
      'получено, распределено, отгружено, доставлено, опоздания',
      'баланс курьера, сдача и выдача денег, расходы',
      'аудит экспорта с персональными данными',
    ],
  },
};

/**
 * Заглушка для учётной записи без единого доступного раздела.
 *
 * С появлением раздела «Склад» (этап 6.1) кладовщик сюда больше не попадает:
 * экран остаётся для учётной записи, которой не назначено ни одной роли,
 * дающей раздел. Выход обязателен: без него человек не смог бы завершить
 * сессию на общем устройстве.
 */
export function NoSectionsPlaceholder(): React.JSX.Element {
  const { user, logout, logoutEverywhere } = useAuth();

  return (
    <main className="shell__content">
      <section className="card stack">
        <h2>Доступных разделов нет</h2>
        <p>
          У вашей учётной записи нет ни одной роли, которая открывает рабочий раздел. Это не ошибка
          входа: вход выполнен, но показывать пока нечего.
        </p>
        <p className="muted text-sm">
          Попросите администратора назначить нужную роль — например, кладовщика для раздела «Склад».
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
