/**
 * Выдача заданий обработчику печати.
 *
 * ЭТО ТА ЖЕ ОЧЕРЕДЬ, ЧТО У ВКЛАДКИ «ПЕЧАТЬ». Второй таблицы заданий нет:
 * `OrderPrintJob` остаётся единственной, а ручная отметка «Напечатано»
 * продолжает работать по тем же строкам. Обработчик добавляет к очереди
 * не хранилище, а протокол — забрать, отчитаться, подтвердить.
 *
 * ПОРЯДОК ОТЧЁТОВ ВЫБРАН РАДИ ОДНОЗНАЧНОСТИ, А НЕ РАДИ ПОДРОБНОСТИ.
 * Обработчик обязан сообщить `printing` ДО того, как передаст документ
 * системному драйверу. Поэтому:
 *
 *   - `CLAIMED` означает «взято, но принтер документа не видел». Такое задание
 *     безопасно вернуть в очередь: бумага заведомо не выходила;
 *   - `PRINTING` означает «документ у драйвера, исход неизвестен». Такое
 *     задание в очередь НЕ возвращается никогда и ни по какому таймеру —
 *     только человеку (`NEEDS_REVIEW`).
 *
 * Если бы отчёт шёл после передачи, оба состояния значили бы «может быть,
 * напечатано», и различить их было бы нечем.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import { writeAudit } from '../audit/service.js';
import { publishPrintEvent } from '../fulfillment/assembly.js';
import { renderPrintFormPdf, printFormFileName } from '../fulfillment/pdf.js';
import type { PrintFormSnapshot } from '../fulfillment/print-form.js';
import {
  isUnambiguousFailure,
  normalizePrintErrorCode,
  printErrorMessage,
  type PrintErrorCode,
} from './errors.js';
import type { AuthenticatedDevice } from './guard.js';

export interface RequestContext {
  ip: string;
  userAgent: string | null;
}

/**
 * Сколько задание может оставаться в печати без подтверждения.
 *
 * По истечении оно уходит человеку, а НЕ в очередь: см. заголовок файла.
 */
export const PRINTING_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Сколько задание может оставаться взятым, не начав печататься.
 *
 * Здесь возврат в очередь безопасен и потому автоматический: `CLAIMED`
 * означает, что принтер документа не видел.
 */
export const CLAIMED_STALE_AFTER_MS = 2 * 60 * 1000;

/** Задание в том виде, в каком его получает обработчик. */
export interface DeviceJobView {
  jobId: string;
  documentKind: string;
  /** Номер заказа: обработчик показывает его в окне состояния. */
  orderNumber: string | null;
  attempt: number | null;
  /**
   * Относительный путь документа на ЭТОМ сервере.
   *
   * Именно путь, а не полный URL: обработчик обязан ходить только к своему
   * серверу. Приняв чужой адрес, он превратился бы в загрузчик произвольных
   * файлов, запускаемый тем, кто сумел ответить на его опрос.
   */
  documentPath: string;
}

const JOB_SELECT = {
  id: true,
  documentKind: true,
  attempt: true,
  state: true,
  deviceId: true,
  orderId: true,
  order: { select: { externalName: true } },
} as const;

interface JobRow {
  id: string;
  documentKind: string;
  attempt: number | null;
  state: string;
  deviceId: string | null;
  orderId: string | null;
  order: { externalName: string } | null;
}

function toDeviceJob(row: JobRow): DeviceJobView {
  return {
    jobId: row.id,
    documentKind: row.documentKind,
    orderNumber: row.order?.externalName ?? null,
    attempt: row.attempt,
    documentPath: `/api/print-agent/jobs/${row.id}/document.pdf`,
  };
}

/**
 * Сколько кандидатов рассматривается за один опрос.
 *
 * Больше одного намеренно: при гонке проигравший обработчик обязан попробовать
 * следующее задание, а не уйти с пустыми руками до следующего опроса.
 */
const CLAIM_CANDIDATES = 10;

/**
 * Атомарный захват очередного задания.
 *
 * Захват — УСЛОВНЫЙ UPDATE, а не «прочитать и записать». Два обработчика,
 * опросившие очередь одновременно, прочитали бы одну и ту же строку и оба
 * сочли бы её свободной. Здесь выигрывает ровно один: условие `state` и
 * `deviceId IS NULL` проверяет сама база в момент записи, и проигравший
 * видит `count === 0`.
 *
 * Гонка не теоретическая: основной обработчик меняется без остановки прежнего,
 * и в этот момент очередь опрашивают оба.
 */
export async function claimNextJob(db: Database, deviceId: string): Promise<DeviceJobView | null> {
  const candidates = await db.orderPrintJob.findMany({
    where: { state: 'PENDING' },
    // Устойчивый добор по идентификатору: без него две строки с одинаковым
    // временем создания могли бы обе выпасть из выборки.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CLAIM_CANDIDATES,
    select: { id: true },
  });

  for (const candidate of candidates) {
    // Захват, журнал и событие — одна транзакция: задание, взятое без записи
    // о том, кто его взял, невозможно ни разобрать, ни вернуть.
    const claimed = await db.$transaction(async (tx) => {
      const changed = await tx.orderPrintJob.updateMany({
        where: { id: candidate.id, state: 'PENDING', deviceId: null },
        data: { state: 'CLAIMED', deviceId, claimedAt: new Date() },
      });

      if (changed.count === 0) {
        return null;
      }

      const row = (await tx.orderPrintJob.findUniqueOrThrow({
        where: { id: candidate.id },
        select: JOB_SELECT,
      })) as JobRow;

      await writeAudit(tx, {
        action: 'PRINT_AGENT_JOB_CLAIMED',
        entityType: 'OrderPrintJob',
        entityId: row.id,
        actorUserId: null,
        actorRoles: [],
        newValue: { deviceId, documentKind: row.documentKind },
        source: 'worker',
      });
      await publishPrintEvent(tx, row.id, row.orderId, 'CLAIMED');

      return row;
    });

    if (claimed === null) {
      // Задание досталось другому обработчику. Пробуем следующее.
      continue;
    }

    return toDeviceJob(claimed);
  }

  return null;
}

/** Читает задание, принадлежащее ЭТОМУ устройству, либо отказывает. */
async function ownedJob(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
  allowedStates: readonly string[],
): Promise<JobRow> {
  const row = (await db.orderPrintJob.findUnique({
    where: { id: jobId },
    select: JOB_SELECT,
  })) as JobRow | null;

  if (row === null || row.deviceId !== device.deviceId) {
    // Чужое и несуществующее задание неотличимы снаружи намеренно: иначе
    // по ответу можно было бы перебрать идентификаторы чужих заданий.
    throw new AppError('NOT_FOUND', { message: 'print job not available for device' });
  }

  if (!allowedStates.includes(row.state)) {
    throw new AppError('CONFLICT', {
      message: `print job state ${row.state} does not allow this report`,
      publicMessage: 'Задание уже завершено.',
      conflict: { kind: 'PRINT_JOB_ALREADY_COMPLETED' },
    });
  }

  return row;
}

/**
 * Документ задания для обработчика.
 *
 * Выдаётся ТОЛЬКО тому устройству, которое это задание забрало, и только пока
 * задание не завершено. Произвольные пути и произвольные идентификаторы
 * документов обработчику не выдаются вовсе: он получает путь вместе с
 * заданием и другого источника не знает.
 */
export async function renderDeviceDocument(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = await ownedJob(db, device, jobId, ['CLAIMED', 'PRINTING']);

  if (row.documentKind === 'TEST_PAGE') {
    const snapshot = testPageSnapshot();
    return { bytes: await renderPrintFormPdf(snapshot), fileName: 'print-test.pdf' };
  }

  const job = await db.orderPrintJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { printForm: { select: { snapshot: true } } },
  });

  if (job.printForm === null) {
    throw new AppError('NOT_FOUND', { message: 'print form missing' });
  }

  const snapshot = job.printForm.snapshot as unknown as PrintFormSnapshot;
  return { bytes: await renderPrintFormPdf(snapshot), fileName: printFormFileName(snapshot) };
}

/**
 * Отчёт «документ передаю драйверу».
 *
 * Приходит ДО передачи. С этого момента исход задания неизвестен, и вернуть
 * его в очередь автоматически уже нельзя.
 */
export async function reportPrinting(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
): Promise<{ state: string }> {
  await ownedJob(db, device, jobId, ['CLAIMED', 'PRINTING']);

  const changed = await db.orderPrintJob.updateMany({
    where: { id: jobId, deviceId: device.deviceId, state: 'CLAIMED' },
    data: { state: 'PRINTING', printingAt: new Date() },
  });

  // Повтор того же отчёта после потери сети не считается ошибкой: обработчик
  // не обязан знать, дошёл ли предыдущий.
  if (changed.count > 0) {
    await db.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: 'PRINT_AGENT_JOB_PRINTING',
        entityType: 'OrderPrintJob',
        entityId: jobId,
        actorUserId: null,
        actorRoles: [],
        newValue: { deviceId: device.deviceId },
        source: 'worker',
      });
    });
  }

  return { state: 'PRINTING' };
}

export type PrintOutcome = 'printed' | 'failed' | 'ambiguous';

export interface ResultReport {
  outcome: PrintOutcome;
  errorCode: string | null;
  /** Принтер по умолчанию на момент печати. Отчёт, а не настройка. */
  defaultPrinterName: string | null;
}

/**
 * Исход задания.
 *
 * ИДЕМПОТЕНТЕН. Обработчик, потерявший сеть сразу после печати, повторит
 * отчёт — и обязан получить успех, а не конфликт: иначе он либо начнёт
 * считать напечатанное неудачей, либо станет печатать заново.
 *
 * НЕОДНОЗНАЧНЫЙ ИСХОД НЕ СТАНОВИТСЯ ОШИБКОЙ. `ERROR` означает «повторить
 * можно», и автоматика с этим состоянием обращается именно так. Там, где
 * бумага могла выйти, состояние другое — `NEEDS_REVIEW`, — и решение
 * принимает человек.
 */
export async function reportResult(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
  report: ResultReport,
  context: RequestContext,
): Promise<{ state: string }> {
  const current = (await db.orderPrintJob.findUnique({
    where: { id: jobId },
    select: { id: true, state: true, deviceId: true },
  })) as { id: string; state: string; deviceId: string | null } | null;

  if (current === null || current.deviceId !== device.deviceId) {
    throw new AppError('NOT_FOUND', { message: 'print job not available for device' });
  }

  // Повторный отчёт о том же исходе — успех, а не конфликт.
  if (['PRINTED', 'ERROR', 'NEEDS_REVIEW', 'CANCELLED'].includes(current.state)) {
    return { state: current.state };
  }

  if (report.outcome === 'printed') {
    return finishPrinted(db, device, jobId, report, context);
  }

  const code = normalizePrintErrorCode(report.errorCode);
  const ambiguous = report.outcome === 'ambiguous' || !isUnambiguousFailure(code);
  return finishFailed(db, device, jobId, code, ambiguous, context);
}

async function finishPrinted(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
  report: ResultReport,
  context: RequestContext,
): Promise<{ state: string }> {
  const now = new Date();

  await db.$transaction(async (tx) => {
    const changed = await tx.orderPrintJob.updateMany({
      where: { id: jobId, deviceId: device.deviceId, state: { in: ['CLAIMED', 'PRINTING'] } },
      data: {
        state: 'PRINTED',
        completedAt: now,
        // Автор — компьютер, а не человек: `completedById` остаётся пустым,
        // и ручная отметка остаётся отличима от машинной.
        completedById: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    if (changed.count === 0) {
      return;
    }

    await tx.printAgentDevice.update({
      where: { id: device.deviceId },
      data: {
        lastSucceededJobId: jobId,
        lastSucceededAt: now,
        lastSeenAt: now,
        ...(report.defaultPrinterName === null
          ? {}
          : { defaultPrinterName: report.defaultPrinterName }),
      },
    });

    const job = await tx.orderPrintJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { orderId: true },
    });

    await writeAudit(tx, {
      action: 'PRINT_AGENT_JOB_SUCCEEDED',
      entityType: 'OrderPrintJob',
      entityId: jobId,
      actorUserId: null,
      actorRoles: [],
      newValue: { deviceId: device.deviceId },
      ip: context.ip,
      userAgent: context.userAgent,
      source: 'worker',
    });
    await publishPrintEvent(tx, jobId, job.orderId, 'PRINTED');
  });

  return { state: 'PRINTED' };
}

async function finishFailed(
  db: Database,
  device: AuthenticatedDevice,
  jobId: string,
  code: PrintErrorCode,
  ambiguous: boolean,
  context: RequestContext,
): Promise<{ state: string }> {
  const now = new Date();
  const state = ambiguous ? 'NEEDS_REVIEW' : 'ERROR';
  const message = printErrorMessage(code);

  await db.$transaction(async (tx) => {
    const changed = await tx.orderPrintJob.updateMany({
      where: { id: jobId, deviceId: device.deviceId, state: { in: ['CLAIMED', 'PRINTING'] } },
      data: { state, lastErrorCode: code, lastErrorMessage: message, lastErrorAt: now },
    });

    if (changed.count === 0) {
      return;
    }

    await tx.printAgentDevice.update({
      where: { id: device.deviceId },
      data: {
        lastErrorCode: code,
        lastErrorMessage: message,
        lastErrorAt: now,
        lastSeenAt: now,
      },
    });

    const job = await tx.orderPrintJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { orderId: true },
    });

    await writeAudit(tx, {
      action: ambiguous ? 'PRINT_AGENT_JOB_NEEDS_REVIEW' : 'PRINT_AGENT_JOB_FAILED',
      entityType: 'OrderPrintJob',
      entityId: jobId,
      actorUserId: null,
      actorRoles: [],
      newValue: { deviceId: device.deviceId, errorCode: code },
      ip: context.ip,
      userAgent: context.userAgent,
      source: 'worker',
    });
    await publishPrintEvent(tx, jobId, job.orderId, ambiguous ? 'NEEDS_REVIEW' : 'FAILED');
  });

  return { state };
}

/**
 * Разбор зависших заданий.
 *
 * ЗАВИСШЕЕ `PRINTING` НЕ ПЕЧАТАЕТСЯ ПОВТОРНО. Оно уходит человеку: принтер мог
 * принять документ, а обработчик закрыться до подтверждения. Автоматический
 * повтор здесь означал бы второй бланк к тому же букету — ровно та ошибка,
 * ради которой это состояние и заведено.
 *
 * Зависшее `CLAIMED` возвращается в очередь: принтер документа не видел.
 */
export async function sweepStaleJobs(
  db: Database,
  now: Date = new Date(),
): Promise<{ needsReview: number; requeued: number }> {
  const printingCutoff = new Date(now.getTime() - PRINTING_STALE_AFTER_MS);
  const claimedCutoff = new Date(now.getTime() - CLAIMED_STALE_AFTER_MS);

  const needsReview = await db.orderPrintJob.updateMany({
    where: { state: 'PRINTING', printingAt: { lt: printingCutoff } },
    data: {
      state: 'NEEDS_REVIEW',
      lastErrorCode: 'PRINTING_TIMED_OUT',
      lastErrorMessage: printErrorMessage('PRINTING_TIMED_OUT'),
      lastErrorAt: now,
    },
  });

  const requeued = await db.orderPrintJob.updateMany({
    where: { state: 'CLAIMED', claimedAt: { lt: claimedCutoff } },
    data: { state: 'PENDING', deviceId: null, claimedAt: null },
  });

  return { needsReview: needsReview.count, requeued: requeued.count };
}

/**
 * Снимок тестовой страницы.
 *
 * Собирается ТЕМ ЖЕ снимком и печатается ТЕМ ЖЕ генератором, что и бланк
 * (`fulfillment/pdf.ts`). Второй генератор проверял бы не тот путь, которым
 * пойдут настоящие бланки, и «тестовая печать прошла» ничего бы не значило.
 *
 * Номер намеренно `TEST-PRINT`: QR кодирует ровно его, и сканер склада на
 * такой номер честно не найдёт заказа, а не подберёт случайный.
 */
export function testPageSnapshot(): PrintFormSnapshot {
  return {
    orderNumber: 'TEST-PRINT',
    deliveryDate: null,
    intervalStartMinute: null,
    intervalEndMinute: null,
    cardText: 'Это тестовая страница. Заказу она не принадлежит.',
    description: 'Если страница вышла из принтера — связь с печатью работает.',
    positions: [
      {
        name: 'Проверка печати',
        quantity: '1',
        uomName: 'шт',
        characteristicLabel: null,
        isBundle: false,
        components: [],
      },
    ],
  };
}

export interface TestPrintActor {
  userId: string;
  roles: readonly Role[];
}

/**
 * Тестовая печать.
 *
 * Идёт ТОЙ ЖЕ очередью, тем же захватом и теми же отчётами, что и бланк.
 * Отдельный путь «только для проверки» доказывал бы работоспособность пути,
 * которым никогда не пойдёт ни один настоящий заказ.
 */
export async function createTestPrintJob(
  db: Database,
  actor: TestPrintActor,
  idempotencyKey: string,
  context: RequestContext,
): Promise<{ jobId: string; state: string }> {
  const existing = await db.orderPrintJob.findUnique({
    where: { idempotencyKey },
    select: { id: true, state: true },
  });
  if (existing !== null) {
    return { jobId: existing.id, state: existing.state };
  }

  try {
    return await db.$transaction(async (tx) => {
      const job = await tx.orderPrintJob.create({
        data: {
          documentKind: 'TEST_PAGE',
          state: 'PENDING',
          idempotencyKey,
        },
        select: { id: true, state: true },
      });

      await writeAudit(tx, {
        action: 'ORDER_PRINT_JOB_CREATED',
        entityType: 'OrderPrintJob',
        entityId: job.id,
        actorUserId: actor.userId,
        actorRoles: actor.roles,
        newValue: { documentKind: 'TEST_PAGE' },
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await publishPrintEvent(tx, job.id, null, 'CREATED');

      return { jobId: job.id, state: job.state };
    });
  } catch (error) {
    // Гонка двух одинаковых нажатий: уникальный индекс отклонил второе.
    // Возвращается первое задание, а не ошибка, — кнопку нажали дважды,
    // а хотели одну проверку.
    const raced = await db.orderPrintJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, state: true },
    });
    if (raced !== null) {
      return { jobId: raced.id, state: raced.state };
    }
    throw error;
  }
}
