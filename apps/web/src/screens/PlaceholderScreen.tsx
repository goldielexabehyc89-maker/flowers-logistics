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
  routing: {
    title: 'Маршрутизация',
    stage: '4–5 — маршруты и карты',
    description:
      'Черновики маршрутов: ручное построение, а затем автоматический расчёт после подключения выбранного владельцем картографического провайдера.',
    upcoming: [
      'анонимные черновики без назначенных курьеров',
      'ограничения по вместимости, длительности и интервалам',
      'кнопка «Пересчитать» и индикатор устаревшего расчёта',
    ],
  },
  'route-sheets': {
    title: 'Маршрутные листы',
    stage: '4 — ручные маршруты и состояния',
    description: 'Подтверждённые, но ещё не отгруженные маршруты.',
    upcoming: [
      'подтверждение маршрута без назначенного курьера',
      'проверки готовности перед отгрузкой',
      'печатная форма маршрутного листа',
    ],
  },
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
 * Заглушка для роли без доступных разделов.
 *
 * Рабочих разделов здесь нет и быть не должно, но выход обязателен: без него
 * кладовщик не смог бы завершить сессию на общем устройстве.
 */
export function WarehousePlaceholder(): React.JSX.Element {
  const { user, logout, logoutEverywhere } = useAuth();

  return (
    <main className="shell__content">
      <section className="card stack">
        <h2>Складской модуль ещё не реализован</h2>
        <p>
          Роль кладовщика заведена в системе заранее, но складские операции появятся позже отдельным
          этапом. Сейчас доступных разделов для этой роли нет.
        </p>
        <p className="muted text-sm">
          Если вам нужен доступ к работе логистики, попросите администратора добавить
          соответствующую роль.
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
