/**
 * Разговор с сервером.
 *
 * ОБРАБОТЧИК ХОДИТ ТОЛЬКО НА СВОЙ СЕРВЕР. Адрес задан при привязке и лежит в
 * настройке; из ответов сервера берётся ОТНОСИТЕЛЬНЫЙ путь документа, который
 * приклеивается к этому адресу. Принять полный URL означало бы превратить
 * обработчик в загрузчик произвольных файлов, запускаемый тем, кто сумел
 * ответить на его опрос очереди.
 *
 * ПОЛУЧЕННЫЙ ФАЙЛ ПРОВЕРЯЕТСЯ ДО ТОГО, КАК ПОПАДЁТ НА ДИСК И К ДРАЙВЕРУ.
 * Тип, размер и сигнатура — три дешёвые проверки, каждая из которых закрывает
 * свой сценарий: страницу входа вместо PDF (сервер за прокси попросил
 * авторизацию), бесконечный ответ (ошибка на сервере), подменённое содержимое.
 *
 * ПОВТОРЫ ОГРАНИЧЕНЫ. Бесконечный повтор при неисправном сервере — это опрос
 * без пауз со всех рабочих мест сразу; конечный повтор с растущей задержкой
 * переживает перезагрузку роутера и не мешает серверу подняться.
 */

import { backoffDelay, delay } from './timing.js';
import { DeviceRevokedError, PrintFailure, TransportFailure } from './errors.js';
import type { JobResult } from './store.js';

/**
 * Разрешённое начало пути документа.
 *
 * Проверка буквальная и оттого надёжная: строка, начинающаяся с
 * `/api/print-agent/`, не может оказаться ни `//чужой-хост/...`, ни
 * `https://...`, ни `\\сервер\доля`.
 */
const DOCUMENT_PATH_PREFIX = '/api/print-agent/';

/**
 * Потолок размера документа.
 *
 * Бланк заказа — одна-две страницы, десятки килобайт. Восемь мегабайт с
 * многократным запасом отсекают ответ, который по ошибке отдаёт не документ,
 * а поток без конца: без потолка такой ответ съел бы память рабочего места.
 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Сигнатура PDF. Первые байты любого настоящего файла. */
const PDF_MAGIC = '%PDF-';

export interface AgentJob {
  jobId: string;
  documentKind: string;
  orderNumber: string | null;
  attempt: number | null;
  /** Относительный путь на этом же сервере. Полный URL не принимается. */
  documentPath: string;
}

export interface DeviceReport {
  os: string | null;
  agentVersion: string;
  defaultPrinterName: string | null;
}

export interface PairInput extends DeviceReport {
  code: string;
  deviceName: string;
}

export interface PairResult {
  deviceId: string;
  name: string;
  token: string;
  isPrimary: boolean;
}

export interface HeartbeatResult {
  deviceId: string;
  name: string;
  isPrimary: boolean;
  serverTime: string;
}

export interface ClientOptions {
  serverUrl: string;
  /** До привязки токена нет: единственный доступный маршрут — `pair`. */
  token: string | null;
  requestTimeoutMs: number;
  retryAttempts: number;
  retryBaseMs: number;
  retryMaxDelayMs: number;
}

export const DEFAULT_CLIENT_TIMING = {
  requestTimeoutMs: 20_000,
  retryAttempts: 4,
  retryBaseMs: 1_000,
  retryMaxDelayMs: 30_000,
} as const;

/**
 * Склеивает путь документа с адресом сервера.
 *
 * Отдельная экспортируемая функция, потому что это граница доверия, и её
 * поведение проверяется отдельно от всего остального.
 */
export function resolveDocumentUrl(serverUrl: string, documentPath: string): URL {
  if (!documentPath.startsWith(DOCUMENT_PATH_PREFIX)) {
    throw new PrintFailure('DOCUMENT_INVALID', 'Сервер прислал недопустимый путь документа.');
  }

  // `..` и его процентная запись отсекаются до разбора: дальше путь попадает
  // в HTTP-запрос как есть, и нормализовать его будет уже не наше дело.
  const lowered = documentPath.toLowerCase();
  if (lowered.includes('..') || lowered.includes('%2e') || lowered.includes('\\')) {
    throw new PrintFailure('DOCUMENT_INVALID', 'Сервер прислал недопустимый путь документа.');
  }

  const base = new URL(serverUrl);
  const resolved = new URL(documentPath, base);

  // Пояс поверх подтяжек: даже если проверка выше однажды окажется обойдена,
  // запрос всё равно не уйдёт на чужой хост.
  if (resolved.origin !== base.origin) {
    throw new PrintFailure('DOCUMENT_INVALID', 'Сервер прислал путь на чужой адрес.');
  }

  return resolved;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Ответ не того вида — это неисправность сервера, а не задания.
 *
 * Поэтому `TransportFailure`, а не отказ печати: реакция та же (подождать и
 * повторить), а отчитаться об исходе задания, которого мы не поняли, было бы
 * враньём.
 */
function protocolFailure(field: string): TransportFailure {
  return new TransportFailure(`Сервер ответил неожиданными данными: ${field}`);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw protocolFailure(key);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function optionalNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Дочитывает тело, которое нам не нужно: иначе соединение остаётся занятым. */
async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Тело уже недоступно — значит, освобождать нечего.
  }
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** Маршрут привязки — единственный без токена. */
  authenticated: boolean;
}

export class PrintAgentClient {
  private token: string | null;

  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.token = options.token;
  }

  /** Токен появляется после привязки и исчезает при отзыве устройства. */
  setToken(token: string | null): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  private headers(authenticated: boolean, withBody: boolean): Headers {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    if (withBody) {
      headers.set('content-type', 'application/json');
    }
    if (authenticated) {
      if (this.token === null) {
        throw new DeviceRevokedError('Рабочее место не привязано.');
      }
      headers.set('authorization', `Bearer ${this.token}`);
    }
    return headers;
  }

  /**
   * Один запрос с ограниченным числом повторов.
   *
   * Повторяются только те отказы, которые проходят сами: обрыв связи, таймаут,
   * 5xx и 429. Ответ 4xx повторять нечем — запрос не изменится, — а 401
   * прекращает работу немедленно: устройство отозвали, и следующая попытка
   * лишь добавит строку в журнал сервера.
   */
  private async send(spec: RequestSpec): Promise<Response> {
    const url = new URL(spec.path, this.options.serverUrl);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.options.retryAttempts; attempt += 1) {
      if (attempt > 1) {
        await delay(
          backoffDelay(attempt - 1, this.options.retryBaseMs, this.options.retryMaxDelayMs),
        );
      }

      try {
        const response = await fetch(url, {
          method: spec.method,
          headers: this.headers(spec.authenticated, spec.body !== undefined),
          ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
          signal: AbortSignal.timeout(this.options.requestTimeoutMs),
          redirect: 'error',
        });

        if (response.status === 401) {
          await discard(response);
          throw new DeviceRevokedError('Устройство не распознано сервером.');
        }

        if (response.status === 429 || response.status >= 500) {
          await discard(response);
          lastError = new TransportFailure(`Сервер ответил ${String(response.status)}`);
          continue;
        }

        if (!response.ok) {
          await discard(response);
          // Отказ 4xx повторять бессмысленно, но и падать на нём нельзя:
          // вызывающий решит, значит ли это отказ печати.
          throw new TransportFailure(`Сервер отклонил запрос: ${String(response.status)}`);
        }

        return response;
      } catch (error) {
        if (error instanceof DeviceRevokedError || error instanceof TransportFailure) {
          throw error;
        }
        lastError = error;
      }
    }

    throw new TransportFailure('Сервер недоступен.', { cause: lastError });
  }

  private async sendJson(spec: RequestSpec): Promise<Record<string, unknown>> {
    const response = await this.send(spec);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TransportFailure('Сервер ответил не JSON.', { cause: error });
    }
    if (!isObject(payload)) {
      throw protocolFailure('тело ответа');
    }
    return payload;
  }

  async pair(input: PairInput): Promise<PairResult> {
    const payload = await this.sendJson({
      method: 'POST',
      path: '/api/print-agent/pair',
      authenticated: false,
      body: {
        code: input.code,
        deviceName: input.deviceName,
        os: input.os,
        agentVersion: input.agentVersion,
        defaultPrinterName: input.defaultPrinterName,
      },
    });

    return {
      deviceId: requireString(payload, 'deviceId'),
      name: requireString(payload, 'name'),
      token: requireString(payload, 'token'),
      isPrimary: payload['isPrimary'] === true,
    };
  }

  async heartbeat(report: DeviceReport): Promise<HeartbeatResult> {
    const payload = await this.sendJson({
      method: 'POST',
      path: '/api/print-agent/heartbeat',
      authenticated: true,
      body: {
        os: report.os,
        agentVersion: report.agentVersion,
        defaultPrinterName: report.defaultPrinterName,
      },
    });

    return {
      deviceId: requireString(payload, 'deviceId'),
      name: requireString(payload, 'name'),
      isPrimary: payload['isPrimary'] === true,
      serverTime: requireString(payload, 'serverTime'),
    };
  }

  /** Очередное задание либо `null`, если очередь пуста или мы не основной. */
  async claimJob(): Promise<AgentJob | null> {
    const payload = await this.sendJson({
      method: 'POST',
      path: '/api/print-agent/jobs/claim',
      authenticated: true,
    });

    const job = payload['job'];
    if (job === null || job === undefined) {
      return null;
    }
    if (!isObject(job)) {
      throw protocolFailure('job');
    }

    return {
      jobId: requireString(job, 'jobId'),
      documentKind: requireString(job, 'documentKind'),
      orderNumber: optionalString(job, 'orderNumber'),
      attempt: optionalNumber(job, 'attempt'),
      documentPath: requireString(job, 'documentPath'),
    };
  }

  /**
   * Забирает документ и проверяет, что это действительно бланк.
   *
   * Любая неудача превращается в код из закрытого перечня, потому что дальше
   * этот код уйдёт серверу и оттуда — на экран флориста.
   */
  async downloadDocument(documentPath: string): Promise<Uint8Array> {
    const url = resolveDocumentUrl(this.options.serverUrl, documentPath);

    const response = await this.send({
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      authenticated: true,
    }).catch((error: unknown) => {
      if (error instanceof DeviceRevokedError) {
        throw error;
      }
      throw new PrintFailure('DOWNLOAD_FAILED', 'Документ не получен с сервера.', {
        cause: error,
      });
    });

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/pdf')) {
      await discard(response);
      throw new PrintFailure('DOCUMENT_INVALID', 'Сервер отдал не PDF.');
    }

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
      await discard(response);
      throw new PrintFailure('DOCUMENT_INVALID', 'Документ больше допустимого размера.');
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new PrintFailure('DOCUMENT_INVALID', 'Документ больше допустимого размера.');
    }

    const magic = Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString('latin1');
    if (magic !== PDF_MAGIC) {
      throw new PrintFailure('DOCUMENT_INVALID', 'Полученный файл не начинается с сигнатуры PDF.');
    }

    return bytes;
  }

  /**
   * Отчёт «передаю документ драйверу».
   *
   * Уходит ДО передачи. Пока сервер его не принял, документ печатать нельзя:
   * иначе `CLAIMED` перестанет означать «принтер документа не видел», и
   * возврат зависшего задания в очередь начнёт печатать вторые бланки.
   */
  async reportPrinting(jobId: string): Promise<void> {
    const response = await this.send({
      method: 'POST',
      path: `/api/print-agent/jobs/${encodeURIComponent(jobId)}/printing`,
      authenticated: true,
    });
    await discard(response);
  }

  /** Исход задания. Сервер идемпотентен, поэтому повтор безопасен. */
  async reportResult(jobId: string, result: JobResult): Promise<void> {
    const response = await this.send({
      method: 'POST',
      path: `/api/print-agent/jobs/${encodeURIComponent(jobId)}/result`,
      authenticated: true,
      body: {
        outcome: result.outcome,
        errorCode: result.errorCode,
        defaultPrinterName: result.defaultPrinterName,
      },
    });
    await discard(response);
  }
}
