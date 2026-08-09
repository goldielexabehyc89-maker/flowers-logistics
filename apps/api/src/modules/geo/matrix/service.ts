/**
 * Матрицы времени и расстояния для будущего планировщика.
 *
 * Сервис внутренний. Публичного endpoint с произвольными координатами нет
 * намеренно: он превратил бы наш маршрутизатор в бесплатный вычислитель для
 * посторонних и позволил бы выяснить, куда мы возим, не имея доступа к заказам.
 *
 * Матрица считается только по подтверждённым точкам (`geoState = RESOLVED`).
 * Неподтверждённая координата в расчёте выглядела бы как обычная и дала бы
 * правдоподобный, но неверный порядок объезда.
 *
 * Три свойства обеспечиваются здесь и обязаны сохраниться при любых правках:
 *
 *   1. Сетевой вызов НИКОГДА не выполняется внутри транзакции. Расчёт длится
 *      секунды, и открытая всё это время транзакция держала бы соединение
 *      и строку кэша.
 *   2. Один ключ не считают два экземпляра приложения одновременно. Право
 *      на расчёт выдаёт база через уникальный индекс ключа.
 *   3. Ошибка не сохраняется как успех и не переживает TTL.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';
import type { AppLogger } from '../../../platform/logging/logger.js';
import { AppError } from '../../../platform/errors.js';
import {
  COSTING,
  ValhallaError,
  type LatLon,
  type MatrixElement,
  type ValhallaErrorCode,
} from '../../integrations/valhalla/client.js';

/** Режим учёта дорожной обстановки. Живых пробок в собственном стеке нет. */
export type TrafficMode = $Enums.TrafficMode;

/**
 * Верхняя граница числа точек по умолчанию.
 *
 * Матрица растёт квадратично: 60 точек — это 3600 пар, и уже они считаются
 * заметное время. Предел настраиваемый, но он обязан существовать: запрос
 * на тысячу точек — это миллион пар и заведомо неудачный расчёт.
 */
export const DEFAULT_MAX_POINTS = 60;

/** Сколько живёт готовый результат. Граф между сборками не меняется. */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Сколько расчёт может числиться за экземпляром, прежде чем считаться брошенным. */
export const LEASE_TIMEOUT_MS = 120_000;

export interface MatrixDeps {
  db: Database;
  logger: AppLogger;
  /** Клиент маршрутизатора. Вызывается строго вне транзакции. */
  valhalla: {
    matrix: (points: readonly LatLon[], costing: string) => Promise<(MatrixElement | null)[][]>;
  };
  /**
   * Ревизия дорожного графа. Обязательна: расчёт по другому графу — другой
   * ответ, и переиспользовать его нельзя.
   */
  graphRevision: string | null;
  maxPoints?: number;
  ttlSeconds?: number;
  now?: () => Date;
  leaseTimeoutMs?: number;
  workerId?: string;
  /** Сколько раз ждать чужой расчёт, прежде чем признать его незавершённым. */
  waitAttempts?: number;
  waitDelayMs?: number;
}

export interface MatrixRequest {
  points: readonly LatLon[];
  profile: $Enums.VehicleType;
}

export interface MatrixResult {
  /** Направленная матрица целых секунд. `null` — пара недостижима. */
  durationsSec: (number | null)[][];
  /** Направленная матрица целых метров. `null` — пара недостижима. */
  distancesM: (number | null)[][];
  graphRevision: string;
  profile: $Enums.VehicleType;
  /**
   * Режим учёта обстановки.
   *
   * `STATIC` означает: время посчитано по постоянным скоростям дорожного графа.
   * Это НЕ пробки. Поле существует, чтобы платный источник времени можно было
   * добавить позже, не переписывая доменную модель и не смешивая старые
   * расчёты с новыми.
   */
  trafficMode: TrafficMode;
  /** Результат взят из кэша: обращения к маршрутизатору не было. */
  cached: boolean;
}

/** Режим, доступный собственному стеку сегодня. Живых пробок в нём нет. */
export const CURRENT_TRAFFIC_MODE: TrafficMode = 'STATIC';

function clockOf(deps: MatrixDeps): Date {
  return (deps.now ?? ((): Date => new Date()))();
}

/**
 * Канонический ключ расчёта.
 *
 * В него входит всё, что влияет на ответ: ревизия графа, профиль, режим
 * обстановки и упорядоченный набор координат. Порядок значим — матрица
 * направленная, и перестановка точек даёт другую матрицу, а не ту же самую
 * в другом порядке.
 *
 * Координаты нормализуются до микроградуса: именно с этой точностью они
 * хранятся, и запись «55.7512440» не должна давать другой ключ, чем «55.751244».
 */
export function matrixCacheKey(input: {
  graphRevision: string;
  profile: $Enums.VehicleType;
  trafficMode: TrafficMode;
  points: readonly LatLon[];
}): string {
  const points = input.points
    .map((point) => `${Math.round(point.lat * 1e6)},${Math.round(point.lon * 1e6)}`)
    .join(';');

  const canonical = [
    'matrix@1',
    input.graphRevision,
    input.profile,
    input.trafficMode,
    // Единицы результата тоже влияют на ответ и потому входят в ключ.
    'sec+m',
    points,
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Считает матрицу, переиспользуя готовый результат.
 *
 * Порядок работы: посмотреть кэш → занять право на расчёт → сходить в сеть
 * ВНЕ транзакции → записать результат. Экземпляр, которому право не досталось,
 * ждёт чужой результат, а не считает то же самое второй раз.
 */
export async function computeMatrix(
  deps: MatrixDeps,
  request: MatrixRequest,
): Promise<MatrixResult> {
  const maxPoints = deps.maxPoints ?? DEFAULT_MAX_POINTS;

  if (deps.graphRevision === null || deps.graphRevision.trim() === '') {
    // Без ревизии графа результат некуда отнести: он мог бы пережить смену
    // дорожных данных и молча остаться в кэше как актуальный.
    throw new AppError('VALIDATION_FAILED', {
      message: 'graph revision is not configured',
      publicMessage: 'Расчёт маршрутов не настроен: не задана ревизия дорожного графа.',
    });
  }

  if (request.points.length < 2) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'matrix needs at least two points',
      publicMessage: 'Для расчёта нужно не меньше двух точек.',
    });
  }

  if (request.points.length > maxPoints) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'too many points for matrix',
      publicMessage: `Слишком много точек для расчёта: не больше ${maxPoints} за один раз.`,
    });
  }

  for (const point of request.points) {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lon) ||
      Math.abs(point.lat) > 90 ||
      Math.abs(point.lon) > 180
    ) {
      throw new AppError('VALIDATION_FAILED', {
        message: 'invalid point in matrix request',
        publicMessage: 'Координата выходит за пределы допустимых значений.',
      });
    }
  }

  const graphRevision = deps.graphRevision;
  const trafficMode = CURRENT_TRAFFIC_MODE;
  const keyHash = matrixCacheKey({
    graphRevision,
    profile: request.profile,
    trafficMode,
    points: request.points,
  });

  const now = clockOf(deps);

  const fresh = await readFresh(deps, keyHash, now);
  if (fresh !== null) {
    return { ...fresh, graphRevision, profile: request.profile, trafficMode, cached: true };
  }

  const claimed = await claim(deps, {
    keyHash,
    graphRevision,
    profile: request.profile,
    trafficMode,
    pointCount: request.points.length,
    now,
  });

  if (!claimed) {
    // Считает кто-то другой. Ждать чужой результат дешевле, чем повторить
    // ту же работу: расчёт одинаков, а лимиты маршрутизатора общие.
    const waited = await waitForOther(deps, keyHash);
    if (waited !== null) {
      return { ...waited, graphRevision, profile: request.profile, trafficMode, cached: true };
    }

    throw new AppError('CONFLICT', {
      message: 'matrix is being computed by another instance',
      publicMessage: 'Расчёт уже выполняется. Повторите попытку через несколько секунд.',
      conflict: { kind: 'MATRIX_IN_PROGRESS' },
    });
  }

  let matrix: (MatrixElement | null)[][];
  try {
    // Вне транзакции. Это главное свойство модуля: расчёт длится секунды,
    // и держать всё это время открытую транзакцию недопустимо.
    matrix = await deps.valhalla.matrix(request.points, COSTING[request.profile]);
  } catch (error) {
    const code: ValhallaErrorCode = error instanceof ValhallaError ? error.code : 'TRANSPORT_ERROR';
    await markFailed(deps, keyHash, code, clockOf(deps));

    throw new AppError('SERVICE_UNAVAILABLE', {
      message: `matrix computation failed: ${code}`,
      publicMessage:
        'Расчёт времени в пути сейчас недоступен. Ручные маршруты продолжают работать.',
      details: { code },
    });
  }

  const { durationsSec, distancesM } = normalize(matrix, request.points.length);

  const computedAt = clockOf(deps);
  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  await deps.db.routeMatrixCache.updateMany({
    where: { keyHash, status: 'PENDING', lockedBy: deps.workerId ?? 'matrix' },
    data: {
      status: 'READY',
      durationsSec,
      distancesM,
      computedAt,
      expiresAt: new Date(computedAt.getTime() + ttlSeconds * 1000),
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
    },
  });

  return {
    durationsSec,
    distancesM,
    graphRevision,
    profile: request.profile,
    trafficMode,
    cached: false,
  };
}

interface CachedMatrix {
  durationsSec: (number | null)[][];
  distancesM: (number | null)[][];
}

/** Готовый и не просроченный результат. Просроченный считается отсутствующим. */
async function readFresh(
  deps: MatrixDeps,
  keyHash: string,
  now: Date,
): Promise<CachedMatrix | null> {
  const row = await deps.db.routeMatrixCache.findUnique({
    where: { keyHash },
    select: { status: true, durationsSec: true, distancesM: true, expiresAt: true },
  });

  if (
    row === null ||
    row.status !== 'READY' ||
    row.expiresAt === null ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }

  return {
    durationsSec: row.durationsSec as (number | null)[][],
    distancesM: row.distancesM as (number | null)[][],
  };
}

/**
 * Пытается занять право на расчёт.
 *
 * Право выдаёт уникальный индекс ключа: вставка либо удаётся, либо нет.
 * Проверка «сначала найти, потом создать» при гонке дала бы два расчёта —
 * параллельные транзакции не видят незафиксированных вставок друг друга.
 *
 * Просроченная и брошенная аренда перехватывается: процесс мог быть убит
 * между захватом и записью результата, и ключ иначе застрял бы навсегда.
 */
async function claim(
  deps: MatrixDeps,
  input: {
    keyHash: string;
    graphRevision: string;
    profile: $Enums.VehicleType;
    trafficMode: TrafficMode;
    pointCount: number;
    now: Date;
  },
): Promise<boolean> {
  const workerId = deps.workerId ?? 'matrix';
  const staleBefore = new Date(input.now.getTime() - (deps.leaseTimeoutMs ?? LEASE_TIMEOUT_MS));

  const inserted = await deps.db.$executeRaw`
    INSERT INTO "RouteMatrixCache"
      ("id", "keyHash", "graphRevision", "profile", "trafficMode", "pointCount",
       "status", "attempts", "lockedAt", "lockedBy", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${input.keyHash}, ${input.graphRevision},
            ${input.profile}::"VehicleType", ${input.trafficMode}::"TrafficMode",
            ${input.pointCount}, 'PENDING', 1, ${input.now}, ${workerId},
            ${input.now}, ${input.now})
    ON CONFLICT ("keyHash") DO NOTHING
  `;

  if (inserted === 1) {
    return true;
  }

  // Ключ уже есть. Забрать его можно только у брошенного расчёта либо
  // у неудачной попытки: чужую активную работу не перехватываем.
  const taken = await deps.db.routeMatrixCache.updateMany({
    where: {
      keyHash: input.keyHash,
      OR: [
        { status: 'PENDING', lockedAt: { lt: staleBefore } },
        { status: 'FAILED' },
        { status: 'READY', expiresAt: { lte: input.now } },
      ],
    },
    data: {
      status: 'PENDING',
      graphRevision: input.graphRevision,
      profile: input.profile,
      trafficMode: input.trafficMode,
      pointCount: input.pointCount,
      // Prisma требует явного JsonNull: обычный null означал бы «не менять».
      durationsSec: Prisma.DbNull,
      distancesM: Prisma.DbNull,
      computedAt: null,
      expiresAt: null,
      lockedAt: input.now,
      lockedBy: workerId,
      attempts: { increment: 1 },
      lastErrorCode: null,
    },
  });

  return taken.count === 1;
}

/** Ждёт чужой расчёт. `null` — не дождались; вызывающая сторона получит 409. */
async function waitForOther(deps: MatrixDeps, keyHash: string): Promise<CachedMatrix | null> {
  const attempts = deps.waitAttempts ?? 10;
  const delayMs = deps.waitDelayMs ?? 300;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const fresh = await readFresh(deps, keyHash, clockOf(deps));
    if (fresh !== null) {
      return fresh;
    }
  }

  return null;
}

/** Неудача сохраняется как неудача. Выдавать её за результат нельзя. */
async function markFailed(
  deps: MatrixDeps,
  keyHash: string,
  code: string,
  now: Date,
): Promise<void> {
  await deps.db.routeMatrixCache.updateMany({
    where: { keyHash, status: 'PENDING', lockedBy: deps.workerId ?? 'matrix' },
    data: {
      status: 'FAILED',
      durationsSec: Prisma.DbNull,
      distancesM: Prisma.DbNull,
      computedAt: null,
      // Срок годности у неудачи есть, но результата в ней нет: строка живёт
      // только ради диагностики и будет перехвачена следующей попыткой.
      expiresAt: new Date(now.getTime() + 60_000),
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: code,
    },
  });
}

/**
 * Приводит ответ маршрутизатора к матрицам целых чисел.
 *
 * Диагональ обнуляется явно: путь из точки в неё же равен нулю, но сервис
 * может вернуть небольшую величину из-за привязки к ближайшей дороге.
 * Недостижимая пара остаётся `null` — ноль означал бы совпадение точек.
 */
export function normalize(
  matrix: (MatrixElement | null)[][],
  size: number,
): { durationsSec: (number | null)[][]; distancesM: (number | null)[][] } {
  const durationsSec: (number | null)[][] = [];
  const distancesM: (number | null)[][] = [];

  if (matrix.length !== size) {
    throw new AppError('INTERNAL_ERROR', { message: 'matrix has unexpected size' });
  }

  for (let from = 0; from < size; from += 1) {
    const row = matrix[from];
    if (row === undefined || row.length !== size) {
      throw new AppError('INTERNAL_ERROR', { message: 'matrix row has unexpected size' });
    }

    const durations: (number | null)[] = [];
    const distances: (number | null)[] = [];

    for (let to = 0; to < size; to += 1) {
      if (from === to) {
        durations.push(0);
        distances.push(0);
        continue;
      }

      const element = row[to] ?? null;
      durations.push(element?.timeSeconds ?? null);
      distances.push(element?.distanceMeters ?? null);
    }

    durationsSec.push(durations);
    distancesM.push(distances);
  }

  return { durationsSec, distancesM };
}

/** Идентификатор экземпляра для аренды расчёта. */
export function newMatrixWorkerId(): string {
  return randomUUID();
}

/**
 * Удаляет просроченные записи кэша.
 *
 * Подключается к общим фоновым очисткам: без неё таблица растёт вечно,
 * а просроченные строки всё равно не используются.
 */
export async function cleanupExpiredMatrices(db: Database, now: Date): Promise<number> {
  const result = await db.routeMatrixCache.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return result.count;
}
