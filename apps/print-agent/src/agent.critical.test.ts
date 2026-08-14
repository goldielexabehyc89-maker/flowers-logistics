/**
 * Критические проверки локального обработчика печати.
 *
 * Здесь проверяется единственное, ради чего обработчик вообще существует:
 * бланк выходит из принтера ровно один раз и уходит на тот принтер, который
 * выбран в системе СЕЙЧАС. Всё остальное — подробности.
 *
 * Сеть настоящая, но своя: поддельный сервер поднимается на 127.0.0.1 в этом
 * же процессе. Заглушка вместо клиента не проверила бы ни склейку пути
 * документа, ни разбор ответа, ни повтор при обрыве — то есть ровно те места,
 * где ошибка стоит второго бланка.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAgent,
  createStatusSink,
  type Agent,
  type AgentStatus,
  type CycleOutcome,
} from './agent.js';
import { PrintAgentClient, type AgentJob } from './client.js';
import { fakePrinterBackend, type FakePrintedDocument } from './printer.js';
import { openJobStore, type JobStore } from './store.js';

/**
 * Поддельный токен устройства.
 *
 * Намеренно короче настоящего (32 байта в base64url — 43 знака) и с говорящим
 * текстом внутри: сканер секретов ищет `flpa_` с полной длиной, и эта строка
 * не должна выглядеть как утёкший токен.
 */
const TEST_TOKEN = 'flpa_test-only-device';

/** Минимальный настоящий PDF: сигнатура и конец файла — больше не требуется. */
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

interface ResultReport {
  jobId: string;
  outcome: string;
  errorCode: string | null;
  defaultPrinterName: string | null;
}

interface FakeServer {
  origin: string;
  /** Задания, которые очередь выдаст по одному на каждый запрос. */
  queue: AgentJob[];
  documents: Map<string, { contentType: string; body: Buffer }>;
  printingReports: string[];
  results: ResultReport[];
  /** Сколько ближайших отчётов об исходе оборвать: имитация потери сети. */
  failResults: number;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  response.end(body);
}

async function startFakeServer(): Promise<FakeServer> {
  const state = {
    queue: [] as AgentJob[],
    documents: new Map<string, { contentType: string; body: Buffer }>(),
    printingReports: [] as string[],
    results: [] as ResultReport[],
    failResults: 0,
  };

  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      // Тот же порядок, что на сервере: без токена устройства маршрута нет.
      if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
        sendJson(response, 401, { error: 'unauthenticated' });
        return;
      }

      if (url.pathname === '/api/print-agent/heartbeat') {
        await readBody(request);
        sendJson(response, 200, {
          deviceId: 'device-1',
          name: 'Проверочное место',
          isPrimary: true,
          serverTime: new Date().toISOString(),
        });
        return;
      }

      if (url.pathname === '/api/print-agent/jobs/claim') {
        sendJson(response, 200, { job: state.queue.shift() ?? null });
        return;
      }

      const document = /^\/api\/print-agent\/jobs\/(?<id>[^/]+)\/document\.pdf$/u.exec(
        url.pathname,
      );
      if (document !== null) {
        const jobId = document.groups?.['id'] ?? '';
        const stored = state.documents.get(jobId);
        if (stored === undefined) {
          sendJson(response, 404, { error: 'not found' });
          return;
        }
        response.writeHead(200, {
          'content-type': stored.contentType,
          'content-length': String(stored.body.byteLength),
        });
        response.end(stored.body);
        return;
      }

      const printing = /^\/api\/print-agent\/jobs\/(?<id>[^/]+)\/printing$/u.exec(url.pathname);
      if (printing !== null) {
        state.printingReports.push(printing.groups?.['id'] ?? '');
        sendJson(response, 200, { state: 'PRINTING' });
        return;
      }

      const result = /^\/api\/print-agent\/jobs\/(?<id>[^/]+)\/result$/u.exec(url.pathname);
      if (result !== null) {
        const raw = await readBody(request);
        if (state.failResults > 0) {
          state.failResults -= 1;
          // Обрыв соединения, а не код ошибки: именно так выглядит пропавшая
          // сеть, и именно этот случай обязан пережить записанный исход.
          request.destroy();
          response.destroy();
          return;
        }
        const parsed: unknown = JSON.parse(raw);
        const body = parsed as Record<string, unknown>;
        state.results.push({
          jobId: result.groups?.['id'] ?? '',
          outcome: String(body['outcome']),
          errorCode: typeof body['errorCode'] === 'string' ? body['errorCode'] : null,
          defaultPrinterName:
            typeof body['defaultPrinterName'] === 'string' ? body['defaultPrinterName'] : null,
        });
        sendJson(response, 200, { state: 'PRINTED' });
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('поддельный сервер не получил порт');
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    queue: state.queue,
    documents: state.documents,
    printingReports: state.printingReports,
    results: state.results,
    get failResults(): number {
      return state.failResults;
    },
    set failResults(value: number) {
      state.failResults = value;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

interface Harness {
  home: string;
  server: FakeServer;
  store: JobStore;
  agent: Agent;
  status(): AgentStatus;
  /** Перечитывает управляющий файл поддельного принтера. */
  setPrinter(control: Record<string, unknown>): Promise<void>;
  printed(): Promise<FakePrintedDocument[]>;
  /** Новый обработчик и новый журнал поверх того же каталога: перезапуск. */
  restart(): Promise<Agent>;
}

let harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'fl-print-agent-'));
  const server = await startFakeServer();
  const controlPath = join(home, 'printer.json');
  const logPath = join(home, 'printed.json');

  const build = async (): Promise<{ agent: Agent; store: JobStore; status: () => AgentStatus }> => {
    const store = await openJobStore(home);
    let latest: AgentStatus | null = null;
    const status = createStatusSink((next) => {
      latest = next;
    });

    const agent = createAgent({
      client: new PrintAgentClient({
        serverUrl: server.origin,
        token: TEST_TOKEN,
        requestTimeoutMs: 2_000,
        // Повторов мало и они короткие: проверка обязана быть быстрой,
        // а проверяется сам факт повтора, а не его расписание.
        retryAttempts: 2,
        retryBaseMs: 5,
        retryMaxDelayMs: 10,
      }),
      printer: fakePrinterBackend({ controlPath, logPath }),
      store,
      status,
      home,
      os: 'Проверка',
      agentVersion: '0.0.0-test',
      timing: { pollIntervalMs: 5, heartbeatIntervalMs: 60_000, offlineRetryMs: 5 },
    });

    return { agent, store, status: () => latest ?? status.current() };
  };

  const first = await build();

  const harness: Harness = {
    home,
    server,
    store: first.store,
    agent: first.agent,
    status: first.status,
    async setPrinter(control: Record<string, unknown>): Promise<void> {
      await writeFile(controlPath, JSON.stringify(control), 'utf8');
    },
    async printed(): Promise<FakePrintedDocument[]> {
      try {
        return JSON.parse(await readFile(logPath, 'utf8')) as FakePrintedDocument[];
      } catch {
        return [];
      }
    },
    async restart(): Promise<Agent> {
      const next = await build();
      harness.store = next.store;
      harness.agent = next.agent;
      harness.status = next.status;
      return next.agent;
    },
  };

  await harness.setPrinter({ defaultPrinter: { name: 'HP LaserJet', offline: false } });
  harnesses.push(harness);
  return harness;
}

/** Кладёт задание в очередь поддельного сервера вместе с его документом. */
function enqueue(
  server: FakeServer,
  jobId: string,
  document: { contentType: string; body: Buffer } = {
    contentType: 'application/pdf',
    body: PDF_BYTES,
  },
): AgentJob {
  const job: AgentJob = {
    jobId,
    documentKind: 'ORDER_FORM',
    orderNumber: `ORD-${jobId}`,
    attempt: 1,
    documentPath: `/api/print-agent/jobs/${jobId}/document.pdf`,
  };
  server.queue.push(job);
  server.documents.set(jobId, document);
  return job;
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`не дождались: ${label}`);
}

beforeEach(() => {
  harnesses = [];
});

afterEach(async () => {
  for (const harness of harnesses) {
    await harness.server.close();
    await rm(harness.home, { recursive: true, force: true });
  }
  harnesses = [];
});

describe('обработчик печати: один бланк на одно задание', () => {
  it('печатает задание и отчитывается об успехе', async () => {
    const harness = await createHarness();
    enqueue(harness.server, 'job-1');

    const outcome: CycleOutcome = await harness.agent.cycle();

    expect(outcome).toBe('printed');
    // Отчёт «передаю драйверу» ушёл ДО передачи: без него состояние `CLAIMED`
    // перестало бы означать «принтер документа не видел».
    expect(harness.server.printingReports).toEqual(['job-1']);
    expect(harness.server.results).toEqual([
      {
        jobId: 'job-1',
        outcome: 'printed',
        errorCode: null,
        defaultPrinterName: 'HP LaserJet',
      },
    ]);

    const printed = await harness.printed();
    expect(printed).toHaveLength(1);
    expect(printed[0]?.printerName).toBe('HP LaserJet');
    // Драйверу достался настоящий PDF, а не пустой файл-заглушка.
    expect(printed[0]?.magic).toBe('%PDF-');

    const record = harness.store.get('job-1');
    expect(record?.stage).toBe('done');
    expect(record?.reported).toBe(true);

    // Человек у станка видит в окне тот же принтер и тот же исход.
    expect(harness.status().defaultPrinterName).toBe('HP LaserJet');
    expect(harness.status().lastJob?.outcome).toBe('printed');
    expect(harness.status().pendingResults).toBe(0);
  });

  it('не печатает, когда принтер по умолчанию исчез из системы', async () => {
    const harness = await createHarness();
    await harness.setPrinter({
      defaultPrinter: { name: 'HP LaserJet', offline: false },
      printFailure: 'PRINTER_NOT_FOUND',
    });
    enqueue(harness.server, 'job-2');

    expect(await harness.agent.cycle()).toBe('failed');

    expect(harness.server.results[0]?.outcome).toBe('failed');
    expect(harness.server.results[0]?.errorCode).toBe('PRINTER_NOT_FOUND');
    expect(await harness.printed()).toHaveLength(0);
  });

  it('не печатает на принтер, который не отвечает', async () => {
    const harness = await createHarness();
    await harness.setPrinter({ defaultPrinter: { name: 'HP LaserJet', offline: true } });
    enqueue(harness.server, 'job-3');

    expect(await harness.agent.cycle()).toBe('failed');

    expect(harness.server.results[0]?.errorCode).toBe('PRINTER_OFFLINE');
    expect(await harness.printed()).toHaveLength(0);
    // Отказ случился ДО передачи драйверу, поэтому сервер не должен был
    // услышать `printing`: задание остаётся безопасным для возврата в очередь.
    expect(harness.server.printingReports).toEqual([]);
  });

  it('сообщает об отсутствии принтера по умолчанию, а не печатает наугад', async () => {
    const harness = await createHarness();
    await harness.setPrinter({ defaultPrinter: null });
    enqueue(harness.server, 'job-4');

    expect(await harness.agent.cycle()).toBe('failed');

    expect(harness.server.results[0]?.errorCode).toBe('NO_DEFAULT_PRINTER');
    expect(harness.server.printingReports).toEqual([]);
    expect(await harness.printed()).toHaveLength(0);
  });

  it('печатает на принтер, выбранный к моменту КАЖДОГО задания', async () => {
    const harness = await createHarness();
    enqueue(harness.server, 'job-5a');

    expect(await harness.agent.cycle()).toBe('printed');

    // Принтер по умолчанию сменили в Windows. Ни перепривязки, ни правки
    // настройки не было — обработчик обязан узнать об этом сам.
    await harness.setPrinter({ defaultPrinter: { name: 'Kyocera у окна', offline: false } });
    enqueue(harness.server, 'job-5b');

    expect(await harness.agent.cycle()).toBe('printed');

    const printed = await harness.printed();
    expect(printed.map((entry) => entry.printerName)).toEqual(['HP LaserJet', 'Kyocera у окна']);
    expect(harness.server.results.map((entry) => entry.defaultPrinterName)).toEqual([
      'HP LaserJet',
      'Kyocera у окна',
    ]);
  });

  it('после аварии на переданном драйверу задании сообщает о неизвестном исходе и не печатает заново', async () => {
    const harness = await createHarness();
    await harness.setPrinter({
      defaultPrinter: { name: 'HP LaserJet', offline: false },
      hangAfterHandoff: true,
    });
    enqueue(harness.server, 'job-6');

    // Документ уходит «драйверу» и ответа не будет никогда: так выглядит
    // выдернутый шнур питания.
    void harness.agent.cycle();

    /*
     * Ждём именно ПОЛУЧЕНИЕ документа драйвером, а не отметку на диске.
     *
     * Отметка `handed` ставится РАНЬШЕ передачи — в этом и состоит защита:
     * запись после передачи потерялась бы при аварии ровно между ними, и
     * обработчик после перезапуска напечатал бы задание заново. Значит,
     * дождавшись отметки, мы ещё ничего не знаем о драйвере, и проверка
     * «бумага уже пошла» оказалась бы гонкой — она и падала примерно
     * в каждом третьем запуске.
     */
    await waitFor(async () => (await harness.printed()).length === 1, 'документ у драйвера');
    expect(harness.store.get('job-6')?.stage).toBe('handed');

    // Машину включили заново: новый процесс, тот же каталог.
    const restarted = await harness.restart();
    await restarted.recover();

    expect(harness.server.results).toEqual([
      {
        jobId: 'job-6',
        outcome: 'ambiguous',
        errorCode: 'AGENT_RESTARTED',
        defaultPrinterName: null,
      },
    ]);
    // Главное: второй бланк не вышел.
    expect(await harness.printed()).toHaveLength(1);
    expect(harness.store.get('job-6')?.stage).toBe('done');
  });

  it('не теряет исход, если связь пропала в момент отчёта', async () => {
    const harness = await createHarness();
    enqueue(harness.server, 'job-7');
    // Все попытки первого отчёта обрываются: клиент делает две.
    harness.server.failResults = 2;

    expect(await harness.agent.cycle()).toBe('printed');
    expect(harness.server.results).toHaveLength(0);

    const pending = harness.store.get('job-7');
    expect(pending?.result?.outcome).toBe('printed');
    expect(pending?.reported).toBe(false);

    // Связь вернулась: следующий проход досылает записанный исход.
    expect(await harness.agent.cycle()).toBe('idle');

    expect(harness.server.results).toEqual([
      { jobId: 'job-7', outcome: 'printed', errorCode: null, defaultPrinterName: 'HP LaserJet' },
    ]);
    expect(harness.store.get('job-7')?.reported).toBe(true);
    // Досылка отчёта — это не повторная печать.
    expect(await harness.printed()).toHaveLength(1);
  });

  it('не печатает второй раз задание с тем же идентификатором', async () => {
    const harness = await createHarness();
    enqueue(harness.server, 'job-8');

    expect(await harness.agent.cycle()).toBe('printed');

    // Очередь предложила тот же идентификатор снова — из-за возврата задания,
    // сбоя сервера или ручного вмешательства. Печатать его нельзя.
    enqueue(harness.server, 'job-8');
    expect(await harness.agent.cycle()).toBe('printed');

    expect(await harness.printed()).toHaveLength(1);
    expect(harness.server.results).toHaveLength(2);
    expect(harness.server.results.every((entry) => entry.outcome === 'printed')).toBe(true);
  });

  it('не отдаёт драйверу файл, который не является PDF', async () => {
    const harness = await createHarness();
    enqueue(harness.server, 'job-9', {
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from('<html><body>Требуется вход</body></html>', 'utf8'),
    });

    expect(await harness.agent.cycle()).toBe('failed');

    expect(harness.server.results[0]?.errorCode).toBe('DOCUMENT_INVALID');
    expect(harness.server.printingReports).toEqual([]);
    expect(await harness.printed()).toHaveLength(0);
  });
});
