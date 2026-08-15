/**
 * Подменный решатель и подменная матрица для проверочного окружения.
 *
 * ЧЕСТНО О ГРАНИЦЕ. Это не оптимизатор. Он раскладывает заказы по машинам
 * подряд, пока хватает вместимости, а остаток отправляет в неразмещённые.
 * Качество маршрута здесь не считается и считаться не может.
 *
 * Зачем он существует. Браузерная приёмка обязана проходить через настоящий
 * серверный контракт: постановку запуска, ожидание, превью и применение.
 * Раньше она подменяла сам HTTP-ответ в браузере — и потому оставалась зелёной,
 * когда клиент обращался к несуществующему адресу и слал неверное поле.
 * Настоящий расчёт требует дорожного графа Valhalla и VROOM: это гигабайты
 * и отдельные сервисы, которых в проверке нет. Подменяются ровно два внешних
 * сервиса, а весь путь приложения остаётся настоящим.
 *
 * Fail closed. Включается только явным флагом и только в локальном окружении;
 * конфигурация отвергает флаг где угодно ещё. Выдуманный план на staging или
 * в production выглядел бы как посчитанный.
 */

import type { LatLon, MatrixElement } from '../integrations/valhalla/client.js';
import type { VroomRequest, VroomSolution } from '../integrations/vroom/client.js';

/** Постоянные значения подменной матрицы. Ровные числа видно в отчёте. */
const LEG_SECONDS = 60;
const LEG_METERS = 1000;

/**
 * Матрица, в которой все пары достижимы.
 *
 * `null` в настоящей матрице останавливает расчёт целиком, и подделка обязана
 * такого значения не выдавать: иначе проверялся бы путь отказа, а не путь
 * расчёта.
 */
export function testMatrix(): {
  verifyGraph: () => Promise<void>;
  matrix: (points: readonly LatLon[]) => Promise<(MatrixElement | null)[][]>;
} {
  return {
    async verifyGraph() {
      return undefined;
    },
    async matrix(points: readonly LatLon[]): Promise<(MatrixElement | null)[][]> {
      return points.map((_, from) =>
        points.map((__, to) =>
          from === to
            ? { timeSeconds: 0, distanceMeters: 0 }
            : { timeSeconds: LEG_SECONDS, distanceMeters: LEG_METERS },
        ),
      );
    },
  };
}

/**
 * Решатель, раскладывающий заказы по машинам подряд.
 *
 * Вместимость соблюдается: сервер проверяет ответ решателя как точное
 * разбиение и отвергает превышение. Поэтому лишние заказы честно уходят
 * в неразмещённые — ровно так же, как это сделал бы настоящий VROOM
 * при нехватке мест.
 */
export function testSolver(): {
  configured: boolean;
  solve: (r: VroomRequest) => Promise<VroomSolution>;
} {
  return {
    configured: true,
    async solve(request: VroomRequest): Promise<VroomSolution> {
      const jobs = [...request.jobs];
      const routes: VroomSolution['routes'] = [];
      let cursor = 0;

      for (const vehicle of request.vehicles) {
        const capacity = vehicle.capacity?.[0] ?? 0;
        const taken = jobs.slice(cursor, cursor + capacity);
        cursor += taken.length;

        if (taken.length === 0) {
          continue;
        }

        const at = vehicle.time_window[0];
        routes.push({
          vehicle: vehicle.id,
          steps: [
            // Маршрут обязан начинаться и заканчиваться на складе: сервер
            // проверяет форму ответа и отвергает любую другую.
            { type: 'start', arrival: at },
            ...taken.map((job) => ({
              type: 'job',
              id: job.id,
              arrival: at,
              // Раннее прибытие к окну доставки настоящий VROOM сообщает
              // ожиданием. Подделка обязана вести себя так же, иначе
              // проверялся бы ответ, которого не бывает.
              waiting_time: Math.max(0, (job.time_windows?.[0]?.[0] ?? at) - at),
            })),
            { type: 'end', arrival: at },
          ],
          duration: LEG_SECONDS * (taken.length + 1),
          service: taken.reduce((sum, job) => sum + (job.service ?? 0), 0),
          distance: LEG_METERS * (taken.length + 1),
        });
      }

      const unassigned = jobs.slice(cursor).map((job) => ({ id: job.id, type: 'capacity' }));

      return {
        code: 0,
        summary: {
          routes: routes.length,
          unassigned: unassigned.length,
          duration: routes.reduce((sum, route) => sum + (route.duration ?? 0), 0),
          service: routes.reduce((sum, route) => sum + (route.service ?? 0), 0),
          distance: routes.reduce((sum, route) => sum + (route.distance ?? 0), 0),
        },
        routes,
        unassigned,
      };
    },
  };
}
