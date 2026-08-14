/**
 * Критические проверки сверки ответа Photon с исходным адресом.
 *
 * Живого геокодера здесь нет: HTTP Photon подменён функцией, а ответы —
 * это настоящий формат Photon с полями, которые он действительно возвращает.
 * Проверяется главное свойство: признака «Photon вернул дом» недостаточно,
 * и точка принимается только при непротиворечивом совпадении.
 *
 * Отдельно закреплена измеренная регрессия: запрос «Санкт-Петербург, Невский
 * проспект, 1» на нашем индексе Москвы и области возвращает дом
 * «Ленинградский проспект, 74к1» в Москве. Точность у него «дом», координаты
 * выглядят обычными — и без сверки заказ уехал бы в другой город молча.
 *
 * Адресов клиентов здесь нет: только публичные ориентиры и заведомо
 * синтетические строки.
 */

import { describe, expect, it } from 'vitest';
import { PhotonClient, type PhotonPlace } from '../../integrations/photon/client.js';
import { decideResult } from './worker.js';
import { houseNumberOf, normalizeHouseNumber, verifyPhotonMatch } from './verify.js';

const PRIVATE_URL = 'http://photon.internal:2322/api';

/** Ответ Photon в его настоящем формате. */
function feature(place: PhotonPlace & { lat: number; lon: number }, type = 'house'): unknown {
  const { lat, lon, ...properties } = place;
  return {
    geometry: { coordinates: [lon, lat] },
    properties: { ...properties, type, osm_key: 'place', osm_value: 'house' },
  };
}

/** Подменённый HTTP: настоящих сетевых обращений в тестах не бывает. */
function photonReturning(features: unknown[]): PhotonClient {
  return new PhotonClient({
    url: PRIVATE_URL,
    fetch: (async () =>
      new Response(JSON.stringify({ features }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch,
  });
}

/** Дом на Тверской: используется как «правильный» ответ во многих проверках. */
const TVERSKAYA_13 = {
  lat: 55.7612,
  lon: 37.6081,
  housenumber: '13',
  street: 'Тверская улица',
  city: 'Москва',
  state: 'Москва',
  postcode: '125009',
  countrycode: 'RU',
};

/** Дом в Мытищах: тот же случай, но в области, а не в городе. */
const MYTISHCHI_29 = {
  lat: 55.9289,
  lon: 37.7519,
  housenumber: '29',
  street: 'Олимпийский проспект',
  city: 'Мытищи',
  county: 'городской округ Мытищи',
  state: 'Московская область',
  countrycode: 'RU',
};

/**
 * Что Photon фактически возвращает на петербургский адрес.
 *
 * Значения взяты из измерения на собранном индексе Москвы и области,
 * артефакт `5d3a5de3…cebda`.
 */
const SPB_FALSE_MATCH = {
  lat: 55.8052,
  lon: 37.5166,
  housenumber: '74 к1',
  street: 'Ленинградский проспект',
  city: 'Москва',
  state: 'Москва',
  countrycode: 'RU',
};

describe('регрессия: чужой город не превращается в московский дом', () => {
  it('«Санкт-Петербург, Невский проспект, 1» не становится точкой', async () => {
    const client = photonReturning([feature(SPB_FALSE_MATCH)]);
    const answer = await client.search('Санкт-Петербург, Невский проспект, 1');

    // Photon честно считает это домом — и именно поэтому одного признака мало.
    expect(answer?.precision).toBe('HOUSE');
    expect(answer?.place.housenumber).toBe('74 к1');

    const verdict = verifyPhotonMatch('Санкт-Петербург, Невский проспект, 1', answer!);
    expect(verdict.accepted).toBe(false);

    // И решение обработчика — позвать человека, а не поставить точку.
    const decision = decideResult(answer, 'Санкт-Петербург, Невский проспект, 1');
    expect(decision.kind).toBe('LOW_PRECISION');
  });

  it('ни один московский дом не подбирается под петербургский адрес', async () => {
    // Даже если бы номер дома случайно совпал, город остаётся чужим.
    const client = photonReturning([
      feature({ ...SPB_FALSE_MATCH, housenumber: '1', street: 'Невский проезд' }),
    ]);
    const answer = await client.search('Санкт-Петербург, Невский проспект, 1');

    expect(answer?.precision).toBe('HOUSE');
    expect(decideResult(answer, 'Санкт-Петербург, Невский проспект, 1').kind).toBe('LOW_PRECISION');
  });

  it('другой явно чужой город тоже не принимается', async () => {
    const cases: [string, PhotonPlace & { lat: number; lon: number }][] = [
      [
        'Казань, улица Баумана, 1',
        { ...TVERSKAYA_13, housenumber: '1', street: 'Баумановская улица' },
      ],
      [
        'Екатеринбург, улица Ленина, 5',
        { ...TVERSKAYA_13, housenumber: '5', street: 'улица Ленина' },
      ],
      [
        'Новосибирск, Красный проспект, 1',
        { ...TVERSKAYA_13, housenumber: '1', street: 'Красная площадь' },
      ],
    ];

    for (const [address, place] of cases) {
      const answer = await photonReturning([feature(place)]).search(address);
      expect(decideResult(answer, address).kind, address).toBe('LOW_PRECISION');
    }
  });
});

describe('корректный адрес принимается', () => {
  it('дом Москвы становится точкой', async () => {
    const address = 'Москва, Тверская улица, 13';
    const answer = await photonReturning([feature(TVERSKAYA_13)]).search(address);

    expect(verifyPhotonMatch(address, answer!).accepted).toBe(true);
    const decision = decideResult(answer, address);
    expect(decision).toMatchObject({
      kind: 'RESOLVED',
      latMicro: 55_761_200,
      lonMicro: 37_608_100,
    });
  });

  it('дом Московской области становится точкой', async () => {
    const address = 'Мытищи, Олимпийский проспект, 29';
    const answer = await photonReturning([feature(MYTISHCHI_29)]).search(address);

    expect(verifyPhotonMatch(address, answer!).accepted).toBe(true);
    expect(decideResult(answer, address).kind).toBe('RESOLVED');
  });

  it('область, названная в запросе полностью, не мешает', async () => {
    const address = 'Московская область, город Мытищи, Олимпийский проспект, дом 29';
    const answer = await photonReturning([feature(MYTISHCHI_29)]).search(address);

    expect(decideResult(answer, address).kind).toBe('RESOLVED');
  });
});

describe('сокращения, регистр и пунктуация ложного отказа не создают', () => {
  const answerFor = async (address: string) =>
    photonReturning([feature(TVERSKAYA_13)]).search(address);

  it('«ул.», «д.», регистр и лишние запятые', async () => {
    const variants = [
      'Москва, ул. Тверская, д. 13',
      'москва, ул.Тверская, д.13',
      'МОСКВА, УЛ ТВЕРСКАЯ, Д 13',
      'Москва,  ул. Тверская,   д. 13,',
      'г. Москва, ул. Тверская, д. 13',
      'Россия, г Москва, ул Тверская, д 13',
      '125009, Москва, Тверская улица, 13',
    ];

    for (const address of variants) {
      const answer = await answerFor(address);
      expect(decideResult(answer, address).kind, address).toBe('RESOLVED');
    }
  });

  it('квартира, офис и подъезд в сверке не участвуют', async () => {
    // Они находятся ВНУТРИ дома, и геокодер о них не знает. Требовать их
    // совпадения — гарантированный ложный отказ.
    for (const address of [
      'Москва, Тверская улица, 13, кв. 5',
      'Москва, ул. Тверская, д. 13, квартира 137',
      'Москва, Тверская улица, 13, офис 4, подъезд 2, этаж 3',
    ]) {
      const answer = await answerFor(address);
      expect(decideResult(answer, address).kind, address).toBe('RESOLVED');
    }
  });

  it('корпус и строение в разных написаниях считаются одним домом', async () => {
    expect(normalizeHouseNumber('74 к1')).toBe(normalizeHouseNumber('74 корпус 1'));
    expect(normalizeHouseNumber('74к1')).toBe(normalizeHouseNumber('74 К 1'));
    expect(normalizeHouseNumber('29 с1')).toBe(normalizeHouseNumber('29 строение 1'));

    // А дробь — это другой дом, и склеивать её с корпусом нельзя.
    expect(normalizeHouseNumber('74/1')).not.toBe(normalizeHouseNumber('74к1'));

    const address = 'Москва, Тверская улица, дом 13 корпус 2';
    const answer = await photonReturning([
      feature({ ...TVERSKAYA_13, housenumber: '13к2' }),
    ]).search(address);
    expect(decideResult(answer, address).kind).toBe('RESOLVED');
  });

  it('номер дома извлекается из разных написаний', () => {
    expect(houseNumberOf('Москва, Тверская улица, 13')).toBe('13');
    expect(houseNumberOf('Москва, ул. Тверская, д. 13')).toBe('13');
    expect(houseNumberOf('Москва, ул. Тверская, д.13, кв.5')).toBe('13');
    expect(houseNumberOf('Москва, Тверская улица, дом 13 корпус 2')).toBe('13к2');
    // Индекс домом не считается.
    expect(houseNumberOf('125009, Москва, Тверская улица')).toBe('');
    expect(houseNumberOf('Москва, Тверская улица')).toBe('');
  });
});

describe('противоречие означает отказ', () => {
  it('другой номер того же дома не принимается', async () => {
    const address = 'Москва, Тверская улица, 15';
    const answer = await photonReturning([feature(TVERSKAYA_13)]).search(address);

    const verdict = verifyPhotonMatch(address, answer!);
    expect(verdict).toMatchObject({ accepted: false, reason: 'HOUSE_NUMBER_MISMATCH' });
    expect(decideResult(answer, address).kind).toBe('LOW_PRECISION');
  });

  it('другой корпус того же дома не принимается', async () => {
    const address = 'Москва, Тверская улица, дом 13 корпус 3';
    const answer = await photonReturning([
      feature({ ...TVERSKAYA_13, housenumber: '13к2' }),
    ]).search(address);

    expect(decideResult(answer, address).kind).toBe('LOW_PRECISION');
  });

  it('другая улица не принимается', async () => {
    const address = 'Москва, Ленинградский проспект, 13';
    const answer = await photonReturning([feature(TVERSKAYA_13)]).search(address);

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'STREET_MISMATCH',
    });
  });

  it('адрес без номера дома не принимается автоматически', async () => {
    // Дом здесь подобрал геокодер, а не указал человек.
    const address = 'Москва, Тверская улица';
    const answer = await photonReturning([feature(TVERSKAYA_13)]).search(address);

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'NO_HOUSE_NUMBER_IN_QUERY',
    });
  });

  it('ответ без улицы не принимается', async () => {
    const address = 'Москва, Тверская улица, 13';
    const answer = await photonReturning([
      feature({ lat: 55.76, lon: 37.6, housenumber: '13', city: 'Москва', countrycode: 'RU' }),
    ]).search(address);

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'NO_STREET_IN_ANSWER',
    });
  });

  it('расхождение индекса не принимается', async () => {
    const address = '199034, Москва, Тверская улица, 13';
    const answer = await photonReturning([feature(TVERSKAYA_13)]).search(address);

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'POSTCODE_MISMATCH',
    });
  });

  it('отсутствие индекса в ответе отказом не является', async () => {
    // Пробел в данных — не противоречие: другого адреса он не доказывает.
    const address = '125009, Москва, Тверская улица, 13';
    const { postcode: _drop, ...withoutPostcode } = TVERSKAYA_13;
    const answer = await photonReturning([feature(withoutPostcode)]).search(address);

    expect(verifyPhotonMatch(address, answer!).accepted).toBe(true);
  });

  it('точка за пределами рабочей области не принимается', async () => {
    const address = 'Москва, Тверская улица, 13';
    const answer = await photonReturning([
      feature({ ...TVERSKAYA_13, lat: 59.9343, lon: 30.3351 }),
    ]).search(address);

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'OUTSIDE_WORKING_AREA',
    });
  });

  it('чужая страна не принимается', async () => {
    const address = 'Москва, Тверская улица, 13';
    const answer = await photonReturning([feature({ ...TVERSKAYA_13, countrycode: 'BY' })]).search(
      address,
    );

    expect(verifyPhotonMatch(address, answer!)).toMatchObject({
      accepted: false,
      reason: 'FOREIGN_COUNTRY',
    });
  });

  it('улица и район домом не объявляются', async () => {
    const address = 'Москва, Тверская улица, 13';
    for (const type of ['street', 'city']) {
      const answer = await photonReturning([
        feature({ lat: 55.76, lon: 37.61, street: 'Тверская улица', city: 'Москва' }, type),
      ]).search(address);
      expect(decideResult(answer, address).kind, type).toBe('LOW_PRECISION');
    }
  });

  it('пустой ответ означает «не найдено», а не подбор похожего', async () => {
    const address = 'Москва, улица Несуществующая Синтетическая, 999';
    const answer = await photonReturning([]).search(address);

    expect(answer).toBeNull();
    expect(decideResult(answer, address).kind).toBe('LOW_PRECISION');
  });
});
