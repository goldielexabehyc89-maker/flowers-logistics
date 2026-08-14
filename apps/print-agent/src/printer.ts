/**
 * Печать средствами операционной системы.
 *
 * ПРИНТЕР ПО УМОЛЧАНИЮ ЧИТАЕТСЯ КАЖДЫЙ РАЗ И НИГДЕ НЕ ЗАПОМИНАЕТСЯ. Это не
 * бережливость, а требование: у станка меняют принтер, и после такой замены
 * не должно требоваться ни новой привязки, ни правки файла, ни звонка
 * администратору. Кэш здесь означал бы бланк, ушедший на принтер, которого
 * в комнате уже нет, — и никто бы этого не заметил, потому что задание
 * закрылось бы как напечатанное.
 *
 * ВСЁ ЗАПУСКАЕТСЯ СПИСКОМ АРГУМЕНТОВ, БЕЗ ОБОЛОЧКИ. Имя принтера в Windows
 * содержит пробелы, кавычки, скобки и кириллицу, путь к файлу — тоже. Собери
 * мы строку команды, эти знаки стали бы разделителями, и «Ricoh (2 этаж) &
 * копир» превратился бы в команду. `shell: true` здесь не появится никогда.
 */

import { execFile } from 'node:child_process';
import { access, constants, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ERROR_CODES, PrintFailure, type AgentErrorCode } from './errors.js';

export interface DefaultPrinter {
  name: string;
  /** Принтер числится, но не отвечает: выключен, отключён или снят с сети. */
  offline: boolean;
}

export interface PrinterBackend {
  /** Принтер по умолчанию НА ЭТОТ МОМЕНТ. `null` — в системе он не назначен. */
  resolveDefaultPrinter(): Promise<DefaultPrinter | null>;
  /** Передаёт готовый файл драйверу. Возврат означает «драйвер принял». */
  printPdf(filePath: string, printerName: string): Promise<void>;
}

/** Сколько ждём внешнюю программу. Дальше это уже зависший драйвер. */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * `PrinterStatus` = 7 в `Win32_Printer` означает Offline.
 *
 * Проверяются оба признака — и `WorkOffline`, и статус: первый выставляет
 * пользователь пунктом «Работать автономно», второй — сама система, когда
 * устройство перестало отвечать. Пропусти мы любой из них, документ ушёл бы
 * в очередь Windows и остался бы там до вечера, а задание закрылось бы
 * успехом.
 */
const PRINTER_STATUS_OFFLINE = 7;

interface CommandResult {
  stdout: string;
  code: number | null;
}

function runCommand(file: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error === null) {
          resolve({ stdout, code: 0 });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        // Причина сохраняется как `cause`, но в сообщение не попадает:
        // текст драйвера уходил бы на экран флориста и в базу.
        reject(
          new PrintFailure('PRINTER_ERROR', 'Внешняя программа печати завершилась с ошибкой.', {
            cause: { file, code },
          }),
        );
      },
    );
  });
}

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'] as const;

/**
 * Запрос принтера по умолчанию.
 *
 * `-Filter "Default = TRUE"` отбирает ровно один объект, `Select-Object -First 1`
 * гарантирует, что `ConvertTo-Json` вернёт объект, а не то объект, то массив.
 * Скрипт — константа: подставлять в него нечего.
 */
const DEFAULT_PRINTER_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Get-CimInstance -ClassName Win32_Printer -Filter "Default = TRUE"',
  ' | Select-Object -First 1 Name, WorkOffline, PrinterStatus',
  ' | ConvertTo-Json -Compress',
].join('');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface WindowsPrinterOptions {
  /**
   * Программа печати PDF, заданная администратором.
   *
   * Проверяется первой: на складе может стоять корпоративная сборка в
   * нестандартном каталоге, и подбор «по известным местам» её не найдёт.
   */
  pdfHelperPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Где искать программу бездиалоговой печати PDF.
 *
 * Порядок не случаен: SumatraPDF печатает молча, завершается сама и не держит
 * окно; Adobe Reader умеет то же, но медленнее и охотнее показывает диалоги.
 * Ставить Adobe первым значило бы получить всплывающее окно на компьютере,
 * за которым никто не сидит.
 */
function pdfHelperCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'] ?? '';

  const candidates = [
    join(programFiles, 'SumatraPDF', 'SumatraPDF.exe'),
    join(programFilesX86, 'SumatraPDF', 'SumatraPDF.exe'),
    join(programFiles, 'Adobe', 'Acrobat DC', 'Acrobat', 'Acrobat.exe'),
    join(programFilesX86, 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe'),
    join(programFilesX86, 'Adobe', 'Reader 11.0', 'Reader', 'AcroRd32.exe'),
  ];

  if (localAppData !== '') {
    // Установка «только для меня»: у пользователя склада часто нет прав
    // администратора, и SumatraPDF попадает именно сюда.
    candidates.splice(2, 0, join(localAppData, 'SumatraPDF', 'SumatraPDF.exe'));
  }

  return candidates;
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const candidate of paths) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function isSumatra(helperPath: string): boolean {
  return helperPath.toLowerCase().endsWith('sumatrapdf.exe');
}

/**
 * Аргументы печати для найденной программы.
 *
 * Массив, а не строка. Имя принтера и путь к файлу попадают отдельными
 * элементами и никакому разбору не подвергаются.
 */
function helperArgs(helperPath: string, filePath: string, printerName: string): string[] {
  if (isSumatra(helperPath)) {
    return ['-print-to', printerName, '-silent', '-exit-when-done', filePath];
  }
  // Adobe: `/N` — новое окно без вкладок, `/T` — печать на указанный принтер
  // с последующим выходом. Порядок аргументов у Adobe фиксирован.
  return ['/N', '/T', filePath, printerName];
}

export function windowsPrinterBackend(options: WindowsPrinterOptions = {}): PrinterBackend {
  const env = options.env ?? process.env;

  return {
    async resolveDefaultPrinter(): Promise<DefaultPrinter | null> {
      let stdout: string;
      try {
        stdout = (
          await runCommand('powershell.exe', [
            ...POWERSHELL_ARGS,
            '-Command',
            DEFAULT_PRINTER_SCRIPT,
          ])
        ).stdout;
      } catch (error) {
        // Класс `Win32_Printer` обслуживает диспетчер печати. Если сам запрос
        // не выполнился, упала служба, а не «принтера нет»: сообщить об
        // отсутствии принтера значило бы предложить человеку искать несуществующую
        // причину.
        throw new PrintFailure('SPOOLER_UNAVAILABLE', 'Служба печати Windows не ответила.', {
          cause: error,
        });
      }

      const trimmed = stdout.trim();
      if (trimmed === '') {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new PrintFailure('SPOOLER_UNAVAILABLE', 'Служба печати ответила неразборчиво.', {
          cause: error,
        });
      }

      if (!isObject(parsed)) {
        return null;
      }

      const name = parsed['Name'];
      if (typeof name !== 'string' || name.trim() === '') {
        return null;
      }

      const status = parsed['PrinterStatus'];
      return {
        name: name.trim(),
        offline:
          parsed['WorkOffline'] === true ||
          (typeof status === 'number' && status === PRINTER_STATUS_OFFLINE),
      };
    },

    async printPdf(filePath: string, printerName: string): Promise<void> {
      const configured = options.pdfHelperPath;
      const candidates =
        configured === undefined || configured.trim() === ''
          ? pdfHelperCandidates(env)
          : [configured.trim(), ...pdfHelperCandidates(env)];

      const helper = await firstExisting(candidates);
      if (helper === null) {
        // Отказ ДО передачи документа: бумага заведомо не выходила, и сервер
        // вправе вернуть задание в очередь, когда программу поставят.
        throw new PrintFailure(
          'PRINT_HELPER_MISSING',
          'Программа бездиалоговой печати PDF не найдена.',
        );
      }

      await runCommand(helper, helperArgs(helper, filePath, printerName));
    },
  };
}

/**
 * Поддельный принтер, управляемый файлом.
 *
 * Нужен затем, что проверить главные свойства обработчика на настоящем
 * принтере нельзя: «после аварии бланк не печатается второй раз» и «принтер
 * сменили между двумя заданиями» — это состояния, которые на живом железе
 * воспроизводятся вручную, по одному разу и без свидетелей.
 *
 * Управляющий файл читается ПЕРЕД КАЖДЫМ обращением, а не при создании: это
 * тот же порядок, что у настоящего бэкенда, и именно он позволяет менять
 * принтер между заданиями, ничего не перезапуская.
 *
 * Отпечатанное пишется в отдельный файл: смешай мы его с управляющим,
 * проверка затирала бы собственные наблюдения при следующей настройке.
 */
export interface FakePrinterControl {
  /** `null` — принтера по умолчанию в системе нет вовсе. */
  defaultPrinter: DefaultPrinter | null;
  /** Чем обрывается передача документа драйверу. `null` — печать удаётся. */
  printFailure: AgentErrorCode | null;
  /**
   * Зависнуть сразу после передачи документа драйверу.
   *
   * Так воспроизводится единственное по-настоящему опасное состояние: документ
   * у драйвера, исход неизвестен, питание пропало.
   */
  hangAfterHandoff: boolean;
}

export interface FakePrintedDocument {
  printerName: string;
  bytes: number;
  /** Первые знаки файла: проверка получает доказательство, что печатался PDF. */
  magic: string;
}

export interface FakePrinterOptions {
  controlPath: string;
  logPath: string;
}

function parseFailureCode(value: unknown): AgentErrorCode | null {
  // Управляющий файл пишет проверка, но опечатка в коде не должна
  // притворяться настоящим отказом принтера: неизвестное значение — ошибка.
  if (typeof value !== 'string') {
    return null;
  }
  const known = AGENT_ERROR_CODES.find((code) => code === value);
  if (known === undefined) {
    throw new Error(`unknown fake printer failure code: ${value}`);
  }
  return known;
}

export function fakePrinterBackend(options: FakePrinterOptions): PrinterBackend {
  const readControl = async (): Promise<FakePrinterControl> => {
    const parsed: unknown = JSON.parse(await readFile(options.controlPath, 'utf8'));
    if (!isObject(parsed)) {
      throw new Error('fake printer control file is not an object');
    }
    const printer = parsed['defaultPrinter'];
    return {
      defaultPrinter:
        isObject(printer) && typeof printer['name'] === 'string'
          ? { name: printer['name'], offline: printer['offline'] === true }
          : null,
      printFailure: parseFailureCode(parsed['printFailure']),
      hangAfterHandoff: parsed['hangAfterHandoff'] === true,
    };
  };

  return {
    async resolveDefaultPrinter(): Promise<DefaultPrinter | null> {
      return (await readControl()).defaultPrinter;
    },

    async printPdf(filePath: string, printerName: string): Promise<void> {
      const control = await readControl();

      if (control.printFailure !== null) {
        // Отказ ДО записи в журнал: проверка обязана видеть, что документ
        // на бумагу не пошёл.
        throw new PrintFailure(control.printFailure, 'Поддельный принтер отказал.');
      }

      const bytes = await readFile(filePath);
      const printed: FakePrintedDocument[] = await readFile(options.logPath, 'utf8')
        .then((raw) => JSON.parse(raw) as FakePrintedDocument[])
        .catch(() => []);

      printed.push({
        printerName,
        bytes: bytes.byteLength,
        magic: bytes.subarray(0, 5).toString('latin1'),
      });
      await writeFile(options.logPath, JSON.stringify(printed), 'utf8');

      if (control.hangAfterHandoff) {
        // Документ у «драйвера», ответа не будет никогда: ровно то положение,
        // из которого обработчик выносят выключением питания.
        return new Promise<void>(() => undefined);
      }
    },
  };
}
