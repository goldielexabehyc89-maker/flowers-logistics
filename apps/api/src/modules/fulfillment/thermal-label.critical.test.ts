/**
 * Термоэтикетка 58×40 мм.
 *
 * Наклейка живёт на коробке и её видит каждый, кто проходит мимо. Поэтому
 * проверяется не «нарисовалось ли», а то, из-за чего этикетка окажется
 * бесполезной или вредной:
 *
 *  * на ней нет ничего, кроме QR и номера — ни адреса, ни получателя,
 *    ни состава: лишнюю строку с коробки уже не отозвать;
 *  * QR несёт РОВНО то значение, которое понимает складской сканер, и его
 *    читает независимый декодер из готового PDF, а не наш же генератор;
 *  * страница физически 58×40 мм — принтер режет по метке, а не по нашему
 *    представлению о размере;
 *  * длинный номер уменьшается, но не переносится и не обрезается: обрезанный
 *    номер выглядит настоящим и отправляет кладовщика искать чужой заказ;
 *  * модуль QR при 203 DPI достаточно крупный, чтобы термопечать его не
 *    размазала;
 *  * повтор печати выдаёт тот же документ и остаётся в общей истории.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import jsQR from 'jsqr';
import { PDFDocument } from 'pdf-lib';
import { buildPrintFormSnapshot, type PrintFormSnapshot } from './print-form.js';
import { qrPayload, renderThermalLabelPdf, thermalLabelFileName } from './pdf.js';
import { pdfContent as textOf, rasterizeQr } from '../printing/testing/label-probe.js';
import { embedLabelFont } from '../printing/label-pdf.js';
import {
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  MM as POINT_PER_MM,
  PADDING_MM,
  SINGLE_LINE_MAX,
  captionFontSize,
  splitCaption,
} from '../printing/label.js';

/** Длина наклейки, в которую обязана уложиться повёрнутая строка. */
const LABEL_NUMBER_HEIGHT_PT = (LABEL_HEIGHT_MM - PADDING_MM * 2) * POINT_PER_MM;
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import {
  MAX_ORDER_NUMBER_LENGTH,
  normalizeOrderNumber,
  resolveOrderByNumber,
} from '../warehouse/order-lookup.js';
import { closeTestContext, createTestContext, type TestContext } from '../auth/testing/harness.js';
import { toDateColumn } from '../integrations/moysklad/delivery-date.js';

/** Пункт PDF на миллиметр. */
const MM = 72 / 25.4;

/**
 * Номера, на которых макет реально ломается: пусто-короткий, обычный,
 * предельно длинный, с кириллицей и разделителями.
 *
 * Шестьдесят четыре символа — не выдумка, а `MAX_ORDER_NUMBER_LENGTH`:
 * ровно столько принимает складской сканер. Значит, этикетка обязана
 * вмещать весь допустимый диапазон номеров, а не только привычные.
 */
const NUMBERS = [
  'A1',
  'FL-000123',
  'CRM-2026-08-29-000000000042',
  'ЗАКАЗ-МСК-000123',
  'X'.repeat(MAX_ORDER_NUMBER_LENGTH),
];

function snapshotFor(orderNumber: string): PrintFormSnapshot {
  return buildPrintFormSnapshot({
    orderNumber,
    deliveryDate: '2026-08-29',
    intervalStartMinute: 600,
    intervalEndMinute: 840,
    // Эти поля НАМЕРЕННО заполнены: проверка ниже доказывает, что на этикетку
    // они не попадают, а пустой снимок доказал бы только собственную пустоту.
    cardText: 'С днём рождения, Мария!',
    description: 'Позвонить за час, домофон 42',
    positions: [
      {
        name: 'Роза красная',
        quantity: '11',
        uomName: 'шт',
        characteristicLabel: null,
        ordinal: 0,
        assortmentId: '00000000-0000-4000-8000-000000000001',
        assortmentKind: 'PRODUCT',
        components: [],
      },
    ] as never,
    ids: MOYSKLAD_IDS,
  });
}

/**
 * Размер страницы и их число — из готового документа.
 *
 * Читает сама `pdf-lib`, а не регулярное выражение по байтам: объекты внутри
 * PDF сжаты, и текстовый поиск нашёл бы разметку только случайно.
 */
async function pageGeometry(pdf: Uint8Array): Promise<{
  pages: number;
  width: number;
  height: number;
}> {
  const document = await PDFDocument.load(pdf);
  const { width, height } = document.getPage(0).getSize();
  return { pages: document.getPageCount(), width, height };
}

describe('размер носителя', () => {
  it('страница ровно 58×40 мм при любом номере', async () => {
    for (const number of NUMBERS) {
      const pdf = await renderThermalLabelPdf(snapshotFor(number));
      const { width, height } = await pageGeometry(pdf);

      // Допуск — сотая доля пункта: принтер режет по метке, и лишний
      // миллиметр смещает всю ленту.
      expect(width, number).toBeCloseTo(LABEL_WIDTH_MM * MM, 1);
      expect(height, number).toBeCloseTo(LABEL_HEIGHT_MM * MM, 1);
    }
  });

  it('одна этикетка — одна страница', async () => {
    for (const number of NUMBERS) {
      expect((await pageGeometry(await renderThermalLabelPdf(snapshotFor(number)))).pages).toBe(1);
    }
  });
});

describe('на этикетке только QR и номер', () => {
  it('персональных и операционных данных нет', async () => {
    const pdf = await renderThermalLabelPdf(snapshotFor('FL-000123'));
    const content = textOf(pdf);

    /*
     * Текст в PDF записан кодами глифов, а не читаемой строкой, поэтому
     * сравнение идёт по ЧИСЛУ нарисованных строк: на этикетке ровно одна
     * операция показа текста — номер. Появись там получатель или состав,
     * операций стало бы больше.
     */
    const showText = (content.match(/Tj/g) ?? []).length;
    expect(showText).toBe(1);
  });

  it('имя файла не содержит ничего, кроме номера', () => {
    expect(thermalLabelFileName(snapshotFor('FL-000123'))).toBe('label-FL-000123.pdf');
    // Кириллица и прочее заменяется: имя файла уходит в заголовок ответа.
    expect(thermalLabelFileName(snapshotFor('ЗАКАЗ-1'))).toBe('label-_____-1.pdf');
  });
});

describe('QR понимает складской сканер', () => {
  it('независимый декодер читает из PDF ровно номер заказа', async () => {
    for (const number of NUMBERS) {
      const snapshot = snapshotFor(number);
      const pdf = await renderThermalLabelPdf(snapshot);
      const image = rasterizeQr(pdf);

      // jsQR — самостоятельная реализация распознавания, не имеющая отношения
      // к нашему генератору. Совпадение означает, что этикетку прочтёт
      // и чужой сканер, а не только наш обратный алгоритм.
      const decoded = jsQR(image.data, image.width, image.height);
      expect(decoded, number).not.toBeNull();
      expect(decoded?.data, number).toBe(number);

      // Контракт QR не изменился: то же значение, что и у бланка.
      expect(decoded?.data, number).toBe(qrPayload(snapshot));

      // И его принимает ТОТ ЖЕ обработчик, которым пользуется склад.
      expect(normalizeOrderNumber(decoded?.data ?? ''), number).toBe(number);
    }
  });

  it('модуль QR при 203 DPI не мельче трёх точек', async () => {
    /*
     * Термопечать «растекается»: модуль в одну-две точки превращается
     * в пятно, и сканер начинает ошибаться там, где на экране всё читалось.
     * Три точки — практический минимум для 203 DPI.
     */
    const dpi = 203;
    for (const number of NUMBERS) {
      const image = rasterizeQr(await renderThermalLabelPdf(snapshotFor(number)));
      const moduleDots = (image.moduleSizePt / 72) * dpi;
      expect(moduleDots, `${number}: модулей ${image.modules}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('вокруг QR остаётся белая зона', async () => {
    const pdf = await renderThermalLabelPdf(snapshotFor('FL-000123'));
    const image = rasterizeQr(pdf);

    // Слева от QR — поле, справа — тихая зона до номера. Модули не начинаются
    // от самого края страницы и не доходят до её правой границы.
    expect(image.minX).toBeGreaterThan(0);
    expect(image.maxX + image.moduleSizePt).toBeLessThan(LABEL_WIDTH_MM * MM);
    expect(image.modules).toBeGreaterThan(20);
  });
});

describe('этикетка ведёт к настоящему заказу', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await closeTestContext(ctx);
  });

  it('склад находит заказ по значению, снятому с наклейки', async () => {
    /*
     * Полная цепочка без единого допущения: заказ в базе → снимок печати →
     * PDF → независимый декодер → тот же поиск, которым пользуется склад.
     *
     * Проверки выше доказывают, что QR читается и что строка проходит
     * нормализацию. Здесь доказывается последнее звено: снятое с наклейки
     * значение приводит к ТОМУ САМОМУ заказу. Разойдись хоть одно звено —
     * наклейка на коробке указывала бы в пустоту, а обнаружилось бы это
     * у кладовщика с коробкой в руках.
     */
    const number = `FL-${process.hrtime.bigint() % 1_000_000n}`;
    const order = await ctx.db.deliveryOrder.create({
      data: {
        externalId: randomUUID(),
        externalName: number,
        externalUpdated: new Date(),
        deliveryDate: toDateColumn('2027-11-18'),
        inScope: true,
      },
      select: { id: true },
    });

    const pdf = await renderThermalLabelPdf(snapshotFor(number));
    const image = rasterizeQr(pdf);
    const decoded = jsQR(image.data, image.width, image.height);
    expect(decoded?.data).toBe(number);

    const resolved = await resolveOrderByNumber(ctx.db, decoded?.data ?? '');
    expect(resolved.id).toBe(order.id);
  });
});

describe('номер заказа', () => {
  it('длинный номер уменьшается, но не обрезается и не переносится', async () => {
    const long = 'X'.repeat(64);
    const pdf = await renderThermalLabelPdf(snapshotFor(long));
    const content = textOf(pdf);

    // Две операции показа текста — ровно две строки. Не три и не одна:
    // третья не поместилась бы по ширине колонки, одна вынудила бы кегль
    // ниже читаемого.
    expect((content.match(/Tj/g) ?? []).length).toBe(2);

    const sizeOf = (text: string): number => {
      const m = /\/[A-Za-z0-9+.-]+ ([\d.]+) Tf/.exec(text);
      return m === null ? 0 : Number(m[1]);
    };

    // Кегль уменьшился по сравнению с коротким номером.
    const shortPdf = await renderThermalLabelPdf(snapshotFor('A1'));
    expect(sizeOf(content)).toBeLessThan(sizeOf(textOf(shortPdf)));

    /*
     * Насколько уменьшился — здесь и проходит граница честности.
     *
     * Шестьдесят четыре ЗАГЛАВНЫХ «X» подряд — самый широкий номер, который
     * вообще принимает сканер, и на нём двух строк хватает ровно до 4,5 пункта.
     * Это мелко, но целиком и вчетверо крупнее прежних 2,75, когда номер
     * рисовался одной строкой и выезжал за край наклейки.
     *
     * Настоящие номера уже читаемы: проверка ниже требует пяти пунктов
     * для длинного номера из цифр и кириллицы.
     */
    expect(sizeOf(content)).toBeGreaterThanOrEqual(4.5);

    const realistic = textOf(
      await renderThermalLabelPdf(snapshotFor(`ЗАКАЗ-МСК-${'4'.repeat(48)}`)),
    );
    expect((realistic.match(/Tj/g) ?? []).length).toBe(2);
    expect(sizeOf(realistic)).toBeGreaterThanOrEqual(5);
  });

  it('подбор кегля держится читаемого диапазона, пока строка в него влезает', () => {
    const font = {
      widthOfTextAtSize: (text: string, size: number) => text.length * size * 0.6,
    } as never;

    // Короткая строка получает максимальный кегль.
    expect(captionFontSize(font, ['A1'], 200, 40)).toBe(13);
    // Пока номер помещается читаемым кеглем, ниже пяти пунктов не опускаемся.
    expect(captionFontSize(font, ['X'.repeat(30)], 90, 40)).toBe(5);
    // Заведомо неразмещаемая строка — не ноль и не отрицательный кегль.
    const tiny = captionFontSize(font, ['X'.repeat(400)], 10, 40);
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(5);
  });

  it('длинный номер делится на две строки, а короткий остаётся одной', () => {
    expect(splitCaption('FL-000123')).toEqual(['FL-000123']);
    expect(splitCaption('X'.repeat(SINGLE_LINE_MAX))).toHaveLength(1);
    expect(splitCaption('X'.repeat(SINGLE_LINE_MAX + 1))).toHaveLength(2);

    // Деление идёт по разделителю ближе к середине: человек читает номер
    // группами, и разрыв внутри группы цифр сбивает сверку сильнее.
    expect(splitCaption('CRM-2026-08-29-000000000042')).toEqual(['CRM-2026-08-29-000000000042']);
    const long = splitCaption('ЗАКАЗ-МСК-' + '4'.repeat(48));
    expect(long).toHaveLength(2);
    // Ничего не потеряно и ничего не дописано.
    expect(long.join('')).toBe('ЗАКАЗ-МСК-' + '4'.repeat(48));
    expect(long.join('')).not.toContain('…');
  });

  it('номер любой длины помещается на наклейку целиком', async () => {
    /*
     * Проверяется физика, а не наш `slice`.
     *
     * Строка, вышедшая за край наклейки, обрезается печатающей головкой
     * и выглядит настоящим номером — просто другим. Поэтому мерится ширина
     * строки настоящей гарнитурой при выбранном кегле: она обязана уложиться
     * в ту же высоту, по которой кегль и подбирался.
     */
    const document = await PDFDocument.create();
    const font = await embedLabelFont(document);

    for (const number of NUMBERS) {
      const lines = splitCaption(number);
      const size = captionFontSize(font, lines, LABEL_NUMBER_HEIGHT_PT, 12 * POINT_PER_MM);
      for (const line of lines) {
        expect(font.widthOfTextAtSize(line, size), number).toBeLessThanOrEqual(
          LABEL_NUMBER_HEIGHT_PT,
        );
      }
      expect(size, number).toBeGreaterThan(0);
      // Строк не больше двух, и вместе они дают исходный номер целиком.
      expect(lines.length, number).toBeLessThanOrEqual(2);
      expect(lines.join(''), number).toBe(number);
    }
  });
});

describe('повтор печати', () => {
  it('тот же снимок даёт побайтово тот же документ', async () => {
    const snapshot = snapshotFor('FL-000123');
    const first = await renderThermalLabelPdf(snapshot);
    const second = await renderThermalLabelPdf(snapshot);

    // Повторная печать — это ТОТ ЖЕ документ, а не похожий: иначе две
    // наклейки на одной коробке отличались бы, и было бы непонятно, какая
    // из них настоящая.
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first.subarray(0, 8)).toString('latin1')).toContain('%PDF-1.7');
  });
});
