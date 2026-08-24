/**
 * Вкладка «Требуют решения».
 *
 * Здесь заканчивается недоставка. Курьер вернул результат — и заказ повисает
 * между двумя мирами: клиенту он не отдан, а компании ещё не возвращён.
 * Пока логист не решит, что с ним делать, заказ не виден в «Сделках» и не
 * попадает ни в какой маршрут.
 *
 * Два ограничения экрана существенны и намеренны:
 *
 * 1. Счётчик в названии вкладки берётся у сервера, а не считается по видимым
 *    строкам: список постраничный, и «12» на второй странице означало бы
 *    другое число, чем на первой.
 * 2. «Повторно доставить» недоступно, пока склад не принял букет физически.
 *    Заказ, лежащий в машине курьера, нельзя поставить в новый маршрут — его
 *    там просто нет.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatMoscowDateTime } from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api-client';
import { useToast } from '../../ui/ToastProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  StatusBadge,
} from '../../ui/components';
import './resolutions.css';

export interface ResolutionRow {
  id: string;
  kind: 'FAILED_DELIVERY' | 'CANCELLED_AFTER_DELIVERY';
  orderId: string;
  orderNumber: string;
  address: string | null;
  /** Детали адреса. `null` у заказа прежнего контракта. */
  addressDetails: string | null;
  routeNumber: string | null;
  courier: { id: string; fullName: string } | null;
  reasonName: string;
  failedAt: string;
  returnState: 'WITH_COURIER' | 'RETURNING' | 'ACCEPTED' | 'CANCELLED' | null;
  decision:
    | 'CANCELLED'
    | 'REDELIVER'
    | 'ACKNOWLEDGED'
    | 'REDELIVER_SAME_BOUQUET'
    | 'REDELIVER_REASSEMBLE'
    | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface ResolutionsPage {
  items: ResolutionRow[];
  total: number;
  unresolved: number;
}

/** Где сейчас букет. Формулировки владельца, без сокращений. */
export const RETURN_STATE_LABELS: Readonly<Record<string, string>> = {
  WITH_COURIER: 'У курьера',
  RETURNING: 'Возвращается на склад',
  ACCEPTED: 'Принят складом',
  CANCELLED: 'Отменён',
};

/**
 * Можно ли отправить ТОТ ЖЕ букет.
 *
 * Ровно одно условие: букет физически принят складом. Решение логиста этого
 * не заменяет — оно лишь называет намерение. Пересборке приёмка не нужна:
 * новый букет собирают из свежих цветов, пока старый едет обратно.
 */
export function readyForSameBouquet(returnState: string | null): boolean {
  return returnState === 'ACCEPTED' || returnState === null;
}

/** Разделы экрана: нерешённое сверху, решённое остаётся видимым ниже. */
const RESOLUTION_GROUPS = [
  {
    key: 'pending',
    title: 'Ждут решения',
    hint: 'сверху те, где букет уже на складе',
    empty: 'Нерешённых недоставок нет.',
  },
  {
    key: 'done',
    title: 'Решено',
    hint: 'остаётся в истории',
    empty: 'Пока ничего не решено.',
  },
] as const;

/** Подпись принятого решения. */
export const DECISION_LABELS: Readonly<Record<string, string>> = {
  CANCELLED: 'Отменён',
  ACKNOWLEDGED: 'Разобрано',
  REDELIVER: 'Повторная доставка',
  REDELIVER_SAME_BOUQUET: 'Повезут тот же букет',
  REDELIVER_REASSEMBLE: 'Передан на пересборку',
};

export function ResolutionsScreen(): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const list = useQuery({
    queryKey: ['logistics-resolutions'],
    queryFn: () => client.get<ResolutionsPage>('/api/logistics/resolutions?limit=100'),
  });

  /** Задача, для которой открыт выбор способа повторной доставки. */
  const [choosing, setChoosing] = useState<ResolutionRow | null>(null);

  const decide = useMutation({
    mutationFn: (input: {
      id: string;
      action: 'cancel-order' | 'redeliver-same' | 'reassemble' | 'acknowledge';
    }) =>
      client.post<{ orderNumber: string; decision: string }>(
        `/api/logistics/resolutions/${input.id}/${input.action}`,
        {},
      ),
    onSuccess: async (result) => {
      setChoosing(null);
      await queryClient.invalidateQueries({ queryKey: ['logistics-resolutions'] });
      await queryClient.invalidateQueries({ queryKey: ['deal-cards'] });
      await queryClient.invalidateQueries({ queryKey: ['deals'] });
      await queryClient.invalidateQueries({ queryKey: ['florist-queue'] });
      /*
       * Формулировка ровно по тому, что произошло.
       *
       * Отмена действует ВНУТРИ системы. Сказать «отменён в МоемСкладе»
       * значило бы пообещать то, чего никто не делал: исходящей записи
       * у системы нет.
       */
      showToast(
        result.decision === 'CANCELLED'
          ? `Заказ ${result.orderNumber} отменён`
          : result.decision === 'ACKNOWLEDGED'
            ? `Задача по заказу ${result.orderNumber} закрыта`
            : result.decision === 'REDELIVER_REASSEMBLE'
              ? `Заказ ${result.orderNumber} передан на пересборку`
              : `Заказ ${result.orderNumber} вернулся в «Сделки» с тем же букетом`,
        'success',
      );
    },
    onError: async (error: unknown) => {
      setChoosing(null);
      /*
       * Конфликт двух логистов: решение уже принято другим человеком.
       *
       * Список перечитывается сразу — иначе на экране осталась бы кнопка,
       * которая заведомо не сработает, и разговор пошёл бы о «глючащем»
       * интерфейсе вместо реального положения дел.
       */
      await queryClient.invalidateQueries({ queryKey: ['logistics-resolutions'] });
      showToast(
        error instanceof ApiError ? error.message : 'Не удалось применить решение.',
        'error',
      );
    },
  });

  if (list.isPending) {
    return <LoadingState title="Загружаем недоставленные заказы…" />;
  }
  if (list.isError) {
    return <ErrorState title="Не удалось загрузить список" onRetry={() => void list.refetch()} />;
  }

  const rows = list.data.items;
  const sameBouquetReady = choosing === null ? false : readyForSameBouquet(choosing.returnState);

  /*
   * Нерешённое отделено от решённого, а внутри нерешённого наверх подняты
   * заказы, чей букет уже на складе: только их можно отправить тем же
   * букетом, и решение по ним не упирается в ожидание склада.
   *
   * Порядок внутри групп в остальном не меняется: он приходит с сервера.
   */
  const pending = rows
    .filter((row) => row.decision === null)
    .slice()
    .sort(
      (a, b) =>
        Number(readyForSameBouquet(b.returnState)) - Number(readyForSameBouquet(a.returnState)),
    );
  const done = rows.filter((row) => row.decision !== null);

  return (
    <section className="stack">
      <div className="card stack">
        <div>
          <h2>Требуют решения</h2>
          <p className="muted text-sm">
            Заказы, которые курьер не смог доставить. Пока склад не принял букет обратно, повторная
            доставка недоступна: заказа физически нет на складе.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card stack">
          <EmptyState title="Нерешённых недоставок нет" />
        </div>
      ) : (
        RESOLUTION_GROUPS.map((group) => {
          const groupRows = group.key === 'pending' ? pending : done;
          return (
            <section
              key={group.key}
              className={`resolutions__group resolutions__group--${group.key}`}
              data-testid={`resolutions-${group.key}`}
            >
              <div className="resolutions__group-head">
                <span className="resolutions__group-dot" aria-hidden="true" />
                <h2 className="resolutions__group-title">{group.title}</h2>
                <span className="resolutions__group-count">{groupRows.length}</span>
                <span className="resolutions__group-hint">{group.hint}</span>
              </div>

              {/*
                Лоток вдавлен, строки внутри подняты: видно, что заказы лежат
                В разделе, а не просто идут за его названием.
              */}
              <div className="resolutions__tray" role="table" aria-label={group.title}>
                <div className="resolutions__head" role="row">
                  <span role="columnheader">Заказ и адрес</span>
                  <span role="columnheader">Причина</span>
                  <span role="columnheader">Букет</span>
                  <span role="columnheader" className="resolutions__head-decision">
                    Решение
                  </span>
                </div>

                {groupRows.length === 0 ? (
                  <p className="muted text-sm resolutions__empty">{group.empty}</p>
                ) : (
                  groupRows.map((row) => {
                    const ready = readyForSameBouquet(row.returnState);
                    const busy = decide.isPending && decide.variables?.id === row.id;

                    return (
                      <div
                        key={row.id}
                        className="resolutions__row"
                        role="row"
                        data-order-number={row.orderNumber}
                        data-testid="resolution-row"
                      >
                        <div className="resolutions__cell" role="cell">
                          <div className="resolutions__order">
                            <strong className="resolutions__number">{row.orderNumber}</strong>
                            {row.routeNumber !== null && (
                              <span className="muted text-sm">маршрут {row.routeNumber}</span>
                            )}
                          </div>
                          <div className="muted text-sm resolutions__address">
                            {row.address ?? '—'}
                          </div>
                          {row.addressDetails !== null && (
                            <div
                              className="muted text-sm resolutions__address"
                              data-testid="resolution-address-details"
                            >
                              {row.addressDetails}
                            </div>
                          )}
                        </div>

                        <div className="resolutions__cell" role="cell">
                          <div>{row.reasonName}</div>
                          {row.kind === 'CANCELLED_AFTER_DELIVERY' && (
                            <div>
                              <StatusBadge tone="error">Требуется коррекция</StatusBadge>
                            </div>
                          )}
                          {/*
                            Время и курьер — одна приглушённая строка: по ним
                            восстанавливают обстоятельства, а не принимают решение.
                          */}
                          <div className="muted text-sm resolutions__when">
                            {formatMoscowDateTime(row.failedAt)}
                            {row.courier === null ? '' : ` · ${row.courier.fullName}`}
                          </div>
                        </div>

                        <div className="resolutions__cell" role="cell">
                          {/*
                            Возврат не требуется — это ответ, а не пропуск.
                            Прочерк на его месте читался как «неизвестно»
                            и заставлял открывать заказ, чтобы убедиться.
                          */}
                          <StatusBadge
                            tone={
                              row.returnState === null ? 'neutral' : ready ? 'success' : 'warning'
                            }
                          >
                            {row.returnState === null
                              ? 'Не требуется'
                              : (RETURN_STATE_LABELS[row.returnState] ?? row.returnState)}
                          </StatusBadge>
                          {/*
                            Запрет назван прямо в строке букета, а не спрятан
                            за нажатием: логист видит его до того, как выберет
                            повторную доставку.
                          */}
                          {!ready && (
                            <span className="resolutions__bouquet-note">
                              тот же букет отправить нельзя
                            </span>
                          )}
                        </div>

                        <div className="resolutions__cell resolutions__decision" role="cell">
                          {row.decision === null && row.kind === 'CANCELLED_AFTER_DELIVERY' ? (
                            /*
                             * Отмена пришла после доставки: букет у клиента,
                             * деньги, возможно, получены. Система здесь ничего
                             * не меняет — человек разбирается и закрывает задачу.
                             */
                            <Button
                              variant="primary"
                              disabled={busy}
                              data-testid="resolution-acknowledge"
                              onClick={() => decide.mutate({ id: row.id, action: 'acknowledge' })}
                            >
                              Разобрано
                            </Button>
                          ) : row.decision === null ? (
                            <>
                              <Button
                                variant="danger"
                                disabled={busy}
                                data-testid="resolution-cancel"
                                onClick={() =>
                                  decide.mutate({ id: row.id, action: 'cancel-order' })
                                }
                              >
                                Отменить заказ
                              </Button>
                              <Button
                                variant="primary"
                                disabled={busy}
                                data-testid="resolution-redeliver"
                                onClick={() => setChoosing(row)}
                              >
                                Доставить снова
                              </Button>
                            </>
                          ) : (
                            <span className="resolutions__decided">
                              <span className="resolutions__decided-what">
                                {DECISION_LABELS[row.decision] ?? row.decision}
                              </span>
                              {row.decidedBy !== null && (
                                <span className="muted text-sm">{row.decidedBy}</span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          );
        })
      )}

      {choosing !== null && (
        <Modal
          open
          title={`Повторная доставка заказа ${choosing.orderNumber}`}
          onClose={() => setChoosing(null)}
        >
          <div className="stack" data-testid="redelivery-choice">
            <div className="stack resolutions__choice">
              <Button
                variant="primary"
                disabled={decide.isPending || !sameBouquetReady}
                data-testid="redelivery-same"
                onClick={() => decide.mutate({ id: choosing.id, action: 'redeliver-same' })}
              >
                Отправить тот же букет
              </Button>
              <p className="muted text-sm">
                {sameBouquetReady
                  ? 'Букет принят складом. Сборка и печать остаются прежними, заказ вернётся в «Сделки».'
                  : 'Недоступно: букет ещё не принят складом. Пока он у курьера, отправлять нечего.'}
              </p>
            </div>

            <div className="stack resolutions__choice">
              <Button
                variant="secondary"
                disabled={decide.isPending}
                data-testid="redelivery-reassemble"
                onClick={() => decide.mutate({ id: choosing.id, action: 'reassemble' })}
              >
                Передать на пересборку
              </Button>
              <p className="muted text-sm">
                Заказ вернётся флористам с тем же номером. Понадобятся новая сборка и новая печать;
                прежние сборка, печать и доставка останутся в истории.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
