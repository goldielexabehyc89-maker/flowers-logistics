/**
 * Точка входа.
 *
 * Четыре команды, и каждая отвечает на вопрос, который человек у станка или
 * администратор задаёт вслух:
 *
 *   run    — «печатай» (по умолчанию: так её запускает планировщик задач);
 *   pair   — «привяжи это рабочее место к серверу»;
 *   status — «а оно вообще работает?»;
 *   unpair — «отвяжи, компьютер уезжает».
 *
 * ОТЗЫВ УСТРОЙСТВА НЕ ЗАВЕРШАЕТ ПРОГРАММУ. Администратор отзывает рабочее
 * место, чтобы выдать новый код, и человек у станка должен иметь возможность
 * ввести этот код прямо здесь. Завершись программа — пришлось бы идти к
 * планировщику задач или перезагружать машину.
 */

import { hostname, version as osVersion } from 'node:os';
import {
  agentHome,
  defaultDeviceName,
  normalizeServerUrl,
  readConfig,
  writeConfig,
  type AgentConfig,
} from './config.js';
import { createAgent, createStatusSink, DEFAULT_TIMING, type AgentStatus } from './agent.js';
import { DEFAULT_CLIENT_TIMING, PrintAgentClient } from './client.js';
import { ConfigError } from './errors.js';
import { windowsPrinterBackend } from './printer.js';
import { createSecretStore } from './secret-store.js';
import { openJobStore } from './store.js';
import { createConsoleUi, type AgentUi } from './ui.js';
import { AGENT_VERSION } from './version.js';

/** Сведения о машине, которые видит администратор. Секретов здесь нет. */
function osDescription(): string {
  return `${osVersion()}`.slice(0, 120);
}

function makeClient(serverUrl: string, token: string | null): PrintAgentClient {
  return new PrintAgentClient({ serverUrl, token, ...DEFAULT_CLIENT_TIMING });
}

/**
 * Спрашивает код и обменивает его на токен.
 *
 * Токен НИ РАЗУ не выводится и не пишется в настройку: он уходит прямо в
 * защищённое хранилище (`secret-store.ts`).
 */
async function pairInteractively(
  ui: AgentUi,
  home: string,
  config: AgentConfig,
): Promise<{ token: string; config: AgentConfig }> {
  const printer = windowsPrinterBackend();
  const secrets = createSecretStore(home);

  for (;;) {
    const code = await ui.askPairingCode();
    if (code === '') {
      ui.line('Код не введён. Получите его в разделе «Настройки → Печать».');
      continue;
    }

    // Принтер сообщается сразу при привязке, чтобы администратор увидел его
    // в списке устройств, не дожидаясь первого задания.
    const defaultPrinterName = await printer
      .resolveDefaultPrinter()
      .then((value) => value?.name ?? null)
      .catch(() => null);

    try {
      const result = await makeClient(config.serverUrl, null).pair({
        code,
        deviceName: config.deviceName,
        os: osDescription(),
        agentVersion: AGENT_VERSION,
        defaultPrinterName,
      });

      await secrets.write(result.token);
      const updated: AgentConfig = {
        serverUrl: config.serverUrl,
        deviceId: result.deviceId,
        deviceName: result.name,
      };
      await writeConfig(home, updated);

      ui.line(`Рабочее место «${result.name}» привязано.`);
      if (!result.isPrimary) {
        ui.line('Это запасное рабочее место: новые задания пока идут на основное.');
      }
      return { token: result.token, config: updated };
    } catch (error) {
      ui.line(error instanceof Error ? error.message : 'Привязка не удалась.');
      ui.line('Проверьте код и повторите. Код действует десять минут.');
    }
  }
}

async function ensureConfig(ui: AgentUi, home: string): Promise<AgentConfig> {
  const existing = await readConfig(home);
  if (existing !== null) {
    return existing;
  }

  const raw = await ui.ask('Адрес сервера (например, https://logistics.example.ru): ');
  const config: AgentConfig = {
    serverUrl: normalizeServerUrl(raw),
    deviceId: null,
    deviceName: defaultDeviceName(),
  };
  await writeConfig(home, config);
  return config;
}

async function commandRun(ui: AgentUi): Promise<number> {
  const home = agentHome();

  // Адрес сервера здесь не спрашивается. `run` запускает планировщик задач при
  // входе в систему, и вопрос, на который никто не ответит, означал бы молча
  // висящий процесс вместо печати. Адрес — решение администратора: он задаётся
  // установщиком либо командой `pair`.
  let config = await readConfig(home);
  if (config === null) {
    ui.line('Рабочее место не настроено. Выполните: florist-print-agent pair');
    return 2;
  }

  const secrets = createSecretStore(home);
  const store = await openJobStore(home);

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const status = createStatusSink((next: AgentStatus) => {
    ui.render(next);
  });

  while (!controller.signal.aborted) {
    let token = await secrets.read();
    if (token === null) {
      const paired = await pairInteractively(ui, home, config);
      token = paired.token;
      config = paired.config;
    }

    const agent = createAgent({
      client: makeClient(config.serverUrl, token),
      printer: windowsPrinterBackend(),
      store,
      status,
      home,
      os: osDescription(),
      agentVersion: AGENT_VERSION,
      timing: DEFAULT_TIMING,
    });

    await agent.run(controller.signal);

    if (controller.signal.aborted) {
      break;
    }

    // Сюда попадаем только после отзыва: токен больше ничего не открывает,
    // и держать его на диске незачем.
    if (status.current().connection === 'revoked') {
      await secrets.clear();
      ui.line('Рабочее место отключено администратором. Введите новый код привязки.');
    }
  }

  ui.line('Обработчик остановлен.');
  return 0;
}

async function commandPair(ui: AgentUi): Promise<number> {
  const home = agentHome();
  const config = await ensureConfig(ui, home);
  await pairInteractively(ui, home, config);
  return 0;
}

/**
 * Что видит человек, которого попросили «проверить, работает ли печать».
 *
 * Токена здесь нет даже в усечённом виде: показать «первые четыре знака»
 * значило бы отдать часть секрета за право не запускать программу.
 */
async function commandStatus(ui: AgentUi): Promise<number> {
  const home = agentHome();
  const config = await readConfig(home);

  if (config === null) {
    ui.line('Рабочее место не настроено. Выполните: florist-print-agent pair');
    return 1;
  }

  const paired = (await createSecretStore(home).read()) !== null;
  const store = await openJobStore(home);
  const pending = store.list().filter((record) => record.result !== null && !record.reported);

  ui.line(`Сервер:        ${config.serverUrl}`);
  ui.line(`Рабочее место: ${config.deviceName}`);
  ui.line(`Привязка:      ${paired ? 'выполнена' : 'НЕ выполнена'}`);
  ui.line(`Версия:        ${AGENT_VERSION}`);
  ui.line(`Компьютер:     ${hostname()}`);
  ui.line(`Не отправлено: ${String(pending.length)}`);

  const printer = await windowsPrinterBackend()
    .resolveDefaultPrinter()
    .catch(() => null);
  ui.line(
    `Принтер:       ${printer === null ? 'не выбран в Windows' : `${printer.name}${printer.offline ? ' (не отвечает)' : ''}`}`,
  );

  return paired ? 0 : 1;
}

/**
 * Отвязка рабочего места.
 *
 * Журнал заданий НЕ удаляется намеренно. Он и есть память о том, какие бланки
 * уже уходили на бумагу; сотри её вместе с токеном — и повторная привязка той
 * же машины позволила бы напечатать второй бланк по заданию, которое уже
 * побывало у драйвера.
 */
async function commandUnpair(ui: AgentUi): Promise<number> {
  const home = agentHome();
  await createSecretStore(home).clear();

  const config = await readConfig(home);
  if (config !== null) {
    await writeConfig(home, { ...config, deviceId: null });
  }

  ui.line('Рабочее место отвязано. Токен удалён.');
  ui.line('Задания в очереди сервера остаются: их заберёт другое рабочее место.');
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'run';
  const ui = createConsoleUi();

  try {
    switch (command) {
      case 'run':
        return await commandRun(ui);
      case 'pair':
        return await commandPair(ui);
      case 'status':
        return await commandStatus(ui);
      case 'unpair':
        return await commandUnpair(ui);
      default:
        ui.line('Команды: run (по умолчанию), pair, status, unpair.');
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      ui.line(error.message);
      return 2;
    }
    throw error;
  } finally {
    ui.close();
  }
}

process.exitCode = await main();
