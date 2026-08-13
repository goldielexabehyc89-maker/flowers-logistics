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
    expect(stepHint(state)).toBe('Сканируйте QR ячейки');
  });

  it('вторая пара уходит одним запросом и завершает цепочку', () => {
    const { state, intents } = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      { type: 'scanned', code: 'S-01' },
      { type: 'succeeded', text: 'принят', final: true },
    ]);

    expect(intents[1]).toEqual({ kind: 'submitPair', orderNumber: 'W-1', cellCode: 'S-01' });
    expect(state.notice).toEqual({ kind: 'success', text: 'принят' });
    // Экран закроется только после того, как успех прочитан.
    expect(isFinished(state)).toBe(false);
    expect(isFinished(reduce(state, { type: 'noticeExpired' }).state)).toBe(true);
  });

  it('маршрутная ячейка требует явного согласия, отказ возвращает к выбору другой', () => {
    const asked = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
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
    expect(agreed.intent).toEqual({ kind: 'submitPair', orderNumber: 'W-1', cellCode: 'R-01' });
  });

  it('ошибка ячейки сохраняет подтверждённый заказ и возвращает на шаг ячейки', () => {
    const failed = run('RECEIVE', [
      { type: 'scanned', code: 'W-1' },
      { type: 'orderResolved', orderNumber: 'W-1' },
      { type: 'scanned', code: 'S-OFF' },
      { type: 'failed', text: 'Ячейка выключена.' },
    ]).state;

    expect(failed.notice?.kind).toBe('error');

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
      { type: 'scanned', code: 'R-42' },
    ]);

    expect(intents[1]).toEqual({ kind: 'submitPair', orderNumber: 'W-7', cellCode: 'R-42' });
  });

  it('подсказка второго шага называет именно маршрутную ячейку', () => {
    const state = run('PICK', [
      { type: 'scanned', code: 'W-7' },
      { type: 'orderResolved', orderNumber: 'W-7' },
    ]).state;

    expect(stepHint(state)).toBe('Сканируйте QR маршрутной ячейки');
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
