/**
 * Деньги МоегоСклада.
 *
 * API отдаёт суммы целыми числами в минорных единицах — копейках. Единица
 * подтверждена сверкой ответа API с карточкой заказа в интерфейсе.
 *
 * Внутри системы деньги живут только как `bigint` копеек. Числа с плавающей
 * точкой не используются нигде: от этих значений зависит долг курьера,
 * а `0.1 + 0.2` в двоичной дроби не равно `0.3`.
 *
 * Наружу в JSON `bigint` отдавать нельзя — `JSON.stringify` на нём бросает
 * исключение, а приведение к `number` теряет точность на больших суммах.
 * Поэтому граница API использует десятичную строку.
 */

/** Максимум, при котором сумма ещё осмысленна: защита от испорченного ответа. */
const MAX_REASONABLE_MINOR = 1_000_000_000_000n;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Приводит значение суммы из ответа API к целым копейкам.
 *
 * Дробное значение — не «почти целое», а признак того, что представление денег
 * в API отличается от ожидаемого. Молча округлять такое нельзя.
 */
export function toMinorUnits(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return assertReasonable(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyParseError('денежное значение должно быть числом');
  }
  if (!Number.isInteger(value)) {
    throw new MoneyParseError('денежное значение обязано быть целым в минорных единицах');
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyParseError('денежное значение вне безопасного диапазона');
  }
  return assertReasonable(BigInt(value));
}

function assertReasonable(value: bigint): bigint {
  if (value < 0n) {
    throw new MoneyParseError('денежное значение не может быть отрицательным');
  }
  if (value > MAX_REASONABLE_MINOR) {
    throw new MoneyParseError('денежное значение неправдоподобно велико');
  }
  return value;
}

/**
 * Сумма к получению курьером.
 *
 * Ниже нуля не опускается: переплата не превращается в долг компании перед
 * клиентом на стороне логистики, она отмечается отдельным признаком аномалии.
 */
export function cashToCollect(sumMinor: bigint, payedSumMinor: bigint): bigint {
  const rest = sumMinor - payedSumMinor;
  return rest > 0n ? rest : 0n;
}

/** Оплачено больше, чем стоит заказ: либо переплата, либо ошибка данных. */
export function isOverpaid(sumMinor: bigint, payedSumMinor: bigint): boolean {
  return payedSumMinor > sumMinor;
}

/**
 * Десятичная строка для JSON API: `499000` → `"4990.00"`.
 * Ровно два знака после точки, без разделителей разрядов и без локали.
 */
export function toDecimalString(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const rubles = absolute / 100n;
  const kopecks = absolute % 100n;
  return `${negative ? '-' : ''}${rubles}.${kopecks.toString().padStart(2, '0')}`;
}

/** Обратное преобразование для контрактных тестов и будущего ввода. */
export function fromDecimalString(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) {
    throw new MoneyParseError('ожидается десятичная строка с двумя знаками');
  }
  const [, sign, whole, fraction = '0'] = match;
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -minor : minor;
}
