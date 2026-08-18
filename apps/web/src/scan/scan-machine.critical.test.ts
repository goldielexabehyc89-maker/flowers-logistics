/**
 * Критические проверки машины складского сканирования.
 *
 * Проверяется не «рисуется ли видео», а нарушение чего теряет коробку или
 * удваивает операцию:
 *
 *  * один неподвижный QR в кадре даёт ровно одно событие;
 *  * пока идёт запрос или открыто уведомление, ввод заблокирован целиком;
 *  * до полной пары «заказ + ячейка» серверу ничего не отправляется;
 *  * комплектование отправляет ФАКТИЧЕСКИ отсканированную ячейку;
 *  * выдача не закрывает сессию между заказами и закрывает её на последнем;
 *  * ошибка не откатывает подтверждённый заказ и не двигает прогресс.
 *
 * Камера, часы и сеть сюда не попадают намеренно: таймерные прогоны доказывают
 * поведение среды, а не правила, и в CI ведут себя иначе, чем на телефоне.
 */

import { describe, expect, it } from 'vitest';
import {
  canAccept,
  scanTitle,
  initialState,
  isFinished,
  reduce,
  stepHint,
  type ScanChain,
  type ScanEvent,
  type ScanIntent,
  type ScanState,
} from './scan-machine';

/** Прогоняет события подряд, собирая намерения. */
function run(chain: ScanChain, events: ScanEvent[]): { state: ScanState; intents: ScanIntent[] } {
  let state = initialState(chain);
  const intents: ScanIntent[] = [];
  for (const event of events) {
    const step = reduce(state, event);
    state = step.state;
    if (step.intent.kind !== 'none') {
      intents.push(step.intent);
    }
  }
  return { state, intents };
}

describe('один QR — одна операция', () => {
  it('повтор того же кода без исчезновения из кадра игнорируется', () => {
    const { intents } = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'scanned', code: 'W-1' },
      { type: 'scanned', code: 'W-1' },
    ]);

    expect(intents).toEqual([{ kind: 'resolveOrder', code: 'W-1' }]);
  });

  it('во время запроса к серверу кадры не принимаются', () => {
    const busy = run('RECEIVE', [{ type: 'scanned', code: 'W-1' }]).state;

    expect(busy.busy).toBe(true);
    expect(canAccept(busy)).toBe(false);
    expect(reduce(busy, { type: 'scanned', code: 'W-2' }).intent).toEqual({ kind: 'none' });
  });

  it('пока открыто уведомление, ввод заблокирован', () => {
    const withNotice = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'failed', text: 'Заказ не найден.' },
    ]).state;

    expect(canAccept(withNotice)).toBe(false);
    expect(reduce(withNotice, { type: 'scanned', code: 'W-9' }).intent).toEqual({ kind: 'none' });
  });

  it('после пустого кадра тот же код принимается снова', () => {
    const { intents } = run('ISSUE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'succeeded', text: 'выдан', progress: { done: 1, total: 3 }, final: false },
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'W-1' },
    ]);

    // Второй раз это осознанный повтор человека, а не тот же кадр: сервер
    // ответит идемпотентно и прогресс не удвоит.
    expect(intents).toHaveLength(2);
    expect(intents[1]).toEqual({ kind: 'issueOrder', orderNumber: 'W-1' });
  });
});

describe('приёмка: пара заказ → ячейка', () => {
  it('до второго скана серверу ничего не отправляется', () => {
    const { state, intents } = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
    ]);

    expect(intents).toEqual([{ kind: 'resolveOrder', code: 'W-1' }]);
    expect(state.step).toBe('CELL');
    // Формулировка приведена к общей для всего склада: под камерой человек
    // читает одну и ту же строку в любом сценарии.
    expect(stepHint(state)).toBe('Наведите камеру на QR-код ячейки');
  });

  it('вторая пара уходит одним запросом и завершает цепочку', () => {
    const { state, intents } = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      // Промежуточный успех показан и исчез сам: только после этого машина
      // принимает следующий код.
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'S-01' },
      { type: 'succeeded', text: 'принят', final: true },
    ]);

    expect(intents[1]).toEqual({
      kind: 'submitPair',
      orderNumber: 'W-1',
      cellCode: 'S-01',
      target: 'STORAGE',
      routeId: null,
      allowNewCell: false,
    });
    expect(state.notice).toEqual({ kind: 'success', text: 'принят' });
    // Экран закроется только после того, как успех прочитан.
    expect(isFinished(state)).toBe(false);
    expect(isFinished(reduce(state, { type: 'noticeExpired' }).state)).toBe(true);
  });

  it('маршрутная ячейка требует явного согласия, отказ возвращает к выбору другой', () => {
    const asked = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'R-01' },
      { type: 'consentRequired', cellCode: 'R-01' },
    ]).state;

    expect(asked.step).toBe('ROUTE_CELL_CONSENT');
    // Пока вопрос открыт, кадры не принимаются: молча в маршрутную ячейку
    // заказ не попадёт.
    expect(canAccept(asked)).toBe(false);

    const declined = reduce(asked, { type: 'consentAnswered', agreed: false });
    expect(declined.intent).toEqual({ kind: 'none' });
    expect(declined.state.step).toBe('CELL');
    expect(declined.state.orderNumber).toBe('W-1');

    const agreed = reduce(asked, { type: 'consentAnswered', agreed: true });
    expect(agreed.intent).toEqual({
      kind: 'submitPair',
      orderNumber: 'W-1',
      cellCode: 'R-01',
      target: 'STORAGE',
      routeId: null,
      allowNewCell: false,
    });
  });

  it('ошибка ячейки сохраняет подтверждённый заказ и возвращает на шаг ячейки', () => {
    const failed = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'S-OFF' },
      { type: 'failed', text: 'Ячейка выключена.' },
    ]).state;

    expect(failed.notice?.kind).toBe('error');
    // Ошибка называет и распознанное, и ожидаемое: иначе человек подносит
    // к камере тот же самый код ещё раз.
    expect(failed.notice?.scanned).toBe('S-OFF');
    expect(failed.notice?.expected).toBe('QR-код ячейки хранения');

    const retried = reduce(failed, { type: 'retry' }).state;
    expect(retried.step).toBe('CELL');
    expect(retried.orderNumber).toBe('W-1');
    expect(canAccept(retried)).toBe(true);
  });
});

describe('комплектование: ячейка из скана, а не из карточки', () => {
  it('отправляется именно отсканированный код ячейки', () => {
    const { intents } = run('PICK', [
      { type: 'scanned', code: 'W-7' },
      { type: 'orderResolved', orderNumber: 'W-7' },
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'R-42' },
    ]);

    expect(intents[1]).toEqual({
      kind: 'submitPair',
      orderNumber: 'W-7',
      cellCode: 'R-42',
      target: 'ROUTE',
      routeId: null,
      allowNewCell: false,
    });
  });

  it('подсказка второго шага называет именно маршрутную ячейку', () => {
    const state = run('PICK', [
      { type: 'scanned', code: 'W-7' },
      { type: 'orderResolved', orderNumber: 'W-7' },
    ]).state;

    expect(stepHint(state)).toBe('Наведите камеру на QR-код маршрутной ячейки');
  });

  it('успех завершает цепочку одного заказа: следующий начинается заново', () => {
    const state = run('PICK', [
      { type: 'scanned', code: 'W-7' },
      { type: 'orderResolved', orderNumber: 'W-7' },
      { type: 'scanned', code: 'R-42' },
      { type: 'succeeded', text: 'перенесён', progress: { done: 1, total: 3 }, final: true },
      { type: 'noticeExpired' },
    ]).state;

    expect(isFinished(state)).toBe(true);
  });
});

describe('выдача: одна сессия на лист', () => {
  it('камера остаётся открытой между заказами и закрывается на последнем', () => {
    const afterFirst = run('ISSUE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'succeeded', text: 'выдан 1 из 3', progress: { done: 1, total: 3 }, final: false },
      { type: 'noticeExpired' },
    ]).state;

    expect(afterFirst.step).toBe('ORDER');
    expect(isFinished(afterFirst)).toBe(false);
    expect(afterFirst.progress).toEqual({ done: 1, total: 3 });

    const afterLast = run('ISSUE', [
      { type: 'scanned', code: 'W-3' },
      { type: 'succeeded', text: 'выдан 3 из 3', progress: { done: 3, total: 3 }, final: true },
      { type: 'noticeExpired' },
    ]).state;

    expect(isFinished(afterLast)).toBe(true);
  });

  it('чужой заказ не двигает прогресс и оставляет сессию открытой', () => {
    const state = run('ISSUE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'succeeded', text: 'выдан 1 из 3', progress: { done: 1, total: 3 }, final: false },
      { type: 'noticeExpired' },
      { type: 'scanned', code: 'ЧУЖОЙ' },
      { type: 'failed', text: 'Этот заказ не входит в маршрутный лист.' },
    ]).state;

    expect(state.progress).toEqual({ done: 1, total: 3 });
    expect(state.notice?.kind).toBe('error');

    const resumed = reduce(state, { type: 'retry' }).state;
    expect(resumed.step).toBe('ORDER');
    expect(isFinished(resumed)).toBe(false);
  });

  it('пауза закрывает экран, но выданное остаётся: откат не выполняется', () => {
    const paused = run('ISSUE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'succeeded', text: 'выдан 1 из 3', progress: { done: 1, total: 3 }, final: false },
      { type: 'noticeExpired' },
      { type: 'cancel' },
    ]).state;

    expect(isFinished(paused)).toBe(true);
    expect(paused.progress).toEqual({ done: 1, total: 3 });
  });
});

describe('уведомления', () => {
  it('успех закрывается сам, ошибка — только человеком', () => {
    const success = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      { type: 'scanned', code: 'S-01' },
      { type: 'succeeded', text: 'принят', final: true },
    ]).state;
    expect(reduce(success, { type: 'noticeExpired' }).state.notice).toBeNull();

    const failure = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'failed', text: 'Заказ не найден.' },
    ]).state;
    // Автозакрытие ошибки не срабатывает: иначе человек не успел бы прочитать
    // причину и повторил бы то же самое действие.
    expect(reduce(failure, { type: 'noticeExpired' }).state.notice).toEqual(failure.notice);
  });

  it('текст уведомления приходит снаружи и машина его не сочиняет', () => {
    const state = run('ISSUE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'failed', text: 'Заказ помечен проблемным.' },
    ]).state;

    expect(state.notice?.text).toBe('Заказ помечен проблемным.');
  });
});

// --- Цепочка только ячейки ---------------------------------------------------

describe('назначение маршрутной ячейки', () => {
  it('начинается сразу с ячейки и не собирает пару', () => {
    /*
     * Заказа в этой цепочке нет вовсе: человек показывает камере полку.
     * Требовать сначала коробку значило бы придумывать шаг, которого
     * в жизни нет.
     */
    const start = initialState('CELL_ONLY');
    expect(start.step).toBe('CELL');

    const { intent } = reduce(start, { type: 'scanned', code: 'R-08' });
    expect(intent).toEqual({ kind: 'submitCell', cellCode: 'R-08' });
  });

  it('заголовок называет ожидаемую ячейку, когда она известна', () => {
    const start = initialState('PICK');
    const afterOrder = reduce(start, { type: 'scanned', code: '12345' }).state;
    const resolved = reduce(afterOrder, { type: 'orderResolved', orderNumber: '12345' }).state;

    expect(scanTitle(resolved, null)).toBe('Сканирование ячейки');
    expect(scanTitle(resolved, '8')).toBe('Сканирование ячейки 8');
    expect(scanTitle(start, null)).toBe('Сканирование заказа');
  });
});

// --- Заказ уже входит в маршрутный лист --------------------------------------

describe('развилка «сборка или хранение»', () => {
  const ROUTE = {
    routeId: 'route-1',
    routeNumber: 'МЛ-3688',
    cells: [{ id: 'c8', code: '8' }],
  };

  /** Заказ распознан и оказался частью подтверждённого листа. */
  function asked(cells = ROUTE.cells): ScanState {
    return run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'routeChoiceRequired', orderNumber: '12345', route: { ...ROUTE, cells } },
    ]).state;
  }

  it('пока человек не ответил, кадры не принимаются', () => {
    const state = asked();

    expect(state.step).toBe('ROUTE_CHOICE');
    // Иначе следующий же кадр с ячейкой решил бы за человека, куда нести
    // коробку — а обе дороги законны.
    expect(canAccept(state)).toBe(false);
    expect(state.routeChoice?.routeNumber).toBe('МЛ-3688');
  });

  it('«В сборку» ведёт к маршрутной ячейке листа и называет её', () => {
    const state = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;

    expect(state.step).toBe('CELL');
    expect(state.target).toBe('ROUTE');
    expect(stepHint(state)).toBe('Сканируйте ячейку 8');
    expect(scanTitle(state)).toBe('Сканирование ячейки 8');
  });

  it('без назначенной ячейки лист просит её назначить, а не «наведите камеру»', () => {
    const state = reduce(asked([]), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;

    expect(stepHint(state)).toBe('Назначьте ячейку маршрута');
  });

  it('несколько ячеек перечисляются: человек выбирает любую из них', () => {
    const state = reduce(
      asked([
        { id: 'c8', code: '8' },
        { id: 'c9', code: '9' },
      ]),
      { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' },
    ).state;

    expect(stepHint(state)).toBe('Сканируйте ячейку маршрута: 8 или 9');
    // Одной ожидаемой полки нет — и в заголовок она не выдумывается.
    expect(scanTitle(state)).toBe('Сканирование ячейки');
  });

  it('пара сборки уходит одним запросом с номером листа', () => {
    const chosen = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;
    const sent = reduce(chosen, { type: 'scanned', code: '8' });

    expect(sent.intent).toEqual({
      kind: 'submitPair',
      orderNumber: '12345',
      cellCode: '8',
      target: 'ROUTE',
      routeId: 'route-1',
      allowNewCell: false,
    });
  });

  it('«+ Доп. ячейка» — это согласие занять новую полку, а не смена вида', () => {
    const chosen = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;
    const allowed = reduce(chosen, { type: 'allowNewCell' }).state;

    expect(allowed.allowNewCell).toBe(true);
    expect(stepHint(allowed)).toBe('Наведите камеру на свободную маршрутную ячейку');

    const sent = reduce(allowed, { type: 'scanned', code: '11' });
    expect(sent.intent).toEqual({
      kind: 'submitPair',
      orderNumber: '12345',
      cellCode: '11',
      target: 'ROUTE',
      routeId: 'route-1',
      allowNewCell: true,
    });
  });

  it('«Всё равно в хранение» ведёт к обычной ячейке и не тянет за собой лист', () => {
    const state = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'STORAGE' }).state;

    expect(state.step).toBe('CELL');
    expect(state.target).toBe('STORAGE');
    expect(state.routeChoice).toBeNull();
    expect(stepHint(state)).toBe('Наведите камеру на QR-код ячейки');

    const sent = reduce(state, { type: 'scanned', code: 'S-01' });
    expect(sent.intent).toEqual({
      kind: 'submitPair',
      orderNumber: '12345',
      cellCode: 'S-01',
      target: 'STORAGE',
      routeId: null,
      allowNewCell: false,
    });
  });

  it('ошибка в сборке называет ожидаемую полку листа', () => {
    const chosen = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;
    const sent = reduce(chosen, { type: 'scanned', code: 'S-01' }).state;
    const failed = reduce(sent, { type: 'failed', text: 'Это ячейка хранения.' }).state;

    expect(failed.notice?.scanned).toBe('S-01');
    expect(failed.notice?.expected).toBe('QR-код маршрутной ячейки 8');
  });

  it('после успеха следующий заказ начинается без памяти о прошлом листе', () => {
    const chosen = reduce(asked(), { type: 'routeChoiceAnswered', choice: 'ASSEMBLY' }).state;
    const done = reduce(chosen, { type: 'succeeded', text: 'перемещён', final: true }).state;

    expect(done.routeChoice).toBeNull();
    expect(done.target).toBe('STORAGE');
    expect(done.allowNewCell).toBe(false);
  });
});

// --- Промежуточный успех ------------------------------------------------------

describe('промежуточное уведомление', () => {
  it('распознанный заказ показывается человеку и только потом открывает шаг ячейки', () => {
    const state = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
    ]).state;

    expect(state.notice).toEqual({ kind: 'success', text: 'Заказ W-1 отсканирован' });
    // Уведомление промежуточное: цепочка не закончена и экран не закрывается.
    expect(state.step).toBe('CELL');
    expect(isFinished(state)).toBe(false);
    expect(canAccept(state)).toBe(false);

    const ready = reduce(state, { type: 'noticeExpired' }).state;
    expect(ready.notice).toBeNull();
    expect(canAccept(ready)).toBe(true);
  });
});

describe('промежуточное уведомление у развилки', () => {
  it('распознанный заказ листа тоже показывается человеку', () => {
    const state = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      {
        type: 'routeChoiceRequired',
        orderNumber: '12345',
        route: { routeId: 'r', routeNumber: 'МЛ-1', cells: [] },
      },
    ]).state;

    expect(state.notice).toEqual({ kind: 'success', text: 'Заказ 12345 отсканирован' });
    // Вопрос остаётся открытым и после того, как уведомление исчезло.
    expect(reduce(state, { type: 'noticeExpired' }).state.step).toBe('ROUTE_CHOICE');
  });
});
