/**
 * Секреты машинного контура печати.
 *
 * Единственное место, где появляются открытый код привязки и открытый токен
 * устройства. Ни одно значение отсюда не логируется, не попадает в аудит,
 * в события realtime и не возвращается повторно: наружу уходит только
 * результат проверки.
 *
 * ДВА СЕКРЕТА С РАЗНОЙ СТОИМОСТЬЮ ПРОВЕРКИ, И ЭТО НЕ НЕПОСЛЕДОВАТЕЛЬНОСТЬ.
 * Код привязки короткий, его вводит человек, у него порядка сорока бит —
 * поэтому argon2id, как у PIN. Токен устройства — 32 случайных байта, перебор
 * невозможен, зато обработчик предъявляет его при КАЖДОМ опросе очереди:
 * argon2 сделал бы медленным каждый такой запрос, ничего не добавив к защите.
 * Ровно тот же расчёт, что у refresh-токена (`auth/crypto.ts`).
 */

import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from '@node-rs/argon2';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * `Algorithm.Argon2id` объявлен ambient const enum и недоступен при
 * `verbatimModuleSyntax`. Значение задаётся числом явно — как в `auth/crypto.ts`.
 */
const ARGON2ID = 2 as Algorithm;

/** Те же параметры, что у PIN: код короткий, стоимость подбора держится высокой. */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Алфавит кода привязки.
 *
 * Без `I`, `L`, `O`, `U`, `0` и `1`: код читают с экрана и набирают на другой
 * машине, и «ноль или буква O» — не теоретическая придирка, а провалившаяся
 * привязка, за которой следует новый код. `U` убрана, чтобы из кода не
 * складывались случайные слова.
 */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Длина кода привязки. Тридцать символов в восьми позициях — около 39 бит. */
export const PAIRING_CODE_LENGTH = 8;

/** Срок жизни кода привязки: десять минут. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Как код показывают человеку: две группы по четыре. Дефис в значение не входит. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Приводит введённое к каноническому виду.
 *
 * Человек перенесёт код с дефисом, пробелами и в нижнем регистре — это ввод,
 * а не другой код. Неоднозначные знаки НЕ исправляются: `0` не превращается
 * в `O`. Такое «исправление» вдвое сузило бы пространство кодов, а ошибку
 * ввода честнее показать отказом.
 */
export function normalizePairingCode(input: string): string {
  return input.replace(/[\s-]/gu, '').toUpperCase();
}

const PAIRING_CODE_PATTERN = new RegExp(
  `^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`,
  'u',
);

export function isValidPairingCode(value: string): boolean {
  return PAIRING_CODE_PATTERN.test(value);
}

/**
 * Генерирует код привязки криптографически стойким генератором.
 *
 * `Math.random` здесь неприменим: предсказуемый код равнозначен его отсутствию —
 * тот, кто угадал код, получает рабочее место, печатающее чужие бланки.
 *
 * `randomInt` вызывается на каждый символ, а не один раз на всё число: он даёт
 * равномерное распределение без смещения по модулю, которое возникло бы при
 * делении большого случайного числа на 30.
 */
export function generatePairingCode(): string {
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/** Хеширует код привязки с ОТДЕЛЬНЫМ pepper контура печати. */
export async function hashPairingCode(code: string, pepper: string): Promise<string> {
  return argon2Hash(code, { ...ARGON2_OPTIONS, secret: Buffer.from(pepper, 'utf8') });
}

/** Проверяет код привязки. Возвращает false вместо исключения при любом сбое. */
export async function verifyPairingCode(
  storedHash: string,
  code: string,
  pepper: string,
): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, code, {
      ...ARGON2_OPTIONS,
      secret: Buffer.from(pepper, 'utf8'),
    });
  } catch {
    return false;
  }
}

/** Длина токена устройства в байтах. */
export const DEVICE_TOKEN_BYTES = 32;

/**
 * Префикс токена устройства.
 *
 * Нужен не для разбора, а чтобы случайно попавшее в чужое поле значение было
 * опознаваемо человеком и сканером секретов (`.gitleaks.toml`).
 */
export const DEVICE_TOKEN_PREFIX = 'flpa_';

/** Токен устройства: 32 случайных байта. Информации об устройстве не несёт. */
export function generateDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

/**
 * Хеш токена устройства для хранения и поиска.
 *
 * SHA-256 достаточно и выбран сознательно: у токена 256 бит энтропии,
 * перебор невозможен, а argon2 сделал бы медленным каждый опрос очереди.
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Сравнение хешей за постоянное время.
 *
 * Поиск идёт по уникальному индексу, то есть базой, — но там, где хеш
 * сравнивается в коде, разница во времени ответа не должна подсказывать,
 * насколько предъявленный токен близок к настоящему.
 */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Извлекает токен устройства из заголовка.
 *
 * Схема `Bearer` та же, что у пользовательского доступа, но проверяет токен
 * СОВСЕМ другой код (`guard.ts`): пользовательский JWT здесь не принимается,
 * а токен устройства не принимается пользовательскими маршрутами.
 */
export function extractDeviceToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer (?<token>[A-Za-z0-9_.\-~+/=]+)$/u.exec(header);
  return match?.groups?.['token'] ?? null;
}
