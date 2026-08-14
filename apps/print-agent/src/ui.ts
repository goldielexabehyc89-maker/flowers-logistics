/**
 * Окно состояния.
 *
 * ЛОКАЛЬНОГО HTTP-ИНТЕРФЕЙСА ЗДЕСЬ НЕТ И НЕ БУДЕТ. Требование безопасности
 * звучит как «если локальный HTTP-интерфейс есть, он обязан слушать только
 * 127.0.0.1». Не иметь его строго безопаснее, чем иметь правильно настроенный:
 * порт, открытый на рабочем месте склада, — это ещё одна точка входа, которую
 * придётся защищать от соседа по сети, от браузера с любой открытой вкладки
 * (CSRF на локальный порт — обычное дело) и от ошибки в собственном разборе
 * запросов. Требование «минимальное окно» консоль закрывает полностью:
 * человек видит состояние и вводит код привязки, ничего не слушая.
 *
 * Ни токен устройства, ни код привязки в этом окне не показываются и не
 * повторяются: код человек вводит один раз и он тут же обменивается на токен.
 */

import { createInterface } from 'node:readline/promises';
import type { AgentStatus } from './agent.js';
import { agentErrorMessage } from './errors.js';

export interface AgentUi {
  render(status: AgentStatus): void;
  /** Спрашивает одноразовый код привязки. Никуда его не записывает. */
  askPairingCode(): Promise<string>;
  ask(question: string): Promise<string>;
  line(text: string): void;
  close(): void;
}

const CONNECTION_TEXT: Record<AgentStatus['connection'], string> = {
  starting: 'запуск',
  connected: 'на связи',
  offline: 'нет связи с сервером',
  revoked: 'рабочее место отключено администратором',
};

function outcomeText(status: AgentStatus): string {
  const job = status.lastJob;
  if (job === null) {
    return 'заданий ещё не было';
  }

  const order = job.orderNumber === null ? job.documentKind : `заказ ${job.orderNumber}`;
  if (job.outcome === 'printed') {
    return `${order} — напечатан (${job.printerName ?? 'принтер не назван'})`;
  }

  const reason = job.errorCode === null ? 'причина не названа' : agentErrorMessage(job.errorCode);
  const verdict = job.outcome === 'ambiguous' ? 'исход неизвестен' : 'не напечатан';
  return `${order} — ${verdict}: ${reason}`;
}

/** Текст окна. Вынесен из вывода, чтобы его можно было проверить отдельно. */
export function renderStatus(status: AgentStatus): string {
  const lines = [
    'Печать бланков — локальный обработчик',
    '',
    `Состояние:        ${CONNECTION_TEXT[status.connection]}`,
    `Рабочее место:    ${status.deviceName ?? 'не привязано'}`,
    `Роль:             ${status.isPrimary ? 'основное (получает задания)' : 'запасное'}`,
    `Принтер:          ${status.defaultPrinterName ?? 'не выбран в Windows'}`,
    `Последнее:        ${outcomeText(status)}`,
  ];

  if (status.pendingResults > 0) {
    lines.push(
      `Не отправлено:    ${String(status.pendingResults)} (уйдут при восстановлении связи)`,
    );
  }
  if (status.lastError !== null) {
    lines.push(`Внимание:         ${status.lastError}`);
  }

  lines.push('', 'Окно можно свернуть. Закрытие останавливает печать.');
  return lines.join('\n');
}

export function createConsoleUi(): AgentUi {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  const write = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  return {
    render(status: AgentStatus): void {
      // Экран перерисовывается целиком только в терминале: при перенаправлении
      // вывода в файл управляющие последовательности были бы мусором в журнале.
      if (process.stdout.isTTY === true) {
        process.stdout.write('\u001B[2J\u001B[H');
      }
      write(renderStatus(status));
    },

    async askPairingCode(): Promise<string> {
      // Код читается и сразу уходит на сервер. В файлы, журналы и переменные
      // окружения он не попадает: одноразовый секрет живёт ровно один вызов.
      return (await readline.question('Код привязки (8 знаков): ')).trim();
    },

    async ask(question: string): Promise<string> {
      return (await readline.question(question)).trim();
    },

    line(text: string): void {
      write(text);
    },

    close(): void {
      readline.close();
    },
  };
}
