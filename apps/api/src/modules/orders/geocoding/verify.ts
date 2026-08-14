/**
 * Сверка ответа Photon с исходным адресом.
 *
 * Одного признака «Photon вернул дом» НЕДОСТАТОЧНО. Геокодер подбирает
 * ближайшее по звучанию, а не отказывается: измеренный пример — запрос
 * «Санкт-Петербург, Невский проспект, 1» вернул дом «Ленинградский проспект,
 * 74к1» в Москве. Точность у такого ответа «дом», координаты выглядят обычными,
 * и без сверки заказ уехал бы в другой город молча.
 *
 * Рамка `bbox` от этого не защищает: она смещает выборку в рабочую область,
 * а не отбрасывает чужие адреса — наоборот, заставляет искать подходящий дом
 * именно внутри Москвы и области.
 *
 * Поэтому здесь принята обратная логика: точка принимается только тогда, когда
 * КАЖДОЕ значимое слово запроса объяснено ответом. Необъяснённое слово —
 * «санкт», «петербург», «казань» — означает, что найдено не то, что спрашивали.
 * Проверять «нет ли в запросе чужого города» по списку городов бессмысленно:
 * список никогда не будет полным, а необъяснённое слово видно всегда.
 *
 * Строгость намеренно избыточна. Сомнительный адрес уходит логисту в «Требует
 * внимания» — это стоит минуты человека. Принятая неверная точка стоит
 * несостоявшейся доставки и поездки курьера в другой конец города.
 */

import type { PhotonAnswer, PhotonPlace } from '../../integrations/photon/client.js';
import { MOSCOW_REGION_BBOX } from '../../integrations/photon/client.js';
import { normalizeAddress } from './normalize.js';

/** Почему точка не принята. Только технические коды: адресов здесь нет. */
export type RejectReason =
  | 'NOT_A_HOUSE'
  | 'NO_HOUSE_NUMBER_IN_QUERY'
  | 'HOUSE_NUMBER_MISMATCH'
  | 'NO_STREET_IN_ANSWER'
  | 'STREET_MISMATCH'
  | 'PLACE_MISMATCH'
  | 'POSTCODE_MISMATCH'
  | 'FOREIGN_COUNTRY'
  | 'OUTSIDE_WORKING_AREA';

export type Verdict = { accepted: true } | { accepted: false; reason: RejectReason };

const ACCEPTED: Verdict = { accepted: true };
const reject = (reason: RejectReason): Verdict => ({ accepted: false, reason });

/**
 * Служебные слова адреса.
 *
 * Они есть в любом адресе и ничего не различают: объяснять их ответом нельзя
 * и требовать их совпадения бессмысленно.
 */
const GENERIC_WORDS = new Set([
  'улица',
  'проспект',
  'переулок',
  'шоссе',
  'набережная',
  'бульвар',
  'площадь',
  'проезд',
  'тупик',
  'аллея',
  'линия',
  'магистраль',
  'дом',
  'корпус',
  'строение',
  'владение',
  'литера',
  'город',
  'поселок',
  'посёлок',
  'село',
  'деревня',
  'станция',
  'микрорайон',
  'мкр',
  'квартал',
  'район',
  'область',
  'округ',
  'муниципальный',
  'городской',
  'сельское',
  'поселение',
  'россия',
  'российская',
  'федерация',
  'рф',
]);

/**
 * Части адреса, которых в геокодере нет и быть не должно.
 *
 * Квартира, офис, подъезд и этаж находятся ВНУТРИ дома. Геокодер о них не знает,
 * поэтому хвост адреса начиная с такого слова исключается из сверки целиком —
 * вместе с номером. Оставить «квартира 137» значило бы требовать от ответа
 * объяснить число 137, то есть гарантированно отказать.
 */
const INSIDE_HOUSE = /\s(?:квартира|офис|подъезд|этаж|помещение|домофон|код)\s.*$/;

/** Российский почтовый индекс: отдельное шестизначное число. */
const POSTCODE = /(?:^|\s)(\d{6})(?=\s|$)/;

/** Буквы, цифры и пробел; всё остальное для сверки роли не играет. */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '');
}

/**
 * Адрес в сравнимом виде.
 *
 * Используется та же нормализация, что и для ключа кэша: она уже умеет
 * разворачивать «ул.» → «улица», «д.13» → «дом 13», «к.2» → «корпус 2».
 * Держать второй набор правил сокращений значило бы однажды разойтись с первым.
 */
function comparable(address: string): string {
  return normalizeAddress(address).replace(INSIDE_HOUSE, '');
}

/**
 * Номер дома в сравнимом виде.
 *
 * «74 корпус 1», «74к1» и «74 К 1» — один и тот же дом, и отказывать из-за
 * написания нельзя. А вот «74/1» и «74к1» различаются: дробь в адресах Москвы
 * означает другой дом, и склеивать их было бы опаснее, чем разделять.
 *
 * Границы слов заданы просмотрами, а не `\b`: в JavaScript `\b` опирается на
 * `\w`, то есть только на латиницу, и рядом с кириллицей срабатывает не там.
 */
const HOUSE_PARTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![0-9a-zа-я])(?:корпус|корп|кор|к)(?![0-9a-zа-я])/g, 'к'],
  [/(?<![0-9a-zа-я])(?:строение|стр|с)(?![0-9a-zа-я])/g, 'с'],
  [/(?<![0-9a-zа-я])(?:литера|лит|л)(?![0-9a-zа-я])/g, 'л'],
  [/(?<![0-9a-zа-я])(?:владение|влд|вл)(?![0-9a-zа-я])/g, 'в'],
];

export function normalizeHouseNumber(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  let value = raw.toLowerCase().replace(/ё/g, 'е');
  for (const [pattern, replacement] of HOUSE_PARTS) {
    value = value.replace(pattern, replacement);
  }
  return value.replace(/[\s.\-–—]+/g, '').trim();
}

/** Номер дома, указанный в запросе. Пусто — номера в запросе нет. */
export function houseNumberOf(address: string): string {
  const cleaned = comparable(address);

  // Явное указание: после нормализации это всегда «дом N» либо «владение N»,
  // возможно с корпусом и строением.
  const explicit =
    /(?:^|\s)(?:дом|владение)\s+(\d+[0-9а-я]*(?:\s+(?:корпус|строение|литера)\s+[0-9а-я]+)*)/.exec(
      cleaned,
    );
  if (explicit?.[1] !== undefined) {
    return normalizeHouseNumber(explicit[1]);
  }

  // Без слова «дом»: номер в конце адреса — «Тверская улица, 13».
  // Шестизначное число исключается: это индекс, а не дом.
  const tail = /(?:^|\s)(\d{1,5}[а-я]?(?:\s+(?:корпус|строение)\s+[0-9а-я]+)*)$/.exec(cleaned);
  if (tail?.[1] !== undefined) {
    return normalizeHouseNumber(tail[1]);
  }

  return '';
}

/** Значимые слова ответа: всё, чем ответ может объяснить запрос. */
function answerWords(place: PhotonPlace): Set<string> {
  const parts = [
    place.housenumber,
    place.street,
    place.name,
    place.city,
    place.district,
    place.locality,
    place.county,
    place.state,
    place.country,
  ];

  const set = new Set<string>();
  for (const part of parts) {
    if (part === undefined || part === null) {
      continue;
    }
    for (const word of words(part)) {
      set.add(word);
      // Русские названия склоняются: «Мытищи» в ответе и «Мытищах» в запросе —
      // одно и то же место. Сверка по основе слова, а не по точной форме.
      if (word.length > 4) {
        set.add(word.slice(0, word.length - 1));
        set.add(word.slice(0, word.length - 2));
      }
    }
  }
  return set;
}

/** Объяснено ли слово запроса ответом — точно либо по основе. */
function explained(word: string, answer: ReadonlySet<string>): boolean {
  if (answer.has(word)) {
    return true;
  }
  if (word.length > 4) {
    for (let cut = 1; cut <= 2; cut += 1) {
      if (answer.has(word.slice(0, word.length - cut))) {
        return true;
      }
    }
  }
  return false;
}

function insideWorkingArea(lat: number, lon: number): boolean {
  const [minLon, minLat, maxLon, maxLat] = MOSCOW_REGION_BBOX;
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}

/**
 * Можно ли принять эту точку автоматически.
 *
 * Ни одно из условий не является достаточным по отдельности — принимается
 * только непротиворечивое совпадение целиком.
 */
export function verifyPhotonMatch(address: string, answer: PhotonAnswer): Verdict {
  const place = answer.place;

  // 1. Это должен быть дом. Улица и район — «где-то там».
  if (answer.precision !== 'HOUSE') {
    return reject('NOT_A_HOUSE');
  }

  // 2. Ответ обязан находиться в рабочей области. Точка за её пределами
  //    не относится к нашей доставке, чем бы она ни была.
  if (!insideWorkingArea(answer.lat, answer.lon)) {
    return reject('OUTSIDE_WORKING_AREA');
  }

  // 3. Чужая страна отсекается сразу и по явному признаку.
  const code = place.countrycode?.toLowerCase();
  if (code !== undefined && code !== '' && code !== 'ru') {
    return reject('FOREIGN_COUNTRY');
  }

  // 4. Номер дома должен быть и в запросе, и в ответе, и совпадать.
  //    Без номера в запросе «дом» подобран геокодером, а не указан человеком.
  const queried = houseNumberOf(address);
  if (queried === '') {
    return reject('NO_HOUSE_NUMBER_IN_QUERY');
  }
  const found = normalizeHouseNumber(place.housenumber);
  if (found === '') {
    return reject('HOUSE_NUMBER_MISMATCH');
  }
  if (found !== queried) {
    return reject('HOUSE_NUMBER_MISMATCH');
  }

  // 5. Улица должна быть названа в ответе и её слова — встречаться в запросе.
  const street = place.street ?? place.name;
  if (street === undefined || street.trim() === '') {
    return reject('NO_STREET_IN_ANSWER');
  }
  const queryWords = words(comparable(address));
  const querySet = new Set(queryWords);
  const streetSignificant = words(street).filter((word) => !GENERIC_WORDS.has(word));
  if (streetSignificant.length === 0) {
    return reject('NO_STREET_IN_ANSWER');
  }
  if (!streetSignificant.every((word) => explained(word, querySet))) {
    return reject('STREET_MISMATCH');
  }

  // 6. Индекс: расхождение — противоречие. Отсутствие индекса в ответе
  //    противоречием не является: это пробел данных, а не другой адрес.
  const queriedPostcode = POSTCODE.exec(comparable(address))?.[1];
  const foundPostcode = place.postcode?.replace(/\D/g, '');
  if (
    queriedPostcode !== undefined &&
    foundPostcode !== undefined &&
    foundPostcode !== '' &&
    foundPostcode !== queriedPostcode
  ) {
    return reject('POSTCODE_MISMATCH');
  }

  // 7. Главное правило: каждое значимое слово запроса должно быть объяснено
  //    ответом. Необъяснённое слово — это чужой город, чужой регион или чужая
  //    улица, и именно оно ловит «Санкт-Петербург» в московском доме.
  const answerSet = answerWords(place);
  for (const word of queryWords) {
    if (GENERIC_WORDS.has(word)) {
      continue;
    }
    if (word === queriedPostcode) {
      continue;
    }
    if (/^\d+$/.test(word) && normalizeHouseNumber(word) === queried) {
      continue;
    }
    // Одиночные буквы и цифры внутри номера дома («к», «1») уже учтены
    // сравнением номера и различать адреса не могут.
    if (word.length <= 1) {
      continue;
    }
    if (queried.includes(normalizeHouseNumber(word))) {
      continue;
    }
    if (!explained(word, answerSet)) {
      return reject('PLACE_MISMATCH');
    }
  }

  return ACCEPTED;
}
