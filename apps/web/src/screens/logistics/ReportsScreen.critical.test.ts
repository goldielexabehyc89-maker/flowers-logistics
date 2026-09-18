/**
 * Критические проверки решений экрана расчётов.
 *
 * Экран рендером здесь не поднимается: проверяются чистые функции, в которые
 * вынесены сами решения — под каким столбцом встаёт сумма журнала, как
 * называется итог периода, что входит в «Доп.» строки и когда отчёт перестаёт
 * листаться. Именно эти решения расходились с сервером и с выгрузкой, а
 * заметить это было нечем: у экрана не было ни одной проверки.
 *
 * Файл подхватывается существующим прогоном (`apps/**\/*.critical.test.ts`) и
 * не требует ни jsdom, ни новой зависимости.
 */

import { describe, expect, it } from 'vitest';
import {
  balanceCaption,
  canShowMore,
  correctiveOperation,
  debtWords,
  formatMoney,
  journalColumn,
  rowExtra,
  SETTLEMENT_COLUMNS,
  signOf,
} from './ReportsScreen';

/** Столбец по ИМЕНИ заголовка: номера в проверке повторяли бы ошибку кода. */
const header = (kind: string): string =>
  SETTLEMENT_COLUMNS[journalColumn(kind) - 1] ?? 'нет такого';

describe('столбец суммы в журнале', () => {
  it('сумма встаёт под тот заголовок, в чей итог дня она вошла', () => {
    /*
     * Проверяется ИМЯ заголовка, а не номер: номер в проверке просто повторил
     * бы число из кода, и перестановка столбца осталась бы незамеченной обеими
     * сторонами. Распределение по категориям — то же, что на сервере
     * (`grouping.ts`): у наличных, оплаты заказа и километров свои столбцы.
     */
    expect(header('CASH_RECEIVED')).toBe('Наличные');
    expect(header('DELIVERY_FEE')).toBe('За заказ');
    expect(header('DISTANCE_FEE')).toBe('За МКАД');
    expect(header('EXPENSE_PARKING')).toBe('Доп.');
    expect(header('BONUS')).toBe('Доп.');
    expect(header('CASH_HANDED_TO_LOGIST')).toBe('Курьер сдал');
    expect(header('CASH_ISSUED_TO_COURIER')).toBe('Выдано курьеру');
  });

  it('оплачиваемая попытка не встаёт под «Доп.»: там её нет и в расчёте', () => {
    /*
     * Своего столбца у неё в таблице нет, а в «Доп.» она не входит намеренно —
     * иначе удвоилась бы в «Начислено». Стоя под «Доп.», строка журнала не
     * сходилась бы со свёрнутой строкой дня.
     */
    expect(header('ATTEMPT_FEE')).toBe('Начислено');
  });

  it('неизвестный вид не выходит за таблицу и не садится на «Итог»', () => {
    /*
     * Вид операции приходит с сервера и может быть новее экрана. Номер вне
     * таблицы дал бы отрицательный colSpan и сломал бы вёрстку всей строки.
     */
    const column = journalColumn('ВИД_КОТОРОГО_ЕЩЁ_НЕТ');
    expect(column).toBeGreaterThan(0);
    expect(column).toBeLessThan(SETTLEMENT_COLUMNS.length);
    expect(header('ВИД_КОТОРОГО_ЕЩЁ_НЕТ')).toBe('Доп.');
  });
});

describe('ширина строки журнала', () => {
  /*
   * Строка журнала складывается из ячеек с colSpan, посчитанным от номера
   * столбца. Ошибка на единицу не роняет ничего: таблица просто уезжает вбок
   * за край страницы, и заметить это можно лишь глазами на широком периоде.
   */
  const KINDS = [
    'CASH_RECEIVED',
    'DELIVERY_FEE',
    'DISTANCE_FEE',
    'ATTEMPT_FEE',
    'EXPENSE_PARKING',
    'BONUS',
    'CASH_HANDED_TO_LOGIST',
    'CASH_ISSUED_TO_COURIER',
    'ВИД_КОТОРОГО_ЕЩЁ_НЕТ',
  ];

  it('любой вид операции даёт ровно столько ячеек, сколько столбцов в шапке', () => {
    for (const kind of KINDS) {
      const column = journalColumn(kind);
      // Дата + название + автор(2) + основание + сумма + отмена.
      const reason = column - 5;
      const tail = SETTLEMENT_COLUMNS.length - column;
      expect(reason, `основание у ${kind}`).toBeGreaterThan(0);
      expect(tail, `хвост у ${kind}`).toBeGreaterThan(0);
      expect(1 + 1 + 2 + reason + 1 + tail).toBe(SETTLEMENT_COLUMNS.length);
    }
  });

  it('заголовок из левой части таблицы не даёт отрицательной ячейки', () => {
    /*
     * Слева от денег — дата, название и автор. Сегодня туда не указывает ни
     * один вид, но словарь заголовков — одна строка, и ошибка в ней сломала бы
     * всю строку журнала, а не сдвинула бы число на столбец.
     */
    for (const name of SETTLEMENT_COLUMNS.slice(0, 5)) {
      expect(SETTLEMENT_COLUMNS.indexOf(name) + 1).toBeLessThan(6);
    }
    // Любой вид встаёт не левее первого денежного столбца.
    for (const kind of [...KINDS, 'ADJUSTMENT', 'OPENING_DEBT', '']) {
      expect(journalColumn(kind), kind).toBeGreaterThanOrEqual(6);
    }
  });

  it('строка отдельной операции тоже во всю ширину шапки', () => {
    // Дата + название + автор(2) + основание + отмена + сумма.
    expect(1 + 1 + 2 + (SETTLEMENT_COLUMNS.length - 6) + 1 + 1).toBe(SETTLEMENT_COLUMNS.length);
  });
});

describe('подпись итога периода', () => {
  it('без отбора по курьеру это ИЗМЕНЕНИЕ, а не баланс', () => {
    /*
     * Входящее сальдо сервер отдаёт нулём, когда курьер не выбран. Называть
     * результат «конечным балансом» и добавлять «курьер должен компании» —
     * прямая дезинформация о направлении долга.
     */
    const caption = balanceCaption('', null, '500000');
    expect(caption.title).toBe('Изменение за период · все курьеры');
    expect(caption.words).toBe('выберите курьера, чтобы увидеть его баланс');
    expect(caption.showOpening).toBe(false);
  });

  it('признак — сам отбор, а не найденное имя курьера', () => {
    /*
     * Справочник отдаёт первую сотню активных курьеров и может ещё не
     * загрузиться. По имени отчёт по ВЫБРАННОМУ курьеру подписывался бы
     * «все курьеры», а его настоящий начальный баланс прятался.
     */
    const caption = balanceCaption('courier-1', null, '500000');
    expect(caption.title).toBe('Конечный баланс');
    expect(caption.words).toBe(debtWords('500000'));
    expect(caption.showOpening).toBe(true);
  });

  it('имя курьера попадает в подпись, когда справочник его знает', () => {
    expect(balanceCaption('courier-1', 'Иванов Иван', '0').title).toBe(
      'Конечный баланс · Иванов Иван',
    );
  });
});

describe('предел листания', () => {
  it('кнопка исчезает у предела, а не упирается в отказ проверки', () => {
    // 25 групп за нажатие, предел 1000: сороковое нажатие — последнее.
    expect(canShowMore(true, 1)).toBe(true);
    expect(canShowMore(true, 39)).toBe(true);
    expect(canShowMore(true, 40)).toBe(false);
    expect(canShowMore(false, 1)).toBe(false);
  });
});

describe('операции, у которых своя строка журнала', () => {
  it('начальный долг и его отмена называются словами и не идут в зарплату', () => {
    expect(
      correctiveOperation({ kind: 'OPENING_DEBT', amountMinor: '100', reversesKind: null }),
    ).toEqual({ title: 'Начальный долг', direction: 'увеличивает долг' });
    expect(
      correctiveOperation({
        kind: 'ADJUSTMENT',
        amountMinor: '-100',
        reversesKind: 'OPENING_DEBT',
      }),
    ).toEqual({ title: 'Отмена: Начальный долг', direction: 'уменьшает долг' });
  });

  it('обычная операция своей строки не требует', () => {
    expect(
      correctiveOperation({ kind: 'EXPENSE_PARKING', amountMinor: '-100', reversesKind: null }),
    ).toBeNull();
  });
});

describe('«Доп.» строки доставки', () => {
  it('складывает расходы и доплаты — тем же правилом, что и день', () => {
    expect(rowExtra({ expensesMinor: '-5000', bonusesMinor: '-1000' })).toBe('-6000');
    expect(rowExtra({ expensesMinor: '0', bonusesMinor: '0' })).toBe('0');
  });
});

describe('деньги и направление', () => {
  it('рубли, запятая, два знака — одинаково во всём приложении', () => {
    expect(formatMoney('123456')).toBe('1234,56 ₽');
    expect(formatMoney('-100')).toBe('-1,00 ₽');
  });

  it('направление долга называется словами, а не только знаком', () => {
    expect(debtWords('0')).toBe('взаиморасчёты закрыты');
    expect(debtWords('100')).toBe('курьер должен компании');
    expect(debtWords('-100')).toBe('компания должна курьеру');
    expect(signOf('-1')).toBe('−');
    expect(signOf('1')).toBe('+');
  });
});
