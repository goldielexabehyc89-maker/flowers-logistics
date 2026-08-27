/**
 * Монохромный кадр этикетки 464×320 точек — то, что физически выжигает
 * термоголовка XP-318B при 203 DPI.
 *
 * Почему растр, а не встроенные команды принтера. У TSPL есть собственные
 * TEXT и QRCODE, и соблазн отдать печать им велик. Но встроенные шрифты
 * принтера не знают кириллицы: код ячейки «СТЕЛЛАЖ-A-001» вышел бы из него
 * вопросительными знаками, а обнаружилось бы это на складе с рулоном наклеек.
 * Поэтому кадр собирается здесь, тем же шрифтом и той же раскладкой, что
 * и PDF, а принтеру остаётся вывести готовые точки.
 *
 * Растеризация без сглаживания намеренно: у термопечати нет полутонов. Серый
 * пиксель всё равно станет либо точкой, либо пустотой, и решать это должен
 * наш код, а не прошивка принтера.
 */

import fontkit from '@pdf-lib/fontkit';
import { encodeQrMatrix } from '../warehouse/qr.js';
import { labelFontBytes } from './font.js';
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM, layoutLabel, type LabelContent } from './label.js';

/** Точек на миллиметр у 203-точечной головки. */
export const DOTS_PER_MM = 8;

export const RASTER_WIDTH = LABEL_WIDTH_MM * DOTS_PER_MM;
export const RASTER_HEIGHT = LABEL_HEIGHT_MM * DOTS_PER_MM;

/** Точек на типографский пункт: 1 пункт = 1/72 дюйма. */
const DOTS_PER_POINT = (DOTS_PER_MM * 25.4) / 72;

/** Просвет между строками подписи, в пунктах. Тот же, что в PDF. */
const LINE_GAP = 2;

/** Кадр: по байту на точку, `1` — чёрная. */
export interface LabelBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

interface LoadedFont {
  unitsPerEm: number;
  layout: (text: string) => {
    glyphs: { path: { commands: { command: string; args: number[] }[] } }[];
    positions: { xAdvance: number }[];
  };
}

let fontCache: LoadedFont | null = null;

function labelFont(): LoadedFont {
  if (fontCache === null) {
    fontCache = (fontkit as unknown as { create: (bytes: Uint8Array) => LoadedFont }).create(
      labelFontBytes(),
    );
  }
  return fontCache;
}

/**
 * Ширина строки тем же шрифтом, что и в PDF.
 *
 * Раскладка обязана мерить ОДНО И ТО ЖЕ для бумаги и для принтера: подобранный
 * по PDF кегль иначе не помещался бы на ленте, и предпросмотр обманывал бы.
 */
function textWidth(): { widthOfTextAtSize: (text: string, size: number) => number } {
  const font = labelFont();
  return {
    widthOfTextAtSize: (text: string, size: number) => {
      const run = font.layout(text);
      const units = run.positions.reduce((sum, position) => sum + position.xAdvance, 0);
      return (units / font.unitsPerEm) * size;
    },
  };
}

/** Прямая линия контура в точках кадра. */
interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Кривые Безье разбиваются на отрезки: у растра всё равно нет кривых. */
const CURVE_STEPS = 8;

/**
 * Заливка контуров по правилу ненулевого индекса.
 *
 * Сканирующая строка берётся по центру ряда точек: край, попавший ровно
 * на границу, иначе то включал бы ряд, то нет — и одна и та же буква
 * печаталась бы по-разному в зависимости от округления.
 */
function fillEdges(bitmap: LabelBitmap, edges: readonly Edge[]): void {
  if (edges.length === 0) {
    return;
  }

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const edge of edges) {
    minY = Math.min(minY, edge.y0, edge.y1);
    maxY = Math.max(maxY, edge.y0, edge.y1);
  }

  const from = Math.max(0, Math.floor(minY));
  const to = Math.min(bitmap.height - 1, Math.ceil(maxY));

  for (let row = from; row <= to; row += 1) {
    const scan = row + 0.5;
    const crossings: { x: number; direction: number }[] = [];

    for (const edge of edges) {
      const { x0, y0, x1, y1 } = edge;
      if (y0 === y1) {
        continue;
      }
      const low = Math.min(y0, y1);
      const high = Math.max(y0, y1);
      if (scan < low || scan >= high) {
        continue;
      }
      const t = (scan - y0) / (y1 - y0);
      crossings.push({ x: x0 + (x1 - x0) * t, direction: y1 > y0 ? 1 : -1 });
    }

    if (crossings.length < 2) {
      continue;
    }
    crossings.sort((left, right) => left.x - right.x);

    let winding = 0;
    for (let index = 0; index < crossings.length - 1; index += 1) {
      winding += crossings[index]?.direction ?? 0;
      if (winding === 0) {
        continue;
      }
      const start = Math.max(0, Math.round(crossings[index]?.x ?? 0));
      const end = Math.min(bitmap.width - 1, Math.round(crossings[index + 1]?.x ?? 0) - 1);
      for (let column = start; column <= end; column += 1) {
        bitmap.data[row * bitmap.width + column] = 1;
      }
    }
  }
}

/**
 * Контуры одной строки, повёрнутой на 90° и читаемой снизу вверх.
 *
 * Точка контура (gx, gy) в единицах шрифта ложится на кадр так: продвижение
 * строки идёт вверх по наклейке, а верх знака смотрит влево. Именно это
 * и делает подпись читаемой, когда наклейка наклеена на коробку.
 */
function rotatedLineEdges(
  text: string,
  size: number,
  baselineX: number,
  baselineY: number,
): Edge[] {
  const font = labelFont();
  const run = font.layout(text);
  const scale = (size * DOTS_PER_POINT) / font.unitsPerEm;

  const edges: Edge[] = [];
  let advance = 0;

  run.glyphs.forEach((glyph, index) => {
    // Экранные координаты точки контура. `baselineY` отсчитывается от низа
    // наклейки, а строки кадра — сверху вниз, поэтому здесь и происходит
    // единственный переворот оси.
    const place = (gx: number, gy: number): { x: number; y: number } => ({
      x: baselineX - gy * scale,
      y: RASTER_HEIGHT - (baselineY + (gx + advance) * scale),
    });

    let current = { x: 0, y: 0 };
    let start = { x: 0, y: 0 };

    for (const command of glyph.path.commands) {
      const args = command.args;
      if (command.command === 'moveTo') {
        current = place(args[0] ?? 0, args[1] ?? 0);
        start = current;
        continue;
      }
      if (command.command === 'lineTo') {
        const next = place(args[0] ?? 0, args[1] ?? 0);
        edges.push({ x0: current.x, y0: current.y, x1: next.x, y1: next.y });
        current = next;
        continue;
      }
      if (command.command === 'quadraticCurveTo' || command.command === 'bezierCurveTo') {
        const points =
          command.command === 'quadraticCurveTo'
            ? [
                [args[0] ?? 0, args[1] ?? 0],
                [args[2] ?? 0, args[3] ?? 0],
              ]
            : [
                [args[0] ?? 0, args[1] ?? 0],
                [args[2] ?? 0, args[3] ?? 0],
                [args[4] ?? 0, args[5] ?? 0],
              ];

        // Кривая разбивается уже в экранных координатах: смешивать единицы
        // шрифта и точки кадра в одном вычислении — верный способ ошибиться
        // на масштабе.
        const control = points.map((point) => place(point[0] ?? 0, point[1] ?? 0));
        let previous = current;
        for (let step = 1; step <= CURVE_STEPS; step += 1) {
          const t = step / CURVE_STEPS;
          const point = curvePoint(current, control, t);
          edges.push({ x0: previous.x, y0: previous.y, x1: point.x, y1: point.y });
          previous = point;
        }
        current = previous;
        continue;
      }
      if (command.command === 'closePath') {
        edges.push({ x0: current.x, y0: current.y, x1: start.x, y1: start.y });
        current = start;
      }
    }

    advance += run.positions[index]?.xAdvance ?? 0;
  });

  return edges;
}

/** Точка кривой Безье второго или третьего порядка. */
function curvePoint(
  from: { x: number; y: number },
  control: { x: number; y: number }[],
  t: number,
): { x: number; y: number } {
  const points = [from, ...control];
  let current = points;
  while (current.length > 1) {
    const next: { x: number; y: number }[] = [];
    for (let index = 0; index < current.length - 1; index += 1) {
      const a = current[index] ?? { x: 0, y: 0 };
      const b = current[index + 1] ?? { x: 0, y: 0 };
      next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    current = next;
  }
  return current[0] ?? from;
}

/**
 * Кадр этикетки: QR слева, подпись справа вдоль длинной стороны.
 *
 * Модуль QR округляется до ЦЕЛОГО числа точек. Дробный модуль термопечать
 * размазывает неравномерно — соседние модули получаются разной толщины,
 * и сканер начинает ошибаться там, где на экране всё читалось.
 */
export function renderLabelBitmap(content: LabelContent): LabelBitmap {
  const bitmap: LabelBitmap = {
    width: RASTER_WIDTH,
    height: RASTER_HEIGHT,
    data: new Uint8Array(RASTER_WIDTH * RASTER_HEIGHT),
  };

  const layout = layoutLabel(textWidth(), content);

  const matrix = encodeQrMatrix(content.qrText);
  const modules = matrix.length;
  const nominal = layout.qr.size * DOTS_PER_MM;
  const module = Math.max(1, Math.floor(nominal / modules));
  const side = module * modules;

  const qrLeft = Math.round(layout.qr.x * DOTS_PER_MM + (nominal - side) / 2);
  const qrTop = Math.round(
    RASTER_HEIGHT - (layout.qr.y * DOTS_PER_MM + nominal) + (nominal - side) / 2,
  );

  for (let row = 0; row < modules; row += 1) {
    const line = matrix[row] ?? [];
    for (let column = 0; column < modules; column += 1) {
      if (line[column] !== true) {
        continue;
      }
      for (let dy = 0; dy < module; dy += 1) {
        const y = qrTop + row * module + dy;
        if (y < 0 || y >= RASTER_HEIGHT) {
          continue;
        }
        for (let dx = 0; dx < module; dx += 1) {
          const x = qrLeft + column * module + dx;
          if (x < 0 || x >= RASTER_WIDTH) {
            continue;
          }
          bitmap.data[y * RASTER_WIDTH + x] = 1;
        }
      }
    }
  }

  const columnWidth = layout.textWidth * DOTS_PER_MM;
  const used =
    (layout.size * layout.lines.length + LINE_GAP * (layout.lines.length - 1)) * DOTS_PER_POINT;
  const columnStart = layout.textX * DOTS_PER_MM + Math.max(0, (columnWidth - used) / 2);

  const measure = textWidth();
  layout.lines.forEach((line, index) => {
    const lineWidth = measure.widthOfTextAtSize(line, layout.size) * DOTS_PER_POINT;
    const baselineX = columnStart + (layout.size * (index + 1) + LINE_GAP * index) * DOTS_PER_POINT;
    const baselineY = Math.max(0, (RASTER_HEIGHT - lineWidth) / 2);
    fillEdges(bitmap, rotatedLineEdges(line, layout.size, baselineX, baselineY));
  });

  return bitmap;
}
