/**
 * Критические проверки правил раздела «Печать».
 *
 * Проверяется не разметка, а решения: что считать готовностью печатать, какие
 * действия показывать и как не выдать неизвестное за неудачу. Ошибка здесь
 * стоит дорого именно потому, что не выглядит ошибкой: экран продолжает
 * работать и сообщает неправду.
 */

import { describe, expect, it } from 'vitest';
import {
  deviceActions,
  deviceStateLabel,
  deviceStateTone,
  formatMoment,
  printReadiness,
  type PrintDeviceView,
} from './print-agent';
import { invalidationKeysFor } from '../../realtime/stream';
import {
  canCancelPrint,
  canMarkPrinted,
  isPrintInFlight,
  printStateLabel,
  printStateTone,
} from '../florist/florist';

function device(overrides: Partial<PrintDeviceView> = {}): PrintDeviceView {
  return {
    id: 'device-1',
    name: 'Компьютер флориста',
    state: 'CONNECTED',
    isPrimary: false,
    online: true,
    os: 'Windows 11',
    agentVersion: '1.0.0',
    defaultPrinterName: 'HP LaserJet',
    lastSeenAt: '2027-04-01T09:00:00.000Z',
    lastSucceededJobId: null,
    lastSucceededAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    pairedAt: '2027-04-01T08:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

describe('готовность печати', () => {
  it('без устройств честно говорит, что печать ручная', () => {
    const readiness = printReadiness([]);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain('не подключён');
  });

  it('привязанное, но не назначенное основным устройство готовностью не является', () => {
    // Иначе администратор видел бы «печать работает» у системы, в которой
    // задания никто не забирает.
    const readiness = printReadiness([device({ isPrimary: false })]);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain('Основной компьютер не назначен');
  });

  it('основной, но выключенный компьютер готовностью не является', () => {
    // Самая опасная разновидность неправды: задания копятся в очереди, и
    // никто не узнает об этом, пока не хватится бланка.
    const readiness = printReadiness([device({ isPrimary: true, online: false })]);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain('не на связи');
    expect(readiness.message).toContain('Компьютер флориста');
  });

  it('основной и на связи — готово', () => {
    const readiness = printReadiness([device({ isPrimary: true, online: true })]);
    expect(readiness.ready).toBe(true);
  });

  it('отозванное устройство не считается за подключённое', () => {
    const readiness = printReadiness([device({ state: 'REVOKED', online: false })]);
    expect(readiness.ready).toBe(false);
    expect(readiness.message).toContain('не подключён');
  });
});

describe('действия над устройством', () => {
  it('основное нельзя сделать основным ещё раз', () => {
    expect(deviceActions(device({ isPrimary: true })).canMakePrimary).toBe(false);
  });

  it('отозванное нельзя ни назначить основным, ни отозвать повторно', () => {
    const actions = deviceActions(device({ state: 'REVOKED' }));
    expect(actions.canMakePrimary).toBe(false);
    expect(actions.canRevoke).toBe(false);
  });

  it('обычное подключённое можно и назначить, и отключить', () => {
    const actions = deviceActions(device());
    expect(actions.canMakePrimary).toBe(true);
    expect(actions.canRevoke).toBe(true);
  });

  it('выключенное, но не отозванное устройство назначить можно', () => {
    // Компьютер могли просто выключить на ночь. Запрет назначения означал бы,
    // что замену основного нельзя подготовить заранее.
    const actions = deviceActions(device({ online: false, state: 'DISCONNECTED' }));
    expect(actions.canMakePrimary).toBe(true);
  });
});

describe('состояние устройства', () => {
  it('не в сети — предупреждение, отзыв — не ошибка', () => {
    // «Не в сети» — обычная ночь; ошибкой это показывать нельзя, иначе
    // настоящая ошибка перестанет отличаться от выключенного компьютера.
    expect(deviceStateTone(device({ online: false }))).toBe('warning');
    expect(deviceStateTone(device({ online: true }))).toBe('success');
    // Отзыв — решение человека, а не поломка.
    expect(deviceStateTone(device({ state: 'REVOKED', online: false }))).toBe('neutral');
  });

  it('неизвестное состояние показывается как есть, а не пустотой', () => {
    expect(deviceStateLabel('CONNECTED')).toBe('В сети');
    expect(deviceStateLabel('НЕЧТО')).toBe('НЕЧТО');
  });

  it('отсутствующий момент показывается прочерком', () => {
    // Пустая ячейка неотличима от неудавшейся загрузки.
    expect(formatMoment(null, () => 'не должно вызываться')).toBe('—');
    expect(formatMoment('2027-04-01T09:00:00.000Z', () => '01.04.2027 12:00')).toBe(
      '01.04.2027 12:00',
    );
  });
});

describe('состояния задания печати', () => {
  it('все новые состояния названы по-русски, а неизвестное не прячется', () => {
    for (const state of ['PENDING', 'CLAIMED', 'PRINTING', 'NEEDS_REVIEW', 'CANCELLED', 'ERROR']) {
      expect(printStateLabel(state)).not.toBe(state);
    }
    expect(printStateLabel('НЕЧТО')).toBe('НЕЧТО');
  });

  it('«проверьте, вышел ли бланк» — предупреждение, а не ошибка', () => {
    // Ошибка означала бы «не напечаталось». Здесь неизвестно: бланк мог уже
    // лежать в лотке, и сотрудник обязан пойти и посмотреть, а не нажать
    // «повторить» рефлекторно.
    expect(printStateTone('NEEDS_REVIEW')).toBe('warning');
    expect(printStateTone('ERROR')).toBe('error');
    expect(printStateTone('PRINTED')).toBe('success');
    expect(printStateTone('CANCELLED')).toBe('neutral');
  });

  it('в пути только то, что ещё может напечататься само', () => {
    expect(isPrintInFlight('PENDING')).toBe(true);
    expect(isPrintInFlight('CLAIMED')).toBe(true);
    expect(isPrintInFlight('PRINTING')).toBe(true);
    // Здесь вопрос не «когда напечатается», а «вышел ли уже».
    expect(isPrintInFlight('NEEDS_REVIEW')).toBe(false);
    expect(isPrintInFlight('PRINTED')).toBe(false);
  });

  it('снять нельзя то, что уже у драйвера принтера', () => {
    // «Отменено» было бы утверждением, которого никто не проверял.
    expect(canCancelPrint('PRINTING')).toBe(false);
    expect(canCancelPrint('PENDING')).toBe(true);
    expect(canCancelPrint('CLAIMED')).toBe(true);
    expect(canCancelPrint('NEEDS_REVIEW')).toBe(true);
    expect(canCancelPrint('PRINTED')).toBe(false);
    expect(canCancelPrint('CANCELLED')).toBe(false);
  });

  it('ручная отметка доступна везде, где печать ещё не подтверждена', () => {
    // Запасной режим обязан работать и тогда, когда обработчик завис:
    // человек видит лоток раньше сервера.
    for (const state of ['PENDING', 'CLAIMED', 'PRINTING', 'ERROR', 'NEEDS_REVIEW']) {
      expect(canMarkPrinted(state)).toBe(true);
    }
    expect(canMarkPrinted('PRINTED')).toBe(false);
    expect(canMarkPrinted('CANCELLED')).toBe(false);
  });
});

describe('обновление по событиям', () => {
  it('событие печати обновляет и очередь, и реестр устройств', () => {
    // Успех и отказ печати меняют «последнее задание» и «последнюю ошибку»
    // компьютера, а отдельного события об устройстве при этом не возникает.
    const keys = invalidationKeysFor('print_job.changed').map((key) => key.join('/'));
    expect(keys).toContain('florist-print-jobs');
    expect(keys).toContain('print-agent-devices');
  });

  it('событие устройства не трогает чужие списки', () => {
    const keys = invalidationKeysFor('print_agent.device_changed');
    expect(keys).toEqual([['print-agent-devices']]);
  });
});
