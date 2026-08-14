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
import { renderPrintFormPdf, printFormFileName } from './pdf.js';
import { normalizePageRequest, pageInfo, type PageInfo, type PageRequest } from './paging.js';
import type { PrintFormSnapshot } from './print-form.js';
import type { RequestContext } from './shifts.js';

export interface PrintActor {
  userId: string;
  roles: readonly Role[];
}

export interface PrintJobView {
  id: string;
  /** `ORDER_FORM` или `TEST_PAGE`. У тестовой страницы заказа нет. */
  documentKind: string;
  orderId: string | null;
  /** Номер заказа: человеческий ключ всех производственных экранов. */
  orderNumber: string | null;
  printFormId: string | null;
  state: string;
  attempt: number | null;
  createdAt: string;
  completedAt: string | null;
  completedById: string | null;
  /** Короткий безопасный код: ни состава, ни PII. */
  lastErrorCode: string | null;
  /** Понятная человеку причина. Текст выбирает сервер из закрытого перечня. */
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  /** Компьютер, взявший задание. Флорист видит, куда ушёл его бланк. */
  deviceId: string | null;
  deviceName: string | null;
  cancelledAt: string | null;
}

const JOB_SELECT = {
  id: true,
  documentKind: true,
  orderId: true,
  printFormId: true,
  state: true,
  attempt: true,
  createdAt: true,
  completedAt: true,
  completedById: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  lastErrorAt: true,
  cancelledAt: true,
  deviceId: true,
  device: { select: { name: true } },
  order: { select: { externalName: true } },
} as const;

interface JobRow {
  id: string;
  documentKind: string;
  orderId: string | null;
  printFormId: string | null;
  state: string;
  attempt: number | null;
  createdAt: Date;
  completedAt: Date | null;
  completedById: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: Date | null;
  cancelledAt: Date | null;
  deviceId: string | null;
  device: { name: string } | null;
  order: { externalName: string } | null;
}

function toView(job: JobRow): PrintJobView {
  return {
    id: job.id,
    documentKind: job.documentKind,
    orderId: job.orderId,
    orderNumber: job.order?.externalName ?? null,
    printFormId: job.printFormId,
    state: job.state,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt === null ? null : job.completedAt.toISOString(),
    completedById: job.completedById,
    lastErrorCode: job.lastErrorCode,
    lastErrorMessage: job.lastErrorMessage,
    lastErrorAt: job.lastErrorAt === null ? null : job.lastErrorAt.toISOString(),
    deviceId: job.deviceId,
    deviceName: job.device?.name ?? null,
    cancelledAt: job.cancelledAt === null ? null : job.cancelledAt.toISOString(),
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
export async function listPrintJobs(
  db: Database,
  input: { filter: PrintFilter } & Partial<PageRequest>,
): Promise<PrintJobPage> {
  // «Требуют внимания» — всё незавершённое: и ожидающее, и то, что сейчас
  // в работе у обработчика. Задание, взятое компьютером и не вернувшееся,
  // обязано остаться на виду — иначе именно оно и потеряется.
  const states =
    input.filter === 'attention'
      ? (['PENDING', 'CLAIMED', 'PRINTING', 'ERROR', 'NEEDS_REVIEW'] as const)
      : input.filter === 'printed'
        ? (['PRINTED'] as const)
        : ([
            'PENDING',
            'CLAIMED',
            'PRINTING',
            'ERROR',
            'NEEDS_REVIEW',
            'PRINTED',
            'CANCELLED',
          ] as const);

  const page = normalizePageRequest(input);
  const where = { state: { in: [...states] } };

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
  /**
   * Ключ идемпотентности нажатия.
   *
   * Двойной клик и повтор запроса при потерянном ответе приходят с ОДНИМ
   * ключом и обязаны вернуть то же задание. Без него к букету приезжали бы
   * два бланка с разными номерами попыток, и оба выглядели бы законными.
   */
  idempotencyKey: string | null = null,
): Promise<PrintJobView> {
  if (idempotencyKey !== null) {
    const existing = (await db.orderPrintJob.findUnique({
      where: { idempotencyKey },
      select: JOB_SELECT,
    })) as JobRow | null;
    if (existing !== null) {
      return toView(existing);
    }
  }

  const source = await readJob(db, jobId);

  try {
    const created = await db.$transaction(async (tx) => {
      // Тестовая страница повторяется тестовой страницей: заказа и снимка
      // у неё нет, а нумерация попыток ведётся по заказу.
      if (source.documentKind === 'TEST_PAGE') {
        const job = (await tx.orderPrintJob.create({
          data: { documentKind: 'TEST_PAGE', state: 'PENDING', idempotencyKey },
          select: JOB_SELECT,
        })) as JobRow;

        await writeAudit(tx, {
          action: 'ORDER_PRINT_JOB_RETRIED',
          entityType: 'OrderPrintJob',
          entityId: job.id,
          actorUserId: actor.userId,
          actorRoles: actor.roles,
          newValue: { documentKind: 'TEST_PAGE', retriedFromJobId: source.id },
          ip: context.ip,
          userAgent: context.userAgent,
        });
        await publishPrintEvent(tx, job.id, null, 'RETRIED');

        return job;
      }

      // Дальше — бланк заказа. CHECK базы гарантирует, что у него есть и заказ,
      // и снимок; проверка здесь нужна лишь типам.
      if (source.orderId === null || source.printFormId === null) {
        throw new AppError('CONFLICT', { message: 'order print job without form' });
      }

      const attempt = await nextPrintAttempt(tx, source.orderId);

      const job = (await tx.orderPrintJob.create({
        data: {
          orderId: source.orderId,
          // Тот же снимок и та же версия шаблона: документ обязан быть тем же.
          printFormId: source.printFormId,
          attempt,
          state: 'PENDING',
          idempotencyKey,
        },
        select: JOB_SELECT,
      })) as JobRow;

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
        },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await publishPrintEvent(tx, job.id, source.orderId, 'RETRIED');

      return job;
    });

    return toView(created);
  } catch (error) {
    // Гонка двух одинаковых нажатий: уникальный индекс отклонил второе.
    // Возвращается первое задание — кнопку нажали дважды, а хотели один бланк.
    if (idempotencyKey !== null) {
      const raced = (await db.orderPrintJob.findUnique({
        where: { idempotencyKey },
        select: JOB_SELECT,
      })) as JobRow | null;
      if (raced !== null) {
        return toView(raced);
      }
    }
    throw error;
  }
}

/**
 * Снятие задания.
 *
 * Доступно тому, что заведомо не печатается: ожидающему, взятому, ошибочному
 * и отправленному на разбор. Задание в состоянии `PRINTING` снять нельзя —
 * документ уже у драйвера, и «отменено» было бы утверждением, которого никто
 * не проверял. Оно сначала уходит в разбор по таймауту.
 */
export async function cancelPrint(
  db: Database,
  actor: PrintActor,
  jobId: string,
  context: RequestContext,
): Promise<PrintJobView> {
  const updated = await db.$transaction(async (tx) => {
    const changed = await tx.orderPrintJob.updateMany({
      // Условие в WHERE, а не проверка «до»: повторное нажатие не должно
      // переписать чужую отметку и её автора.
      where: { id: jobId, state: { in: ['PENDING', 'CLAIMED', 'ERROR', 'NEEDS_REVIEW'] } },
      data: {
        state: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: actor.userId,
        // Устройство отпускается: снятое задание больше ничьё.
        deviceId: null,
        claimedAt: null,
      },
    });

    if (changed.count === 0) {
      const existing = await tx.orderPrintJob.findUnique({
        where: { id: jobId },
        select: { id: true, state: true },
      });
      if (existing === null) {
        throw new AppError('NOT_FOUND', { message: 'print job not found' });
      }
      throw new AppError('CONFLICT', {
        message: `print job in state ${existing.state} cannot be cancelled`,
        publicMessage:
          existing.state === 'PRINTING'
            ? 'Документ уже передан принтеру. Дождитесь результата.'
            : 'Задание уже завершено.',
        conflict: { kind: 'PRINT_JOB_ALREADY_COMPLETED' },
      });
    }

    const job = (await tx.orderPrintJob.findUniqueOrThrow({
      where: { id: jobId },
      select: JOB_SELECT,
    })) as JobRow;

    await writeAudit(tx, {
      action: 'ORDER_PRINT_JOB_CANCELLED',
      entityType: 'OrderPrintJob',
      entityId: job.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { orderId: job.orderId, attempt: job.attempt },
      ip: context.ip,
      userAgent: context.userAgent,
    });
    await publishPrintEvent(tx, job.id, job.orderId, 'CANCELLED');

    return job;
  });

  return toView(updated);
}

/**
 * Ручная отметка «Напечатано».
 *
 * ЗАПАСНОЙ РЕЖИМ, А НЕ ОТКАЗ. Обработчик может быть не подключён, отозван или
 * выключен — бумага при этом всё равно выходит из принтера через браузер, и
 * человек обязан иметь возможность это зафиксировать.
 *
 * Разрешена и для заданий, зависших у обработчика: `NEEDS_REVIEW` — это ровно
 * вопрос «вышел ли бланк», и ответить на него может только человек, который
 * посмотрел на лоток. `PRINTING` тоже разрешено: пока драйвер молчит, человек
 * видит бумагу раньше сервера.
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
      where: {
        id: jobId,
        state: { in: ['PENDING', 'CLAIMED', 'PRINTING', 'ERROR', 'NEEDS_REVIEW'] },
      },
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
    select: {
      documentKind: true,
      printForm: { select: { snapshot: true, snapshotHash: true } },
    },
  });

  if (job === null) {
    throw new AppError('NOT_FOUND', { message: 'print job not found' });
  }

  // У тестовой страницы снимка нет и быть не может: она ничего не описывает.
  // Скачивать её из вкладки «Печать» незачем — проверка идёт через принтер.
  if (job.documentKind === 'TEST_PAGE' || job.printForm === null) {
    throw new AppError('NOT_FOUND', {
      message: 'print job has no order document',
      publicMessage: 'У этого задания нет бланка заказа.',
    });
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
