/**
 * Опрос очереди и порядок отчётов.
 *
 * ПОРЯДОК ДЕЙСТВИЙ ЗДЕСЬ — ЭТО И ЕСТЬ ВСЯ ЦЕННОСТЬ ОБРАБОТЧИКА. Он выбран так,
 * чтобы у каждого состояния был ровно один смысл, а не «может быть, напечатано»:
 *
 *   1. документ забирается и проверяется;
 *   2. принтер по умолчанию читается ЗДЕСЬ, а не раньше и не из настройки;
 *   3. серверу уходит `printing` — и только после его подтверждения
 *   4. на диск ложится отметка `handed`, после чего
 *   5. документ передаётся драйверу.
 *
 * Шаг 3 стоит перед шагом 5, потому что сервер различает `CLAIMED` («принтер
 * документа не видел, вернуть в очередь безопасно») и `PRINTING` («исход
 * неизвестен, решает человек»). Отчитайся обработчик после передачи — оба
 * состояния значили бы одно и то же, и любое зависшее задание пришлось бы
 * либо терять, либо печатать дважды.
 *
 * Шаг 4 стоит ПОСЛЕ шага 3, а не до него, по практической причине: если бы
 * отметка `handed` появлялась раньше, а отчёт `printing` не дошёл из-за
 * потерянной сети, сервер вернул бы задание в очередь (оно осталось `CLAIMED`),
 * а обработчик отказался бы его печатать навсегда — бланк не вышел бы вовсе,
 * и никто бы не понял почему.
 *
 * НИ ОДНО ЗАДАНИЕ НЕ ПЕЧАТАЕТСЯ ДВАЖДЫ. Перед печатью проверяется журнал на
 * диске (`store.ts`): задание со стадией `handed` или `done` документа больше
 * не увидит, вместо печати повторяется уже известный исход.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentJob, PrintAgentClient } from './client.js';
import { DeviceRevokedError, PrintFailure, TransportFailure } from './errors.js';
import type { AgentErrorCode } from './errors.js';
import type { DefaultPrinter, PrinterBackend } from './printer.js';
import { cleanSpool, spoolDir, type JobResult, type JobStore } from './store.js';
import { delay } from './timing.js';

export type AgentConnection = 'starting' | 'connected' | 'offline' | 'revoked';

export interface LastJobStatus {
  orderNumber: string | null;
  documentKind: string;
  outcome: JobResult['outcome'];
  errorCode: AgentErrorCode | null;
  printerName: string | null;
  at: string;
}

export interface AgentStatus {
  connection: AgentConnection;
  /** Имя рабочего места, как его подтвердил сервер. */
  deviceName: string | null;
  /** Получает ли эта машина новые задания. */
  isPrimary: boolean;
  /** Принтер по умолчанию, каким его видит система прямо сейчас. */
  defaultPrinterName: string | null;
  lastJob: LastJobStatus | null;
  lastError: string | null;
  /** Исходы, записанные на диск, но ещё не принятые сервером. */
  pendingResults: number;
}

export function initialStatus(): AgentStatus {
  return {
    connection: 'starting',
    deviceName: null,
    isPrimary: false,
    defaultPrinterName: null,
    lastJob: null,
    lastError: null,
    pendingResults: 0,
  };
}

export interface StatusSink {
  update(patch: Partial<AgentStatus>): void;
  current(): AgentStatus;
}

/**
 * Хранит состояние и сообщает о каждом изменении.
 *
 * Отдельный объект нужен, чтобы окно состояния не опрашивало обработчик по
 * таймеру: экран у станка должен показывать текущее, а не то, что было
 * секунду назад.
 */
export function createStatusSink(onChange: (status: AgentStatus) => void): StatusSink {
  let status = initialStatus();
  return {
    update(patch: Partial<AgentStatus>): void {
      status = { ...status, ...patch };
      onChange(status);
    },
    current(): AgentStatus {
      return status;
    },
  };
}

export interface AgentTiming {
  /** Пауза между опросами пустой очереди. */
  pollIntervalMs: number;
  /** Как часто отмечаться на сервере, если задания не идут. */
  heartbeatIntervalMs: number;
  /** Пауза после потери связи. */
  offlineRetryMs: number;
}

export const DEFAULT_TIMING: AgentTiming = {
  pollIntervalMs: 3_000,
  heartbeatIntervalMs: 30_000,
  offlineRetryMs: 10_000,
};

export interface AgentDeps {
  client: PrintAgentClient;
  printer: PrinterBackend;
  store: JobStore;
  status: StatusSink;
  /** Каталог рабочего места: сюда кладётся документ перед передачей драйверу. */
  home: string;
  os: string | null;
  agentVersion: string;
  timing: AgentTiming;
}

export type CycleOutcome = 'printed' | 'failed' | 'idle' | 'offline' | 'revoked';

export interface Agent {
  /** Разбор того, что осталось после предыдущего запуска. */
  recover(): Promise<void>;
  /** Один проход: отметка, досылка исходов, попытка взять задание. */
  cycle(): Promise<CycleOutcome>;
  run(signal: AbortSignal): Promise<void>;
}

/** Исход перезапуска: бумага могла выйти, решать человеку. */
const RESTART_RESULT: JobResult = {
  outcome: 'ambiguous',
  errorCode: 'AGENT_RESTARTED',
  defaultPrinterName: null,
};

export function createAgent(deps: AgentDeps): Agent {
  let lastHeartbeatAt = 0;

  const countPending = (): number =>
    deps.store.list().filter((record) => record.result !== null && !record.reported).length;

  const noteStatus = (patch: Partial<AgentStatus>): void => {
    deps.status.update({ ...patch, pendingResults: countPending() });
  };

  /**
   * Отправляет исход и помечает его доставленным.
   *
   * Порядок обратный привычному: сначала диск, потом сеть. Записанный исход
   * переживает и обрыв связи, и выключение питания; отправленный, но не
   * записанный — не переживает ничего.
   */
  const flushResult = async (jobId: string, result: JobResult): Promise<boolean> => {
    try {
      await deps.client.reportResult(jobId, result);
      await deps.store.markReported(jobId);
      return true;
    } catch (error) {
      if (error instanceof DeviceRevokedError) {
        throw error;
      }
      // Исход остаётся на диске неотправленным и уйдёт следующим проходом.
      return false;
    }
  };

  const flushPending = async (): Promise<void> => {
    for (const record of deps.store.list()) {
      if (record.result === null || record.reported) {
        continue;
      }
      await flushResult(record.jobId, record.result);
    }
    noteStatus({});
  };

  const finish = async (
    job: AgentJob,
    stage: 'claimed' | 'done',
    result: JobResult,
  ): Promise<void> => {
    await deps.store.setResult(job.jobId, stage, result);

    noteStatus({
      lastJob: {
        orderNumber: job.orderNumber,
        documentKind: job.documentKind,
        outcome: result.outcome,
        errorCode: result.errorCode,
        printerName: result.defaultPrinterName,
        at: new Date().toISOString(),
      },
    });

    const delivered = await flushResult(job.jobId, result);

    // Неудача ДО передачи драйверу забывается, как только сервер о ней узнал:
    // помни мы её дальше, повторная попытка того же задания (принтер включили)
    // упёрлась бы в старый отказ вместо печати.
    if (delivered && stage === 'claimed') {
      await deps.store.forget(job.jobId);
    }
    noteStatus({});
  };

  /**
   * Кладёт документ на диск под СЛУЧАЙНЫМ именем.
   *
   * Идентификатор задания приходит с сервера, и подставлять его в путь нельзя:
   * имя файла — не то место, где стоит доверять чужой строке. Случайное имя
   * снимает вопрос целиком.
   */
  const spoolDocument = async (bytes: Uint8Array): Promise<string> => {
    const directory = spoolDir(deps.home);
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${randomUUID()}.pdf`);
    await writeFile(filePath, bytes, { mode: 0o600 });
    return filePath;
  };

  const failureCode = (error: unknown, fallback: AgentErrorCode): AgentErrorCode =>
    error instanceof PrintFailure ? error.code : fallback;

  const processJob = async (job: AgentJob): Promise<CycleOutcome> => {
    const known = deps.store.get(job.jobId);

    // Задание, которое уже видел драйвер, не печатается повторно НИКОГДА.
    // Сюда попадают два случая: сервер вернул задание после перезапуска и
    // очередь предложила один и тот же идентификатор дважды.
    if (known !== null && known.stage !== 'claimed') {
      const repeated = known.result ?? RESTART_RESULT;
      await finish(job, 'done', repeated);
      return repeated.outcome === 'printed' ? 'printed' : 'failed';
    }

    await deps.store.setStage(job.jobId, 'claimed');

    let document: Uint8Array;
    try {
      document = await deps.client.downloadDocument(job.documentPath);
    } catch (error) {
      if (error instanceof PrintFailure) {
        await finish(job, 'claimed', {
          outcome: 'failed',
          errorCode: error.code,
          defaultPrinterName: null,
        });
        return 'failed';
      }
      throw error;
    }

    // Принтер по умолчанию — ЗДЕСЬ. Между этой строкой и передачей документа
    // не должно быть ничего, что могло бы затянуться: смысл в том, чтобы
    // печатать на тот принтер, который выбран в системе прямо сейчас.
    let printer: DefaultPrinter | null;
    try {
      printer = await deps.printer.resolveDefaultPrinter();
    } catch (error) {
      await finish(job, 'claimed', {
        outcome: 'failed',
        errorCode: failureCode(error, 'SPOOLER_UNAVAILABLE'),
        defaultPrinterName: null,
      });
      return 'failed';
    }

    if (printer === null) {
      await finish(job, 'claimed', {
        outcome: 'failed',
        errorCode: 'NO_DEFAULT_PRINTER',
        defaultPrinterName: null,
      });
      return 'failed';
    }

    noteStatus({ defaultPrinterName: printer.name });

    if (printer.offline) {
      // Отказ до передачи: документ драйверу не уходил, повторить безопасно.
      await finish(job, 'claimed', {
        outcome: 'failed',
        errorCode: 'PRINTER_OFFLINE',
        defaultPrinterName: printer.name,
      });
      return 'failed';
    }

    const filePath = await spoolDocument(document);

    try {
      // Сервер узнаёт о передаче ДО передачи. Не дошло — не печатаем вовсе:
      // задание останется `CLAIMED` и честно вернётся в очередь.
      await deps.client.reportPrinting(job.jobId);
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      await deps.store.forget(job.jobId);
      throw error;
    }

    await deps.store.setStage(job.jobId, 'handed');

    try {
      await deps.printer.printPdf(filePath, printer.name);
    } catch (error) {
      // `PRINTER_ERROR` по умолчанию, и это не перестраховка: драйвер сообщает
      // об отказе и после того, как часть страницы уже ушла на бумагу. Сервер
      // считает такой исход неоднозначным и отдаёт задание человеку.
      await finish(job, 'done', {
        outcome: 'failed',
        errorCode: failureCode(error, 'PRINTER_ERROR'),
        defaultPrinterName: printer.name,
      });
      return 'failed';
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    await finish(job, 'done', {
      outcome: 'printed',
      errorCode: null,
      defaultPrinterName: printer.name,
    });
    return 'printed';
  };

  /**
   * Читает принтер для отметки на сервере.
   *
   * Неудача здесь не останавливает отметку: администратору важнее видеть, что
   * машина на связи, чем не видеть ничего из-за упавшего диспетчера печати.
   */
  const printerNameForReport = async (): Promise<string | null> => {
    try {
      const printer = await deps.printer.resolveDefaultPrinter();
      return printer?.name ?? null;
    } catch {
      return null;
    }
  };

  const heartbeat = async (): Promise<void> => {
    const defaultPrinterName = await printerNameForReport();
    const info = await deps.client.heartbeat({
      os: deps.os,
      agentVersion: deps.agentVersion,
      defaultPrinterName,
    });
    lastHeartbeatAt = Date.now();
    noteStatus({
      connection: 'connected',
      deviceName: info.name,
      isPrimary: info.isPrimary,
      defaultPrinterName,
      lastError: null,
    });
  };

  return {
    async recover(): Promise<void> {
      // Оставшиеся документы уносятся первыми: в них состав заказа и адрес,
      // и лежать в профиле пользователя им незачем.
      await cleanSpool(deps.home);

      for (const record of deps.store.list()) {
        if (record.stage === 'handed') {
          // Документ был у драйвера, подтверждения нет. Печатать заново нельзя
          // и объявлять напечатанным нельзя: решение принимает человек.
          await deps.store.setResult(record.jobId, 'done', RESTART_RESULT);
        }
      }

      try {
        await flushPending();
      } catch (error) {
        if (!(error instanceof DeviceRevokedError)) {
          throw error;
        }
        noteStatus({ connection: 'revoked' });
        return;
      }

      for (const record of deps.store.list()) {
        // Взятое, но не переданное драйверу задание забывается: сервер вернёт
        // его в очередь сам, а помнить о нём значило бы отказаться печатать.
        if (record.stage === 'claimed' && (record.result === null || record.reported)) {
          await deps.store.forget(record.jobId);
        }
      }
      noteStatus({});
    },

    async cycle(): Promise<CycleOutcome> {
      try {
        if (Date.now() - lastHeartbeatAt >= deps.timing.heartbeatIntervalMs) {
          await heartbeat();
        }
        await flushPending();

        const job = await deps.client.claimJob();
        if (job === null) {
          noteStatus({ connection: 'connected' });
          return 'idle';
        }
        return await processJob(job);
      } catch (error) {
        if (error instanceof DeviceRevokedError) {
          noteStatus({
            connection: 'revoked',
            lastError:
              'Рабочее место отключено администратором. Получите новый код и выполните привязку.',
          });
          return 'revoked';
        }
        if (error instanceof TransportFailure) {
          noteStatus({ connection: 'offline', lastError: 'Нет связи с сервером.' });
          return 'offline';
        }
        throw error;
      }
    },

    async run(signal: AbortSignal): Promise<void> {
      await this.recover();

      while (!signal.aborted) {
        let outcome: CycleOutcome;
        try {
          outcome = await this.cycle();
        } catch {
          // Непредвиденная ошибка НЕ останавливает обработчик: остановившийся
          // обработчик перестаёт печатать навсегда и молча, а пауза с повтором
          // хотя бы даёт шанс следующему заданию.
          noteStatus({
            connection: 'offline',
            lastError: 'Внутренняя ошибка обработчика. Повтор через несколько секунд.',
          });
          outcome = 'offline';
        }

        if (outcome === 'revoked') {
          // Возврат из `run` — это приглашение привязать заново: программа
          // не завершается, окно остаётся, код можно ввести (`main.ts`).
          return;
        }
        if (outcome === 'offline') {
          await delay(deps.timing.offlineRetryMs, signal);
        } else if (outcome === 'idle') {
          await delay(deps.timing.pollIntervalMs, signal);
        }
        // После обработанного задания пауза не нужна: очередь может быть
        // не пуста, а бланк ждут у станка.
      }
    },
  };
}
