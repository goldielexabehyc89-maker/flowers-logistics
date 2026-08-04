/**
 * Криптографические примитивы авторизации.
 *
 * Единственное место, где появляются открытые PIN, коды и refresh-токены.
 * Ни одно значение отсюда не логируется, не попадает в аудит и не возвращается
 * повторно: наружу уходит только результат проверки.
 */

import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * `Algorithm.Argon2id` из @node-rs/argon2 объявлен как ambient const enum и недоступен
 * при `verbatimModuleSyntax`. Значение задаётся числом явно: полагаться на умолчание
 * библиотеки в параметре безопасности не стоит.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Параметры argon2id. PIN состоит всего из четырёх цифр, поэтому стоимость подбора
 * держится высокой намеренно: вместе с прогрессивной блокировкой это основная защита.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Длина PIN и одноразового кода активации. Ведущий ноль значим. */
export const SECRET_CODE_LENGTH = 4;
const SECRET_CODE_PATTERN = /^\d{4}$/;

export function isValidFourDigitCode(value: string): boolean {
  return SECRET_CODE_PATTERN.test(value);
}

/**
 * Генерирует четырёхзначный код криптографически стойким генератором.
 * `Math.random` здесь неприменим: предсказуемый код активации равнозначен его отсутствию.
 */
export function generateFourDigitCode(): string {
  return String(randomInt(0, 10_000)).padStart(SECRET_CODE_LENGTH, '0');
}

/** Хеширует PIN или код активации с серверным pepper. */
export async function hashSecretCode(code: string, pepper: string): Promise<string> {
  return argon2Hash(code, { ...ARGON2_OPTIONS, secret: Buffer.from(pepper, 'utf8') });
}

/** Проверяет PIN или код активации. Возвращает false вместо исключения при любом сбое. */
export async function verifySecretCode(
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

/**
 * Refresh-токен: 32 случайных байта. Значение непрозрачное, никакой информации
 * о пользователе не несёт и в базе не хранится в открытом виде.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Хеш refresh-токена для хранения и поиска.
 *
 * SHA-256 достаточно и выбран сознательно: токен имеет 256 бит энтропии,
 * перебор невозможен, а argon2 сделал бы каждый запрос обновления медленным.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const AES_IV_LENGTH = 12;

/**
 * Шифрует токен-преемник для grace-окна (AES-256-GCM, новый nonce на каждое шифрование).
 * Формат: `base64url(iv).base64url(authTag).base64url(ciphertext)`.
 */
export function encryptSuccessorToken(token: string, key: Buffer): string {
  const iv = randomBytes(AES_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Расшифровывает токен-преемник. Возвращает null при любой ошибке, в том числе
 * при неверном authTag: подменённое значение не должно выдаваться за валидный токен.
 */
export function decryptSuccessorToken(payload: string, key: Buffer): string | null {
  try {
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (ivPart === undefined || tagPart === undefined || dataPart === undefined) {
      return null;
    }

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Хеш-«пустышка» для неизвестного телефона.
 *
 * Без неё ответ на несуществующий номер приходил бы заметно быстрее, чем на неверный PIN,
 * и телефоны сотрудников можно было бы перебрать по времени ответа. Значение считается
 * один раз при старте от случайных данных, поэтому подобрать код к нему нельзя.
 */
export async function createDummyPinHash(pepper: string): Promise<string> {
  return hashSecretCode(generateFourDigitCode(), pepper);
}
