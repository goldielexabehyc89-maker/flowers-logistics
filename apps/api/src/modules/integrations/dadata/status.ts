/**
 * Состояние интеграции подсказок адреса.
 *
 * Отдельный provider `dadata` и только про Suggestions. Clean API в проекте
 * нет, второй ключ не хранится, и эта запись о них ничего не сообщает.
 *
 * Зачем понадобилась. Строку `dadata` когда-то создала миграция, а писавший её
 * код позже переименовали в `photon`. Запись осталась сиротой: панель
 * интеграций годами показывала «Не настроена», пока подсказки работали. Отчёт
 * о состоянии, который расходится с фактом, хуже отсутствующего — по нему
 * принимают решения.
 *
 * Поэтому статус пишется по ФАКТУ обращения: успешная выдача подсказок ставит
 * `OK`, отказ провайдера — `ERROR`, а при старте состояние берётся из
 * конфигурации. Разойтись с действительностью он больше не может.
 *
 * В `details` попадают только коды и числа. Ни ключа, ни запроса, ни адреса,
 * ни ответа провайдера здесь нет и быть не может: `state` виден вообще без
 * авторизации.
 */

import type { $Enums } from '../../../generated/prisma/client.js';
import type { Database } from '../../../platform/db.js';

export const SUGGESTIONS_PROVIDER = 'dadata';

export type SuggestionsState = 'NOT_CONFIGURED' | 'CONFIGURED' | 'OK' | 'ERROR';

/** Значения деталей: только безопасные примитивы. */
export type SuggestionsDetails = Record<string, string | number | boolean | null>;

export async function setSuggestionsStatus(
  db: Database,
  state: SuggestionsState,
  details: SuggestionsDetails,
  now: Date = new Date(),
): Promise<void> {
  await db.integrationStatus.upsert({
    where: { provider: SUGGESTIONS_PROVIDER },
    create: {
      provider: SUGGESTIONS_PROVIDER,
      state: state as $Enums.IntegrationState,
      pendingOperations: 0,
      details,
      lastOkAt: state === 'OK' ? now : null,
      lastErrorAt: state === 'ERROR' ? now : null,
    },
    update: {
      state: state as $Enums.IntegrationState,
      details,
      ...(state === 'OK' ? { lastOkAt: now } : {}),
      ...(state === 'ERROR' ? { lastErrorAt: now } : {}),
    },
  });
}

/**
 * Состояние при старте приложения.
 *
 * `CONFIGURED` — ключ есть и окружение разрешает обращаться, но подсказок ещё
 * никто не запрашивал. Выдавать `OK` авансом нельзя: работоспособность
 * доказывает только настоящий ответ.
 */
export async function reportSuggestionsStartupStatus(
  db: Database,
  config: { allowed: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (!config.allowed) {
    await setSuggestionsStatus(db, 'NOT_CONFIGURED', { reason: 'no-key-or-environment' }, now);
    return;
  }
  await setSuggestionsStatus(db, 'CONFIGURED', { reason: 'starting' }, now);
}
