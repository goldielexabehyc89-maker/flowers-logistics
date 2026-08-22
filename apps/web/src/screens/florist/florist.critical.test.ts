/**
 * Критические проверки правил экрана флориста.
 *
 * Проверяется не вёрстка, а решения, ошибка в которых стоит дорого: показать
 * кнопку «Собран» тому, за кем заказ не закреплён, предложить «Взять в работу»
 * без смены или превратить точное время в выдуманный диапазон.
 *
 * Ни одна из этих функций защитой не является — право на действие проверяет
 * сервер. Но интерфейс, обещающий невозможное, приводит человека к отказу
 * после работы, а не до неё, и это тоже дефект.
 */

import { describe, expect, it } from 'vitest';
import {
  QUEUE_PAGE_SIZE,
  QUEUE_POLL_MS,
  availableActions,
  groupQueueByRoute,
  queueGroupTitle,
  formatInterval,
  formatQuantity,
  latestJob,
  mergePages,
  nextPageOffset,
  pageSummary,
  printStateLabel,
  processLabel,
  routeLabel,
  type OrderCardView,
  type QueueItemView,
} from './florist';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function card(overrides: Partial<OrderCardView> = {}): OrderCardView {
  return {
    id: 'order-1',
    number: 'FL-1',
    deliveryDate: '2027-03-10',
    startMinute: 600,
    endMinute: 840,
    cardText: null,
    description: null,
    positions: [],
    process: {
      state: 'NEW',
      version: 0,
      assignee: null,
      assignedAt: null,
      assembledAt: null,
      assembledById: null,
    },
    changedSinceClaim: false,
    print: { formId: null, jobs: [] },
    ...overrides,
  };
}

describe('доступные действия', () => {
  it('без активной смены «Взять в работу» не предлагается', () => {
    const actions = availableActions({
      card: card(),
      viewerId: VIEWER,
      isAdmin: false,
      hasActiveShift: false,
    });
    expect(actions.canClaim).toBe(false);

    const onShift = availableActions({
      card: card(),
      viewerId: VIEWER,
      isAdmin: false,
      hasActiveShift: true,
    });
    expect(onShift.canClaim).toBe(true);
  });

  it('«Собран» доступен только исполнителю, а не всякому, кто открыл карточку', () => {
    const mine = card({
      process: {
        state: 'IN_ASSEMBLY',
        version: 1,
        assignee: { id: VIEWER, fullName: 'Я' },
        assignedAt: null,
        assembledAt: null,
        assembledById: null,
      },
    });
    const foreign = card({
      process: {
        state: 'IN_ASSEMBLY',
        version: 1,
        assignee: { id: OTHER, fullName: 'Коллега' },
        assignedAt: null,
        assembledAt: null,
        assembledById: null,
      },
    });

    expect(
      availableActions({ card: mine, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canAssemble,
    ).toBe(true);
    // Даже администратору: завершать чужую сборку молча нельзя.
    expect(
      availableActions({ card: foreign, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canAssemble,
    ).toBe(false);
    // Но освободить чужой заказ администратор вправе.
    expect(
      availableActions({ card: foreign, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canRelease,
    ).toBe(true);
  });

  it('после закрытия смены «Собран» и отказ исчезают, а у администратора остаются', () => {
    const mine = card({
      process: {
        state: 'IN_ASSEMBLY',
        version: 1,
        assignee: { id: VIEWER, fullName: 'Я' },
        assignedAt: null,
        assembledAt: null,
        assembledById: null,
      },
    });

    // Смена закрыта: сервер откажет, и кнопка не должна этого обещать.
    const closed = availableActions({
      card: mine,
      viewerId: VIEWER,
      isAdmin: false,
      hasActiveShift: false,
    });
    expect(closed.canAssemble).toBe(false);
    expect(closed.canRelease).toBe(false);

    // Администратор разбирает оставшиеся назначения и в смене не нуждается.
    const admin = availableActions({
      card: mine,
      viewerId: OTHER,
      isAdmin: true,
      hasActiveShift: false,
    });
    expect(admin.canRelease).toBe(true);
    expect(admin.canAssemble).toBe(false);
  });

  it('возврат в работу — только администратору и только для собранного', () => {
    const assembled = card({
      process: {
        state: 'ASSEMBLED',
        version: 2,
        assignee: { id: VIEWER, fullName: 'Я' },
        assignedAt: null,
        assembledAt: '2027-03-10T09:00:00.000Z',
        assembledById: VIEWER,
      },
    });

    expect(
      availableActions({ card: assembled, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canReopen,
    ).toBe(false);
    expect(
      availableActions({ card: assembled, viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canReopen,
    ).toBe(true);
    expect(
      availableActions({ card: card(), viewerId: VIEWER, isAdmin: true, hasActiveShift: true })
        .canReopen,
    ).toBe(false);
  });

  it('действия печати появляются только вместе с бланком', () => {
    expect(
      availableActions({ card: card(), viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canPrint,
    ).toBe(false);

    const withForm = card({ print: { formId: 'form-1', jobs: [] } });
    expect(
      availableActions({ card: withForm, viewerId: VIEWER, isAdmin: false, hasActiveShift: true })
        .canPrint,
    ).toBe(true);
  });
});

describe('показ значений', () => {
  it('точное время не превращается в диапазон', () => {
    expect(formatInterval({ startMinute: 840, endMinute: 840 })).toBe('14:00');
    expect(formatInterval({ startMinute: 840, endMinute: null })).toBe('14:00');
    expect(formatInterval({ startMinute: 600, endMinute: 840 })).toBe('10:00 – 14:00');
    expect(formatInterval({ startMinute: null, endMinute: null })).toBe('без времени');
  });

  it('состояния названы по-русски, неизвестное не скрывается', () => {
    expect(processLabel('NEEDS_REVIEW')).toBe('Требует проверки');
    expect(printStateLabel('ERROR')).toBe('Ошибка печати');
    // Неизвестное состояние показывается как есть: молчание хуже непонятного кода.
    expect(processLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('маршрут объясняет, почему заказ поднялся выше', () => {
    const item: QueueItemView = {
      id: 'o1',
      number: 'FL-1',
      deliveryDate: '2027-03-10',
      startMinute: 900,
      endMinute: 960,
      overdue: false,
      processState: 'NEW',
      assignee: null,
      route: { id: 'r1', number: 'R-2027-03-10-001', position: 2 },
      hasPrintForm: false,
      changedSinceClaim: false,
    };

    expect(routeLabel(item)).toBe('Маршрут R-2027-03-10-001, остановка 2');
    expect(routeLabel({ ...item, route: null })).toBeNull();
  });

  /**
   * Количество с единицей.
   *
   * Правило повторяет серверное (`apps/api/.../pdf.ts`) намеренно: экран и
   * бумага обязаны показывать одно число одинаково. «0.5 м» на экране и
   * «0,5 м» на бланке читались бы как два разных документа об одном заказе.
   */
  it('количество показывается с запятой и подтверждённой единицей', () => {
    expect(formatQuantity('2', 'шт')).toBe('2 шт');
    expect(formatQuantity('0.5', 'м')).toBe('0,5 м');
    expect(formatQuantity('11', 'шт')).toBe('11 шт');
  });

  it('без подтверждённой единицы показывается одно число', () => {
    // Ни «ед. не указана», ни подставленного «шт»: догадка выглядит как факт
    // и уводит сборку — 2 метра ленты и 2 штуки лент это разные заказы.
    expect(formatQuantity('2', null)).toBe('2');
    expect(formatQuantity('0.5', null)).toBe('0,5');
    expect(formatQuantity('2', '   ')).toBe('2');
  });

  it('счётчик показывает и показанное, и общее', () => {
    // Оба числа обязательны: без общего список выглядит полным, и заказ за
    // границей страницы перестаёт существовать для того, кто на него смотрит.
    expect(pageSummary(50, 111)).toBe('Показано 50 из 111');
    expect(pageSummary(12, 12)).toBe('Показано 12 из 12');
  });

  it('последнее задание печати — с наибольшим номером попытки', () => {
    const view = card({
      print: {
        formId: 'form-1',
        jobs: [
          {
            id: 'job-1',
            attempt: 1,
            state: 'ERROR',
            createdAt: '2027-03-10T09:00:00.000Z',
            completedAt: null,
            lastErrorCode: 'PRINTER_OFFLINE',
          },
          {
            id: 'job-2',
            attempt: 2,
            state: 'PENDING',
            createdAt: '2027-03-10T09:05:00.000Z',
            completedAt: null,
            lastErrorCode: null,
          },
        ],
      },
    });

    expect(latestJob(view)?.id).toBe('job-2');
    expect(latestJob(card())).toBeNull();
  });
});

/**
 * Накопление страниц.
 *
 * Проверяется то, чего не видно на экране до самого отказа: смещение следующей
 * страницы и склейка накопленного. Ошибка здесь не выглядит ошибкой — список
 * просто показывает заказ дважды или молча теряет его, и человек собирает
 * не то, что нужно.
 */
describe('страницы очереди', () => {
  it('следующая страница считается по ответу сервера, а не по числу строк', () => {
    // Продолжение обещает СЕРВЕР. Догадка «пришло меньше, чем просили — значит
    // конец» ошибается ровно там, где последняя страница полная.
    expect(nextPageOffset({ total: 111, limit: 50, offset: 0, hasMore: true })).toBe(50);
    expect(nextPageOffset({ total: 111, limit: 50, offset: 50, hasMore: true })).toBe(100);
    expect(nextPageOffset({ total: 100, limit: 50, offset: 50, hasMore: false })).toBeNull();
    // Ровно полная последняя страница продолжения не обещает.
    expect(nextPageOffset({ total: 50, limit: 50, offset: 0, hasMore: false })).toBeNull();
  });

  it('склейка страниц не теряет порядок и не повторяет заказ', () => {
    const page = (numbers: number[]): { items: { id: string }[] } => ({
      items: numbers.map((value) => ({ id: `order-${value}` })),
    });

    expect(mergePages([page([1, 2, 3]), page([4, 5])]).map((item) => item.id)).toEqual([
      'order-1',
      'order-2',
      'order-3',
      'order-4',
      'order-5',
    ]);

    // Очередь живая: пока человек читал первую страницу, заказ мог уйти,
    // смещение сдвинулось, и строка пришла второй раз. В списке она обязана
    // остаться одна и на своём — верхнем — месте.
    const withRepeat = mergePages([page([1, 2, 3]), page([3, 4])]);
    expect(withRepeat.map((item) => item.id)).toEqual(['order-1', 'order-2', 'order-3', 'order-4']);
    expect(new Set(withRepeat.map((item) => item.id)).size).toBe(withRepeat.length);

    expect(mergePages([])).toEqual([]);
  });

  it('клиент просит ровно столько, сколько сервер отдаёт по умолчанию', () => {
    // Разойдись эти числа — «Загрузить ещё» пропускала бы или повторяла строки.
    expect(QUEUE_PAGE_SIZE).toBe(50);
  });
});

describe('группы очереди', () => {
  function row(overrides: Partial<QueueItemView> & { id: string }): QueueItemView {
    return {
      number: overrides.id,
      deliveryDate: '2027-03-10',
      startMinute: 600,
      endMinute: 840,
      overdue: false,
      processState: 'NEW',
      assignee: null,
      route: null,
      hasPrintForm: false,
      changedSinceClaim: false,
      ...overrides,
    };
  }

  it('ближайшие самовывозы идут своей группой над маршрутными листами', () => {
    const route = { id: 'r1', number: 'МЛ-1', position: 1 };
    const groups = groupQueueByRoute([
      row({ id: 'p1', pickupSoon: true }),
      row({ id: 'p2', pickupSoon: true }),
      row({ id: 'r-a', route }),
      row({ id: 'plain' }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['pickup-soon', 'route', 'none']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['p1', 'p2']);
    expect(queueGroupTitle(groups[0]!)).toBe('Ближайшие самовывозы');
    expect(queueGroupTitle(groups[1]!)).toBe('Маршрут МЛ-1');
    expect(queueGroupTitle(groups[2]!)).toBe('Без маршрута');
  });

  it('заказ приоритетной группы не повторяется в маршрутной', () => {
    // Самовывоз может числиться и в подтверждённом листе. Показать его дважды
    // значило бы предложить собрать один букет два раза.
    const route = { id: 'r1', number: 'МЛ-1', position: 2 };
    const groups = groupQueueByRoute([
      row({ id: 'pickup', pickupSoon: true, route }),
      row({ id: 'other', route }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['pickup-soon', 'route']);
    const shown = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(shown).toEqual(['pickup', 'other']);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('очередь перезапрашивается сама: порог наступает от хода времени', () => {
    // Момент «осталось меньше часа» не сопровождается ничьим действием, и
    // realtime о нём молчит. Без опроса заказ поднялся бы только по F5.
    expect(QUEUE_POLL_MS).toBeGreaterThan(0);
    expect(QUEUE_POLL_MS).toBeLessThanOrEqual(60_000);
  });
});
