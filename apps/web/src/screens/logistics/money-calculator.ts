/**
 * Безопасный калькулятор денежной суммы.
 *
 * Логист складывает чеки прямо в поле: «1000+500» должно давать 1500. Разбор
 * написан вручную рекурсивным спуском — `eval` и конструктор `Function` здесь
 * запрещены: это исполнение произвольного кода из поля ввода, и цена ошибки
 * здесь — деньги и чужой браузер.
 *
 * Результат отдаётся в целых минорных единицах: рубли с копейками существуют
 * только на экране, а в учёт уходит целое число.
 */

/** Что понял калькулятор. `minor === null` — считать нечего или ошибка. */
export interface MoneyExpression {
  minor: bigint | null;
  error: string | null;
}

interface Token {
  kind: 'number' | 'operator' | 'open' | 'close';
  value: string;
}

/** Знаки умножения и деления пишут по-разному: принимаются оба варианта. */
const OPERATORS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '–': '-',
  '*': '*',
  '×': '*',
  х: '*',
  x: '*',
  '/': '/',
  '÷': '/',
  ':': '/',
};

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] ?? '';

    if (char === ' ' || char === ' ') {
      index += 1;
      continue;
    }

    if (/[0-9]/.test(char) || char === ',' || char === '.') {
      let number = '';
      while (index < input.length && /[0-9.,]/.test(input[index] ?? '')) {
        number += input[index] === ',' ? '.' : input[index];
        index += 1;
      }
      // Две точки в одном числе — это не число, а опечатка.
      if ((number.match(/\./g) ?? []).length > 1) {
        return null;
      }
      tokens.push({ kind: 'number', value: number });
      continue;
    }

    if (char === '(') {
      tokens.push({ kind: 'open', value: '(' });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ kind: 'close', value: ')' });
      index += 1;
      continue;
    }

    const operator = OPERATORS[char.toLowerCase()];
    if (operator !== undefined) {
      tokens.push({ kind: 'operator', value: operator });
      index += 1;
      continue;
    }

    // Знак «=» человек ставит в конце по привычке: он ничего не меняет.
    if (char === '=') {
      index += 1;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * Рекурсивный спуск: сумма → произведение → множитель.
 *
 * Приоритет операций задаётся структурой разбора, а не таблицей: так его
 * видно глазами и невозможно перепутать местами.
 */
function parse(tokens: readonly Token[]): number | null {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  const parseFactor = (): number | null => {
    const token = peek();
    if (token === undefined) {
      return null;
    }

    if (token.kind === 'operator' && (token.value === '-' || token.value === '+')) {
      position += 1;
      const value = parseFactor();
      if (value === null) {
        return null;
      }
      return token.value === '-' ? -value : value;
    }

    if (token.kind === 'open') {
      position += 1;
      const value = parseSum();
      if (value === null || peek()?.kind !== 'close') {
        return null;
      }
      position += 1;
      return value;
    }

    if (token.kind === 'number') {
      position += 1;
      const value = Number(token.value);
      return Number.isFinite(value) ? value : null;
    }

    return null;
  };

  const parseProduct = (): number | null => {
    let left = parseFactor();
    if (left === null) {
      return null;
    }

    while (peek()?.kind === 'operator' && ['*', '/'].includes(peek()?.value ?? '')) {
      const operator = peek()?.value ?? '';
      position += 1;
      const right = parseFactor();
      if (right === null) {
        return null;
      }
      if (operator === '/' && right === 0) {
        return null;
      }
      left = operator === '*' ? left * right : left / right;
    }

    return left;
  };

  const parseSum = (): number | null => {
    let left = parseProduct();
    if (left === null) {
      return null;
    }

    while (peek()?.kind === 'operator' && ['+', '-'].includes(peek()?.value ?? '')) {
      const operator = peek()?.value ?? '';
      position += 1;
      const right = parseProduct();
      if (right === null) {
        return null;
      }
      left = operator === '+' ? left + right : left - right;
    }

    return left;
  };

  const result = parseSum();
  return result === null || position !== tokens.length ? null : result;
}

/**
 * Разбор суммы.
 *
 * Ноль и отрицательный результат отвергаются: направление операции задаёт
 * столбец таблицы, а не знак в поле. Отрицательная сумма в поле означала бы,
 * что одна и та же операция может означать противоположное.
 */
export function evaluateMoney(input: string): MoneyExpression {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { minor: null, error: null };
  }

  const tokens = tokenize(trimmed);
  if (tokens === null || tokens.length === 0) {
    return { minor: null, error: 'Понимаю только числа, + − × ÷ и скобки.' };
  }

  const value = parse(tokens);
  if (value === null || !Number.isFinite(value)) {
    return { minor: null, error: 'Выражение не сходится: проверьте скобки и знаки.' };
  }

  // Копейки округляются один раз и здесь: дальше живёт целое число.
  const minor = Math.round((value + Number.EPSILON) * 100);
  if (minor <= 0) {
    return { minor: null, error: 'Сумма должна быть больше нуля.' };
  }
  if (!Number.isSafeInteger(minor)) {
    return { minor: null, error: 'Сумма слишком большая.' };
  }

  return { minor: BigInt(minor), error: null };
}

/** Подсказка под полем: показывает, что именно посчитано. */
export function previewOf(input: string): string | null {
  const result = evaluateMoney(input);
  if (result.minor === null) {
    return null;
  }
  return `${(Number(result.minor) / 100).toFixed(2).replace('.', ',')} ₽`;
}
