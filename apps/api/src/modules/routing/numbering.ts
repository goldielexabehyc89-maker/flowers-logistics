/**
 * Номер маршрута.
 *
 * Формат `R-YYYY-MM-DD-NNN`: дата маршрута и порядковый номер внутри дня.
 * Персональных данных не содержит, читается вслух и сортируется как текст.
 *
 * Выдача атомарна: один оператор `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * увеличивает счётчик дня и сразу возвращает новое значение, поэтому два
 * одновременных создания получают разные номера без внешней блокировки.
 * Сериализуются только маршруты одного дня.
 *
 * Счётчик обновляется В ТОЙ ЖЕ транзакции, что и создание маршрута: откат
 * создания откатывает и номер. Отдельной транзакции ради номера нет намеренно —
 * она оставляла бы «занятый» номер после каждой неудачной попытки.
 */

import type { TransactionClient } from '../auth/sessions.js';

interface CounterRow {
  lastNumber: number;
}

/**
 * Выдаёт следующий номер для календарной даты Москвы.
 *
 * `date` — строка `YYYY-MM-DD`: маршрут привязан к календарному дню, а не к моменту
 * времени, и часовой пояс здесь не участвует.
 */
export async function nextRouteNumber(tx: TransactionClient, date: string): Promise<string> {
  const rows = await tx.$queryRaw<CounterRow[]>`
    INSERT INTO "RouteNumberCounter" ("deliveryDate", "lastNumber", "updatedAt")
    VALUES (${date}::date, 1, NOW())
    ON CONFLICT ("deliveryDate")
      DO UPDATE SET "lastNumber" = "RouteNumberCounter"."lastNumber" + 1, "updatedAt" = NOW()
    RETURNING "lastNumber"
  `;

  const last = rows[0]?.lastNumber;
  if (last === undefined) {
    // Недостижимо при корректной схеме, но молчаливый номер «undefined»
    // попал бы в уникальное поле и сломал бы весь день.
    throw new Error('счётчик номеров маршрутов не вернул значение');
  }

  return formatRouteNumber(date, last);
}

/** `2026-08-07` + `3` → `R-2026-08-07-003`. */
export function formatRouteNumber(date: string, sequence: number): string {
  return `R-${date}-${String(sequence).padStart(3, '0')}`;
}
