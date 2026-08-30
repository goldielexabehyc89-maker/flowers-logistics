/**
 * Владение календарными месяцами в общей критической тестовой базе.
 *
 * Критические файлы выполняются последовательно, но пишут в ОДНУ базу и ничего
 * за собой не убирают: `DeliveryOrder` защищён триггером и физически не
 * удаляется. Заказ, созданный одним файлом, остаётся видимым всем последующим,
 * и любая выборка «по дате доставки» возвращает вместе со своими строками
 * чужие.
 *
 * Именно так ломался сценарий планирования: `lifecycle.critical.test.ts`
 * оставлял на `2026-12-10` заказы без подтверждённой точки, планирование на ту
 * же дату забирало их вместе со своими, и `assertOrdersArePlannable` честно
 * отвечал «order is not plannable». Отказ воспроизводился при порядке
 * `lifecycle → planning` и исчезал при обратном — то есть тест доказывал
 * не поведение планирования, а порядок запуска файлов.
 *
 * ДОГОВОР: бронируется месяц, а не день.
 *
 * Файл, который выбирает заказы по дате, резервирует целый календарный месяц.
 * Ни один другой критический файл не вправе создать заказ с датой доставки
 * внутри чужого месяца. Брони по одному дню не хватило бы: следующий сценарий
 * добавляет соседнюю дату, и однажды она совпадает с чужой. Месяц оставляет
 * запас и делает нарушение видимым сразу.
 *
 * Месяцы, никем не забронированные, остаются общими — там живут проверки
 * разбора календаря (високосные годы, границы месяцев, заведомо несуществующие
 * даты), которым важно само значение даты. Файлы, которые там пишут, выборок
 * по дате не делают. Если такой файл однажды начнёт выбирать заказы по дате,
 * он обязан забронировать себе месяц — иначе повторится ровно тот же отказ.
 *
 * Договор проверяется механически (`test-days.critical.test.ts`): проверка
 * читает исходники критических тестов и падает, если файл использовал дату
 * доставки в чужом месяце. Соблюдать его по памяти не требуется.
 */

import { isCalendarDate } from '../../modules/integrations/moysklad/delivery-date.js';

/** Месяц в виде `ГГГГ-ММ`. */
export type ReservedMonth = string;

/** Файл и день, который он использует как дату доставки. */
export interface DayUsage {
  /** Путь от корня репозитория. */
  file: string;
  /** Дата в виде `ГГГГ-ММ-ДД`. */
  day: string;
}

export interface MonthConflict {
  month: ReservedMonth;
  owners: string[];
}

export interface OwnershipViolation {
  file: string;
  day: string;
  owner: string;
}

/**
 * Кто какими месяцами владеет.
 *
 * Ключ — путь файла от корня репозитория, значение — забронированные месяцы.
 * Броня нужна файлам, которые выбирают заказы по дате доставки: планирование
 * планирует день целиком, маршрутизация и геосценарии группируют заказы днями.
 */
export const RESERVED_MONTHS: Readonly<Record<string, readonly ReservedMonth[]>> = Object.freeze({
  'apps/api/src/modules/routing/routing.critical.test.ts': Object.freeze(['2026-11']),
  'apps/api/src/modules/planning/planning.critical.test.ts': Object.freeze(['2026-12']),
  'apps/api/src/modules/routing/lifecycle.critical.test.ts': Object.freeze(['2027-01']),
  'apps/api/src/modules/orders/geo.critical.test.ts': Object.freeze(['2027-02']),
  'apps/api/src/modules/fulfillment/florist.critical.test.ts': Object.freeze(['2027-03']),
  'apps/api/src/modules/fulfillment/pickup-priority.critical.test.ts': Object.freeze(['2028-09']),
  'apps/api/src/modules/orders/order-timeline.critical.test.ts': Object.freeze(['2028-10']),
  'apps/api/src/modules/orders/structured-address.critical.test.ts': Object.freeze(['2028-11']),
  'apps/api/src/modules/integrations/moysklad/import-cutoff.critical.test.ts': Object.freeze([
    '2028-12',
  ]),
  'apps/api/src/modules/pickup/pickup.critical.test.ts': Object.freeze(['2027-06']),
  'apps/api/src/modules/pickup/pickup-queue.critical.test.ts': Object.freeze(['2028-08']),
  'apps/api/src/modules/orders/deals-scope.critical.test.ts': Object.freeze(['2027-09']),
  'apps/api/src/modules/routing/selection.critical.test.ts': Object.freeze(['2027-10']),
  'apps/api/src/modules/finance/finance.critical.test.ts': Object.freeze(['2028-04']),
  'apps/api/src/modules/finance/finance-recompute.critical.test.ts': Object.freeze(['2030-06']),
  'apps/api/src/modules/finance/cash.critical.test.ts': Object.freeze(['2028-05']),
  'apps/api/src/modules/integrations/moysklad/state-sync.critical.test.ts': Object.freeze([
    '2028-07',
  ]),
});

/** Месяц даты `ГГГГ-ММ-ДД`. */
export function monthOf(day: string): ReservedMonth {
  return day.slice(0, 7);
}

/**
 * Месяцы, забронированные более чем одним файлом.
 *
 * Чистая функция: доказать, что проверка ловит пересечение, можно на выдуманном
 * реестре, не ломая настоящий.
 */
export function monthConflicts(
  reserved: Readonly<Record<string, readonly ReservedMonth[]>> = RESERVED_MONTHS,
): MonthConflict[] {
  const owners = new Map<ReservedMonth, string[]>();

  for (const [file, months] of Object.entries(reserved)) {
    for (const month of months) {
      owners.set(month, [...(owners.get(month) ?? []), file]);
    }
  }

  return [...owners.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([month, files]) => ({ month, owners: [...files].sort() }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Использование чужого забронированного месяца. */
export function ownershipViolations(
  usage: readonly DayUsage[],
  reserved: Readonly<Record<string, readonly ReservedMonth[]>> = RESERVED_MONTHS,
): OwnershipViolation[] {
  const ownerOf = new Map<ReservedMonth, string>();
  for (const [file, months] of Object.entries(reserved)) {
    for (const month of months) {
      ownerOf.set(month, file);
    }
  }

  const violations: OwnershipViolation[] = [];
  for (const { file, day } of usage) {
    const owner = ownerOf.get(monthOf(day));
    if (owner !== undefined && owner !== file) {
      violations.push({ file, day, owner });
    }
  }
  return violations;
}

/**
 * Брони, которыми никто не пользуется.
 *
 * Реестр, разошедшийся с действительностью, перестаёт быть договором: месяц
 * числится занятым, хотя владелец давно переехал, и настоящее пересечение
 * прячется за ложным спокойствием.
 */
export function unusedReservations(
  usage: readonly DayUsage[],
  reserved: Readonly<Record<string, readonly ReservedMonth[]>> = RESERVED_MONTHS,
): { file: string; month: ReservedMonth }[] {
  const used = new Set(usage.map((item) => `${item.file}|${monthOf(item.day)}`));

  return Object.entries(reserved)
    .flatMap(([file, months]) => months.map((month) => ({ file, month })))
    .filter((item) => !used.has(`${item.file}|${item.month}`));
}

/**
 * Даты доставки, найденные в тексте критического теста.
 *
 * Разбор намеренно грубый и построчный: он ищет ровно те места, где дата
 * становится датой доставки заказа. Это либо литерал в поле снимка
 * (`deliveryPlannedMoment`, `deliveryDate`), либо константа дня, из которой
 * такое поле собирается шаблонной строкой.
 *
 * Прочие даты в тексте — момент «сейчас», курсор синхронизации, время
 * изменения — датой доставки не являются и в разбор не попадают: правило
 * должно ловить настоящие пересечения, а не всякое упоминание года.
 *
 * Несуществующие даты (`2026-02-30`, `2025-02-29`) отбрасываются той же
 * функцией, которой пользуется импорт. Такой день колонкой `deliveryDate`
 * не становится ни при каких условиях, заказа в общей базе за собой не
 * оставляет и потому ничьей территорией быть не может: два файла вправе
 * проверять разбор одного и того же несуществующего дня.
 */
const DATE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const DELIVERY_FIELD = /deliveryPlannedMoment|deliveryDate/;
const DAY_CONSTANT = /\b(?:const|let)\s+[A-Za-z_]*(?:DAY|Day|day)[A-Za-z_]*\s*(?::[^=]+)?=\s*'/;

export function deliveryDaysIn(source: string): string[] {
  const days = new Set<string>();

  for (const line of source.split('\n')) {
    if (!DELIVERY_FIELD.test(line) && !DAY_CONSTANT.test(line)) {
      continue;
    }
    for (const match of line.matchAll(DATE)) {
      const day = match[1] as string;
      if (isCalendarDate(day)) {
        days.add(day);
      }
    }
  }

  return [...days].sort();
}
