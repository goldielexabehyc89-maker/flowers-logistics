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
  signOf,
} from './ReportsScreen';

describe('столбец суммы в журнале', () => {
  it('сумма встаёт под тот столбец, в который вошла итогом дня', () => {
    // 11 — «Курьер сдал», 12 — «Выдано курьеру», 9 — «Доп.», 10 — «Начислено».
    expect(journalColumn('CASH_HANDED_TO_LOGIST')).toBe(11);
    expect(journalColumn('CASH_ISSUED_TO_COURIER')).toBe(12);
    expect(journalColumn('EXPENSE_PARKING')).toBe(9);
    expect(journalColumn('BONUS')).toBe(9);
  });

  it('оплачиваемая попытка не встаёт под «Доп.»: там её нет и в расчёте', () => {
    /*
     * Своего столбца у неё в таблице нет, а в «Доп.» она не входит намеренно —
     * иначе удвоилась бы в «Начислено». Стоя под «Доп.», строка журнала не
     * сходилась бы со свёрнутой строкой дня.
     */
    expect(journalColumn('ATTEMPT_FEE')).toBe(10);
    expect(journalColumn('ATTEMPT_FEE')).not.toBe(journalColumn('EXPENSE_PARKING'));
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
