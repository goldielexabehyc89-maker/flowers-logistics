/**
 * Вкладка склада «Ожидают приёмки».
 *
 * Показывает собранные флористом заказы, которых ещё нет на полке: их склад
 * должен принять. Это ЭКРАН — он ничего не разрешает и статусов не заводит.
 *
 * Вид — таблица по дням: заголовок дня вдавлен (группа), заказы приподняты
 * (карточки-строки), день сворачивается и разворачивается. Справа от поиска —
 * чипы «Все / Доставка / Самовывоз» со счётчиками; поиск вдавлен в фон.
 * Самовывоз слегка отличается заливкой строки.
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
 * ручной ввод на складе и в самовывозе»; отдельного переключателя нет.
 */

import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
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
import { type AwaitingTypeFilter } from './awaiting-view';
import { assembledDateLabel } from '../florist/florist';

/** Размер страницы: полный набор доступен догрузкой, без потери строк. */
const AWAITING_PAGE_SIZE = 50;

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
  /** Счётчики чипов: учитывают поиск, но НЕ тип. Считает сервер. */
  counts: { all: number; delivery: number; pickup: number };
  /** Полное число без поиска — счётчик вкладки. */
  fullTotal: number;
  /** Страница текущего отбора (поиск + тип). */
  page: { total: number; limit: number; offset: number; hasMore: boolean };
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

const TYPE_FILTERS: readonly { key: AwaitingTypeFilter; title: string }[] = [
  { key: 'all', title: 'Все' },
  { key: 'delivery', title: 'Доставка' },
  { key: 'pickup', title: 'Самовывоз' },
];

/** Одна строка-заказ: приподнятая карточка в табличной сетке. */
function AwaitingRow({
  card,
  onAccept,
}: {
  card: AwaitingCard;
  onAccept: () => void;
}): React.JSX.Element {
  return (
    <article
      className={card.isPickup ? 'wh-awaiting__row wh-awaiting__row--pickup' : 'wh-awaiting__row'}
      data-testid="wh-awaiting-card"
      data-order-number={card.orderNumber}
    >
      <div className="wh-awaiting__cell wh-awaiting__cell--order">
        <span className="wh-awaiting__colhead">Заказ</span>
        <strong className="wh-awaiting__number">{card.orderNumber}</strong>
      </div>
      <div className="wh-awaiting__cell wh-awaiting__cell--type">
        <span className="wh-awaiting__colhead">Тип</span>
        <StatusBadge tone={card.isPickup ? 'info' : 'neutral'}>
          {card.isPickup ? 'Самовывоз' : 'Доставка'}
        </StatusBadge>
      </div>
      <div className="wh-awaiting__cell wh-awaiting__cell--interval">
        <span className="wh-awaiting__colhead">Интервал</span>
        <span>{intervalLabel(card)}</span>
      </div>
      <div className="wh-awaiting__cell wh-awaiting__cell--count">
        <span className="wh-awaiting__colhead">Позиций</span>
        <span>{card.positionCount}</span>
      </div>
      <div className="wh-awaiting__cell wh-awaiting__cell--assembled">
        <span className="wh-awaiting__colhead">Собран</span>
        <span className="muted text-sm">
          {card.assembledAt === null ? '—' : formatMoscowDateTime(card.assembledAt)}
          {card.floristName === null ? '' : ` · ${card.floristName}`}
        </span>
      </div>
      <div className="wh-awaiting__cell wh-awaiting__cell--action">
        <Button variant="primary" data-testid="wh-awaiting-accept" onClick={onAccept}>
          Принять
        </Button>
      </div>
    </article>
  );
}

export function AwaitingTab({ manualEntry }: ManualEntryProps): React.JSX.Element {
  const { client } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<AwaitingTypeFilter>('all');
  /** Свёрнутые дни: ключ группы. По умолчанию все развёрнуты. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /** Карточка, которую сейчас принимают: открыт сканер именно на неё. */
  const [acceptingCard, setAcceptingCard] = useState<AwaitingCard | null>(null);

  const term = search.trim();
  const awaiting = useInfiniteQuery({
    queryKey: ['warehouse-awaiting', term, typeFilter],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (term !== '') {
        params.set('search', term);
      }
      if (typeFilter !== 'all') {
        params.set('method', typeFilter);
      }
      params.set('limit', String(AWAITING_PAGE_SIZE));
      params.set('offset', String(pageParam));
      return client.get<AwaitingResponse>(`/api/warehouse/awaiting?${params.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last: AwaitingResponse) =>
      last.page.hasMore ? last.page.offset + last.page.limit : undefined,
  });

  const pages = useMemo(() => awaiting.data?.pages ?? [], [awaiting.data]);
  // Строки склеиваются с дедупом по orderId: набор живёт, и между страницами
  // смещение может сдвинуться — один заказ пришёл бы дважды.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const merged: AwaitingCard[] = [];
    for (const page of pages) {
      for (const card of page.items) {
        if (!seen.has(card.orderId)) {
          seen.add(card.orderId);
          merged.push(card);
        }
      }
    }
    return merged;
  }, [pages]);
  // Счётчики чипов и итог — с СЕРВЕРА (первая страница): один и тот же набор
  // правил, поэтому чипы, вкладка и список не расходятся и не упираются в 500.
  const counts = pages[0]?.counts ?? { all: 0, delivery: 0, pickup: 0 };
  const selectionTotal = pages[0]?.page.total ?? 0;
  const groups = useMemo(() => groupByDate(items, new Date()), [items]);

  const toggleDay = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
      <div className="wh-awaiting__panel">
        <div className="wh-awaiting__intro">
          <h3>Ожидают приёмки</h3>
          <p className="muted text-sm">
            Собранные заказы, которых ещё нет на полке. «Принять» открывает сканер: сначала заказ,
            затем ячейка.
          </p>
        </div>

        <div className="wh-awaiting__controls">
          <input
            className="wh-awaiting__search"
            type="search"
            inputMode="search"
            placeholder="Номер заказа"
            aria-label="Поиск по номеру заказа"
            data-testid="wh-awaiting-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="wh-awaiting__filters" role="group" aria-label="Тип получения">
            {TYPE_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className={
                  filter.key === typeFilter
                    ? 'wh-awaiting__chip wh-awaiting__chip--active'
                    : 'wh-awaiting__chip'
                }
                aria-pressed={filter.key === typeFilter}
                data-testid={`wh-awaiting-filter-${filter.key}`}
                onClick={() => setTypeFilter(filter.key)}
              >
                {filter.title}
                <span className="wh-awaiting__chip-count">{counts[filter.key]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {awaiting.isPending ? (
        <LoadingState title="Загружаем список…" />
      ) : awaiting.isError ? (
        <ErrorState title="Не удалось загрузить список" onRetry={() => void awaiting.refetch()} />
      ) : selectionTotal === 0 ? (
        <EmptyState
          title="Пусто"
          description={
            term !== ''
              ? 'По этому номеру ничего не найдено.'
              : typeFilter === 'pickup'
                ? 'Среди ожидающих нет самовывоза.'
                : typeFilter === 'delivery'
                  ? 'Среди ожидающих нет доставки.'
                  : 'Нет собранных заказов, ожидающих приёмки.'
          }
        />
      ) : (
        <div className="stack" data-testid="wh-awaiting-list">
          <p className="muted text-sm" data-testid="wh-awaiting-total">
            Показано {items.length} из {selectionTotal}
          </p>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <section
                key={group.key}
                className="wh-awaiting__group"
                data-awaiting-group={group.key}
                data-testid="wh-awaiting-group"
              >
                <button
                  type="button"
                  className="wh-awaiting__group-head"
                  aria-expanded={!isCollapsed}
                  data-testid="wh-awaiting-group-toggle"
                  onClick={() => toggleDay(group.key)}
                >
                  <span className="wh-awaiting__group-date">{group.label}</span>
                  <span className="wh-awaiting__group-meta">
                    <span className="wh-awaiting__group-count">{group.items.length}</span>
                    <span
                      className={
                        isCollapsed
                          ? 'wh-awaiting__chevron'
                          : 'wh-awaiting__chevron wh-awaiting__chevron--open'
                      }
                      aria-hidden="true"
                    >
                      ▾
                    </span>
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="wh-awaiting__table">
                    <div className="wh-awaiting__thead" aria-hidden="true">
                      <span className="wh-awaiting__cell--order">Заказ</span>
                      <span className="wh-awaiting__cell--type">Тип</span>
                      <span className="wh-awaiting__cell--interval">Интервал</span>
                      <span className="wh-awaiting__cell--count">Позиций</span>
                      <span className="wh-awaiting__cell--assembled">Собран</span>
                      <span className="wh-awaiting__cell--action" />
                    </div>
                    {group.items.map((card) => (
                      <AwaitingRow
                        key={card.orderId}
                        card={card}
                        onAccept={() => setAcceptingCard(card)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {awaiting.hasNextPage && (
            <div className="wh-awaiting__more">
              <Button
                variant="secondary"
                data-testid="wh-awaiting-more"
                disabled={awaiting.isFetchingNextPage}
                onClick={() => void awaiting.fetchNextPage()}
              >
                {awaiting.isFetchingNextPage ? 'Загрузка…' : 'Загрузить ещё'}
              </Button>
            </div>
          )}
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
