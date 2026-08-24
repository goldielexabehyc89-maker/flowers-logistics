/**
 * Раздел «История заказов»: найти заказ и открыть его историю.
 *
 * Отдельный раздел, а не вкладка «Логистики». Вкладки логистики — рабочие
 * места одного дня; сюда приходят, когда день давно закрыт и нужно разобрать
 * конкретный заказ за любую дату.
 *
 * ПОИСК СЕРВЕРНЫЙ. Фильтровать загруженную страницу нельзя: заказ, лежащий
 * на второй странице, «не нашёлся» бы молча — а это худший вид отказа.
 *
 * ЭКРАН ТОЛЬКО ЧИТАЕТ. Ни одного действия над заказом: строка отвечает на
 * вопрос «тот ли это заказ», а разбор идёт в самой истории.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from '../../ui/components';
import { formatMoscowDateTime } from '@fl/shared';
import {
  HISTORY_SEARCH_PAGE_SIZE,
  PROCESS_LABELS,
  RETURN_STATE_LABELS,
  ROUTE_STATE_LABELS,
  formatMoscowDay,
  intervalLine,
  mergeSearchPages,
  scrollKeyFor,
  type HistorySearchPage,
} from './order-history-search';
import './order-history-search.css';

export function OrderHistorySearchScreen(): React.JSX.Element {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [input, setInput] = useState(query);
  const listRef = useRef<HTMLUListElement | null>(null);

  /*
   * Строка поиска живёт в адресе.
   *
   * Возврат из истории заказа — это обычная кнопка «назад», и после неё экран
   * обязан показать тот же список. Держи мы запрос только в состоянии
   * компонента, он терялся бы на каждом переходе.
   */
  useEffect(() => {
    setInput(query);
  }, [query]);

  const search = useInfiniteQuery({
    queryKey: ['order-history-search', query],
    queryFn: ({ pageParam }) =>
      client.get<HistorySearchPage>(
        `/api/orders/history/search?query=${encodeURIComponent(query)}` +
          `&limit=${HISTORY_SEARCH_PAGE_SIZE}&offset=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last: HistorySearchPage) =>
      last.hasMore ? last.offset + last.items.length : undefined,
    enabled: query !== '',
  });

  const pages = search.data?.pages ?? [];
  const items = mergeSearchPages(pages);
  const total = pages[0]?.total ?? 0;

  /*
   * Положение списка возвращается вместе со списком.
   *
   * Человек прокрутил результаты, открыл историю, вернулся — и должен увидеть
   * ту же строку, а не начало списка. Страницы держит кэш запроса, а смещение
   * прокрутки — сессия вкладки: оно относится к вкладке, а не к учётной записи.
   */
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    const key = scrollKeyFor(query);
    const saved = window.sessionStorage.getItem(key);
    if (saved !== null) {
      const container = document.querySelector('.shell__content');
      const offset = Number(saved);
      if (Number.isFinite(offset)) {
        if (container !== null) {
          container.scrollTop = offset;
        }
        window.scrollTo({ top: offset });
      }
    }
    return () => {
      const container = document.querySelector('.shell__content');
      const offset = container === null ? window.scrollY : container.scrollTop;
      window.sessionStorage.setItem(key, String(offset));
    };
  }, [items.length, query]);

  function submit(value: string): void {
    const trimmed = value.trim();
    setParams(trimmed === '' ? {} : { q: trimmed }, { replace: true });
  }

  return (
    <section className="stack order-search" data-testid="order-history-search">
      <header className="order-search__top">
        <h1 className="order-search__title">История заказов</h1>
        <p className="muted text-sm">
          Поиск по номеру заказа или номеру возврата. День доставки не ограничен: находятся и
          доставленные, и отменённые, и списанные заказы.
        </p>
      </header>

      <form
        className="order-search__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(input);
        }}
      >
        <input
          className="input order-search__input"
          type="search"
          aria-label="Номер заказа или возврата"
          placeholder="Номер заказа или возврата"
          data-testid="order-history-search-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button variant="primary" type="submit" data-testid="order-history-search-submit">
          Найти
        </Button>
      </form>

      {query === '' && (
        <p className="muted text-sm" data-testid="order-history-search-hint">
          Введите номер заказа — например, часть номера.
        </p>
      )}

      {query !== '' && search.isPending && <LoadingState title="Ищем заказ…" />}
      {search.isError && (
        <ErrorState title="Не удалось выполнить поиск" onRetry={() => void search.refetch()} />
      )}

      {query !== '' && search.isSuccess && items.length === 0 && (
        <EmptyState title="Ничего не найдено" />
      )}

      {items.length > 0 && (
        <ul className="order-search__list" data-testid="order-history-results" ref={listRef}>
          {items.map((item) => (
            <li
              key={item.orderId}
              className="order-search__row"
              data-testid="order-history-result"
              data-order-number={item.number}
              data-order-id={item.orderId}
            >
              <div className="order-search__main">
                <button
                  type="button"
                  className="order-search__number"
                  data-testid="order-history-open"
                  onClick={() =>
                    void navigate(`/order-history/${item.orderId}`, { state: { fromList: true } })
                  }
                >
                  {item.number}
                </button>
                <span className="order-search__stage">
                  {PROCESS_LABELS[item.processState] ?? item.processState}
                </span>
                {item.pickup && <StatusBadge tone="info">Самовывоз</StatusBadge>}
                {item.cancellation !== null && (
                  <StatusBadge tone="error">
                    {item.cancellation.source ? 'Отменён в МоёмСкладе' : 'Отменён логистом'}
                  </StatusBadge>
                )}
              </div>

              <dl className="order-search__facts">
                <Fact label="Доставка" value={formatMoscowDay(item.deliveryDate)} />
                <Fact label="Интервал" value={intervalLine(item.interval)} />
                <Fact label="Флорист" value={item.florist?.fullName ?? null} />
                <Fact
                  label="Лист"
                  value={
                    item.route === null
                      ? null
                      : `${item.route.number} · ${ROUTE_STATE_LABELS[item.route.state] ?? item.route.state}`
                  }
                />
                <Fact label="Курьер" value={item.courier?.fullName ?? null} />
                <Fact
                  label="Ячейка"
                  value={item.cell === null ? null : `${item.cell.code} · ${item.cell.kind}`}
                />
                <Fact
                  label="Доставка"
                  value={
                    item.delivery === null
                      ? null
                      : item.delivery.outcome === 'DELIVERED'
                        ? 'Доставлен'
                        : `Не доставлен${item.delivery.reason === null ? '' : ` · ${item.delivery.reason}`}`
                  }
                />
                <Fact
                  label="Возврат"
                  value={
                    item.returnObligation === null
                      ? null
                      : `${item.returnObligation.displayNumber} · ${
                          RETURN_STATE_LABELS[item.returnObligation.state] ??
                          item.returnObligation.state
                        }`
                  }
                />
                <Fact
                  label="Последнее событие"
                  value={item.lastEventAt === null ? null : formatMoscowDateTime(item.lastEventAt)}
                />
              </dl>

              <Button
                variant="secondary"
                data-testid="order-history-open-button"
                onClick={() =>
                  void navigate(`/order-history/${item.orderId}`, { state: { fromList: true } })
                }
              >
                Открыть историю
              </Button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="order-search__more">
          <span className="muted text-sm" data-testid="order-history-count">
            Показано {items.length} из {total}
          </span>
          {search.hasNextPage && (
            <Button
              variant="secondary"
              data-testid="order-history-more"
              disabled={search.isFetchingNextPage}
              onClick={() => void search.fetchNextPage()}
            >
              {search.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Факт строки. Пустое значение не показывается: его отсутствие — тоже ответ. */
function Fact({ label, value }: { label: string; value: string | null }): React.JSX.Element | null {
  if (value === null || value === '') {
    return null;
  }
  return (
    <div className="order-search__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
