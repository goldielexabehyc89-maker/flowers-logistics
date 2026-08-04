/**
 * Критическая проверка криптографии авторизации.
 *
 * Хеш PIN не должен раскрывать сам PIN, шифрование преемника обязано использовать
 * новый nonce, а подменённое значение не должно расшифровываться в валидный токен.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decryptSuccessorToken,
  encryptSuccessorToken,
  generateFourDigitCode,
  generateRefreshToken,
  hashRefreshToken,
  hashSecretCode,
  isValidFourDigitCode,
  verifySecretCode,
} from './crypto.js';

const PEPPER = 'test-pepper-not-used-anywhere-else-0123456789';

describe('коды и PIN', () => {
  it('генерирует четырёхзначные коды, включая начинающиеся с нуля', () => {
    const codes = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const code = generateFourDigitCode();
      expect(isValidFourDigitCode(code)).toBe(true);
      expect(code).toHaveLength(4);
      codes.add(code);
    }
    // Генератор не должен выдавать одно и то же значение.
    expect(codes.size).toBeGreaterThan(100);
  });

  it('хеш не содержит открытого значения и проверяется только верным кодом', async () => {
    const hash = await hashSecretCode('0417', PEPPER);

    expect(hash).not.toContain('0417');
    expect(await verifySecretCode(hash, '0417', PEPPER)).toBe(true);
    expect(await verifySecretCode(hash, '0418', PEPPER)).toBe(false);
  });

  it('без правильного pepper хеш не проверяется', async () => {
    const hash = await hashSecretCode('1234', PEPPER);
    expect(await verifySecretCode(hash, '1234', 'другой-pepper-длиной-не-меньше-32-символов')).toBe(
      false,
    );
  });

  it('одинаковые коды дают разные хеши: соль не переиспользуется', async () => {
    const first = await hashSecretCode('1234', PEPPER);
    const second = await hashSecretCode('1234', PEPPER);
    expect(first).not.toBe(second);
  });

  it('повреждённый хеш не приводит к исключению и не считается верным', async () => {
    expect(await verifySecretCode('не-хеш', '1234', PEPPER)).toBe(false);
  });
});

describe('refresh-токены', () => {
  it('токены уникальны и не хранятся в открытом виде', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      tokens.add(generateRefreshToken());
    }
    expect(tokens.size).toBe(200);

    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toBe(hashRefreshToken(token));
  });
});

describe('шифрование преемника', () => {
  const key = randomBytes(32);

  it('расшифровывается в исходный токен', () => {
    const token = generateRefreshToken();
    expect(decryptSuccessorToken(encryptSuccessorToken(token, key), key)).toBe(token);
  });

  it('использует новый nonce на каждое шифрование', () => {
    const token = generateRefreshToken();
    const first = encryptSuccessorToken(token, key);
    const second = encryptSuccessorToken(token, key);

    expect(first).not.toBe(second);
    expect(first.split('.')[0]).not.toBe(second.split('.')[0]);
  });

  it('подменённое значение не расшифровывается', () => {
    const payload = encryptSuccessorToken(generateRefreshToken(), key);
    const parts = payload.split('.');
    const tampered = [parts[0], parts[1], 'AAAA'].join('.');

    expect(decryptSuccessorToken(tampered, key)).toBeNull();
    expect(decryptSuccessorToken('мусор', key)).toBeNull();
    expect(decryptSuccessorToken(payload, randomBytes(32))).toBeNull();
  });
});
