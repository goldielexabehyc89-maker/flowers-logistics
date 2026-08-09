/**
 * Синтетические точки для staging.
 *
 * Решение владельца: staging работает только на вымышленных адресах
 * и координатах. Настоящие адреса клиентов туда не переносятся ни в каком виде,
 * включая «улицу без дома» — это по-прежнему реальные данные, и для проверки
 * маршрутов они всё равно непригодны.
 *
 * Набор устроен так, чтобы проверки маршрутизации имели смысл: часть точек
 * внутри МКАД, часть за ним, включая дальние направления области. Маршрут,
 * целиком лежащий в центре, не покажет ни выездов, ни длинных перегонов.
 *
 * Один псевдоним адреса всегда получает одну и ту же точку. Это нужно, чтобы
 * группировка по адресу на staging продолжала работать: два заказа, у которых
 * на production один адрес, и здесь окажутся в одном месте. Обратный переход
 * от точки к настоящему адресу невозможен — точка выбирается по псевдониму,
 * а псевдоним получен хешированием с секретной солью, которая на staging
 * не передаётся.
 *
 * Подписи вымышленные. Названия улиц не повторяют существующие адреса
 * конкретных клиентов и служат только для чтения глазами.
 */

import { createHash } from 'node:crypto';

export interface SyntheticPoint {
  /** Стабильный идентификатор точки внутри набора. */
  id: string;
  /** Вымышленная подпись. Настоящих адресов здесь нет. */
  label: string;
  latMicro: number;
  lonMicro: number;
  /** Внутри МКАД или за его пределами. */
  zone: 'INSIDE_MKAD' | 'OUTSIDE_MKAD';
}

/**
 * Набор точек.
 *
 * Координаты — целые микроградусы, как и везде в системе: число с плавающей
 * точкой здесь недопустимо, потому что от координаты зависят расстояния.
 */
export const SYNTHETIC_POINTS: readonly SyntheticPoint[] = [
  // --- Внутри МКАД ---
  {
    id: 'in-01',
    label: 'Синтетическая Центральная улица, 1',
    latMicro: 55_752_000,
    lonMicro: 37_617_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-02',
    label: 'Синтетический Северный проезд, 4',
    latMicro: 55_836_000,
    lonMicro: 37_632_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-03',
    label: 'Синтетическая Южная улица, 7',
    latMicro: 55_651_000,
    lonMicro: 37_614_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-04',
    label: 'Синтетический Западный бульвар, 12',
    latMicro: 55_733_000,
    lonMicro: 37_479_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-05',
    label: 'Синтетическая Восточная улица, 3',
    latMicro: 55_762_000,
    lonMicro: 37_784_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-06',
    label: 'Синтетический Речной переулок, 9',
    latMicro: 55_705_000,
    lonMicro: 37_552_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-07',
    label: 'Синтетическая Парковая улица, 21',
    latMicro: 55_795_000,
    lonMicro: 37_726_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-08',
    label: 'Синтетический Лесной проезд, 5',
    latMicro: 55_679_000,
    lonMicro: 37_736_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-09',
    label: 'Синтетическая Садовая улица, 18',
    latMicro: 55_770_000,
    lonMicro: 37_580_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-10',
    label: 'Синтетический Тихий тупик, 2',
    latMicro: 55_722_000,
    lonMicro: 37_684_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-11',
    label: 'Синтетическая Ясная улица, 30',
    latMicro: 55_812_000,
    lonMicro: 37_508_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-12',
    label: 'Синтетический Ольховый проезд, 6',
    latMicro: 55_669_000,
    lonMicro: 37_527_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-13',
    label: 'Синтетическая Ландышевая улица, 14',
    latMicro: 55_748_000,
    lonMicro: 37_760_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-14',
    label: 'Синтетический Верхний переулок, 8',
    latMicro: 55_688_000,
    lonMicro: 37_660_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-15',
    label: 'Синтетическая Нижняя улица, 25',
    latMicro: 55_784_000,
    lonMicro: 37_549_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-16',
    label: 'Синтетический Мостовой проезд, 11',
    latMicro: 55_713_000,
    lonMicro: 37_615_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-17',
    label: 'Синтетическая Луговая улица, 33',
    latMicro: 55_824_000,
    lonMicro: 37_690_000,
    zone: 'INSIDE_MKAD',
  },
  {
    id: 'in-18',
    label: 'Синтетический Крайний проезд, 16',
    latMicro: 55_661_000,
    lonMicro: 37_672_000,
    zone: 'INSIDE_MKAD',
  },

  // --- За МКАД: ближний пояс ---
  {
    id: 'out-01',
    label: 'Синтетический Северный посёлок, 1',
    latMicro: 55_968_000,
    lonMicro: 37_540_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-02',
    label: 'Синтетическая Загородная улица, 5',
    latMicro: 55_540_000,
    lonMicro: 37_760_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-03',
    label: 'Синтетический Западный тракт, 12',
    latMicro: 55_704_000,
    lonMicro: 37_306_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-04',
    label: 'Синтетическое Восточное шоссе, 8',
    latMicro: 55_760_000,
    lonMicro: 37_950_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-05',
    label: 'Синтетическая Дальняя улица, 3',
    latMicro: 55_988_000,
    lonMicro: 37_180_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-06',
    label: 'Синтетический Южный проезд, 22',
    latMicro: 55_452_000,
    lonMicro: 37_560_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-07',
    label: 'Синтетическая Полевая улица, 7',
    latMicro: 55_872_000,
    lonMicro: 38_064_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-08',
    label: 'Синтетический Озёрный переулок, 4',
    latMicro: 55_600_000,
    lonMicro: 37_120_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-09',
    label: 'Синтетическая Боровая улица, 19',
    latMicro: 56_012_000,
    lonMicro: 37_856_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-10',
    label: 'Синтетический Дачный проезд, 2',
    latMicro: 55_512_000,
    lonMicro: 38_020_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-11',
    label: 'Синтетическая Сосновая улица, 15',
    latMicro: 55_930_000,
    lonMicro: 36_990_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-12',
    label: 'Синтетический Речной посёлок, 6',
    latMicro: 55_380_000,
    lonMicro: 37_900_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-13',
    label: 'Синтетическая Тепличная улица, 10',
    latMicro: 56_100_000,
    lonMicro: 37_460_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-14',
    label: 'Синтетический Каменный проезд, 24',
    latMicro: 55_566_000,
    lonMicro: 36_880_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-15',
    label: 'Синтетическая Ветряная улица, 9',
    latMicro: 55_840_000,
    lonMicro: 38_320_000,
    zone: 'OUTSIDE_MKAD',
  },
  {
    id: 'out-16',
    label: 'Синтетический Дальний хутор, 1',
    latMicro: 55_300_000,
    lonMicro: 37_320_000,
    zone: 'OUTSIDE_MKAD',
  },
] as const;

/** Минимум, обещанный владельцу. Проверяется тестом, а не соглашением. */
export const MIN_SYNTHETIC_POINTS = 30;

/**
 * Выбирает точку по псевдониму адреса.
 *
 * Отображение детерминированное и равномерное: хеш псевдонима переводится
 * в индекс набора. Никакого состояния и никакой таблицы соответствий — иначе
 * она стала бы ещё одним местом, где хранится связь с настоящим адресом.
 *
 * Восстановить адрес по точке нельзя: на вход поступает уже псевдоним,
 * полученный хешированием с солью, которой на staging нет.
 */
export function pointForAlias(addressAlias: string): SyntheticPoint {
  const digest = createHash('sha256').update(`synthetic-point:${addressAlias}`).digest();
  // Четырёх байт достаточно: набор заведомо меньше четырёх миллиардов точек.
  const value = digest.readUInt32BE(0);
  const index = value % SYNTHETIC_POINTS.length;

  const point = SYNTHETIC_POINTS[index];
  if (point === undefined) {
    // Недостижимо: индекс получен остатком от деления на длину набора.
    throw new Error('Синтетический набор точек пуст');
  }
  return point;
}
