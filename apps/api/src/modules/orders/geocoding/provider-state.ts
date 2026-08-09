/**
 * Общее состояние провайдера геокодирования.
 *
 * Всё, что относится к ключу целиком, а не к отдельному заданию, живёт здесь —
 * в базе, а не в памяти процесса. Причина простая: экземпляров приложения
 * несколько, они по очереди берут общий advisory-lock, и состояние внутри
 * объекта клиента не переживает передачу замка соседу.
 *
 * Отсюда три вещи:
 *   - минимальный интервал между началами запросов;
 *   - пауза после 429, относящаяся ко всему ключу;
 *   - полная остановка обращений при неверном ключе или отозванных правах.
 */

import type { Database } from '../../../platform/db.js';

export const PROVIDER_STATE_ID = 'dadata';

/** Минимальный интервал между началами запросов. Строже официального предела. */
export const MIN_REQUEST_INTERVAL_MS = 1000;

/** Пауза после 429 без корректного Retry-After. */
export const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Насколько долгое ожидание слота ещё имеет смысл выдерживать внутри прохода.
 *
 * Обычная пауза — около секунды. Ожидание в минуты означает действующий
 * cooldown: держать ради него advisory-lock и открытый проход нельзя,
 * проход обязан закончиться и уступить.
 */
export const MAX_INLINE_WAIT_MS = 5_000;

export interface ProviderState {
  nextRequestAllowedAt: Date;
  haltedReason: string | null;
  haltedAt: Date | null;
}

export async function readProviderState(db: Database): Promise<ProviderState> {
  const state = await db.geocodingProviderState.findUnique({
    where: { id: PROVIDER_STATE_ID },
    select: { nextRequestAllowedAt: true, haltedReason: true, haltedAt: true },
  });

  // Строку создаёт миграция. Её отсутствие означает незавершённое обновление
  // базы: безопаснее считать провайдера остановленным, чем начать обращения.
  return (
    state ?? {
      nextRequestAllowedAt: new Date(8640000000000000),
      haltedReason: 'STATE_MISSING',
      haltedAt: new Date(),
    }
  );
}

export interface SlotDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

export interface SlotReservation {
  /** Слот получен: запрос можно выполнять. */
  granted: boolean;
  /** Сколько пришлось бы ждать. Заполняется, когда слот не выдан. */
  waitMs: number;
}

/**
 * Резервирует право выполнить один запрос.
 *
 * Резервирование атомарно: одним `UPDATE … RETURNING` время следующего
 * разрешённого запроса сдвигается на интервал вперёд. Два процесса, выполнившие
 * его одновременно, получат разные слоты — второй окажется на секунду позже,
 * а не рядом с первым. Проверка «прочитать, сравнить, записать» здесь не годится:
 * между чтением и записью соседний процесс успел бы занять тот же слот.
 *
 * Слот выдаётся даже когда до него нужно немного подождать — тогда функция
 * дожидается его сама. Но если ждать пришлось бы долго (действует cooldown),
 * слот не выдаётся: держать ради этого проход открытым нельзя.
 */
export async function reserveRequestSlot(
  db: Database,
  deps: SlotDeps = {},
): Promise<SlotReservation> {
  const clock = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = deps.intervalMs ?? MIN_REQUEST_INTERVAL_MS;

  const now = clock();

  const rows = await db.$queryRaw<{ nextRequestAllowedAt: Date }[]>`
    UPDATE "GeocodingProviderState"
    SET "nextRequestAllowedAt" =
          GREATEST("nextRequestAllowedAt", ${now}) + (${intervalMs} || ' milliseconds')::interval,
        "updatedAt" = ${now}
    WHERE "id" = ${PROVIDER_STATE_ID}
      AND "haltedReason" IS NULL
    RETURNING "nextRequestAllowedAt"
  `;

  const row = rows[0];
  if (row === undefined) {
    // Строки нет либо провайдер остановлен: обращаться нельзя.
    return { granted: false, waitMs: Number.POSITIVE_INFINITY };
  }

  // `RETURNING` отдаёт новое значение; начало нашего слота — на интервал раньше.
  const startAt = row.nextRequestAllowedAt.getTime() - intervalMs;
  const waitMs = startAt - now.getTime();

  if (waitMs > MAX_INLINE_WAIT_MS) {
    return { granted: false, waitMs };
  }

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  return { granted: true, waitMs: Math.max(0, waitMs) };
}

/**
 * Останавливает обращения к провайдеру целиком.
 *
 * Неверный ключ и отозванные права сами не пройдут. Без общей отметки каждый
 * следующий проход и каждый соседний экземпляр выясняли бы это заново, тратя
 * обращения и время. Отметка снимается только при запуске приложения —
 * то есть после того, как человек исправил конфигурацию.
 */
export async function haltProvider(db: Database, reason: string, now: Date): Promise<void> {
  await db.geocodingProviderState.update({
    where: { id: PROVIDER_STATE_ID },
    data: { haltedReason: reason, haltedAt: now },
  });
}

/** Общая пауза после 429: она относится к ключу, а не к одному заказу. */
export async function startCooldown(db: Database, until: Date, now: Date): Promise<void> {
  await db.$executeRaw`
    UPDATE "GeocodingProviderState"
    SET "nextRequestAllowedAt" = GREATEST("nextRequestAllowedAt", ${until}),
        "updatedAt" = ${now}
    WHERE "id" = ${PROVIDER_STATE_ID}
  `;
}

/**
 * Снимает остановку при запуске приложения.
 *
 * Вызывается только там, где geocoding действительно включён: запуск с той же
 * неверной конфигурацией снова остановится после первого же отказа, и это
 * правильное поведение — оно стоит одного запроса, а не потока обращений.
 */
export async function clearHalt(db: Database): Promise<void> {
  await db.geocodingProviderState.updateMany({
    where: { id: PROVIDER_STATE_ID },
    data: { haltedReason: null, haltedAt: null },
  });
}
