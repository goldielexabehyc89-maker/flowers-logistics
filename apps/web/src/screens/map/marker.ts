/**
 * Отметка заказа на карте: один визуальный контракт на весь продукт.
 *
 * «Сделки» и «Маршрутизация» показывают одни и те же заказы на одной и той же
 * подложке. Две собственные реализации отметки означали бы, что один заказ
 * выглядит по-разному в зависимости от того, из какого раздела на него смотрят,
 * и что исправление в одной карте не доходит до второй. Поэтому разметка,
 * заполнение и классы живут здесь, а разделы решают только, ЧТО показать:
 * какой вид отметки, какая подпись, какая подсказка.
 *
 * Правило подписи одно на обе карты: цифра внутри кружка означает позицию
 * в маршруте. У заказа, который ещё никуда не входит, позиции нет — его кружок
 * пуст, а номер и адрес показывает подсказка.
 */

import './marker.css';

/** Базовый класс отметки. Все свои модификаторы начинаются с него. */
export const MARKER_CLASS = 'map-point';

/** Что нарисовано в конкретной отметке. */
export interface MarkerContent {
  /**
   * Что написано в кружке.
   *
   * Пусто — обычная точка без позиции в маршруте. Это не «нет данных»,
   * а осознанный вид: сотня номеров на карте не читается и превращает её
   * в текст.
   */
  label: string;
  /** Подпись над кружком. Показана всегда: по времени логист и группирует день. */
  interval: string;
  /** Подсказка при наведении и по клавиатурному фокусу: номер и адрес. */
  hint: string;
  /** Полный список классов отметки, включая базовый. */
  className: string;
  ariaLabel: string;
}

/**
 * Разметка отметки.
 *
 * Кружок, подпись времени и подсказка — разные узлы: подпись обязана оставаться
 * читаемой и не растягивать сам кружок, от размера которого зависит, куда
 * MapLibre поставит центр.
 */
export function createMarkerElement(): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';

  const time = document.createElement('span');
  time.className = `${MARKER_CLASS}__time`;
  const dot = document.createElement('span');
  dot.className = `${MARKER_CLASS}__dot`;
  const hint = document.createElement('span');
  hint.className = `${MARKER_CLASS}__hint`;
  hint.setAttribute('role', 'tooltip');

  element.append(time, dot, hint);
  element.dataset['testid'] = 'map-marker';
  return element;
}

/**
 * Заполнение отметки.
 *
 * Свои классы заменяются, чужие остаются. Раньше в «Сделках» здесь стояло
 * `element.className = ...`, и обновление отметки стирало класс
 * `maplibregl-marker`, который ставит сама библиотека. Вместе с ним элемент
 * терял `position: absolute` и вставал в обычный поток: отметка съезжала
 * относительно подложки на десятки пикселей, хотя её координата не менялась
 * ни разу. Происходило это при КАЖДОМ обновлении данных.
 */
export function fillMarkerElement(element: HTMLElement, content: MarkerContent): void {
  for (const existing of Array.from(element.classList)) {
    if (existing.startsWith(MARKER_CLASS)) {
      element.classList.remove(existing);
    }
  }
  for (const own of content.className.split(' ')) {
    if (own !== '') {
      element.classList.add(own);
    }
  }
  element.setAttribute('aria-label', content.ariaLabel);

  const time = element.querySelector(`.${MARKER_CLASS}__time`);
  const dot = element.querySelector(`.${MARKER_CLASS}__dot`);
  const hint = element.querySelector(`.${MARKER_CLASS}__hint`);
  if (time !== null) {
    time.textContent = content.interval;
  }
  if (dot !== null) {
    dot.textContent = content.label;
  }
  // Подсказка своя, а не нативный `title`: тот появляется через секунду
  // с лишним, и логист успевает решить, что подсказки нет вовсе.
  if (hint !== null) {
    hint.textContent = content.hint;
  }
}

/**
 * Координата доменного объекта — прямо в разметке.
 *
 * Она и есть место заказа. Проверка сверяет с ней экранное положение кружка
 * после каждого масштабирования и сдвига: если когда-нибудь отметку начнут
 * двигать пикселями, расхождение станет видно сразу.
 */
export function stampMarkerPoint(element: HTMLElement, lngLat: readonly [number, number]): void {
  element.dataset['lng'] = String(lngLat[0]);
  element.dataset['lat'] = String(lngLat[1]);
}
