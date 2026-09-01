/**
 * Вкладка склада «Ожидают приёмки».
 *
 * Показывает собранные флористом заказы, которых ещё нет на полке: их склад
 * должен принять. Это ЭКРАН — он ничего не разрешает и статусов не заводит.
 *
 * «Принять» на карточке открывает тот же сканер приёмки, что и вкладка
 * «Склад», но с одним отличием: заказ на карточке уже выбран, и первый скан
 * обязан совпасть ИМЕННО с ним. Совпадение проверяется по устойчивому
 * идентификатору заказа (`orderId`), который возвращает штатный разбор
 * отсканированного кода, — а не по похожей строке номера. Не тот заказ —
 * сканер остаётся на первом шаге и ничего не записывает. После совпадения
 * идёт второй шаг «ячейка», и только пара «заказ + ячейка» уходит на сервер
 * прежним путём `receiveOrder` (`POST /api/warehouse/placements`). Второго
 * пути размещения здесь нет.
 *
 * Ручной ввод рядом со сканером включает существующая настройка «Разрешить
 * ручной ввод на складе и в самовывозе»; отдельного переключателя нет. Он
 * проходит те же проверки, что и QR.
 *
 * Группировка по дате доставки и счётчик приходят с сервера; экран лишь
 * раскладывает уже упорядоченный список по заголовкам дат.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatMinutesOfDay,
  formatMoscowDateTime,
  moscowToday,
  shiftCalendarDate,
} from '@fl/shared';
import { useAuth } from '../../auth/AuthContext';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { ScannerScreen } from '../../scan/ScannerScreen';
import type { ScanContext } from './warehouse-flow';
import { createReceiveIntent } from './receive-intent';
import { assembledDateLabel } from '../florist/florist';

interface AwaitingCard {
  orderId: string;
  orderNumber: string;
  deliveryDate: string | null;
  isPickup: boolean;
  startMinute: number | null;
  endMinute: number | null;
  intervalKind: string;
  assembledAt: string | null;
  floristName: string | null;
  positionCount: number;
}

interface AwaitingResponse {
  total: number;
  fullTotal: number;
  items: AwaitingCard[];
}

interface ManualEntryProps {
  manualEntry: boolean;
}

/** Интервал заказа словами: диапазон, «к времени» или прочерк. */
function intervalLabel(card: AwaitingCard): string {
  if (card.startMinute !== null && card.endMinute !== null) {
    return `${formatMinutesOfDay(card.startMinute)}–${formatMinutesOfDay(card.endMinute)}`;
  }
  if (card.startMinute !== null) {
    return `к ${formatMinutesOfDay(card.startMinute)}`;
  }
  return 'интервал не указан';
}

interface DateGroup {
  key: string;
  label: string;
  items: AwaitingCard[];
}

/**
 * Раскладывает уже упорядоченный сервером список по датам доставки.
 *
 * Порядок групп сохраняется тем, что список пришёл отсортированным (даты по
 * возрастанию, без даты — в конце), поэтому группы строятся подряд и пустых
 * среди них не бывает.
 */
function groupByDate(items: AwaitingCard[], now: Date): DateGroup[] {
  const today = moscowToday(now);
  const tomorrow = shiftCalendarDate(today, 1);
  const groups: DateGroup[] = [];
  for (const card of items) {
    const key = card.deliveryDate ?? '—';
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) {
      last.items.push(card);
    } else {
      groups.push({
        key,
        label: assembledDateLabel(card.deliveryDate, today, tomorrow),
        items: [card],
      });
    }
  }
  return groups;
}

export function AwaitingTab({ manualEntry }: ManualEntryProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  /** Карточка, которую сейчас принимают: открыт сканер именно на неё. */
  const [acceptingCard, setAcceptingCard] = useState<AwaitingCard | null>(null);

  const term = search.trim();
  const awaiting = useQuery({
    queryKey: ['warehouse-awaiting', term],
    queryFn: () =>
      client.get<AwaitingResponse>(
        `/api/warehouse/awaiting${term === '' ? '' : `?search=${encodeURIComponent(term)}`}`,
      ),
  });

  const groups = useMemo(
    () => groupByDate(awaiting.data?.items ?? [], new Date()),
    [awaiting.data],
  );

  /*
   * Обработчик приёмки живёт ровно одну сессию сканирования одной карточки.
   *
   * У него есть внутреннее состояние (согласие на маршрутную ячейку), которое
   * обязано пережить перерисовку списка от события реального времени. Поэтому
   * он привязан к идентификатору принимаемого заказа, а не создаётся заново на
   * каждый кадр. Проверка совпадения (`guard`) сверяет устойчивый `orderId`.
   */
  const acceptIntent = useMemo(() => {
    const card = acceptingCard;
    if (card === null) {
      return null;
    }
    return createReceiveIntent({
      client,
      onPlaced: async () => {
        await queryClient.invalidateQueries({ queryKey: ['warehouse-awaiting'] });
        await queryClient.invalidateQueries({ queryKey: ['warehouse-placements'] });
      },
      guard: (context: ScanContext) =>
        context.orderId === card.orderId
          ? null
          : {
              type: 'failed',
              text: `Отсканирован заказ ${context.orderNumber}, а нужен ${card.orderNumber}. Отсканируйте заказ с карточки.`,
            },
    });
    // client и queryClient стабильны; пересобираем обработчик только на смену
    // принимаемой карточки, чтобы его внутреннее состояние (согласие на
    // маршрутную ячейку) пережило перерисовку списка.
  }, [acceptingCard, client, queryClient]);

  return (
    <div className="stack" data-testid="wh-awaiting">
      <div className="card stack">
        <div>
          <h3>Ожидают приёмки</h3>
          <p className="muted text-sm">
            Собранные заказы, которых ещё нет на полке. «Принять» открывает сканер: сначала заказ с
            карточки, затем ячейка — тем же путём, что и «Склад».
          </p>
        </div>

        <input
          className="wh-search"
          type="search"
          inputMode="search"
          placeholder="Поиск по номеру заказа"
          aria-label="Поиск по номеру заказа"
          data-testid="wh-awaiting-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {awaiting.isPending ? (
        <LoadingState title="Загружаем список…" />
      ) : awaiting.isError ? (
        <ErrorState title="Не удалось загрузить список" onRetry={() => void awaiting.refetch()} />
      ) : (awaiting.data?.total ?? 0) === 0 ? (
        <EmptyState
          title="Пусто"
          description={
            term === ''
              ? 'Нет собранных заказов, ожидающих приёмки.'
              : 'По этому номеру ничего не найдено.'
          }
        />
      ) : (
        <div className="stack" data-testid="wh-awaiting-list">
          <p className="muted text-sm" data-testid="wh-awaiting-total">
            Всего: {awaiting.data.total}
          </p>
          {groups.map((group) => (
            <section key={group.key} className="card stack" data-awaiting-group={group.key}>
              <h4 className="wh-awaiting__date">{group.label}</h4>
              {group.items.map((card) => (
                <article
                  key={card.orderId}
                  className="wh-awaiting__card"
                  data-testid="wh-awaiting-card"
                  data-order-number={card.orderNumber}
                >
                  <div className="row">
                    <div className="stack stack--tight">
                      <strong>{card.orderNumber}</strong>
                      <div className="muted text-sm">
                        <StatusBadge tone={card.isPickup ? 'info' : 'neutral'}>
                          {card.isPickup ? 'Самовывоз' : 'Доставка'}
                        </StatusBadge>{' '}
                        · {intervalLabel(card)} · {card.positionCount} поз.
                      </div>
                      <div className="muted text-sm">
                        Собран:{' '}
                        {card.assembledAt === null ? '—' : formatMoscowDateTime(card.assembledAt)}
                        {card.floristName === null ? '' : ` · ${card.floristName}`}
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      data-testid="wh-awaiting-accept"
                      onClick={() => setAcceptingCard(card)}
                    >
                      Принять
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}

      {acceptingCard !== null && acceptIntent !== null && (
        <ScannerScreen
          resultWindow
          manualEntry={manualEntry}
          chain="RECEIVE"
          operation={`Приёмка · заказ ${acceptingCard.orderNumber}`}
          onIntent={acceptIntent}
          onClose={() => {
            setAcceptingCard(null);
            // Список и счётчик подравниваем после закрытия: приёмка могла
            // пройти в последнем кадре перед закрытием окна.
            void queryClient.invalidateQueries({ queryKey: ['warehouse-awaiting'] });
          }}
        />
      )}
    </div>
  );
}
