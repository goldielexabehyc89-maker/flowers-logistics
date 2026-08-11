/**
 * Чтение назначенных ролей, устойчивое к неизвестным значениям.
 *
 * ЗАЧЕМ ЭТО СУЩЕСТВУЕТ.
 *
 * `Role` — перечисление PostgreSQL, а сгенерированный клиент Prisma знает ровно
 * те значения, которые были в схеме на момент генерации. Если версия приложения
 * старше базы и в `UserRoleAssignment` появилась строка с более новым значением,
 * любая выборка, которая пытается его разобрать, падает целиком:
 *
 *     PrismaClientKnownRequestError P2023: Value 'FLORIST' not found in enum 'Role'
 *
 * Падает не одна строка, а весь запрос. Один сотрудник с новой ролью выключил бы
 * администратору список пользователей, а не показался бы в нём непонятной строкой.
 * Проверено фактически на предыдущей версии приложения, не выведено из документации.
 *
 * Удалить значение из перечисления PostgreSQL нельзя, поэтому обратной миграции
 * у расширения enum не существует. Единственная защита — читать роли так, чтобы
 * неизвестное значение не доходило до десериализации.
 *
 * КАК.
 *
 * Роль читается как ТЕКСТ (`role::text`) и здесь же делится на две части:
 * известные этой версии роли и признак наличия неизвестных. Наружу уходит только
 * признак: само значение — имя из будущей версии, и ни журналу, ни клиенту оно
 * не нужно.
 *
 * Слой намеренно один. Разбросанные по модулям raw-запросы разошлись бы, и первый
 * же забытый `roles: { select: { role: true } }` вернул бы `P2023` в неожиданном
 * месте. Все продуктовые чтения ролей идут сюда.
 *
 * FAIL CLOSED.
 *
 * Неизвестная роль никогда не превращается в известную и никогда не даёт прав.
 * Но и «не существует» она тоже не значит: пользователь с ней считается
 * защищённым от управления логистом, а операции, способные переписать набор
 * ролей, обязаны отказывать (см. `modules/users/service.ts`).
 */

import { ROLES, type Role } from '@fl/shared';
import { Prisma } from '../generated/prisma/client.js';

/** Минимум, который нужен слою: обычный клиент и клиент транзакции подходят оба. */
export interface RoleReader {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface RoleAssignments {
  /** Роли, известные ЭТОЙ версии приложения. Только они дают права. */
  known: Role[];
  /**
   * Есть ли у пользователя роли, которых эта версия не знает.
   *
   * Наружу отдаётся именно признак, а не значения: имя роли из будущей версии
   * ничего не объясняет пользователю и не должно попадать в журналы и ответы.
   */
  hasUnsupportedRoles: boolean;
}

const KNOWN: ReadonlySet<string> = new Set<string>(ROLES);

export const EMPTY_ASSIGNMENTS: RoleAssignments = Object.freeze({
  known: Object.freeze([]) as unknown as Role[],
  hasUnsupportedRoles: false,
});

/**
 * Делит список текстовых значений на известные и неизвестные.
 *
 * Чистая функция: правило проверяется тестом без базы, а порядок известных ролей
 * сохраняется таким, каким его вернул запрос.
 */
export function splitRoleValues(values: readonly string[]): RoleAssignments {
  const known: Role[] = [];
  let unsupported = false;

  for (const value of values) {
    if (KNOWN.has(value)) {
      known.push(value as Role);
    } else {
      unsupported = true;
    }
  }

  return { known, hasUnsupportedRoles: unsupported };
}

interface Row {
  userId: string;
  role: string;
}

/**
 * Назначения ролей для набора пользователей.
 *
 * Пользователь без единой строки назначения в результат не попадает: вызывающий
 * код подставляет `EMPTY_ASSIGNMENTS`. Так «нет ролей» и «не нашли пользователя»
 * не сливаются в одно значение.
 */
export async function readRoleAssignments(
  client: RoleReader,
  userIds: readonly string[],
): Promise<Map<string, RoleAssignments>> {
  const unique = [...new Set(userIds)];
  const result = new Map<string, RoleAssignments>();

  if (unique.length === 0) {
    return result;
  }

  const list = Prisma.join(unique.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await client.$queryRaw<Row[]>`
    SELECT "userId"::text AS "userId", "role"::text AS "role"
    FROM "UserRoleAssignment"
    WHERE "userId" IN (${list})
    ORDER BY "userId", "role"
  `;

  const collected = new Map<string, string[]>();
  for (const row of rows) {
    collected.set(row.userId, [...(collected.get(row.userId) ?? []), row.role]);
  }

  for (const [userId, values] of collected) {
    result.set(userId, splitRoleValues(values));
  }

  return result;
}

/** Назначения ролей одного пользователя. */
export async function readRoleAssignment(
  client: RoleReader,
  userId: string,
): Promise<RoleAssignments> {
  const map = await readRoleAssignments(client, [userId]);
  return map.get(userId) ?? EMPTY_ASSIGNMENTS;
}
