/**
 * Карточка сборки заказа.
 *
 * Показывается ровно то, что утвердил владелец: номер, московские дата и
 * интервал, состав с бандлами и компонентами, «Текст открытки» и нижний
 * комментарий. Цены, артикула, адреса, получателя и «Комментария по доставке»
 * здесь нет — карточка флориста намеренно не является карточкой заказа.
 *
 * ФОТО. Загружается отдельным запросом при открытии и НЕ сохраняется: ни в
 * состоянии приложения, ни в кэше. Недоступное фото карточку не ломает —
 * на его месте остаётся честное «Фото отсутствует».
 *
 * ОШИБКА НЕ ОСТАВЛЯЕТ ЛОЖНОГО СОСТОЯНИЯ. Ни одно действие не меняет карточку
 * «оптимистично»: экран перерисовывается только после ответа сервера, а отказ
 * приводит к перезапросу. Иначе флорист видел бы «Собран» на заказе, который
 * сервер не принял.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, StatusBadge } from '../../ui/components';
import {
  EMPTY_VALUE,
  availableActions,
  formatDay,
  formatInterval,
  latestJob,
  printStateLabel,
  processLabel,
  type CardPositionView,
  type FloristOption,
  type OrderCardView,
} from './florist';

interface PhotoProps {
  assortmentId: string | null;
}

/**
 * Фотография позиции.
 *
 * Обычный `<img src>` здесь непригоден: запрос ушёл бы без заголовка
 * авторизации и получил бы 401, а токен в адресе оказался бы в истории
 * браузера и журналах прокси. Поэтому байты забираются запросом и живут
 * только временной ссылкой, которая освобождается при закрытии карточки.
 */
function PositionPhoto({ assortmentId }: PhotoProps): React.JSX.Element | null {
  const { client } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (assortmentId === null) {
      return;
    }

    let revoked = false;
    let objectUrl: string | null = null;

    void client
      .getBlob(`/api/florist/assortment/${assortmentId}/photo`, 'image/*')
      .then((blob) => {
        if (revoked) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // Отсутствующее или недоступное фото — штатное состояние карточки.
        if (!revoked) {
          setMissing(true);
        }
      });

    return () => {
      revoked = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assortmentId, client]);

  if (assortmentId === null) {
    return null;
  }

  if (missing || url === null) {
    return (
      <div className="florist__photo florist__photo--empty" data-testid="position-photo-empty">
        {missing ? 'Фото отсутствует' : 'Загружаем фото…'}
      </div>
    );
  }

  return (
    <img
      className="florist__photo"
      src={url}
      alt="Фотография позиции"
      data-testid="position-photo"
    />
  );
}

function Position({ position }: { position: CardPositionView }): React.JSX.Element {
  return (
    <li className="florist__position" data-testid="card-position">
      <div className="florist__position-head">
        <span className="florist__position-qty">{position.quantity}</span>
        <span className="florist__position-name">{position.name ?? 'без названия'}</span>
        {position.characteristicLabel !== null && (
          <span className="muted text-sm">{position.characteristicLabel}</span>
        )}
        {position.isBundle && <StatusBadge tone="info">Бандл</StatusBadge>}
      </div>

      {position.components.length > 0 && (
        <ul className="florist__components">
          {position.components.map((component, index) => (
            <li key={`${component.name ?? 'component'}-${index}`}>
              {component.quantity} × {component.name ?? 'без названия'}
            </li>
          ))}
        </ul>
      )}

      <PositionPhoto assortmentId={position.assortmentId} />
    </li>
  );
}

export interface OrderCardPanelProps {
  card: OrderCardView;
  viewerId: string;
  isAdmin: boolean;
  hasActiveShift: boolean;
  florists: FloristOption[];
  busy: boolean;
  onClose: () => void;
  onClaim: () => void;
  onRelease: () => void;
  onAssemble: () => void;
  onReopen: (reason: string) => void;
  onReassign: (floristId: string) => void;
  onDownload: () => void;
  onRetry: () => void;
  onMarkPrinted: () => void;
}

export function OrderCardPanel(props: OrderCardPanelProps): React.JSX.Element {
  const { card } = props;
  const actions = availableActions({
    card,
    viewerId: props.viewerId,
    isAdmin: props.isAdmin,
    hasActiveShift: props.hasActiveShift,
  });
  const job = latestJob(card);

  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');

  return (
    <section className="florist__card card stack" data-testid="florist-card">
      <header className="florist__card-head">
        <div>
          <h2>{card.number}</h2>
          <p className="muted text-sm">
            {formatDay(card.deliveryDate)} · {formatInterval(card)}
          </p>
        </div>
        <div className="row">
          <StatusBadge tone={card.process.state === 'NEEDS_REVIEW' ? 'warning' : 'info'}>
            {processLabel(card.process.state)}
          </StatusBadge>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>
      </header>

      {card.changedSinceClaim && (
        <div className="florist__alert" role="alert" data-testid="card-changed">
          Заказ изменён. Состав ниже уже обновлён — сверьтесь с ним перед завершением.
        </div>
      )}

      {card.process.state === 'NEEDS_REVIEW' && (
        <div className="florist__alert" role="alert" data-testid="card-needs-review">
          Заказ изменился после сборки и требует проверки. Напечатанный бланк относится к прежнему
          составу.
        </div>
      )}

      {card.process.assignee !== null && (
        <p className="muted text-sm">Собирает: {card.process.assignee.fullName}</p>
      )}

      <div>
        <div className="field__label">Состав</div>
        {card.positions.length === 0 ? (
          <p className="muted text-sm">Состав пуст.</p>
        ) : (
          <ul className="florist__positions">
            {card.positions.map((position, index) => (
              <Position key={`${position.name ?? 'position'}-${index}`} position={position} />
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="field__label">Текст открытки</div>
        <p data-testid="card-text">{card.cardText ?? EMPTY_VALUE}</p>
      </div>

      <div>
        <div className="field__label">Комментарий заказа</div>
        <p data-testid="card-description">{card.description ?? EMPTY_VALUE}</p>
      </div>

      <div className="row florist__actions">
        {actions.canClaim && (
          <Button variant="primary" disabled={props.busy} onClick={props.onClaim}>
            Взять в работу
          </Button>
        )}
        {actions.canAssemble && (
          <Button
            variant="primary"
            disabled={props.busy}
            data-testid="card-assemble"
            onClick={props.onAssemble}
          >
            Собран
          </Button>
        )}
        {actions.canRelease && (
          <Button variant="secondary" disabled={props.busy} onClick={props.onRelease}>
            Отказаться
          </Button>
        )}
        {actions.canPrint && (
          <Button
            variant="secondary"
            disabled={props.busy}
            data-testid="card-download"
            onClick={props.onDownload}
          >
            Скачать PDF
          </Button>
        )}
        {actions.canPrint && job !== null && (
          <Button variant="ghost" disabled={props.busy} onClick={props.onRetry}>
            Повторить печать
          </Button>
        )}
        {actions.canPrint && job !== null && job.state !== 'PRINTED' && (
          <Button
            variant="ghost"
            disabled={props.busy}
            data-testid="card-mark-printed"
            onClick={props.onMarkPrinted}
          >
            Напечатано вручную
          </Button>
        )}
      </div>

      {job !== null && (
        <p className="muted text-sm" data-testid="card-print-state">
          Печать: {printStateLabel(job.state)} · попытка {job.attempt}
          {job.lastErrorCode === null ? '' : ` · код ошибки ${job.lastErrorCode}`}
        </p>
      )}

      {props.isAdmin && actions.canReassign && props.florists.length > 0 && (
        <div className="row">
          <select
            className="input"
            aria-label="Назначить флориста"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Выберите флориста на смене</option>
            {props.florists.map((florist) => (
              <option key={florist.userId} value={florist.userId}>
                {florist.fullName} ({florist.openAssignments})
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            disabled={props.busy || target === ''}
            onClick={() => props.onReassign(target)}
          >
            Назначить
          </Button>
        </div>
      )}

      {props.isAdmin && actions.canReopen && (
        <div className="row">
          <input
            className="input"
            aria-label="Причина возврата в работу"
            placeholder="Причина возврата в работу"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={props.busy || reason.trim().length < 3}
            onClick={() => props.onReopen(reason.trim())}
          >
            Вернуть в работу
          </Button>
        </div>
      )}
    </section>
  );
}
