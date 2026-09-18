/**
 * Отчёт «Касса логистов»: день → логист → операции.
 *
 * Остаток переносится между московскими днями: остаток на начало дня — это
 * сумма всех движений строго до него, а не «ноль в полночь». Итоги считает
 * сервер по полному отфильтрованному набору; страница нарезается по группам,
 * поэтому один логист за один день не делится между страницами.
 *
 * «Ожидается к сдаче» — расчётная величина, а не движение денег: она говорит,
 * сколько наличных сейчас числится за курьерами, и кассу не меняет.
 */

import type { Database } from '../../platform/db.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';
import { toCashView, type CashEntryView } from './cash.js';

export interface CashFilters {
  from: string;
  to: string;
  logistUserId?: string | undefined;
  kind?: string | undefined;
  search?: string | undefined;
  limit: number;
  offset: number;
  /** Кассы, доступные пользователю. `null` — все (администратор). */
  visibleLogistIds: string[] | null;
}

export interface CashGroup {
  logistUserId: string;
  fullName: string;
  phone: string | null;
  openingMinor: string;
  receivedMinor: string;
  takenMinor: string;
  issuedMinor: string;
  handedMinor: string;
  closingMinor: string;
  entries: CashEntryView[];
}

export interface CashDay {
  date: string;
  logists: CashGroup[];
}

export interface CashSummary {
  cashOnHandMinor: string;
  expectedFromCouriersMinor: string;
  receivedMinor: string;
  takenMinor: string;
  issuedMinor: string;
  handedMinor: string;
  closingMinor: string;
}

export interface CashReport {
  period: { from: string; to: string };
  summary: CashSummary;
  days: CashDay[];
  totalGroups: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Кассы, доступные текущему пользователю: список для фильтра. */
  /**
   * Кассы, доступные текущему пользователю: список для фильтра.
   *
   * `balanceMinor` — наличные СЕЙЧАС, `closingMinor` — остаток на конец
   * выбранного периода. Это разные числа, и подписи у них разные.
   */
  desks: {
    id: string;
    fullName: string;
    phone: string | null;
    balanceMinor: string;
    closingMinor: string;
  }[];
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Сумма движений одного вида.
 *
 * Отменённые записи не считаются: если сдачу отменили обратной операцией,
 * денег в кассе нет, и показывать их как «получено» значит противоречить
 * остатку. Сам остаток по-прежнему считается по ВСЕМ записям, включая
 * обратные, — история не переписывается.
 */
function sumOf(entries: readonly CashEntryView[], kinds: readonly string[]): bigint {
  return entries
    .filter((entry) => kinds.includes(entry.kind) && !entry.reversed)
    .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
}

/**
 * Поиск переводится в множество идентификаторов ДО выборки.
 *
 * Фильтровать загруженную страницу нельзя: операция со второй страницы
 * исчезала бы из поиска вовсе.
 */
async function idsBySearch(db: Database, search: string): Promise<string[]> {
  const value = search.trim();
  const users = await db.user.findMany({
    where: {
      OR: [{ fullName: { contains: value, mode: 'insensitive' } }, { phone: { contains: value } }],
    },
    select: { id: true },
    take: 200,
  });
  return users.map((user) => user.id);
}

export async function buildCashReport(db: Database, filters: CashFilters): Promise<CashReport> {
  const matched = filters.search === undefined ? null : await idsBySearch(db, filters.search);

  /*
   * Выбранная касса И граница видимости — ОБА условия, а не одно поверх другого.
   *
   * Прежде ключ `logistUserId` задавался в литерале дважды, и второй молча
   * затирал первый: у не-администратора выбор кассы не работал вовсе, а любое
   * расширение видимости показало бы вместо выбранной кассы все доступные.
   */
  const deskFilters = [
    ...(filters.logistUserId === undefined ? [] : [{ logistUserId: filters.logistUserId }]),
    ...(filters.visibleLogistIds === null
      ? []
      : [{ logistUserId: { in: filters.visibleLogistIds } }]),
  ];

  const where = {
    operationDate: { gte: toDateColumn(filters.from), lte: toDateColumn(filters.to) },
    ...(filters.kind === undefined ? {} : { kind: filters.kind as 'RECEIVED_FROM_COURIER' }),
    ...(deskFilters.length === 0 ? {} : { AND: deskFilters }),
    // Поиск ищет и по логисту, и по курьеру: человек помнит любого из двоих.
    ...(matched === null
      ? {}
      : { OR: [{ logistUserId: { in: matched } }, { courierUserId: { in: matched } }] }),
  };

  const rows = await db.logistCashEntry.findMany({
    where,
    orderBy: [{ operationDate: 'desc' }, { occurredAt: 'asc' }],
    select: {
      id: true,
      logistUserId: true,
      kind: true,
      amountMinor: true,
      operationDate: true,
      occurredAt: true,
      actorUserId: true,
      courierUserId: true,
      transferId: true,
      reason: true,
      reversesEntryId: true,
      actor: { select: { fullName: true } },
      courier: { select: { fullName: true } },
      reversedBy: { select: { id: true } },
    },
  });

  const entries = rows.map(toCashView);

  const logistIds = [...new Set(entries.map((entry) => entry.logistUserId))];
  const profiles = new Map(
    (
      await db.user.findMany({
        where: { id: { in: logistIds } },
        select: { id: true, fullName: true, phone: true },
      })
    ).map((user) => [user.id, user]),
  );

  /*
   * Остатки на начало дня.
   *
   * Считаются одним запросом на пару «логист + день»: касса непрерывна, и
   * первый день периода обязан начинаться с того, чем закончился прошлый.
   */
  const byDay = new Map<string, Map<string, CashEntryView[]>>();
  for (const entry of entries) {
    const logists = byDay.get(entry.operationDate) ?? new Map<string, CashEntryView[]>();
    byDay.set(entry.operationDate, logists);
    logists.set(entry.logistUserId, [...(logists.get(entry.logistUserId) ?? []), entry]);
  }

  const days: CashDay[] = [];
  for (const [date, logists] of byDay) {
    const groups: CashGroup[] = [];

    for (const [logistUserId, own] of logists) {
      /*
       * Остаток дня считается по ВСЕМ записям кассы, а не по показанным.
       *
       * Прежде конец дня складывался из отобранных операций: стоило выбрать
       * вид или строку поиска — и «конец» показывал остаток, которого никогда
       * не существовало. Отбор решает, ЧТО показать, а не сколько денег
       * в кассе.
       */
      const [opening, closing] = await Promise.all([
        db.logistCashEntry.aggregate({
          where: { logistUserId, operationDate: { lt: toDateColumn(date) } },
          _sum: { amountMinor: true },
        }),
        db.logistCashEntry.aggregate({
          where: { logistUserId, operationDate: { lte: toDateColumn(date) } },
          _sum: { amountMinor: true },
        }),
      ]);
      const openingMinor = opening._sum.amountMinor ?? 0n;
      const closingMinor = closing._sum.amountMinor ?? 0n;
      const profile = profiles.get(logistUserId);

      groups.push({
        logistUserId,
        fullName: profile?.fullName ?? 'Логист удалён из справочника',
        phone: profile?.phone ?? null,
        openingMinor: openingMinor.toString(),
        receivedMinor: abs(sumOf(own, ['RECEIVED_FROM_COURIER'])).toString(),
        takenMinor: abs(sumOf(own, ['TAKEN_FROM_COMPANY'])).toString(),
        issuedMinor: abs(sumOf(own, ['ISSUED_TO_COURIER'])).toString(),
        handedMinor: abs(sumOf(own, ['HANDED_TO_COMPANY'])).toString(),
        closingMinor: closingMinor.toString(),
        entries: own,
      });
    }

    days.push({
      date,
      logists: groups.sort((left, right) => left.fullName.localeCompare(right.fullName, 'ru')),
    });
  }

  days.sort((left, right) => right.date.localeCompare(left.date));

  // Страница режется по группам «день + логист».
  const flat = days.flatMap((day) => day.logists.map((group) => ({ date: day.date, group })));
  const slice = flat.slice(filters.offset, filters.offset + filters.limit);
  const pagedByDay = new Map<string, CashGroup[]>();
  for (const item of slice) {
    pagedByDay.set(item.date, [...(pagedByDay.get(item.date) ?? []), item.group]);
  }

  /*
   * Наличные во всех доступных кассах: не сумма периода, а остаток НА СЕЙЧАС.
   * Период фильтрует движения, но деньги в кассе от этого не исчезают.
   */
  /*
   * Кассы итога — те же, что в таблице.
   *
   * Выбранная касса сужает и итог: администратор, выбравший логиста, видел над
   * его таблицей сумму по всем кассам сразу. Граница видимости при этом
   * остаётся: чужую кассу выбрать нельзя.
   */
  const visibleIds = filters.visibleLogistIds ?? (await visibleDeskIds(db));
  const deskIds =
    filters.logistUserId === undefined
      ? visibleIds
      : visibleIds.filter((id) => id === filters.logistUserId);

  const [deskProfiles, balances, closings] = await Promise.all([
    db.user.findMany({
      where: { id: { in: deskIds } },
      select: { id: true, fullName: true, phone: true },
    }),
    /*
     * Итоги считаются ОДНИМ запросом на все кассы, а не тремя на каждую.
     * Выгрузки строят отчёт без постраничности, и при двух сотнях касс это
     * были сотни запросов ради одного числа.
     */
    db.logistCashEntry.groupBy({
      by: ['logistUserId'],
      where: { logistUserId: { in: deskIds } },
      _sum: { amountMinor: true },
    }),
    // Остаток НА КОНЕЦ ПЕРИОДА — отдельно от «сейчас»: отчёт за прошлый период
    // показывал бы сегодняшнее число под подписью «остаток на конец».
    db.logistCashEntry.groupBy({
      by: ['logistUserId'],
      where: { logistUserId: { in: deskIds }, operationDate: { lte: toDateColumn(filters.to) } },
      _sum: { amountMinor: true },
    }),
  ]);

  const profileById = new Map(deskProfiles.map((row) => [row.id, row]));
  const balanceById = new Map(
    balances.map((row) => [row.logistUserId, row._sum.amountMinor ?? 0n]),
  );
  const closingById = new Map(
    closings.map((row) => [row.logistUserId, row._sum.amountMinor ?? 0n]),
  );

  const desks = deskIds.map((id) => ({
    id,
    fullName: profileById.get(id)?.fullName ?? 'Логист удалён из справочника',
    phone: profileById.get(id)?.phone ?? null,
    balanceMinor: (balanceById.get(id) ?? 0n).toString(),
    closingMinor: (closingById.get(id) ?? 0n).toString(),
  }));

  /*
   * Ожидается к сдаче: сколько наличных сейчас числится за курьерами.
   *
   * Это остаток по учёту курьеров, а не движение кассы: пока деньги не
   * переданы, ни в одной кассе их нет.
   */
  /*
   * Сколько НАЛИЧНЫХ ещё числится за курьерами.
   *
   * Начальный долг сюда не входит: это долг до перехода на ERP, за которым
   * наличных не стоит вовсе, и его нельзя «сдать в кассу». Попав в этот
   * показатель, он навсегда разводил ожидаемую сдачу с тем, что логист
   * действительно может получить, — сверка не сошлась бы никогда.
   */
  const expected = await db.courierLedgerEntry.groupBy({
    by: ['courierUserId'],
    where: {
      operationDate: { lte: toDateColumn(filters.to) },
      /*
       * Исключается и САМ долг, и его отмена.
       *
       * У обратной записи собственный вид всегда `ADJUSTMENT`, поэтому отбор
       * по одному виду её не ловил: заведённый долг показатель не менял, а его
       * исправление — занижало ровно на ту же сумму. Правило «категория
       * обратной записи — категория отменяемой» здесь то же, что в отчёте.
       */
      NOT: {
        OR: [{ kind: 'OPENING_DEBT' }, { reversesEntry: { kind: 'OPENING_DEBT' } }],
      },
    },
    _sum: { amountMinor: true },
  });

  const summary: CashSummary = {
    cashOnHandMinor: desks
      .reduce((total, desk) => total + BigInt(desk.balanceMinor), 0n)
      .toString(),
    /*
     * Считается ПО КАЖДОМУ курьеру и складывается только положительное.
     *
     * Одной суммой отрицательный баланс одного курьера гасил наличные другого:
     * доплата, которую компания должна одному, обнуляла деньги, лежащие в
     * кармане у второго, — и показатель, ради которого логист открывает кассу,
     * занижался ровно на эту величину.
     */
    expectedFromCouriersMinor: expected
      .reduce((total, row) => {
        const value = row._sum.amountMinor ?? 0n;
        return value > 0n ? total + value : total;
      }, 0n)
      .toString(),
    receivedMinor: abs(sumOf(entries, ['RECEIVED_FROM_COURIER'])).toString(),
    takenMinor: abs(sumOf(entries, ['TAKEN_FROM_COMPANY'])).toString(),
    issuedMinor: abs(sumOf(entries, ['ISSUED_TO_COURIER'])).toString(),
    handedMinor: abs(sumOf(entries, ['HANDED_TO_COMPANY'])).toString(),
    // Остаток на конец ПЕРИОДА, а не сегодняшний: см. выше.
    closingMinor: desks.reduce((total, desk) => total + BigInt(desk.closingMinor), 0n).toString(),
  };

  return {
    period: { from: filters.from, to: filters.to },
    summary,
    days: [...pagedByDay.entries()].map(([date, logists]) => ({ date, logists })),
    totalGroups: flat.length,
    limit: filters.limit,
    offset: filters.offset,
    hasMore: filters.offset + slice.length < flat.length,
    desks,
  };
}

/** Все логисты системы: у каждого своя касса. */
export async function visibleDeskIds(db: Database): Promise<string[]> {
  const users = await db.user.findMany({
    where: { roles: { some: { role: 'LOGISTICIAN' } }, status: 'ACTIVE' },
    select: { id: true },
    take: 200,
  });

  /*
   * Кассы с деньгами не исчезают вместе с кадровым решением.
   *
   * Список действующих логистов отвечает на вопрос «кому можно провести
   * операцию». Но деньги в кассе замороженного или снятого с роли человека
   * физически существуют, и итог, который их не считает, расходится с
   * таблицей на том же экране: движения видны, а суммы в них нет.
   */
  const withMoney = await db.logistCashEntry.groupBy({
    by: ['logistUserId'],
    _sum: { amountMinor: true },
  });
  const nonEmpty = withMoney
    .filter((row) => (row._sum.amountMinor ?? 0n) !== 0n)
    .map((row) => row.logistUserId);

  return [...new Set([...users.map((user) => user.id), ...nonEmpty])];
}
