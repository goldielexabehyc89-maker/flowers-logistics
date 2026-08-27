/**
 * Очередь печати бланков.
 *
 * ПОВТОР НЕ ПЕРЕСОБИРАЕТ ДОКУМЕНТ. Повторная печать создаёт НОВОЕ задание по
 * ТОМУ ЖЕ неизменяемому снимку и той же версии шаблона (`FUL-002` §2.8). Если
 * бы повтор строился из живого заказа, к букету оказался бы приложен бланк,
 * которого никто не собирал, — причём под тем же номером.
 *
 * СКАЧИВАНИЕ НЕ ЕСТЬ ПЕЧАТЬ. Получение PDF ничего не меняет: состояние задания
 * переводит только явная отметка человека. В этом срезе Windows-службы
 * бездиалоговой печати нет, и ручная отметка — штатный путь MVP, а не ошибка.
 *
 * СОСТОЯНИЕ «СОБРАН» ОТ ПЕЧАТИ НЕ ЗАВИСИТ. Ни повтор, ни ошибка принтера
 * не откатывают готовность заказа: бумага — отдельная сущность.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import { writeAudit } from '../audit/service.js';
import { nextPrintAttempt, publishPrintEvent } from './assembly.js';
import {
  printFormFileName,
  renderPrintFormPdf,
  renderThermalLabelPdf,
  thermalLabelFileName,
} from './pdf.js';
import { normalizePageRequest, pageInfo, type PageInfo, type PageRequest } from './paging.js';
import type { PrintFormSnapshot } from './print-form.js';
import type { RequestContext } from './shifts.js';

export interface PrintActor {
  userId: string;
  roles: readonly Role[];
}

export interface PrintJobView {
  id: string;
  orderId: string;
  /** Номер заказа: человеческий ключ всех производственных экранов. */
  orderNumber: string;
  printFormId: string;
  state: string;
  attempt: number;
  createdAt: string;
  completedAt: string | null;
  completedById: string | null;
  /** Короткий безопасный код: ни состава, ни PII. */
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  /**
   * Как идёт автоматическая доставка наклейки на принтер.
   *
   * `null` — доставки нет: задание создано вне смены с выбранной точкой либо
   * до появления печати вовсе. Такие задания печатаются руками, как раньше.
   */
  deliveryState: string | null;
  printPointId: string | null;
  sentAt: string | null;
}

const JOB_SELECT = {
  id: true,
  orderId: true,
  printFormId: true,
  state: true,
  attempt: true,
  createdAt: true,
  completedAt: true,
  completedById: true,
  lastErrorCode: true,
  lastErrorAt: true,
  deliveryState: true,
  printPointId: true,
  sentAt: true,
  order: { select: { externalName: true } },
} as const;

interface JobRow {
  id: string;
  orderId: string;
  printFormId: string;
  state: string;
  attempt: number;
  createdAt: Date;
  completedAt: Date | null;
  completedById: string | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  deliveryState: string | null;
  printPointId: string | null;
  sentAt: Date | null;
  order: { externalName: string };
}

function toView(job: JobRow): PrintJobView {
  return {
    id: job.id,
    orderId: job.orderId,
    orderNumber: job.order.externalName,
    printFormId: job.printFormId,
    state: job.state,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt === null ? null : job.completedAt.toISOString(),
    completedById: job.completedById,
    lastErrorCode: job.lastErrorCode,
    lastErrorAt: job.lastErrorAt === null ? null : job.lastErrorAt.toISOString(),
    deliveryState: job.deliveryState,
    printPointId: job.printPointId,
    sentAt: job.sentAt === null ? null : job.sentAt.toISOString(),
  };
}

/** Что показывает вкладка «Печать». */
export type PrintFilter = 'attention' | 'printed' | 'all';

export interface PrintJobPage extends PageInfo {
  items: PrintJobView[];
}

/**
 * Очередь заданий.
 *
 * По умолчанию — только требующие внимания: ожидающие и ошибки. История
 * успешно напечатанных открывается отдельным фильтром, чтобы рабочий список
 * не превращался в архив (`FUL-002` §2.8).
 *
 * СТРАНИЦЫ ЧЕСТНЫЕ ДЛЯ ЛЮБОГО ФИЛЬТРА. Прежняя версия молча отдавала первые
 * 50 строк и ничем не отличала «заданий ровно столько» от «остальные не
 * показаны». За сотней заданий это означало, что ошибка печати, случившаяся
 * раньше других, становилась недостижимой: ни повторить, ни отметить вручную
 * её было нельзя. Теперь ответ несёт `total` и `hasMore`, и продолжение
 * доступно при каждом фильтре.
 *
 * Срез здесь делает база, и это не противоречит правилу «сначала порядок»:
 * порядок заданий полный и выражается самой базой — время создания с добором
 * по идентификатору, — поэтому `skip`/`take` дают ровно ту же страницу, что и
 * срез в памяти. Группового правила, как у очереди сборки, тут нет.
 */
/**
 * Окно «Общих» заданий: двое суток скользящим окном.
 *
 * Без границы «общий» список превратился бы в архив за всё время: печать
 * недельной давности уже никого не касается, а листать её приходится
 * каждому. Двое суток покрывают вчерашнюю смену и сегодняшнюю — ровно то,
 * что человек ещё может доделать руками.
 */
export const GENERAL_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function listPrintJobs(
  db: Database,
  input: {
    filter: PrintFilter;
    /**
     * Показывать задания всех флористов и рабочих мест.
     *
     * Выключено — свои: те заказы, что закреплены за этим человеком. Иначе
     * флорист разбирает чужую печать вместо своей. Включено — общие, но
     * только за последние двое суток.
     */
    general?: boolean;
    /** Кто спрашивает. Нужен ровно для отбора «своих». */
    actorUserId: string;
    now?: Date;
  } & Partial<PageRequest>,
): Promise<PrintJobPage> {
  const states =
    input.filter === 'attention'
      ? (['PENDING', 'ERROR'] as const)
      : input.filter === 'printed'
        ? (['PRINTED'] as const)
        : (['PENDING', 'ERROR', 'PRINTED'] as const);

  const page = normalizePageRequest(input);
  const general = input.general === true;
  const now = input.now ?? new Date();

  /*
   * Отбор считает СЕРВЕР.
   *
   * И «свои», и окно двух суток — часть запроса, а не фильтр загруженной
   * страницы: иначе на второй странице оказалось бы совсем другое множество,
   * а счётчик врал бы о размере списка.
   */
  const where = {
    state: { in: [...states] },
    /*
     * Уже переданное принтеру внимания не требует.
     *
     * Бланк по-прежнему ждёт отметки человека — состояние `PENDING` остаётся
     * честным, — но наклейка ушла на печать сама, и держать такое задание
     * в рабочем списке значит наполнить его тем, с чем делать нечего.
     */
    ...(input.filter === 'attention' ? { NOT: { deliveryState: 'SENT_TO_PRINTER' as const } } : {}),
    ...(general
      ? { createdAt: { gte: new Date(now.getTime() - GENERAL_WINDOW_MS) } }
      : { order: { fulfillmentAssigneeId: input.actorUserId } }),
  };

  // Счёт и страница читаются одним запросом к пулу: разница между ними
  // возможна только при одновременной печати, и клиент в этом случае
  // перезапрашивает первую страницу по событию realtime.
  const [total, rows] = await Promise.all([
    db.orderPrintJob.count({ where }),
    db.orderPrintJob.findMany({
      where,
      // Устойчивый добор по идентификатору обязателен: без него две записи
      // с одинаковым временем создания могли бы попасть на две страницы сразу
      // или не попасть ни на одну.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.limit,
      select: JOB_SELECT,
    }) as Promise<JobRow[]>,
  ]);

  const items = rows.map(toView);
  return { items, ...pageInfo(page, total, items.length) };
}

async function readJob(db: Database, jobId: string): Promise<JobRow> {
  const job = (await db.orderPrintJob.findUnique({
    where: { id: jobId },
    select: JOB_SELECT,
  })) as JobRow | null;

  if (job === null) {
    throw new AppError('NOT_FOUND', { message: 'print job not found' });
  }
  return job;
}

/**
 * Повторная печать.
 *
 * Создаётся новое задание с ТЕМ ЖЕ `printFormId`, что у исходного, — даже если
 * у заказа успела появиться более новая форма после пересборки: повторяют
 * конкретный документ, а не «последний бланк заказа».
 *
 * Номер попытки выдаёт общий счётчик под блокировкой строки заказа. Прежняя
 * версия читала максимум без блокировки, и два одновременных повтора выбирали
 * один номер: один из них падал сырой ошибкой уникальности, то есть 500 вместо
 * понятного результата.
 */
export async function retryPrint(
  db: Database,
  actor: PrintActor,
  jobId: string,
  context: RequestContext,
): Promise<PrintJobView> {
  const source = await readJob(db, jobId);

  const created = await db.$transaction(async (tx) => {
    const attempt = await nextPrintAttempt(tx, source.orderId);

    /*
     * Повтор печатается на ТЕКУЩЕЙ точке, а не на точке исходного задания.
     *
     * Человек, нажимающий «Повторить печать», стоит у своего принтера сейчас.
     * Отправить наклейку на прошлую точку значило бы напечатать её там, где
     * никого нет, — а исходное задание могло быть создано и вчера.
     *
     * Точка берётся из активной смены. Её нет (администратор, смена без
     * точки) — повтор остаётся ручным, как и раньше.
     */
    const shift = await tx.floristShift.findUnique({
      where: { activeKey: actor.userId },
      select: { printPointId: true },
    });
    const printPointId = shift?.printPointId ?? null;

    const job = await tx.orderPrintJob.create({
      data: {
        orderId: source.orderId,
        // Тот же снимок и та же версия шаблона: документ обязан быть тем же.
        printFormId: source.printFormId,
        attempt,
        state: 'PENDING',
        printPointId,
        deliveryState: printPointId === null ? null : 'QUEUED',
      },
      select: JOB_SELECT,
    });

    await writeAudit(tx, {
      action: 'ORDER_PRINT_JOB_RETRIED',
      entityType: 'OrderPrintJob',
      entityId: job.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: {
        orderId: source.orderId,
        printFormId: source.printFormId,
        attempt: job.attempt,
        retriedFromJobId: source.id,
        automatic: printPointId !== null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishPrintEvent(tx, job.id, source.orderId, 'RETRIED');

    return job as JobRow;
  });

  return toView(created);
}

/**
 * Ручная отметка «Напечатано».
 *
 * Меняет ТОЛЬКО состояние печати. Складской приёмкой это не является:
 * она по-прежнему начинается физическим сканированием QR кладовщиком.
 */
export async function markPrinted(
  db: Database,
  actor: PrintActor,
  jobId: string,
  context: RequestContext,
): Promise<PrintJobView> {
  const updated = await db.$transaction(async (tx) => {
    const changed = await tx.orderPrintJob.updateMany({
      // Условие в WHERE, а не проверка «до»: повторное нажатие не должно
      // переписать чужую отметку и её автора.
      where: { id: jobId, state: { in: ['PENDING', 'ERROR'] } },
      data: { state: 'PRINTED', completedAt: new Date(), completedById: actor.userId },
    });

    if (changed.count === 0) {
      const existing = await tx.orderPrintJob.findUnique({
        where: { id: jobId },
        select: { id: true },
      });
      if (existing === null) {
        throw new AppError('NOT_FOUND', { message: 'print job not found' });
      }
      throw new AppError('CONFLICT', {
        message: 'print job already completed',
        publicMessage: 'Задание уже отмечено напечатанным.',
        conflict: { kind: 'PRINT_JOB_ALREADY_COMPLETED' },
      });
    }

    const job = (await tx.orderPrintJob.findUniqueOrThrow({
      where: { id: jobId },
      select: JOB_SELECT,
    })) as JobRow;

    await writeAudit(tx, {
      action: 'ORDER_PRINT_JOB_PRINTED',
      entityType: 'OrderPrintJob',
      entityId: job.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { orderId: job.orderId, attempt: job.attempt, manual: true },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishPrintEvent(tx, job.id, job.orderId, 'PRINTED');

    return job;
  });

  return toView(updated);
}

export interface PrintDocument {
  bytes: Uint8Array;
  fileName: string;
  /** Хеш снимка: тот же снимок обязан давать тот же документ. */
  snapshotHash: string;
}

/**
 * Документ по заданию печати.
 *
 * Берётся снимок, привязанный к заданию, а не последний снимок заказа: повтор
 * обязан выдать ровно тот документ, ради которого его создавали.
 */
export async function renderJobDocument(db: Database, jobId: string): Promise<PrintDocument> {
  const job = await db.orderPrintJob.findUnique({
    where: { id: jobId },
    select: { printForm: { select: { snapshot: true, snapshotHash: true } } },
  });

  if (job === null) {
    throw new AppError('NOT_FOUND', { message: 'print job not found' });
  }

  return renderStored(job.printForm.snapshot, job.printForm.snapshotHash);
}

/** Документ последнего бланка заказа: то, что открывается из карточки. */
export async function renderOrderDocument(db: Database, orderId: string): Promise<PrintDocument> {
  const form = await db.orderPrintForm.findFirst({
    where: { orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { snapshot: true, snapshotHash: true },
  });

  if (form === null) {
    throw new AppError('NOT_FOUND', {
      message: 'print form not found',
      publicMessage: 'Бланк ещё не создан: заказ не собран.',
    });
  }

  return renderStored(form.snapshot, form.snapshotHash);
}

async function renderStored(snapshot: unknown, hash: string): Promise<PrintDocument> {
  const stored = snapshot as PrintFormSnapshot;
  return {
    bytes: await renderPrintFormPdf(stored),
    fileName: printFormFileName(stored),
    snapshotHash: hash,
  };
}

/**
 * Термоэтикетка задания печати.
 *
 * Второе ПРЕДСТАВЛЕНИЕ того же документа, а не второй механизм: снимок берётся
 * тот же, что и у бланка, поэтому история печати, повторы и аудит остаются
 * общими. Заведи мы отдельную сущность «этикетка» — у одного заказа появились
 * бы две несогласованные истории печати.
 */
export async function renderJobLabel(db: Database, jobId: string): Promise<PrintDocument> {
  const job = await db.orderPrintJob.findUnique({
    where: { id: jobId },
    select: { printForm: { select: { snapshot: true, snapshotHash: true } } },
  });

  if (job === null) {
    throw new AppError('NOT_FOUND', { message: 'print job not found' });
  }

  return renderStoredLabel(job.printForm.snapshot, job.printForm.snapshotHash);
}

/** Этикетка последнего бланка заказа: то, что открывается из карточки. */
export async function renderOrderLabel(db: Database, orderId: string): Promise<PrintDocument> {
  const form = await db.orderPrintForm.findFirst({
    where: { orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { snapshot: true, snapshotHash: true },
  });

  if (form === null) {
    throw new AppError('NOT_FOUND', {
      message: 'print form not found',
      publicMessage: 'Бланк ещё не создан: заказ не собран.',
    });
  }

  return renderStoredLabel(form.snapshot, form.snapshotHash);
}

async function renderStoredLabel(snapshot: unknown, hash: string): Promise<PrintDocument> {
  const stored = snapshot as PrintFormSnapshot;
  return {
    bytes: await renderThermalLabelPdf(stored),
    fileName: thermalLabelFileName(stored),
    snapshotHash: hash,
  };
}

// --- Автоматическая доставка на принтер --------------------------------------

/**
 * Насколько задание закрепляется за агентом.
 *
 * Заведомо больше времени одной печати и заметно меньше терпения человека
 * у принтера: зависший агент не держит очередь дольше минуты.
 */
export const DELIVERY_LEASE_MS = 60_000;

/** Сколько раз задание выдаётся агенту, прежде чем стать отказом. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface ClaimedDelivery {
  jobId: string;
  orderId: string;
  attempt: number;
  /** Снимок бланка: из него и собирается наклейка. Второго снимка не бывает. */
  snapshot: PrintFormSnapshot;
}

/**
 * Выдаёт агенту следующее задание в АРЕНДУ.
 *
 * Одно задание за раз: у принтера один рулон, и порядок наклеек имеет
 * физический смысл.
 *
 * Берутся ТОЛЬКО задания с явно назначенной точкой печати. Это не оптимизация,
 * а защита: у всех заданий, созданных до появления печати, точка пуста,
 * и без этого условия первое же подключение принтера напечатало бы всю
 * историческую очередь.
 *
 * `FOR UPDATE SKIP LOCKED` обязателен: два опроса одного агента (например,
 * после обрыва связи) не должны забрать одно задание дважды.
 */
export async function claimNextDelivery(
  db: Database,
  pointId: string,
  now = new Date(),
): Promise<ClaimedDelivery | null> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
      FROM "OrderPrintJob"
      WHERE "printPointId" = ${pointId}::uuid
        AND (
          "deliveryState" = 'QUEUED'
          OR ("deliveryState" = 'CLAIMED' AND "leaseUntil" IS NOT NULL AND "leaseUntil" < ${now})
        )
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;

    const first = rows[0];
    if (first === undefined) {
      return null;
    }

    const job = await tx.orderPrintJob.update({
      where: { id: first.id },
      data: {
        deliveryState: 'CLAIMED',
        claimedAt: now,
        leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
        deliveryAttempts: { increment: 1 },
      },
      select: {
        id: true,
        orderId: true,
        deliveryAttempts: true,
        printForm: { select: { snapshot: true } },
      },
    });

    return {
      jobId: job.id,
      orderId: job.orderId,
      attempt: job.deliveryAttempts,
      snapshot: job.printForm.snapshot as unknown as PrintFormSnapshot,
    };
  });
}

/**
 * Итог доставки со стороны агента.
 *
 * `sent` — задание принято спулером Windows. Это ЧЕСТНАЯ граница нашего
 * знания: вышла ли бумага, спулер не сообщает.
 *
 * `failed` — спулер отказал. Отказавший спулер ничего не напечатал, поэтому
 * такое задание можно выдать снова.
 *
 * `unknown` — агент не смог выяснить исход: например, компьютер выключили
 * между передачей в спулер и ответом серверу. Повторять НЕЛЬЗЯ: наклейка,
 * возможно, уже вышла, а две наклейки на коробке хуже, чем ни одной —
 * отсутствие видно сразу, а дубль уезжает к покупателю.
 */
export type DeliveryOutcome = 'sent' | 'failed' | 'unknown';

/**
 * Коды ошибок доставки. Короткие и безопасные: они попадают в задание,
 * которое читают все производственные экраны.
 */
const DELIVERY_ERROR_CODE: Record<Exclude<DeliveryOutcome, 'sent'>, string> = {
  failed: 'AGENT_SPOOLER_FAILED',
  unknown: 'AGENT_OUTCOME_UNKNOWN',
};

export async function reportDelivery(
  db: Database,
  input: { pointId: string; jobId: string; outcome: DeliveryOutcome },
  now = new Date(),
): Promise<{ deliveryState: string }> {
  return db.$transaction(async (tx) => {
    const job = await tx.orderPrintJob.findUnique({
      where: { id: input.jobId },
      select: {
        id: true,
        orderId: true,
        printPointId: true,
        deliveryState: true,
        deliveryAttempts: true,
      },
    });

    if (job === null || job.printPointId !== input.pointId) {
      throw new AppError('NOT_FOUND', {
        message: 'print job not found for this point',
        publicMessage: 'Задание не найдено.',
      });
    }

    // Итог уже подведён: повторное сообщение агента после обрыва связи
    // не должно ни менять состояние, ни воскрешать задание.
    if (job.deliveryState !== 'CLAIMED') {
      return { deliveryState: job.deliveryState ?? 'NONE' };
    }

    const deliveryState =
      input.outcome === 'sent'
        ? 'SENT_TO_PRINTER'
        : input.outcome === 'unknown'
          ? 'NEEDS_REVIEW'
          : job.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS
            ? 'FAILED'
            : 'QUEUED';

    /*
     * Состояние ДОКУМЕНТА при этом не меняется на «Напечатано».
     *
     * База требует, чтобы «напечатано» было именным: кто подтвердил и когда
     * (`OrderPrintJob_printed_is_complete`). Спулер человеком не является
     * и подтвердить выход бумаги не может. Поэтому бланк остаётся
     * ожидающим, а правду о наклейке несёт `deliveryState`.
     *
     * Исключение — отказ: он именно ошибка печати, и существующее состояние
     * `ERROR` для неё и заведено.
     */
    const failed = deliveryState === 'FAILED';

    await tx.orderPrintJob.update({
      where: { id: job.id },
      data: {
        deliveryState,
        leaseUntil: null,
        ...(deliveryState === 'SENT_TO_PRINTER' ? { sentAt: now } : {}),
        ...(input.outcome === 'sent'
          ? {}
          : { lastErrorCode: DELIVERY_ERROR_CODE[input.outcome], lastErrorAt: now }),
        ...(failed ? { state: 'ERROR' as const } : {}),
      },
    });

    await publishPrintEvent(tx, job.id, job.orderId, 'DELIVERY');

    return { deliveryState };
  });
}
