/**
 * Содержимое карточки сборки. Живёт внутри модального окна (`FloristScreen`).
 *
 * Показывается ровно то, что утвердил владелец: номер, московские дата и
 * интервал, состав с бандлами и компонентами, «Текст открытки» и нижний
 * комментарий. Цены, артикула, адреса, получателя и «Комментария по доставке»
 * здесь нет — карточка флориста намеренно не является карточкой заказа.
 *
 * ФОТО. Загружается отдельным запросом при открытии и НЕ сохраняется: ни в
 * состоянии приложения, ни в кэше. Отсутствующее и недоступное фото не
 * оставляет после себя ни надписи, ни пустого прямоугольника: отсутствие
 * фотографии — обычное состояние, а не сообщение, которое стоит читать.
 *
 * ОШИБКА НЕ ОСТАВЛЯЕТ ЛОЖНОГО СОСТОЯНИЯ. Ни одно действие не меняет карточку
 * «оптимистично»: экран перерисовывается только после ответа сервера, а отказ
 * приводит к перезапросу. Иначе флорист видел бы «Собран» на заказе, который
 * сервер не принял.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, Modal, StatusBadge } from '../../ui/components';
import {
  EMPTY_VALUE,
  availableActions,
  formatDay,
  formatInterval,
  formatQuantity,
  latestJob,
  printStateLabel,
  processLabel,
  type CardPositionView,
  type FloristOption,
  type OrderCardView,
} from './florist';

interface PhotoProps {
  assortmentId: string | null;
  /** Название позиции: alt обязан связывать фото с тем, что человек собирает. */
  positionName: string;
}

/**
 * Фотография позиции: миниатюра и окно поверх карточки.
 *
 * Обычный `<img src>` здесь непригоден: запрос ушёл бы без заголовка
 * авторизации и получил бы 401, а токен в адресе оказался бы в истории
 * браузера и журналах прокси. Поэтому байты забираются запросом и живут
 * только временной ссылкой, которая освобождается при закрытии карточки.
 *
 * ПОКА ФОТО НЕТ — НЕТ И МЕСТА ПОД НЕГО. Ни надписи, ни рамки, ни
 * зарезервированной высоты: у большинства позиций фотографии не существует
 * вовсе, и пустой прямоугольник у каждой строки растягивал бы состав втрое
 * ради сообщения «ничего нет».
 *
 * Внешний адрес источника не показывается нигде — ни в `src`, ни в `alt`.
 */
function PositionPhoto({ assortmentId, positionName }: PhotoProps): React.JSX.Element | null {
  const { client } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

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
          // Карточка успела закрыться: ссылку создавать незачем, а созданную
          // никто бы уже не освободил.
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // Отсутствующее или недоступное фото — штатное состояние карточки.
        // Отдельного видимого состояния у него нет по решению владельца.
      });

    return () => {
      revoked = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [assortmentId, client]);

  if (url === null) {
    return null;
  }

  const alt = `Фотография позиции «${positionName}»`;

  return (
    <>
      <button
        type="button"
        className="florist__photo-thumb"
        data-testid="position-photo"
        aria-label={`Открыть фотографию позиции «${positionName}»`}
        onClick={() => setZoomed(true)}
      >
        <img src={url} alt={alt} />
      </button>

      {/*
       * Отдельное окно ПОВЕРХ карточки, а не вместо неё.
       *
       * Второй `showModal()` встаёт выше первого, поэтому Escape и крестик
       * закрывают только фотографию: карточка остаётся открытой со всем своим
       * состоянием, а фокус возвращается на ту миниатюру, которую нажали.
       */}
      <Modal
        open={zoomed}
        title={positionName}
        onClose={() => setZoomed(false)}
        dismissOnBackdrop
        className="modal--wide"
        testId="position-photo-dialog"
      >
        <img className="florist__photo-full" src={url} alt={alt} />
      </Modal>
    </>
  );
}

function Position({ position }: { position: CardPositionView }): React.JSX.Element {
  const name = position.name ?? 'без названия';

  return (
    <li className="florist__position" data-testid="card-position">
      <div className="florist__position-head">
        <PositionPhoto assortmentId={position.assortmentId} positionName={name} />
        <span className="florist__position-qty" data-testid="position-quantity">
          {formatQuantity(position.quantity, position.uomName)}
        </span>
        <span className="florist__position-name">{name}</span>
        {position.characteristicLabel !== null && (
          <span className="muted text-sm">{position.characteristicLabel}</span>
        )}
        {position.isBundle && <StatusBadge tone="info">Бандл</StatusBadge>}
      </div>

      {position.components.length > 0 && (
        <ul className="florist__components">
          {position.components.map((component, index) => (
            <li key={`${component.name ?? 'component'}-${index}`}>
              {formatQuantity(component.quantity, component.uomName)} ×{' '}
              {component.name ?? 'без названия'}
            </li>
          ))}
        </ul>
      )}
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
    <div className="stack" data-testid="florist-card">
      <header className="florist__card-head">
        <p className="muted text-sm">
          {formatDay(card.deliveryDate)} · {formatInterval(card)}
        </p>
        <StatusBadge tone={card.process.state === 'NEEDS_REVIEW' ? 'warning' : 'info'}>
          {processLabel(card.process.state)}
        </StatusBadge>
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
          <Button
            variant="primary"
            disabled={props.busy}
            data-testid="card-claim"
            onClick={props.onClaim}
          >
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
          Печать: {printStateLabel(job.state)}
          {job.attempt === null ? '' : ` · попытка ${job.attempt}`}
        </p>
      )}

      {/*
       * Причина отказа — словами и отдельной строкой.
       *
       * Флорист не управляет устройствами и не должен, но обязан понять,
       * почему его бланк не вышел. «Принтер выключен» он исправит сам;
       * «код PRINTER_OFFLINE» отправит его искать администратора.
       */}
      {job !== null && job.lastErrorMessage !== null && (
        <p className="text-sm" data-testid="card-print-error">
          {job.lastErrorMessage}
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
    </div>
  );
}
