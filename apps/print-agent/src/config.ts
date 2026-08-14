/**
 * Настройка рабочего места.
 *
 * В файле лежит РОВНО ТО, ЧТО НЕ ЯВЛЯЕТСЯ СЕКРЕТОМ: адрес сервера, выданный
 * сервером идентификатор устройства и имя, под которым машина видна
 * администратору. Токен устройства сюда не попадает никогда — он хранится
 * отдельно и в защищённом виде (`secret-store.ts`).
 *
 * ПРИНТЕРА В НАСТРОЙКАХ НЕТ И НЕ БУДЕТ. Принтер по умолчанию выбирают в
 * Windows, и обработчик читает его перед каждой печатью. Появись он здесь —
 * смена принтера у станка требовала бы правки файла на диске, то есть вызова
 * администратора; а забытая старая запись однажды отправила бы бланк на
 * принтер, которого в этой комнате уже нет.
 */

import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-file.js';
import { ConfigError } from './errors.js';

/** Каталог рабочего места. Имя совпадает с тем, что создаёт `install.ps1`. */
export const AGENT_DIR_NAME = 'FloristPrintAgent';

/**
 * Переопределение каталога.
 *
 * Нужно проверкам и обслуживанию: без него единственный способ проверить
 * поведение при перезапуске — писать в настоящий профиль пользователя.
 */
export const AGENT_HOME_ENV = 'FLORIST_PRINT_AGENT_HOME';

export interface AgentConfig {
  /** Origin сервера: схема, хост и порт. Пути, запроса и якоря быть не может. */
  serverUrl: string;
  /** Выдан сервером при привязке. До привязки — `null`. */
  deviceId: string | null;
  /** Имя рабочего места, как его видит администратор в настройках. */
  deviceName: string;
}

export function agentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_HOME_ENV];
  if (override !== undefined && override.trim() !== '') {
    return override;
  }

  const localAppData = env['LOCALAPPDATA'];
  if (localAppData !== undefined && localAppData.trim() !== '') {
    return join(localAppData, AGENT_DIR_NAME);
  }

  // Вне Windows каталог нужен только проверкам и разработке: рабочие места
  // цветочного склада — Windows, и `%LOCALAPPDATA%` там есть всегда.
  return join(homedir(), '.florist-print-agent');
}

export function configPath(home: string): string {
  return join(home, 'config.json');
}

/**
 * Приводит введённый адрес к origin и отвергает всё остальное.
 *
 * ПУТЬ В АДРЕСЕ ЗАПРЕЩЁН СОЗНАТЕЛЬНО. Пути документов приходят от сервера
 * относительными и приклеиваются к этому адресу. Разреши мы здесь
 * `https://сервер/что-нибудь`, склейка дала бы неожиданный адрес, а проверка
 * «путь начинается с /api/print-agent/» перестала бы означать то, что
 * означает. Логин с паролем в адресе запрещены по той же причине: они утекли
 * бы в каждый запрос и в каждое сообщение об ошибке.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new ConfigError('Адрес сервера не задан.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError('Адрес сервера не разобран. Пример: https://logistics.example.ru');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('Адрес сервера должен начинаться с http:// или https://');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError('Логин и пароль в адресе сервера не поддерживаются.');
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigError('В адресе сервера допустимы только схема, имя и порт.');
  }

  return parsed.origin;
}

/** Имя рабочего места по умолчанию: сетевое имя машины. */
export function defaultDeviceName(): string {
  const name = hostname().trim();
  // Сервер принимает не более 120 знаков и отвергает пустое имя.
  return name === '' ? 'Рабочее место печати' : name.slice(0, 120);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Читает настройку. Отсутствие файла — не ошибка: машина ещё не привязана.
 *
 * Испорченный файл — ошибка, и намеренно громкая. Молча подставить умолчания
 * значило бы начать опрашивать не тот сервер и печатать чужие бланки.
 */
export async function readConfig(home: string): Promise<AgentConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), 'utf8');
  } catch (error) {
    if (isObject(error) && error['code'] === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('Файл настройки повреждён. Выполните привязку заново: команда pair.');
  }

  if (!isObject(parsed)) {
    throw new ConfigError('Файл настройки повреждён. Выполните привязку заново: команда pair.');
  }

  const serverUrl = readString(parsed, 'serverUrl');
  if (serverUrl === null) {
    throw new ConfigError('В файле настройки не задан адрес сервера.');
  }

  return {
    serverUrl: normalizeServerUrl(serverUrl),
    deviceId: readString(parsed, 'deviceId'),
    deviceName: readString(parsed, 'deviceName') ?? defaultDeviceName(),
  };
}

export async function writeConfig(home: string, config: AgentConfig): Promise<void> {
  const payload: AgentConfig = {
    serverUrl: normalizeServerUrl(config.serverUrl),
    deviceId: config.deviceId,
    deviceName: config.deviceName,
  };
  await writeFileAtomic(configPath(home), `${JSON.stringify(payload, null, 2)}\n`);
}
