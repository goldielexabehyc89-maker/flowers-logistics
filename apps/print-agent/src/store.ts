/**
 * Долговременная память об исходах заданий.
 *
 * ЭТО ЕДИНСТВЕННОЕ, ЧТО МЕШАЕТ НАПЕЧАТАТЬ ВТОРОЙ БЛАНК. Сервер знает состояние
 * задания, но между «документ ушёл драйверу» и «сервер об этом услышал» есть
 * промежуток, и именно в него попадает выключенный из розетки компьютер.
 * Память в процессе такого не переживает, поэтому запись идёт на диск и
 * целиком (`atomic-file.ts`).
 *
 * Три состояния, и границы между ними проведены по одному признаку — ВИДЕЛ ЛИ
 * ДОКУМЕНТ ДРАЙВЕР:
 *
 *   - `claimed` — задание взято, драйвер документа не видел. Бумага заведомо
 *     не выходила, повторить безопасно. Такую запись после перезапуска просто
 *     забывают: сервер сам вернёт задание в очередь по своему таймауту;
 *   - `handed`  — документ передан драйверу, исхода нет. Повторять НЕЛЬЗЯ ни
 *     при каких условиях. После перезапуска превращается в `ambiguous`;
 *   - `done`    — исход известен. Запись остаётся и после подтверждения
 *     сервером: если то же задание придёт снова, печатать его не нужно,
 *     нужно повторить уже известный исход.
 *
 * Признак `reported` отделён от исхода намеренно: исход, записанный на диск,
 * но не дошедший до сервера, обязан пережить и потерю сети, и перезапуск.
 */

import { readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import type { AgentErrorCode } from './errors.js';

export type JobStage = 'claimed' | 'handed' | 'done';

export type JobOutcome = 'printed' | 'failed' | 'ambiguous';

export interface JobResult {
  outcome: JobOutcome;
  errorCode: AgentErrorCode | null;
  /** Принтер, на который ушёл документ. Отчёт о факте, а не настройка. */
  defaultPrinterName: string | null;
}

export interface JobRecord {
  jobId: string;
  stage: JobStage;
  /** Исход, если он определён. Хранится и после подтверждения сервером. */
  result: JobResult | null;
  /** Дошёл ли исход до сервера. Неподтверждённый уходит повторно. */
  reported: boolean;
  updatedAt: string;
}

export interface JobStore {
  get(jobId: string): JobRecord | null;
  list(): readonly JobRecord[];
  setStage(jobId: string, stage: JobStage): Promise<void>;
  /** Исход и состояние пишутся одной записью: порознь они бессмысленны. */
  setResult(jobId: string, stage: JobStage, result: JobResult): Promise<void>;
  markReported(jobId: string): Promise<void>;
  forget(jobId: string): Promise<void>;
}

const STORE_FILE = 'jobs.json';

/** Версия формата. Читатель обязан узнавать чужой файл, а не гадать по полям. */
const STORE_VERSION = 1;

/**
 * Сколько живёт запись о завершённом задании.
 *
 * Файл не должен расти вечно, но забыть задание раньше, чем сервер перестанет
 * его предлагать, нельзя: именно эта запись и запрещает второй бланк. Месяц
 * с запасом перекрывает любой разумный срок разбора зависшего задания.
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface StoreFile {
  version: number;
  jobs: JobRecord[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStage(value: unknown): JobStage | null {
  return value === 'claimed' || value === 'handed' || value === 'done' ? value : null;
}

function parseResult(value: unknown): JobResult | null {
  if (!isObject(value)) {
    return null;
  }
  const outcome = value['outcome'];
  if (outcome !== 'printed' && outcome !== 'failed' && outcome !== 'ambiguous') {
    return null;
  }
  const errorCode = value['errorCode'];
  const printer = value['defaultPrinterName'];
  return {
    outcome,
    errorCode: typeof errorCode === 'string' ? (errorCode as AgentErrorCode) : null,
    defaultPrinterName: typeof printer === 'string' ? printer : null,
  };
}

function parseRecord(value: unknown): JobRecord | null {
  if (!isObject(value)) {
    return null;
  }
  const jobId = value['jobId'];
  const stage = parseStage(value['stage']);
  if (typeof jobId !== 'string' || jobId === '' || stage === null) {
    return null;
  }
  const updatedAt = value['updatedAt'];
  return {
    jobId,
    stage,
    result: parseResult(value['result']),
    reported: value['reported'] === true,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date(0).toISOString(),
  };
}

/**
 * Разбирает файл, отбрасывая непонятные записи поштучно.
 *
 * Одна испорченная строка не должна стирать память обо ВСЕХ заданиях: цена
 * такой потери — повторно напечатанный бланк, а цена пропуска одной записи —
 * одно задание, которое сервер разберёт по таймауту.
 */
function parseStoreFile(raw: string): JobRecord[] {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed) || parsed['version'] !== STORE_VERSION) {
    throw new Error('unsupported job store version');
  }
  const jobs = parsed['jobs'];
  if (!Array.isArray(jobs)) {
    throw new Error('job store has no jobs');
  }

  const records: JobRecord[] = [];
  for (const entry of jobs) {
    const record = parseRecord(entry);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Открывает журнал заданий.
 *
 * Нечитаемый файл НЕ удаляется, а отодвигается в сторону: он единственное
 * свидетельство того, что печаталось перед сбоем, и разбираться с зависшим
 * заданием без него придётся вслепую. Номера заказов внутри — не секрет,
 * токенов и кодов там нет по построению.
 */
export async function openJobStore(home: string, now: Date = new Date()): Promise<JobStore> {
  const filePath = join(home, STORE_FILE);
  const records = new Map<string, JobRecord>();

  const raw = await readFile(filePath, 'utf8').catch(() => null);

  if (raw !== null) {
    try {
      for (const record of parseStoreFile(raw)) {
        records.set(record.jobId, record);
      }
    } catch {
      await rename(filePath, `${filePath}.broken-${now.getTime()}`).catch(() => undefined);
    }
  }

  // Устаревшие завершённые записи отбрасываются при открытии, а не по таймеру:
  // обработчик может неделями работать без перезапуска, и лишний фоновой
  // процесс ради обрезки файла на 20 килобайт того не стоит.
  const cutoff = now.getTime() - RETENTION_MS;
  for (const [jobId, record] of records) {
    if (record.stage === 'done' && record.reported && Date.parse(record.updatedAt) < cutoff) {
      records.delete(jobId);
    }
  }

  const persist = async (): Promise<void> => {
    const payload: StoreFile = { version: STORE_VERSION, jobs: [...records.values()] };
    await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  };

  const upsert = async (jobId: string, patch: Partial<JobRecord>): Promise<void> => {
    const existing = records.get(jobId);
    const base: JobRecord = existing ?? {
      jobId,
      stage: 'claimed',
      result: null,
      reported: false,
      updatedAt: new Date().toISOString(),
    };
    records.set(jobId, { ...base, ...patch, jobId, updatedAt: new Date().toISOString() });
    await persist();
  };

  await persist();

  return {
    get(jobId: string): JobRecord | null {
      return records.get(jobId) ?? null;
    },

    list(): readonly JobRecord[] {
      return [...records.values()];
    },

    async setStage(jobId: string, stage: JobStage): Promise<void> {
      await upsert(jobId, { stage });
    },

    async setResult(jobId: string, stage: JobStage, result: JobResult): Promise<void> {
      await upsert(jobId, { stage, result, reported: false });
    },

    async markReported(jobId: string): Promise<void> {
      if (records.has(jobId)) {
        await upsert(jobId, { reported: true });
      }
    },

    async forget(jobId: string): Promise<void> {
      if (records.delete(jobId)) {
        await persist();
      }
    },
  };
}

/** Каталог, куда обработчик кладёт документ перед передачей драйверу. */
export function spoolDir(home: string): string {
  return join(home, 'spool');
}

/**
 * Удаляет забытые документы.
 *
 * Бланк содержит состав заказа, адрес и текст открытки. Файл, оставшийся после
 * аварийного завершения, — это те же данные, лежащие в профиле пользователя
 * без срока и без надзора.
 */
export async function cleanSpool(home: string): Promise<void> {
  const directory = spoolDir(home);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    await unlink(join(directory, entry)).catch(() => undefined);
  }
}
