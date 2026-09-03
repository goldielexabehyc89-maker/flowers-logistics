/**
 * Изолированный контур загрузки фотографий номенклатуры.
 *
 * Фотографии НЕ должны занимать очередь основного клиента МоегоСклада
 * (2/1/30) и мешать импорту, delta-синхронизации и передаче статусов. Здесь —
 * отдельный ограниченный контур со своими правилами, не трогающий тот клиент:
 *
 *  - таймаут ОДНОГО обращения к МоемуСкладу ≤ 3 с (AbortController);
 *  - без автоматических повторов при timeout/429/5xx/сетевом обрыве;
 *  - ограничены и одновременные, и ожидающие запросы (bounded semaphore);
 *  - одинаковые assortmentId склеиваются в один upstream-запрос (dedup);
 *  - при заполнении очереди новые запросы быстро завершаются «Фото отсутствует»
 *    (`null`), не обращаясь в upstream;
 *  - circuit breaker: после сетевого отказа/timeout/429/5xx открывается на ~60 с,
 *    пока открыт — мгновенный локальный отказ; затем ОДИН пробный запрос
 *    закрывает или снова открывает предохранитель;
 *  - байты, адрес источника и токен не сохраняются и не логируются.
 *
 * Всё, что нужно для тестов (`fetch`, `now`, логгер, лимиты), инъектируется,
 * поэтому отказы и задержки моделируются заглушкой сети и управляемым временем,
 * без обращения к настоящему МоемуСкладу.
 */

export interface PhotoBytes {
  bytes: Uint8Array;
  contentType: string;
}

export interface PhotoFetcherStats {
  circuit: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /** Быстрые локальные отказы: открытый предохранитель или заполненная очередь. */
  fastFails: number;
  timeouts: number;
  /** Подтверждённые отказы upstream (429/5xx/сеть), открывшие предохранитель. */
  failures: number;
  /** Склеенные повторные запросы той же номенклатуры. */
  coalesced: number;
  /** Сколько раз предохранитель открывался. */
  opens: number;
  inFlight: number;
  queueLength: number;
}

export interface PhotoFetcherLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export interface PhotoFetcherOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  logger?: PhotoFetcherLogger;
  maxConcurrent?: number;
  maxQueued?: number;
  timeoutMs?: number;
  breakerOpenMs?: number;
  maxBytes?: number;
  allowedTypes?: readonly string[];
}

const DEFAULT_ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Внутренняя ошибка: истёк таймаут одного обращения. */
class PhotoTimeoutError extends Error {}
/** Внутренняя ошибка: upstream вернул временную ошибку (429/5xx). */
class PhotoUpstreamError extends Error {
  constructor(public readonly status: number) {
    super(`upstream ${String(status)}`);
  }
}

type Circuit = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface ListImage {
  meta: { downloadHref: string };
  size?: number;
}

export class PhotoFetcher {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly logger: PhotoFetcherLogger | undefined;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly breakerOpenMs: number;
  private readonly maxBytes: number;
  private readonly allowedTypes: readonly string[];

  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly inflightById = new Map<string, Promise<PhotoBytes | null>>();

  private circuit: Circuit = 'CLOSED';
  private openedAt = 0;
  private trialInProgress = false;

  private readonly stats = {
    fastFails: 0,
    timeouts: 0,
    failures: 0,
    coalesced: 0,
    opens: 0,
  };

  constructor(options: PhotoFetcherOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxQueued = options.maxQueued ?? 20;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.breakerOpenMs = options.breakerOpenMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.allowedTypes = options.allowedTypes ?? DEFAULT_ALLOWED;
  }

  /** Безопасный снимок метрик: ни байтов, ни адресов, ни токена. */
  snapshot(): PhotoFetcherStats {
    return {
      circuit: this.circuit,
      fastFails: this.stats.fastFails,
      timeouts: this.stats.timeouts,
      failures: this.stats.failures,
      coalesced: this.stats.coalesced,
      opens: this.stats.opens,
      inFlight: this.inFlight,
      queueLength: this.waiters.length,
    };
  }

  /**
   * Фотография номенклатуры или `null` («Фото отсутствует»).
   *
   * `entities` — типы сущности МоегоСклада (product/variant/bundle), которыми
   * встречается эта номенклатура; перебираются в пределах одного бюджета времени.
   * Одинаковые `assortmentId` склеиваются в один upstream-запрос.
   */
  getPhoto(entities: readonly string[], assortmentId: string): Promise<PhotoBytes | null> {
    const existing = this.inflightById.get(assortmentId);
    if (existing !== undefined) {
      this.stats.coalesced += 1;
      return existing;
    }
    const promise = this.run(entities, assortmentId).finally(() => {
      this.inflightById.delete(assortmentId);
    });
    this.inflightById.set(assortmentId, promise);
    return promise;
  }

  private async run(entities: readonly string[], id: string): Promise<PhotoBytes | null> {
    const gate = this.gate();
    if (gate === 'fastfail') {
      this.stats.fastFails += 1;
      return null;
    }
    const acquired = await this.acquire();
    if (!acquired) {
      // Очередь заполнена — быстрый локальный отказ, upstream не трогаем.
      this.stats.fastFails += 1;
      if (gate === 'trial') {
        // Пробный запрос не состоялся — вернём предохранитель в OPEN, чтобы
        // следующий запрос попробовал снова, но без нагрузки на upstream.
        this.circuit = 'OPEN';
        this.trialInProgress = false;
      }
      return null;
    }

    try {
      const result = await this.withTimeout((signal) => this.attempt(entities, id, signal));
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      return null;
    } finally {
      this.release();
    }
  }

  /** Решение предохранителя ДО обращения к upstream. */
  private gate(): 'proceed' | 'fastfail' | 'trial' {
    if (this.circuit === 'CLOSED') {
      return 'proceed';
    }
    if (this.circuit === 'OPEN') {
      if (this.now() - this.openedAt >= this.breakerOpenMs) {
        this.circuit = 'HALF_OPEN';
        this.trialInProgress = true;
        return 'trial';
      }
      return 'fastfail';
    }
    // HALF_OPEN: ровно один пробный запрос.
    if (this.trialInProgress) {
      return 'fastfail';
    }
    this.trialInProgress = true;
    return 'trial';
  }

  private onSuccess(): void {
    const wasOpen = this.circuit !== 'CLOSED';
    this.circuit = 'CLOSED';
    this.trialInProgress = false;
    if (wasOpen) {
      this.log('closed');
    }
  }

  private onFailure(error: unknown): void {
    if (error instanceof PhotoTimeoutError) {
      this.stats.timeouts += 1;
    }
    this.stats.failures += 1;
    this.circuit = 'OPEN';
    this.openedAt = this.now();
    this.trialInProgress = false;
    this.stats.opens += 1;
    this.log('open');
  }

  private log(event: 'open' | 'closed'): void {
    // Только агрегаты: ни токена, ни адреса, ни состава заказа, ни PII.
    this.logger?.info({ contour: 'moysklad-photo', event, ...this.snapshot() }, 'photo circuit');
  }

  private acquire(): Promise<boolean> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve(true);
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve(true);
      });
    });
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  /** Гонка операции с общим 3-секундным дедлайном; по нему upstream отменяется. */
  private async withTimeout<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PhotoTimeoutError());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([op(controller.signal), timeout]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  /** Пробует каждую сущность в пределах одного бюджета времени. */
  private async attempt(
    entities: readonly string[],
    id: string,
    signal: AbortSignal,
  ): Promise<PhotoBytes | null> {
    for (const entity of entities) {
      const image = await this.firstImage(entity, id, signal);
      if (image === null) {
        continue;
      }
      if (image.size !== undefined && image.size > this.maxBytes) {
        return null;
      }
      const file = await this.download(image.meta.downloadHref, signal);
      if (file !== null) {
        return file;
      }
    }
    return null;
  }

  private async firstImage(
    entity: string,
    id: string,
    signal: AbortSignal,
  ): Promise<ListImage | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/entity/${entity}/${id}/images`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (res.status === 429 || res.status >= 500) {
      throw new PhotoUpstreamError(res.status);
    }
    if (!res.ok) {
      return null; // 404 и прочее — «нет фото», не отказ upstream.
    }
    const body = (await res.json()) as { rows?: ListImage[] };
    const first = body.rows?.[0];
    if (first === undefined || typeof first.meta?.downloadHref !== 'string') {
      return null;
    }
    return first;
  }

  private async download(href: string, signal: AbortSignal): Promise<PhotoBytes | null> {
    // SSRF-защита: скачиваем только с базового адреса МоегоСклада.
    if (!href.startsWith(this.baseUrl)) {
      return null;
    }
    const res = await this.fetchImpl(href, {
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: 'manual',
      signal,
    });
    if (res.status === 429 || res.status >= 500) {
      throw new PhotoUpstreamError(res.status);
    }
    if (!res.ok) {
      return null;
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!this.allowedTypes.includes(contentType)) {
      return null;
    }
    // Ранний отказ по ОБЕЩАННОМУ размеру: заведомо большой файл не читаем вовсе.
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > this.maxBytes) {
      await res.body?.cancel();
      return null;
    }
    const bytes = await this.readLimited(res);
    if (bytes === null) {
      return null;
    }
    return { bytes, contentType };
  }

  private async readLimited(res: Response): Promise<Uint8Array | null> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
      const buffer = new Uint8Array(await res.arrayBuffer());
      return buffer.byteLength > this.maxBytes ? null : buffer;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}
