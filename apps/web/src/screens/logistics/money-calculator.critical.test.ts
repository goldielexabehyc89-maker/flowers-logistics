/**
 * Критические проверки калькулятора суммы.
 *
 * Поле принимает выражение от человека, а результат уходит в неизменяемый
 * учёт. Проверяется не «складывает ли он», а то, нарушение чего стоит денег:
 * приоритет операций, копейки, отказ от отрицательных и нулевых сумм и полное
 * отсутствие исполнения произвольного кода.
 */

import { describe, expect, it } from 'vitest';
import { evaluateMoney, previewOf } from './money-calculator';

describe('калькулятор суммы', () => {
  it('складывает и вычитает как обычный калькулятор', () => {
    expect(evaluateMoney('1000+500').minor).toBe(150_000n);
    expect(evaluateMoney('1000+500=').minor).toBe(150_000n);
    expect(evaluateMoney('1000 - 250').minor).toBe(75_000n);
  });

  it('умножение и деление считаются раньше сложения', () => {
    expect(evaluateMoney('100+2*50').minor).toBe(20_000n);
    expect(evaluateMoney('(100+2)*50').minor).toBe(510_000n);
    expect(evaluateMoney('300÷2').minor).toBe(15_000n);
    expect(evaluateMoney('300×2').minor).toBe(60_000n);
  });

  it('копейки принимаются и точкой, и запятой', () => {
    expect(evaluateMoney('12,34').minor).toBe(1_234n);
    expect(evaluateMoney('12.34').minor).toBe(1_234n);
    expect(evaluateMoney('0,1+0,2').minor).toBe(30n);
  });

  it('деньги округляются до копейки один раз', () => {
    // 10 / 3 = 3,333… рубля: в учёт уходит целое число копеек.
    expect(evaluateMoney('10/3').minor).toBe(333n);
  });

  it('ноль, отрицательное и деление на ноль не принимаются', () => {
    expect(evaluateMoney('0').minor).toBeNull();
    expect(evaluateMoney('100-200').minor).toBeNull();
    expect(evaluateMoney('100/0').minor).toBeNull();
  });

  it('произвольный код не исполняется и не разбирается', () => {
    for (const input of [
      'alert(1)',
      'process.exit(1)',
      '1;drop table users',
      'globalThis',
      '__proto__',
      '1+1)',
    ]) {
      expect(evaluateMoney(input).minor).toBeNull();
      expect(evaluateMoney(input).error).not.toBeNull();
    }
  });

  it('пустое поле — не ошибка, а отсутствие ввода', () => {
    expect(evaluateMoney('   ')).toEqual({ minor: null, error: null });
    expect(previewOf('   ')).toBeNull();
  });

  it('подсказка показывает посчитанную сумму человеку', () => {
    expect(previewOf('1000+500')).toBe('1500,00 ₽');
    expect(previewOf('12,3')).toBe('12,30 ₽');
  });
});
