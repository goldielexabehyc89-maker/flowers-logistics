/**
 * Дорожный набор пилота: 60 синтетических точек на дорожной сети.
 *
 * ФАЙЛ СГЕНЕРИРОВАН. Источник — `tools/geo/build-road-fixture.mjs`, который
 * примагничивает детерминированную решётку к дорогам собранного графа обоими
 * профилями и требует полной матрицы без единого пустого элемента.
 *
 * Координаты не получены из заказов, адресов, базы staging или МоегоСклада:
 * они вычислены из решётки вокруг общеизвестной городской точки и уточнены
 * ответом маршрутизатора о том, где проходит дорога. Подписей, названий
 * и адресов здесь нет.
 *
 * Нулевая точка — склад: маршрут начинается и заканчивается на ней. Префиксы
 * набора дают размеры 11, 31 и 60, поэтому одна и та же fixture служит
 * и генератору дня, и предельной проверке при выкатке.
 */

export interface RoadFixturePoint {
  readonly latMicro: number;
  readonly lonMicro: number;
}

export const ROAD_FIXTURE_POINTS: readonly RoadFixturePoint[] = [
  { latMicro: 55751224, lonMicro: 37618351 },
  { latMicro: 55757476, lonMicro: 37629791 },
  { latMicro: 55757369, lonMicro: 37618725 },
  { latMicro: 55757490, lonMicro: 37607460 },
  { latMicro: 55751142, lonMicro: 37607275 },
  { latMicro: 55745338, lonMicro: 37607594 },
  { latMicro: 55744884, lonMicro: 37618495 },
  { latMicro: 55745056, lonMicro: 37629524 },
  { latMicro: 55745003, lonMicro: 37640796 },
  { latMicro: 55751321, lonMicro: 37640555 },
  { latMicro: 55757766, lonMicro: 37640614 },
  { latMicro: 55764051, lonMicro: 37640924 },
  { latMicro: 55763901, lonMicro: 37629294 },
  { latMicro: 55764069, lonMicro: 37618393 },
  { latMicro: 55763835, lonMicro: 37607645 },
  { latMicro: 55763868, lonMicro: 37596283 },
  { latMicro: 55757623, lonMicro: 37596050 },
  { latMicro: 55751290, lonMicro: 37596094 },
  { latMicro: 55744948, lonMicro: 37596314 },
  { latMicro: 55738596, lonMicro: 37596110 },
  { latMicro: 55738645, lonMicro: 37607309 },
  { latMicro: 55738751, lonMicro: 37618341 },
  { latMicro: 55738675, lonMicro: 37629471 },
  { latMicro: 55738920, lonMicro: 37640828 },
  { latMicro: 55738593, lonMicro: 37651585 },
  { latMicro: 55744969, lonMicro: 37651665 },
  { latMicro: 55751044, lonMicro: 37651577 },
  { latMicro: 55757468, lonMicro: 37651820 },
  { latMicro: 55763878, lonMicro: 37651806 },
  { latMicro: 55770024, lonMicro: 37651629 },
  { latMicro: 55770129, lonMicro: 37640600 },
  { latMicro: 55770110, lonMicro: 37629451 },
  { latMicro: 55770145, lonMicro: 37618280 },
  { latMicro: 55769979, lonMicro: 37606893 },
  { latMicro: 55770069, lonMicro: 37596059 },
  { latMicro: 55770180, lonMicro: 37585151 },
  { latMicro: 55763937, lonMicro: 37585992 },
  { latMicro: 55757529, lonMicro: 37585340 },
  { latMicro: 55751239, lonMicro: 37585301 },
  { latMicro: 55744943, lonMicro: 37585068 },
  { latMicro: 55738749, lonMicro: 37585101 },
  { latMicro: 55732341, lonMicro: 37585157 },
  { latMicro: 55732335, lonMicro: 37596009 },
  { latMicro: 55731771, lonMicro: 37606735 },
  { latMicro: 55732395, lonMicro: 37618389 },
  { latMicro: 55732353, lonMicro: 37629492 },
  { latMicro: 55732270, lonMicro: 37640752 },
  { latMicro: 55732188, lonMicro: 37651255 },
  { latMicro: 55732277, lonMicro: 37662861 },
  { latMicro: 55738632, lonMicro: 37662798 },
  { latMicro: 55744956, lonMicro: 37662818 },
  { latMicro: 55751345, lonMicro: 37662738 },
  { latMicro: 55757632, lonMicro: 37664379 },
  { latMicro: 55763909, lonMicro: 37662755 },
  { latMicro: 55770106, lonMicro: 37663137 },
  { latMicro: 55776452, lonMicro: 37662811 },
  { latMicro: 55776485, lonMicro: 37640804 },
  { latMicro: 55776445, lonMicro: 37629291 },
  { latMicro: 55776454, lonMicro: 37618510 },
  { latMicro: 55776435, lonMicro: 37607270 },
];
