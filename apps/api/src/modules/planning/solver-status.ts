/**
 * Состояние решателя VROOM.
 *
 * Отдельная запись интеграции `vroom`: подложка, геокодер, маршрутизатор
 * и решатель — четыре разных сервиса с разными видами отказа. Общая запись
 * скрывала бы отказ одного за работоспособностью другого.
 *
 * Недоступность решателя НЕ влияет на готовность приложения: ручные маршруты
 * остаются основным способом работы, а планирование только ускоряет его.
 *
 * ПРОВЕРКА ВОЗМОЖНОСТИ, а не версии из настройки.
 *
 * Разное время обслуживания по типам транспорта (`service_per_type`) появилось
 * в VROOM 1.15.0. Версия, объявленная переменной окружения, — это утверждение
 * о сервисе, а не знание о нём: запись легко разойдётся с фактически
 * запущенным образом. Решатель версии 1.14 неизвестный ключ просто
 * проигнорирует и вернёт правдоподобный план с нулевым временем обслуживания.
 *
 * Поэтому при старте решателю отправляется крошечная задача из двух точек,
 * в которой время обслуживания задано ТОЛЬКО через `service_per_type`. Если
 * в ответе это время учтено — возможность есть. Если нет — планирование
 * закрыто, сколько бы ни было написано в настройке.
 */

import type { $Enums } from '../../generated/prisma/client.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { VroomError, VROOM_PROFILE, type VroomClient } from '../integrations/vroom/client.js';

export const VROOM_PROVIDER = 'vroom';

export type SolverState = 'NOT_CONFIGURED' | 'OK' | 'DEGRADED' | 'ERROR';

export type StatusDetails = Record<string, string | number | boolean | null>;

/** Время обслуживания пробной задачи. Любое отличное от нуля значение подходит. */
const PROBE_SERVICE_SECONDS = 600;
/** Тип машины пробной задачи. Совпадать с рабочими типами не обязан. */
const PROBE_TYPE = 'PROBE';

export async function setSolverStatus(
  db: Database,
  state: SolverState,
  details: StatusDetails,
  now: Date = new Date(),
): Promise<void> {
  const pending = await db.routePlanRun.count({
    where: { state: { in: ['QUEUED', 'COMPUTING'] } },
  });

  await db.integrationStatus.upsert({
    where: { provider: VROOM_PROVIDER },
    create: {
      provider: VROOM_PROVIDER,
      state: state as $Enums.IntegrationState,
      pendingOperations: pending,
      details,
      lastOkAt: state === 'OK' ? now : null,
      lastErrorAt: state === 'DEGRADED' || state === 'ERROR' ? now : null,
    },
    update: {
      state: state as $Enums.IntegrationState,
      pendingOperations: pending,
      details,
      ...(state === 'OK' ? { lastOkAt: now } : {}),
      ...(state === 'DEGRADED' || state === 'ERROR' ? { lastErrorAt: now } : {}),
    },
  });
}

/**
 * Пробная задача.
 *
 * Две точки, одна машина, один заказ. Время обслуживания задано только
 * через `service_per_type`: решатель, который этого ключа не знает, вернёт
 * `summary.service = 0`, и это единственное, что нам нужно выяснить.
 *
 * Ни координат, ни описаний в задаче нет — как и в рабочих запросах.
 */
function probeRequest() {
  return {
    jobs: [
      {
        id: 1,
        location_index: 1,
        // Ноль здесь намеренно: если `service_per_type` не поддержан,
        // итоговое время обслуживания окажется нулевым и это будет видно.
        service: 0,
        service_per_type: { [PROBE_TYPE]: PROBE_SERVICE_SECONDS },
        delivery: [1],
      },
    ],
    vehicles: [
      {
        id: 1,
        profile: VROOM_PROFILE.CAR,
        type: PROBE_TYPE,
        start_index: 0,
        end_index: 0,
        capacity: [1],
        time_window: [0, 86_400] as [number, number],
      },
    ],
    matrices: {
      [VROOM_PROFILE.CAR]: {
        durations: [
          [0, 10],
          [10, 0],
        ],
        distances: [
          [0, 10],
          [10, 0],
        ],
      },
    },
  };
}

export interface SolverProbeResult {
  state: SolverState;
  /** Учитывает ли запущенный решатель время обслуживания по типу машины. */
  servicePerType: boolean;
  /** Версия, объявленная конфигурацией. Для записи в снимок и диагностики. */
  declaredVersion: string | null;
}

/**
 * Проверяет решатель.
 *
 * Возвращает `OK` только когда сервис отвечает И действительно учитывает
 * `service_per_type`. Отсутствие возможности — это `ERROR`, а не
 * предупреждение: план с нулевым временем обслуживания выглядит выполнимым
 * и таковым не является.
 */
export async function probeSolver(
  db: Database,
  client: Pick<VroomClient, 'configured' | 'solve'>,
  declaredVersion: string | null,
  now: Date = new Date(),
): Promise<SolverProbeResult> {
  if (!client.configured) {
    await setSolverStatus(db, 'NOT_CONFIGURED', { reason: 'no-url' }, now);
    return { state: 'NOT_CONFIGURED', servicePerType: false, declaredVersion };
  }

  try {
    const solution = await client.solve(probeRequest());
    const service = solution.summary?.service ?? 0;
    const unassigned = solution.unassigned?.length ?? 0;

    if (unassigned !== 0) {
      // Пробная задача заведомо решаема. Неразмещённый заказ означает, что
      // сервис ведёт себя не так, как описано, и доверять ему нельзя.
      await setSolverStatus(db, 'ERROR', { reason: 'probe-unassigned', declaredVersion }, now);
      return { state: 'ERROR', servicePerType: false, declaredVersion };
    }

    if (service !== PROBE_SERVICE_SECONDS) {
      await setSolverStatus(
        db,
        'ERROR',
        { reason: 'service-per-type-unsupported', declaredVersion, service },
        now,
      );
      return { state: 'ERROR', servicePerType: false, declaredVersion };
    }

    await setSolverStatus(db, 'OK', { declaredVersion, servicePerType: true }, now);
    return { state: 'OK', servicePerType: true, declaredVersion };
  } catch (error) {
    const code = error instanceof VroomError ? error.code : 'TRANSPORT_ERROR';
    await setSolverStatus(db, 'DEGRADED', { code, declaredVersion }, now);
    return { state: 'DEGRADED', servicePerType: false, declaredVersion };
  }
}

/**
 * Ворота планирования.
 *
 * Проверка выполняется один раз на процесс и запоминается: гонять пробную
 * задачу перед каждым расчётом значило бы добавлять лишний запрос. Неудача
 * НЕ запоминается — решатель могли поднять, пока приложение работало.
 */
export function createSolverGate(deps: {
  db: Database;
  client: Pick<VroomClient, 'configured' | 'solve'>;
  declaredVersion: string | null;
  now?: () => Date;
}): { verifySolver: () => Promise<void>; reset: () => void } {
  let verified = false;

  return {
    reset() {
      verified = false;
    },
    async verifySolver() {
      if (verified) {
        return;
      }

      const clock = deps.now ?? ((): Date => new Date());
      const result = await probeSolver(deps.db, deps.client, deps.declaredVersion, clock());

      if (result.state !== 'OK') {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message: `solver is not verified: ${result.state}`,
          publicMessage:
            'Автоматическое планирование недоступно: решатель не подтверждён. ' +
            'Ручные маршруты продолжают работать.',
        });
      }

      verified = true;
    },
  };
}
