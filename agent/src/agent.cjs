/**
 * Агент печати наклеек для Windows.
 *
 * ФОРМАТ ФАЙЛА. CommonJS, а не модуль ECMAScript: из этого файла собирается
 * одиночный `.exe` штатной сборкой Node (SEA), а она принимает только
 * CommonJS. Ради одной строки синтаксиса терять переносимый исполняемый файл
 * не стоит.
 *
 * ЧТО ОН ДЕЛАЕТ. Раз в полминуты спрашивает сервер, есть ли что печатать,
 * и отдаёт полученные байты принтеру. Всё остальное — раскладка, шрифт,
 * растеризация, порядок очереди — решает сервер: агент придётся ставить
 * на чужие компьютеры и обновлять руками, а сервер обновляется сам.
 *
 * ТОЛЬКО ИСХОДЯЩИЕ ЗАПРОСЫ. Ни одного открытого порта: это чужая машина
 * в чужой сети, и открытый порт на ней — обязательство, которое некому
 * выполнять.
 *
 * ПОЧЕМУ RAW. XP-318B понимает TSPL. Печать через драйвер превратила бы
 * готовый кадр в растр драйвера и сместила бы наклейку; сырой поток уходит
 * в принтер как есть.
 *
 * ГЛАВНОЕ ПРАВИЛО: ЛУЧШЕ НЕ НАПЕЧАТАТЬ, ЧЕМ НАПЕЧАТАТЬ ДВАЖДЫ. Отсутствие
 * наклейки видно сразу, а лишняя уезжает к покупателю на чужой коробке.
 * Поэтому любой неясный исход сообщается серверу как «неизвестно», и такое
 * задание больше не выдаётся автоматически.
 */

const { execFile } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } = require('node:fs');
const { hostname, homedir, tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

const WINDOWS = process.platform === 'win32';

/** Куда агент кладёт свои файлы. Рядом с профилем пользователя, не в Program Files. */
function stateDirectory() {
  const base = WINDOWS
    ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
    : join(homedir(), '.local', 'share');
  return join(base, 'flowers-print-agent');
}

const STATE_DIR = process.env['AGENT_STATE_DIR'] ?? stateDirectory();
const CONFIG_PATH = join(STATE_DIR, 'config.json');
const JOURNAL_PATH = join(STATE_DIR, 'processed.log');
const PENDING_PATH = join(STATE_DIR, 'pending.json');
const ERROR_PATH = join(STATE_DIR, 'last-error.txt');

/** Сколько идентификаторов помнить: журнал не должен расти вечно. */
const JOURNAL_LIMIT = 500;

function log(message) {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
}

// --- Хранение настроек -------------------------------------------------------

/**
 * Токен шифруется средствами Windows под текущего пользователя (DPAPI).
 *
 * Файл, унесённый на другой компьютер или открытый другим пользователем,
 * бесполезен. На не-Windows шифрования нет, и агент об этом прямо
 * предупреждает: там он запускается только для разработки.
 */
async function protect(value) {
  if (!WINDOWS) {
    return { scheme: 'plain', value };
  }
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `ConvertTo-SecureString -String "${value}" -AsPlainText -Force | ConvertFrom-SecureString`,
  ]);
  return { scheme: 'dpapi', value: stdout.trim() };
}

async function unprotect(stored) {
  if (stored.scheme !== 'dpapi') {
    return stored.value;
  }
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$s = ConvertTo-SecureString -String "${stored.value}"; ` +
      '[Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
      '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
  ]);
  return stdout.trim();
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// --- Журнал ------------------------------------------------------------------

function processedJobs() {
  if (!existsSync(JOURNAL_PATH)) {
    return new Set();
  }
  return new Set(
    readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
}

function rememberJob(jobId) {
  mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
  appendFileSync(JOURNAL_PATH, `${jobId}\n`);

  const all = [...processedJobs()];
  if (all.length > JOURNAL_LIMIT) {
    writeFileSync(JOURNAL_PATH, `${all.slice(-JOURNAL_LIMIT).join('\n')}\n`);
  }
}

/**
 * Отметка «задание отдано принтеру, исход неизвестен».
 *
 * Ставится ДО обращения к спулеру и снимается после ясного ответа. Если
 * компьютер выключат посередине, при следующем запуске агент увидит эту
 * отметку и честно скажет серверу «неизвестно» — вместо того чтобы
 * напечатать наклейку второй раз.
 */
function markPending(jobId) {
  mkdirSync(dirname(PENDING_PATH), { recursive: true });
  writeFileSync(PENDING_PATH, JSON.stringify({ jobId, at: new Date().toISOString() }));
}

function clearPending() {
  if (existsSync(PENDING_PATH)) {
    writeFileSync(PENDING_PATH, '');
  }
}

function readPending() {
  if (!existsSync(PENDING_PATH)) {
    return null;
  }
  const raw = readFileSync(PENDING_PATH, 'utf8').trim();
  return raw === '' ? null : JSON.parse(raw);
}

function rememberError(text) {
  mkdirSync(dirname(ERROR_PATH), { recursive: true });
  writeFileSync(ERROR_PATH, `${new Date().toISOString()}\n${text}\n`);
}

// --- Принтер -----------------------------------------------------------------

/**
 * Список установленных принтеров.
 *
 * Спрашивается у Windows, а не вводится руками: имя принтера с опечаткой
 * агент обнаружил бы только при первой печати.
 */
async function listPrinters() {
  if (!WINDOWS) {
    return [];
  }
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-Printer | Select-Object -ExpandProperty Name',
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Передача сырого потока в спулер Windows.
 *
 * Идёт мимо драйвера: `winspool.drv` принимает поток типа RAW, и принтер
 * получает ровно те байты, что собрал сервер. Печать через драйвер
 * пересобрала бы кадр и сместила наклейку на ленте.
 *
 * Вспомогательный класс объявляется прямо в PowerShell: это избавляет агента
 * от нативных зависимостей, которые пришлось бы собирать под каждую версию
 * Windows.
 */
const RAW_PRINT_SCRIPT = `
param([string]$PrinterName, [string]$FilePath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void Send(string printer, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(printer, out handle, IntPtr.Zero)) throw new Exception("OpenPrinter: " + Marshal.GetLastWin32Error());
    try {
      DOCINFO info = new DOCINFO();
      info.pDocName = "Flowers label";
      info.pDataType = "RAW";
      if (!StartDocPrinter(handle, 1, info)) throw new Exception("StartDocPrinter: " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(handle)) throw new Exception("StartPagePrinter: " + Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, buffer, bytes.Length);
          int written;
          if (!WritePrinter(handle, buffer, bytes.Length, out written)) throw new Exception("WritePrinter: " + Marshal.GetLastWin32Error());
          if (written != bytes.Length) throw new Exception("WritePrinter: передано " + written + " из " + bytes.Length);
        } finally { Marshal.FreeCoTaskMem(buffer); }
        EndPagePrinter(handle);
      } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}
"@
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($FilePath))
`;

/**
 * Отдаёт задание принтеру.
 *
 * `file:` вместо принтера — путь разработки: тот же агент, тот же протокол,
 * тот же журнал, но вместо спулера файл на диске. Так проверяется всё, кроме
 * последнего сантиметра — самого принтера, которого на машине разработчика
 * нет.
 */
async function sendToPrinter(printerName, bytes) {
  if (printerName.startsWith('file:')) {
    const directory = printerName.slice('file:'.length);
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `job-${Date.now()}-${Math.floor(bytes.length)}.bin`);
    writeFileSync(file, bytes);
    log(`  задание записано в ${file}`);
    return;
  }

  if (!WINDOWS) {
    throw new Error('печать на принтер доступна только в Windows');
  }

  const scriptPath = join(tmpdir(), `flowers-raw-print-${process.pid}.ps1`);
  const jobPath = join(tmpdir(), `flowers-job-${process.pid}.bin`);
  writeFileSync(scriptPath, RAW_PRINT_SCRIPT, 'utf8');
  writeFileSync(jobPath, bytes);

  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-PrinterName',
    printerName,
    '-FilePath',
    jobPath,
  ]);
}

// --- Обмен с сервером --------------------------------------------------------

async function callServer(config, path, body, token) {
  const response = await fetch(new URL(path, config.serverUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body ?? {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  }

  return response.json();
}

// --- Настройка при первом запуске -------------------------------------------

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nНастройка агента печати\n\n');

    const serverUrl = (await rl.question('Адрес сервера (например, https://erpget.ru): ')).trim();
    if (serverUrl === '') {
      throw new Error('адрес сервера обязателен');
    }

    const printers = await listPrinters();
    let printerName = '';

    if (printers.length === 0) {
      printerName = (await rl.question('Имя принтера (или file:C:\\labels для проверки): ')).trim();
    } else {
      process.stdout.write('\nУстановленные принтеры:\n');
      printers.forEach((name, index) => process.stdout.write(`  ${index + 1}. ${name}\n`));
      const choice = (await rl.question('\nНомер принтера: ')).trim();
      printerName = printers[Number(choice) - 1] ?? '';
      if (printerName === '') {
        throw new Error('принтер не выбран');
      }
    }

    const code = (await rl.question('Код подключения из настроек: ')).trim();

    const paired = await callServer({ serverUrl }, '/api/print-agent/pair', {
      code,
      computerName: hostname(),
      printerName,
    });

    const token = await protect(paired.token);
    writeConfig({ serverUrl, printerName, pointId: paired.pointId, token });

    process.stdout.write(`\nГотово. Точка печати: ${paired.pointName}\n`);
    if (token.scheme === 'plain') {
      process.stdout.write('ВНИМАНИЕ: вне Windows токен хранится незашифрованным.\n');
    }
    process.stdout.write(`Настройки: ${CONFIG_PATH}\n\n`);
  } finally {
    rl.close();
  }
}

// --- Рабочий цикл ------------------------------------------------------------

async function loop() {
  const config = readConfig();
  if (config === null) {
    throw new Error(`нет настроек: ${CONFIG_PATH}. Запустите агента без параметров.`);
  }

  const token = await unprotect(config.token);
  let heartbeatMs = 30_000;
  let lastError = null;
  const done = processedJobs();

  /*
   * Незавершённое задание с прошлого запуска.
   *
   * Компьютер выключили между передачей в спулер и ответом серверу. Наклейка,
   * возможно, уже вышла — печатать её снова нельзя. Сервер узнает об этом
   * как о неизвестном исходе и отдаст задание человеку на разбор.
   */
  const pending = readPending();
  if (pending !== null && pending.jobId) {
    log(`незавершённое задание ${pending.jobId}: сообщаю «исход неизвестен»`);
    try {
      await callServer(
        config,
        `/api/print-agent/jobs/${pending.jobId}/result`,
        { outcome: 'unknown' },
        token,
      );
      clearPending();
    } catch (error) {
      log(`  не удалось сообщить: ${error.message}`);
    }
  }

  log(`агент запущен, принтер: ${config.printerName}`);

  for (;;) {
    try {
      const answer = await callServer(config, '/api/print-agent/poll', { error: lastError }, token);
      heartbeatMs = answer.heartbeatMs ?? heartbeatMs;
      lastError = null;

      const job = answer.job;
      if (job === null || job === undefined) {
        await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
        continue;
      }

      if (job.jobId !== null && done.has(job.jobId)) {
        // Это задание уже печаталось на этом компьютере: сервер выдал его
        // повторно после обрыва связи. Второй наклейки быть не должно.
        log(`задание ${job.jobId} уже печаталось: сообщаю «исход неизвестен»`);
        await callServer(
          config,
          `/api/print-agent/jobs/${job.jobId}/result`,
          { outcome: 'unknown' },
          token,
        );
        continue;
      }

      const bytes = Buffer.from(job.tspl, 'base64');
      log(
        `печать: ${job.kind}${job.jobId === null ? '' : ` (${job.jobId})`}, ${bytes.length} байт`,
      );

      if (job.jobId !== null) {
        markPending(job.jobId);
      }

      try {
        await sendToPrinter(config.printerName, bytes);
        if (job.jobId !== null) {
          rememberJob(job.jobId);
          await callServer(
            config,
            `/api/print-agent/jobs/${job.jobId}/result`,
            { outcome: 'sent' },
            token,
          );
          clearPending();
        }
        log('  передано принтеру');
      } catch (error) {
        /*
         * Спулер отказал — значит, он ничего и не напечатал.
         *
         * Такой исход честно называется отказом: сервер выдаст задание снова.
         * Отметка «неизвестно» осталась бы только если бы мы не смогли даже
         * сообщить об отказе.
         */
        lastError = error.message;
        rememberError(error.message);
        log(`  ОШИБКА: ${error.message}`);
        if (job.jobId !== null) {
          await callServer(
            config,
            `/api/print-agent/jobs/${job.jobId}/result`,
            { outcome: 'failed' },
            token,
          );
          clearPending();
        }
      }
    } catch (error) {
      lastError = error.message;
      rememberError(error.message);
      log(`связь с сервером: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, heartbeatMs));
    }
  }
}

// --- Точка входа -------------------------------------------------------------

async function main() {
  const command = process.argv[2] ?? '';

  if (command === '--setup' || readConfig() === null) {
    await setup();
    if (command === '--setup') {
      return;
    }
  }
  await loop();
}

main().catch((error) => {
  process.stderr.write(`\nОшибка: ${error.message}\n`);
  rememberError(error.message);
  process.exit(1);
});
