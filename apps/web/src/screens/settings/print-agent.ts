/**
 * Правила раздела «Печать» в настройках.
 *
 * Вынесены из компонента, потому что их можно и нужно доказывать отдельно:
 * «в сети или нет», «что можно сделать с устройством» и «что показать вместо
 * пустоты» — это решения, а не разметка.
 *
 * СОСТОЯНИЕ СЧИТАЕТ СЕРВЕР. Клиент не вычисляет «в сети» по своим часам:
 * `online` приходит готовым. Браузер, у которого часы ушли на час, иначе
 * показывал бы работающий компьютер отключённым — ровно тогда, когда
 * администратор разбирается, почему не печатает.
 */

import type { StatusTone } from '../../ui/components';

export interface PrintDeviceView {
  id: string;
  name: string;
  state: string;
  isPrimary: boolean;
  online: boolean;
  os: string | null;
  agentVersion: string | null;
  /** Принтер по умолчанию на момент последней связи: отчёт, а не настройка. */
  defaultPrinterName: string | null;
  lastSeenAt: string | null;
  lastSucceededJobId: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  pairedAt: string;
  revokedAt: string | null;
}

export interface PrintDevicesResponse {
  items: PrintDeviceView[];
}

export interface PairingCodeResponse {
  /** Открытый код. Приходит ОДИН раз и после закрытия окна не восстановим. */
  code: string;
  display: string;
  expiresAt: string;
}

export const DEVICE_STATE_LABELS: Record<string, string> = {
  CONNECTED: 'В сети',
  DISCONNECTED: 'Не в сети',
  REVOKED: 'Отключено',
};

export function deviceStateLabel(state: string): string {
  return DEVICE_STATE_LABELS[state] ?? state;
}

/**
 * Тон значка устройства.
 *
 * «Не в сети» — предупреждение, а не ошибка: компьютер могли просто выключить
 * на ночь. Ошибкой показывается только отзыв — то, что сделал человек.
 */
export function deviceStateTone(device: PrintDeviceView): StatusTone {
  if (device.state === 'REVOKED') return 'neutral';
  return device.online ? 'success' : 'warning';
}

/**
 * Действия, доступные для устройства.
 *
 * Скрытая кнопка защитой не считается — решение принимает сервер. Здесь
 * решается только то, что показывать: кнопка, которая заведомо ответит
 * отказом, дезориентирует не меньше, чем её отсутствие.
 */
export interface DeviceActions {
  canMakePrimary: boolean;
  canRevoke: boolean;
}

export function deviceActions(device: PrintDeviceView): DeviceActions {
  const active = device.state !== 'REVOKED';
  return {
    // Отозванное устройство основным быть не может: это запрещает и CHECK базы.
    canMakePrimary: active && !device.isPrimary,
    canRevoke: active,
  };
}

/**
 * Готова ли система печатать без участия человека.
 *
 * Основной обработчик обязан существовать И быть на связи. Привязанный, но
 * выключенный компьютер — это не «печать настроена»: задания будут копиться
 * в очереди, и никто не узнает об этом, пока не хватится бланка.
 */
export function printReadiness(devices: readonly PrintDeviceView[]): {
  ready: boolean;
  message: string;
} {
  const primary = devices.find((device) => device.isPrimary);

  if (primary === undefined) {
    return {
      ready: false,
      message: devices.some((device) => device.state !== 'REVOKED')
        ? 'Основной компьютер не назначен. Выберите его — иначе задания печати никто не заберёт.'
        : 'Компьютер для печати не подключён. Бланки печатаются через браузер вручную.',
    };
  }

  if (!primary.online) {
    return {
      ready: false,
      message: `Основной компьютер «${primary.name}» не на связи. Задания копятся в очереди.`,
    };
  }

  return { ready: true, message: `Печатает «${primary.name}».` };
}

/**
 * Момент времени словами.
 *
 * `null` показывается прочерком, а не пустотой: пустая ячейка неотличима
 * от неудавшейся загрузки.
 */
export function formatMoment(value: string | null, formatter: (iso: string) => string): string {
  return value === null ? '—' : formatter(value);
}
