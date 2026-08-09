/**
 * Раздача картографических артефактов с нашего origin.
 *
 * Браузер получает стиль, шрифты, спрайты и PMTiles только отсюда. Публичные
 * серверы OSM, демонстрационные тайлы MapLibre, MapTiler и CDN Protomaps
 * не используются в работе ни при каких условиях: их условия не допускают
 * продуктовую нагрузку, а доступность никем не гарантирована.
 *
 * Отдаются ТОЛЬКО файлы, перечисленные в проверенном манифесте. Каталог
 * смонтирован на чтение, но одного этого мало: без белого списка любой файл,
 * случайно оказавшийся рядом, стал бы доступен по HTTP.
 *
 * Наружу сервис выводится обратным прокси по HTTPS. Отдельного порта здесь нет:
 * артефакты раздаёт то же приложение и тот же порт, поэтому происхождение
 * совпадает с интерфейсом само по себе, без правил CORS.
 */

import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { AppServer } from '../../../platform/http/types.js';
import { AppError } from '../../../platform/errors.js';
import type { BasemapState } from './manifest.js';
import { contentRange, parseRange, unsatisfiableContentRange } from './range.js';

/** Публичный префикс артефактов. Совпадает с адресами внутри стиля. */
export const BASEMAP_PREFIX = '/maps';

/**
 * Имена файлов содержат ревизию набора и не переиспользуются, поэтому кэшировать
 * их можно бессрочно. Новая сборка — новые имена, а не подмена содержимого.
 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export interface BasemapDeps {
  /** Текущее состояние набора. Проверяется при старте приложения. */
  state: () => BasemapState;
}

export async function registerBasemapRoutes(app: AppServer, deps: BasemapDeps): Promise<void> {
  app.get(`${BASEMAP_PREFIX}/*`, async (request, reply) => {
    const state = deps.state();
    if (!state.ok) {
      // Подложка не настроена или не совпала с манифестом. Никакого перехода
      // на внешний источник: интерфейс честно покажет «Карта не настроена».
      throw new AppError('NOT_FOUND', { message: 'basemap is not configured' });
    }

    const params = request.params as { '*'?: string };
    const requested = params['*'] ?? '';

    const artifact = state.artifacts.get(requested);
    if (artifact === undefined) {
      // Белый список манифеста — единственный источник истины о том,
      // что вообще существует по этому адресу.
      throw new AppError('NOT_FOUND', { message: 'artifact is not listed' });
    }

    const filePath = path.join(state.root, artifact.path);

    void reply.header('Content-Type', artifact.contentType);
    void reply.header('Cache-Control', IMMUTABLE_CACHE);
    // Без этого заголовка клиент PMTiles не станет запрашивать диапазоны
    // и потянет весь архив целиком.
    void reply.header('Accept-Ranges', 'bytes');
    // Артефакты не содержат персональных данных, но и рассказывать о себе
    // посторонним сайтам незачем.
    void reply.header('X-Content-Type-Options', 'nosniff');

    const range = parseRange(request.headers.range, artifact.bytes);

    if (range.kind === 'UNSATISFIABLE') {
      void reply.header('Content-Range', unsatisfiableContentRange(artifact.bytes));
      return reply.code(416).send();
    }

    if (range.kind === 'PARTIAL') {
      void reply.header('Content-Range', contentRange(range.start, range.end, artifact.bytes));
      void reply.header('Content-Length', String(range.length));
      return reply
        .code(206)
        .send(createReadStream(filePath, { start: range.start, end: range.end }));
    }

    void reply.header('Content-Length', String(artifact.bytes));
    return reply.code(200).send(createReadStream(filePath));
  });
}
