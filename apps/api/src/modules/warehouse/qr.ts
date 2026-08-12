/**
 * Генерация QR-этикетки складской ячейки.
 *
 * Кодировщик написан здесь, а не взят зависимостью, по двум причинам. Первая:
 * этикетка обязана кодировать РОВНО код ячейки — ни URL, ни внутреннего UUID,
 * ни токена, — и проверить это можно только у кода, который читается целиком.
 * Вторая: одна строка в `package-lock.json` в ветке, идущей параллельно чужой,
 * стоит дороже трёхсот строк детерминированной арифметики.
 *
 * Реализовано подмножество ISO/IEC 18004, которого достаточно для кода ячейки:
 * режим байтов, уровень коррекции M, версии 1–6. Версии 7 и выше сюда не
 * входят намеренно — они требуют блока информации о версии, а код длиной
 * до 48 символов до них не дорастает даже в кириллице.
 *
 * Генерация детерминированная: один и тот же код всегда даёт один и тот же
 * рисунок, поэтому этикетку можно перепечатать и сверить.
 */

import { AppError } from '../../platform/errors.js';

/** Уровень коррекции M: два бита индикатора формата. */
const ECC_LEVEL_BITS = 0b00;

interface VersionSpec {
  version: number;
  /** Всего кодовых слов в символе. */
  totalCodewords: number;
  /** Кодовых слов коррекции на блок. */
  eccPerBlock: number;
  /** Блоки данных: [сколько блоков, кодовых слов данных в каждом]. */
  blocks: readonly (readonly [number, number])[];
  /** Центры выравнивающих узоров. Версия 1 их не имеет. */
  alignment: readonly number[];
}

/**
 * Таблица версий для уровня M. Значения — из стандарта; проверяются тестом
 * на согласованность: сумма блоков и коррекции обязана дать общее число слов.
 */
const VERSIONS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, eccPerBlock: 10, blocks: [[1, 16]], alignment: [] },
  { version: 2, totalCodewords: 44, eccPerBlock: 16, blocks: [[1, 28]], alignment: [6, 18] },
  { version: 3, totalCodewords: 70, eccPerBlock: 26, blocks: [[1, 44]], alignment: [6, 22] },
  { version: 4, totalCodewords: 100, eccPerBlock: 18, blocks: [[2, 32]], alignment: [6, 26] },
  { version: 5, totalCodewords: 134, eccPerBlock: 24, blocks: [[2, 43]], alignment: [6, 30] },
  { version: 6, totalCodewords: 172, eccPerBlock: 16, blocks: [[4, 27]], alignment: [6, 34] },
];

function dataCapacity(spec: VersionSpec): number {
  return spec.blocks.reduce((sum, [count, data]) => sum + count * data, 0);
}

/** Байтовый режим: 4 бита режима и 8 бит длины укладываются в два кодовых слова. */
function byteCapacity(spec: VersionSpec): number {
  return dataCapacity(spec) - 2;
}

// --- Арифметика GF(256) -----------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    // Примитивный многочлен x^8 + x^4 + x^3 + x^2 + 1.
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    EXP[i] = EXP[i - 255] ?? 0;
  }
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0;
}

/** Порождающий многочлен кода Рида — Соломона для `degree` проверочных слов. */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ gfMultiply(poly[j] ?? 0, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }

  return remainder;
}

// --- Поток данных -----------------------------------------------------------

function selectVersion(byteLength: number): VersionSpec {
  const spec = VERSIONS.find((candidate) => byteCapacity(candidate) >= byteLength);
  if (spec === undefined) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'qr payload does not fit supported versions',
      publicMessage: 'Код ячейки слишком длинный для этикетки.',
    });
  }
  return spec;
}

/**
 * Кодовые слова символа: данные и коррекция, разложенные по блокам
 * и перемешанные в порядке, который требует стандарт.
 *
 * Чередование обязательно: без него потеря одного куска этикетки уничтожила бы
 * целый блок целиком, а смысл коррекции в том, чтобы повреждение размазалось
 * по всем блокам.
 */
export function buildCodewords(text: string, spec: VersionSpec = selectVersion(utf8(text).length)) {
  const payload = utf8(text);
  const bits: number[] = [];

  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  };

  push(0b0100, 4); // режим байтов
  push(payload.length, 8); // счётчик символов: версии 1–9 используют 8 бит
  for (const byte of payload) {
    push(byte, 8);
  }

  const capacityBits = dataCapacity(spec) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) {
    bits.push(0);
  }
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      byte = (byte << 1) | (bits[i + j] ?? 0);
    }
    dataBytes.push(byte);
  }

  // Заполнители стандарта: чередующиеся 0xEC и 0x11.
  const padding = [0xec, 0x11];
  let paddingIndex = 0;
  while (dataBytes.length < dataCapacity(spec)) {
    dataBytes.push(padding[paddingIndex % 2] ?? 0);
    paddingIndex += 1;
  }

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of spec.blocks) {
    for (let i = 0; i < count; i += 1) {
      const block = dataBytes.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      eccBlocks.push(errorCorrection(block, spec.eccPerBlock));
    }
  }

  const interleaved: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        interleaved.push(block[i] ?? 0);
      }
    }
  }
  for (let i = 0; i < spec.eccPerBlock; i += 1) {
    for (const block of eccBlocks) {
      interleaved.push(block[i] ?? 0);
    }
  }

  return { spec, codewords: interleaved };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// --- Матрица ----------------------------------------------------------------

type Grid = (boolean | null)[][];

function placeFunctionPatterns(grid: Grid, spec: VersionSpec): void {
  const size = grid.length;

  const finder = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) {
          continue;
        }
        const inRing =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        (grid[y] ?? [])[x] = inRing || inCore;
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Синхронизирующие дорожки.
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    (grid[6] ?? [])[i] = dark;
    (grid[i] ?? [])[6] = dark;
  }

  // Выравнивающие узоры. Пересечения с поисковыми пропускаются.
  for (const row of spec.alignment) {
    for (const col of spec.alignment) {
      const nearFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (nearFinder) {
        continue;
      }
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          (grid[row + r] ?? [])[col + c] = ring !== 1;
        }
      }
    }
  }

  // Тёмный модуль: всегда чёрный, всегда в одном месте.
  (grid[size - 8] ?? [])[8] = true;

  // Резерв под информацию о формате.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      (grid[8] ?? [])[i] = (grid[8] ?? [])[i] ?? false;
      (grid[i] ?? [])[8] = (grid[i] ?? [])[8] ?? false;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    (grid[8] ?? [])[size - 1 - i] = (grid[8] ?? [])[size - 1 - i] ?? false;
    (grid[size - 1 - i] ?? [])[8] = (grid[size - 1 - i] ?? [])[8] ?? false;
  }
}

/** Модули, зарезервированные под служебные узоры и формат. */
function functionMask(spec: VersionSpec, size: number): boolean[][] {
  const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  placeFunctionPatterns(grid, spec);
  return grid.map((row) => row.map((cell) => cell !== null));
}

const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Порядок обхода модулей данных: снизу вверх парами столбцов справа налево,
 * с разворотом на каждой паре. Столбец синхронизации пропускается целиком.
 *
 * Функция вынесена отдельно и используется и записью, и проверкой: обход —
 * самое лёгкое место для незаметной ошибки, и он обязан быть один.
 */
export function dataModuleOrder(size: number, reserved: readonly boolean[][]): [number, number][] {
  const order: [number, number][] = [];
  let upward = true;
  let right = size - 1;

  while (right >= 1) {
    // Столбец 6 занят синхронизирующей дорожкой целиком. Пара сдвигается на него
    // ЦЕЛИКОМ, а следующий шаг отсчитывается уже от сдвинутого значения: иначе
    // один столбец был бы пройден дважды, а крайний левый — потерян.
    if (right === 6) {
      right = 5;
    }

    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!(reserved[row] ?? [])[col]) {
          order.push([row, col]);
        }
      }
    }

    upward = !upward;
    right -= 2;
  }

  return order;
}

function formatBits(mask: number): number {
  const value = (ECC_LEVEL_BITS << 3) | mask;
  let remainder = value << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >> i) & 1) {
      remainder ^= 0b10100110111 << (i - 10);
    }
  }
  return ((value << 10) | remainder) ^ 0b101010000010010;
}

function placeFormat(grid: boolean[][], mask: number): void {
  const size = grid.length;
  const bits = formatBits(mask);

  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> i) & 1) === 1;

    // Первая копия — вокруг левого верхнего поискового узора: младшие биты
    // идут ВНИЗ по столбцу 8, старшие — ВЛЕВО по строке 8.
    if (i <= 5) {
      (grid[i] ?? [])[8] = bit;
    } else if (i === 6) {
      (grid[7] ?? [])[8] = bit;
    } else if (i === 7) {
      (grid[8] ?? [])[8] = bit;
    } else if (i === 8) {
      (grid[8] ?? [])[7] = bit;
    } else {
      (grid[8] ?? [])[14 - i] = bit;
    }

    // Вторая копия — вдоль правого верхнего и левого нижнего узоров.
    if (i < 8) {
      (grid[8] ?? [])[size - 1 - i] = bit;
    } else {
      (grid[size - 15 + i] ?? [])[8] = bit;
    }
  }
}

function penalty(grid: readonly boolean[][]): number {
  const size = grid.length;
  let score = 0;

  // Правило 1: длинные одноцветные полосы.
  for (let i = 0; i < size; i += 1) {
    for (const line of [
      (j: number) => (grid[i] ?? [])[j] === true,
      (j: number) => (grid[j] ?? [])[i] === true,
    ]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (line(j) === line(j - 1)) {
          run += 1;
        } else {
          if (run >= 5) {
            score += run - 2;
          }
          run = 1;
        }
      }
      if (run >= 5) {
        score += run - 2;
      }
    }
  }

  // Правило 2: одноцветные квадраты 2×2.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = (grid[r] ?? [])[c];
      if (
        value === (grid[r] ?? [])[c + 1] &&
        value === (grid[r + 1] ?? [])[c] &&
        value === (grid[r + 1] ?? [])[c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Правило 3: узор, похожий на поисковый.
  const pattern = [true, false, true, true, true, false, true];
  const light = [false, false, false, false];
  const matches = (values: boolean[], start: number, expected: boolean[]): boolean =>
    expected.every((bit, index) => values[start + index] === bit);

  for (let i = 0; i < size; i += 1) {
    const row = Array.from({ length: size }, (_v, j) => (grid[i] ?? [])[j] === true);
    const col = Array.from({ length: size }, (_v, j) => (grid[j] ?? [])[i] === true);
    for (const values of [row, col]) {
      for (let start = 0; start + 10 < size; start += 1) {
        if (matches(values, start, [...pattern, ...light])) {
          score += 40;
        }
        if (matches(values, start, [...light, ...pattern])) {
          score += 40;
        }
      }
    }
  }

  // Правило 4: перекос доли тёмных модулей.
  const dark = grid.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/**
 * Матрица QR для строки: `true` — тёмный модуль.
 *
 * Маска выбирается по штрафу стандарта, а не фиксируется: одна и та же маска
 * на всех кодах давала бы у части из них крупные одноцветные пятна, которые
 * сканер читает плохо.
 */
export function encodeQrMatrix(text: string): boolean[][] {
  const { spec, codewords } = buildCodewords(text);
  const size = 17 + 4 * spec.version;
  const reserved = functionMask(spec, size);

  const base: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  placeFunctionPatterns(base, spec);

  const order = dataModuleOrder(size, reserved);
  const bits: boolean[] = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) {
      bits.push(((codeword >> i) & 1) === 1);
    }
  }

  let best: { grid: boolean[][]; score: number } | null = null;

  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const rule = MASKS[mask];
    const grid = base.map((row) => row.map((cell) => cell === true));

    order.forEach(([row, col], index) => {
      const bit = bits[index] ?? false;
      (grid[row] ?? [])[col] = rule !== undefined && rule(row, col) ? !bit : bit;
    });

    placeFormat(grid, mask);

    const score = penalty(grid);
    if (best === null || score < best.score) {
      best = { grid, score };
    }
  }

  if (best === null) {
    throw new AppError('INTERNAL_ERROR', { message: 'qr mask selection failed' });
  }
  return best.grid;
}

/** Экранирование текста внутри SVG: подпись приходит из кода ячейки. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LabelOptions {
  /** Размер одного модуля в единицах SVG. */
  moduleSize?: number;
  /** Светлое поле вокруг кода, в модулях. Стандарт требует не меньше четырёх. */
  quietZone?: number;
}

/**
 * Печатная этикетка ячейки: QR и подпись под ним.
 *
 * В документе нет ни ссылок, ни внешних ресурсов, ни шрифтов с чужого сервера:
 * SVG, открытый в браузере или в редакторе, не должен никуда ходить.
 * Подпись дублирует код словами — этикетку должно быть можно прочитать глазами,
 * когда сканер не работает.
 */
export function renderCellLabelSvg(normalizedCode: string, options: LabelOptions = {}): string {
  const moduleSize = options.moduleSize ?? 4;
  const quietZone = options.quietZone ?? 4;

  const matrix = encodeQrMatrix(normalizedCode);
  const size = matrix.length;
  const side = (size + quietZone * 2) * moduleSize;
  const captionHeight = Math.max(16, moduleSize * 6);
  const height = side + captionHeight;

  const rects: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if ((matrix[row] ?? [])[col] !== true) {
        continue;
      }
      const x = (col + quietZone) * moduleSize;
      const y = (row + quietZone) * moduleSize;
      rects.push(`<rect x="${x}" y="${y}" width="${moduleSize}" height="${moduleSize}"/>`);
    }
  }

  const caption = escapeXml(normalizedCode);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${height}"`,
    ` viewBox="0 0 ${side} ${height}" role="img" aria-label="${caption}">`,
    `<rect width="${side}" height="${height}" fill="#ffffff"/>`,
    `<g fill="#000000">${rects.join('')}</g>`,
    `<text x="${side / 2}" y="${side + captionHeight / 2}" fill="#000000"`,
    ` font-family="monospace" font-size="${Math.max(10, moduleSize * 3)}"`,
    ` text-anchor="middle" dominant-baseline="middle">${caption}</text>`,
    '</svg>',
  ].join('');
}
