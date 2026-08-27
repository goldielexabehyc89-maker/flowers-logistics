/**
 * Правила раздела точек печати, вынесенные из компонента.
 *
 * Здесь только чистые функции: их проверяют без браузера. Решения принимает
 * сервер — клиентские правила защитой не являются; они отвечают на другой
 * вопрос: что человек видит и почему.
 */

export type PrintPointState = 'ONLINE' | 'OFFLINE' | 'ERROR';

export interface PrintPointView {
  id: string;
  name: string;
  computerName: string | null;
  printerName: string | null;
  isActive: boolean;
  state: PrintPointState;
  paired: boolean;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
  lastErrorText: string | null;
  queued: number;
  pairingActive: boolean;
  testPending: boolean;
}

export interface PrintPointOption {
  id: string;
  name: string;
  state: PrintPointState;
}

/** Название состояния для человека. */
export const POINT_STATE_LABELS: Record<PrintPointState, string> = {
  ONLINE: 'Онлайн',
  OFFLINE: 'Нет связи',
  ERROR: 'Ошибка',
};

export type StateTone = 'success' | 'warning' | 'error' | 'neutral';

export function pointTone(state: PrintPointState): StateTone {
  if (state === 'ONLINE') {
    return 'success';
  }
  return state === 'ERROR' ? 'error' : 'warning';
}

/**
 * Что делать администратору с этой точкой прямо сейчас.
 *
 * Подсказка одна и по делу: список из трёх советов человек не читает.
 * Порядок важнее формулировок — сначала то, без чего печать не поедет вовсе.
 */
export function pointHint(point: PrintPointView): string {
  if (!point.isActive) {
    return 'Точка отключена. Заведите новую, если печать нужна снова.';
  }
  if (!point.paired) {
    return point.pairingActive
      ? 'Код выпущен: введите его в агенте на компьютере.'
      : 'Компьютер не подключён. Выпустите код подключения.';
  }
  if (point.state === 'ERROR') {
    return point.lastErrorText ?? 'Агент сообщил об ошибке печати.';
  }
  if (point.state === 'OFFLINE') {
    return 'Агент не выходит на связь: компьютер выключен или закрыт агент.';
  }
  return point.queued > 0 ? 'Печатает очередь.' : 'Готова к печати.';
}

/**
 * Строка «когда последний раз видели».
 *
 * Относительное время намеренно: «2 минуты назад» человек соотносит
 * с происходящим, а «14:37» требует посмотреть на часы.
 */
export function lastSeenLabel(iso: string | null, now: Date = new Date()): string {
  if (iso === null) {
    return 'ни разу';
  }

  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) {
    return 'только что';
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  return `${Math.round(hours / 24)} дн назад`;
}
