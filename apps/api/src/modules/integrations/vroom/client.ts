/**
 * Клиент решателя VROOM.
 *
 * Сервис поднят рядом, в ОТДЕЛЬНОЙ внутренней сети Compose без единого
 * проброса портов. Полностью отрезать его от сети (`--network none`)
 * невозможно: мы сами обращаемся к нему по HTTP. Поэтому изоляция строится
 * не отсутствием сети, а отсутствием доступа к ней снаружи — решатель
 * подключён только к внутренней сети, а приложение к обеим.
 *
 * В VROOM уходят ТОЛЬКО числа и индексы. Ни адресов, ни координат, ни номеров
 * заказов, ни описаний, ни имён курьеров: решателю они не нужны, а попав
 * в чужой лог, остались бы там навсегда. Проверка этого выполняется здесь,
 * на границе, а не только при сборке запроса: граница — последнее место,
 * где ошибку ещё можно остановить.
 *
 * Геометрия не запрашивается: она не нужна ни плану, ни интерфейсу, а её
 * получение заставило бы решатель обратиться к маршрутизатору самостоятельно.
 *
 * Скрытых повторов нет: клиент выполняет один запрос и возвращает либо
 * проверенный ответ, либо ошибку с кодом.
 */

import { z } from 'zod';

export type VroomErrorCode =
  | 'NOT_CONFIGURED'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR'
  | 'TRANSPORT_ERROR'
  | 'BAD_RESPONSE'
  | 'SOLVER_ERROR'
  | 'FORBIDDEN_FIELD';

const MESSAGES: Record<VroomErrorCode, string> = {
  NOT_CONFIGURED: 'Оптимизация маршрутов не настроена',
  BAD_REQUEST: 'Решатель отклонил запрос',
  SERVER_ERROR: 'Решатель ответил ошибкой',
  TRANSPORT_ERROR: 'Не удалось связаться с решателем',
  BAD_RESPONSE: 'Ответ решателя не удалось разобрать',
  SOLVER_ERROR: 'Решатель не смог построить план',
  FORBIDDEN_FIELD: 'В запросе к решателю оказалось недопустимое поле',
};

/** Ошибка решателя без подробностей запроса: его текст мог бы протащить данные. */
export class VroomError extends Error {
  readonly code: VroomErrorCode;
  readonly status: number | null;

  constructor(code: VroomErrorCode, status: number | null = null) {
    super(MESSAGES[code]);
    this.name = 'VroomError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Профили решателя.
 *
 * Имя профиля связывает машину с её матрицей и ничего больше не значит:
 * матрицы мы передаём готовыми, и в маршрутизатор решатель не ходит.
 */
export const VROOM_PROFILE = { CAR: 'car', FOOT: 'foot' } as const;
export type VroomProfile = (typeof VROOM_PROFILE)[keyof typeof VROOM_PROFILE];

/** Пара «время, расстояние» матрицы. Целые неотрицательные числа. */
export interface VroomMatrix {
  durations: number[][];
  distances: number[][];
}

export interface VroomJob {
  id: number;
  location_index: number;
  service: number;
  service_per_type: Record<string, number>;
  delivery: number[];
  time_windows?: [number, number][];
}

export interface VroomVehicle {
  id: number;
  profile: VroomProfile;
  type: string;
  start_index: number;
  end_index: number;
  capacity: number[];
  time_window: [number, number];
}

export interface VroomRequest {
  jobs: VroomJob[];
  vehicles: VroomVehicle[];
  matrices: Record<string, VroomMatrix>;
}

/**
 * Поля запроса, которые не должны уйти решателю ни при каких обстоятельствах.
 *
 * `description` и `location` — прямые каналы утечки: первый принимает
 * произвольный текст, второй — координаты. Оба необязательны для решения
 * по индексам и потому просто запрещены.
 */
const FORBIDDEN_REQUEST_FIELDS = /^(description|location|address|recipient|comment|name|number)$/i;

/**
 * Проверяет, что в запросе нет ничего, кроме чисел, индексов и известных строк.
 *
 * Строки допускаются только там, где они являются частью контракта решателя:
 * имя профиля и тип машины. Любая другая строка означает, что в запрос попало
 * что-то, чему там не место.
 */
export function assertNumericRequest(value: unknown, path = ''): void {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'string') {
    // Единственные допустимые строковые значения — профиль и тип машины.
    const leaf = path.split('.').pop() ?? '';
    if (leaf === 'profile' || leaf === 'type') {
      return;
    }
    throw new VroomError('FORBIDDEN_FIELD');
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNumericRequest(item, `${path}[${index}]`));
    return;
  }

  if (typeof value !== 'object') {
    throw new VroomError('FORBIDDEN_FIELD');
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_REQUEST_FIELDS.test(key)) {
      throw new VroomError('FORBIDDEN_FIELD');
    }
    assertNumericRequest(item, path === '' ? key : `${path}.${key}`);
  }
}

/**
 * Ответ решателя.
 *
 * Разбирается строго: у шага обязателен тип, а идентификатор задачи есть
 * только у шагов задач. Необязательность обязательных полей означала бы,
 * что ответ без маршрутов проходит как «все заказы размещены в ноль маршрутов».
 */
const stepSchema = z.object({
  type: z.string().min(1),
  id: z.number().int().optional(),
  arrival: z.number().optional(),
});

const routeSchema = z.object({
  vehicle: z.number().int(),
  steps: z.array(stepSchema),
  duration: z.number().optional(),
  service: z.number().optional(),
  waiting_time: z.number().optional(),
  distance: z.number().optional(),
});

const unassignedSchema = z.object({
  id: z.number().int(),
  type: z.string().optional(),
});

const solutionSchema = z.object({
  code: z.number().int(),
  error: z.string().optional(),
  summary: z
    .object({
      cost: z.number().optional(),
      routes: z.number().int().optional(),
      unassigned: z.number().int().optional(),
      duration: z.number().optional(),
      service: z.number().optional(),
      distance: z.number().optional(),
    })
    .optional(),
  routes: z.array(routeSchema).optional(),
  unassigned: z.array(unassignedSchema).optional(),
});

export type VroomSolution = z.infer<typeof solutionSchema>;

export interface VroomClientDeps {
  /** Базовый адрес решателя. `null` — оптимизация не настроена. */
  baseUrl: string | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class VroomClient {
  private readonly baseUrl: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(deps: VroomClientDeps) {
    this.baseUrl = deps.baseUrl === null ? null : deps.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get configured(): boolean {
    return this.baseUrl !== null;
  }

  /** Проверка доступности. Решатель прогоняет собственную маленькую задачу. */
  async health(): Promise<void> {
    await this.request('/health', { method: 'GET' }, false);
  }

  /**
   * Решает задачу.
   *
   * Запрос проверяется на отсутствие недопустимых полей ДО отправки: если
   * проверка не прошла, наружу не уходит ничего.
   */
  async solve(request: VroomRequest): Promise<VroomSolution> {
    assertNumericRequest(request);

    const body = await this.request(
      '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
      },
      true,
    );

    const parsed = solutionSchema.safeParse(body);
    if (!parsed.success) {
      throw new VroomError('BAD_RESPONSE');
    }

    // Ненулевой код — это отказ, а не решение. Продолжать с ним нельзя:
    // `routes` в таком ответе либо отсутствуют, либо неполны.
    if (parsed.data.code !== 0) {
      throw new VroomError('SOLVER_ERROR');
    }

    return parsed.data;
  }

  private async request(path: string, init: RequestInit, parseJson: boolean): Promise<unknown> {
    if (this.baseUrl === null) {
      throw new VroomError('NOT_CONFIGURED');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Текст сетевой ошибки содержит адрес и может содержать тело запроса.
      throw new VroomError('TRANSPORT_ERROR');
    }

    if (!response.ok) {
      throw new VroomError(
        response.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST',
        response.status,
      );
    }

    if (!parseJson) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      throw new VroomError('BAD_RESPONSE', response.status);
    }
  }
}
