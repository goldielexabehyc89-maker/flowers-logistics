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
  };
}

/** Что показывает вкладка «Печать». */
export type PrintFilter = 'attention' | 'printed' | 'all';

export const MAX_PRINT_JOBS = 200;

/**
 * Очередь заданий.
 *
 * По умолчанию — только требующие внимания: ожидающие и ошибки. История
 * успешно напечатанных открывается отдельным фильтром, чтобы рабочий список
 * не превращался в архив (`FUL-002` §2.8).
 */
export async function listPrintJobs(
  db: Database,
  input: { filter: PrintFilter; limit: number },
): Promise<PrintJobView[]> {
  const states =
    input.filter === 'attention'
      ? (['PENDING', 'ERROR'] as const)
      : input.filter === 'printed'
        ? (['PRINTED'] as const)
        : (['PENDING', 'ERROR', 'PRINTED'] as const);

  const rows = (await db.orderPrintJob.findMany({
    where: { state: { in: [...states] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(input.limit, MAX_PRINT_JOBS),
    select: JOB_SELECT,
  })) as JobRow[];

  return rows.map(toView);
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

    const job = await tx.orderPrintJob.create({
      data: {
        orderId: source.orderId,
        // Тот же снимок и та же версия шаблона: документ обязан быть тем же.
        printFormId: source.printFormId,
        attempt,
        state: 'PENDING',
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
