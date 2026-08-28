/**
 * Конфигурация приложения из переменных окружения.
 *
 * Секреты читаются только здесь и только на сервере. Ни одно значение из этого модуля
 * не попадает в клиентскую сборку и не выводится в лог целиком.
 */

import { z } from 'zod';
import { MAX_MATRIX_POINTS } from '../modules/geo/limits.js';
import { isCalendarDate } from '../modules/integrations/moysklad/delivery-date.js';

/**
 * Необязательное значение, у которого пустая строка означает «не задано».
 *
 * Шаблон конфигурации перечисляет такие переменные пустыми, и файлы окружения
 * доносят их до процесса именно пустой строкой, а не отсутствием. Без этого
 * приведения скопированный без правок шаблон ронял бы запуск сообщением
 * «слишком короткая строка» — вместо честного «не настроено», ради которого
 * переменная и объявлена необязательной.
 */
const optionalText = (): z.ZodType<string | undefined> =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).optional(),
  );

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Логическое окружение: local | staging | production. */
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  /**
   * Маркер окружения. Deploy-скрипты сверяют его с ожидаемым значением цели,
   * чтобы staging-команда не могла отработать по production-хосту и наоборот.
   */
  APP_ENVIRONMENT_MARKER: z.string().min(1).default('local'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // `silent` полностью отключает вывод и используется в тестах.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  /** Каталог собранного web-клиента; в production один Node-процесс отдаёт API и статику. */
  WEB_DIST_PATH: z.string().optional(),

  /**
   * Доверие к заголовкам прокси (`X-Forwarded-For`).
   *
   * По умолчанию — отключено. Безусловное доверие позволило бы клиенту подделать
   * свой IP-адрес и обойти будущий rate limit и прогрессивную блокировку перебора,
   * если приложение окажется доступно не только через доверенный reverse proxy.
   *
   * Допустимые значения:
   *   не задано | `false`  — не доверять никому (значение по умолчанию);
   *   целое число          — доверять строго указанному числу переходов;
   *   список IP или CIDR   — доверять только перечисленным адресам, через запятую.
   *
   * Значение `true` запрещено намеренно.
   */
  TRUST_PROXY: z.string().optional(),

  // --- Секреты авторизации ---
  // Обязательны во всех окружениях. Небезопасного значения по умолчанию нет намеренно:
  // сгенерированный на лету секрет молча обесценил бы подписи и шифрование,
  // а «пустой» секрет означал бы подделываемые токены.
  // Для локальной разработки значения задаются в docker-compose.yml и явно помечены dev-only.
  AUTH_ACCESS_TOKEN_SECRET: z
    .string()
    .min(32, 'AUTH_ACCESS_TOKEN_SECRET должен быть не короче 32 символов'),
  AUTH_PIN_PEPPER: z.string().min(32, 'AUTH_PIN_PEPPER должен быть не короче 32 символов'),
  // --- МойСклад ---
  // Рабочий токен существует только в production и в staging-режиме read-only
  // (решение владельца ENV-004). Локальная разработка и CI работают на фикстурах
  // и поддельном HTTP: настоящие заказы туда не попадают, а случайно оставленный
  // в чужом окружении токен — это доступ к живому аккаунту.
  MOYSKLAD_TOKEN: z.string().min(1).optional(),
  /**
   * Режим «только чтение» серверного контура МоегоСклада.
   *
   * Несекретный параметр: он не даёт доступа, а отнимает его. Значением по
   * умолчанию НЕ снабжён намеренно — различаются три состояния:
   *
   *   `'true'`     — явное согласие на живой read-only контур; обязательное
   *                  условие допуска токена и синхронизации на staging;
   *   отсутствует  — контур не настраивают. Безопасно означает «только чтение»
   *                  для окружения без токена, но разрешением начать живую
   *                  staging-синхронизацию не является;
   *   `'false'`    — режим записи. Он ещё не существует ни в одном окружении,
   *                  поэтому запуск останавливается: молча стартовать с
   *                  настройкой, которой код не поддерживает, нельзя.
   */
  MOYSKLAD_READ_ONLY: z.enum(['true', 'false']).optional(),

  /**
   * Идентификатор статуса «Отменен» в МоемСкладе.
   *
   * Значение принадлежит конкретному аккаунту и в репозитории не хранится:
   * в другом аккаунте у того же статуса другой идентификатор, а название
   * администратор переименовывает в любой момент.
   *
   * Пустое значение — это НЕ «отмен не бывает», а «распознавание отмен
   * выключено». В local и staging это допустимо: контур настраивают
   * постепенно. В production пустое значение недопустимо — отменённые
   * заказы молча уезжали бы клиентам.
   */
  MOYSKLAD_CANCELLED_STATE_ID: z.string().trim().optional(),
  /** Автоматический фоновый опрос. По умолчанию выключен во всех окружениях. */
  MOYSKLAD_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Узкая синхронизация СОСТОЯНИЯ заказа в МойСклад.
   *
   * Разрешает единственную операцию записи — смену поля `state` заказа
   * покупателя — и ничего больше. Глобальный запрет записи (`MOYSKLAD_READ_ONLY`)
   * этим флагом НЕ ослабляется: любой другой метод, кроме GET/HEAD и этой
   * именованной операции, клиент по-прежнему отвергает.
   *
   * По умолчанию выключен во всех окружениях. Включать разрешено только в
   * production (см. `assertMoyskladEnvironment`): на local и staging реальные
   * записи в живой аккаунт не выполняются, а контракт проверяется подменным
   * сервером в тестах.
   */
  MOYSKLAD_ORDER_STATE_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  MOYSKLAD_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  /** Перекрытие окна delta-синхронизации. Стартовое значение — пять минут. */
  MOYSKLAD_SYNC_OVERLAP_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),

  /**
   * Откуда собирать ЗАПРОС К ГЕОКОДЕРУ.
   *
   * Адрес заказа этим не управляется: он всегда операционный и приходит целиком,
   * с квартирой и домофоном. Настройка влияет только на строку, которая уходит
   * в Photon: `shipmentAddressFull` собирает её из разобранных частей —
   * индекс, страна, регион, город, улица и дом.
   *
   * Значение временное и включается только там, где его проверяют. Умолчание
   * сохраняет прежнее поведение: отдельного запроса нет, геокодер берёт адрес.
   */
  MOYSKLAD_GEOCODING_ADDRESS_SOURCE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['shipmentAddress', 'shipmentAddressFull']).default('shipmentAddress'),
  ),

  /**
   * Доля общего токена МоегоСклада, которую занимает наш импорт.
   *
   * Токен делят несколько сервисов, поэтому предел выбирается не по
   * возможностям API, а по доле, которую мы согласны отнять у остальных.
   * Умолчания сохраняют прежнее поведение: один запрос в секунду,
   * последовательно, без неприкосновенного остатка.
   */
  MOYSKLAD_API_MAX_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(45).default(1),
  /**
   * Параллельность обращений. Больше единицы клиент не поддерживает: очередь
   * последовательна по построению, и значение здесь — явный договор, а не
   * настройка, которую можно поднять и получить другое поведение.
   */
  MOYSKLAD_API_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
  /**
   * Неприкосновенный остаток окна лимита.
   *
   * Ноль означает «не придерживать» — прежнее поведение. Положительное
   * значение останавливает нашу очередь, когда сервер сообщает, что осталось
   * меньше: остаток общий, и последние обращения нужны чужой интеграции
   * не меньше, чем нам.
   */
  MOYSKLAD_API_RESERVE_REQUESTS: z.coerce.number().int().min(0).max(1000).default(0),

  /**
   * Нижняя граница даты доставки при импорте из МоегоСклада.
   *
   * Московская календарная дата `ГГГГ-ММ-ДД`, граница ВКЛЮЧИТЕЛЬНАЯ: заказ
   * с этой датой импортируется, а с предыдущей — нет. Нужна первому запуску
   * нового контура: старые сделки из МоегоСклада туда переносить не нужно,
   * а перенести их «потом вручную» невозможно — заказ создаётся один раз.
   *
   * Это ограничение ОТБОРА, а не подмена даты: у созданного заказа дата
   * доставки остаётся ровно той, что пришла из источника.
   *
   * Отсутствие переменной сохраняет прежнее поведение — так работают local
   * и staging. А вот НЕВЕРНОЕ значение роняет запуск: молча импортировать
   * без ограничения хуже, чем не запуститься, потому что лишние заказы
   * пришлось бы удалять руками, а удаления заказов в системе нет.
   */
  MOYSKLAD_IMPORT_DELIVERY_DATE_FROM: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().optional(),
    )
    .refine((value) => value === undefined || isCalendarDate(value), {
      message:
        'MOYSKLAD_IMPORT_DELIVERY_DATE_FROM должен быть московской календарной датой ГГГГ-ММ-ДД',
    }),

  /**
   * Новый адресный контракт: город, улица и дом отдельно от деталей.
   *
   * Выключатель, а не переключатель поведения всего приложения. Он решает
   * ровно одно: получит ли ВПЕРВЫЕ создаваемый заказ версию контракта 2.
   * Существующие заказы он не трогает никогда, а уже созданные заказы версии 2
   * продолжают работать по своей записанной версии и после выключения —
   * поэтому обратный ход не ломает данные, а лишь прекращает выпуск новых.
   *
   * По умолчанию выключен, и в `.env.example` записано `false`: новый контур
   * не должен включить незавершённый переход случайно. Неизвестное значение
   * роняет разбор конфигурации — молчаливого включения быть не может.
   */
  MOYSKLAD_STRUCTURED_ADDRESS_V2_ENABLED: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(['true', 'false']).default('false'),
    )
    .transform((value) => value === 'true'),

  // --- DaData: ТОЛЬКО подсказки адреса в ручной правке ---
  // Ключ даёт доступ к платному балансу организации, а каждый запрос содержит
  // адрес клиента: обращение из local, CI или смешанной конфигурации означало
  // бы и трату чужих денег, и отправку персональных данных наружу из окружения,
  // где их быть не должно.
  //
  // Ключ ровно один. Подсказки авторизуются заголовком `Authorization: Token`
  // и ничего кроме него не отправляют. Секретный ключ (`X-Secret`) требовался
  // платному Clean API, которого в проекте больше нет, и здесь его нет тоже:
  // хранить на сервере секрет, который никуда не уходит, — лишний риск без
  // единой причины.
  DADATA_API_KEY: optionalText(),
  /**
   * Серверные подсказки адреса в ручной правке.
   *
   * Автоматическое геокодирование этим флагом НЕ включается: его включает
   * только `PHOTON_URL`.
   */
  DADATA_GEOCODING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Адрес СОБСТВЕННОГО Photon — единственного автоматического геокодера.
   *
   * Пусто — геокодер не настроен, и ни одного обращения не выполняется:
   * новые адреса просто остаются в «Требует внимания». Публичные
   * `photon.komoot.io` и `nominatim.openstreetmap.org` отвергаются до сети
   * (`modules/integrations/photon/client.ts`): они не рассчитаны на рабочую
   * нагрузку и увозят адреса клиентов третьей стороне.
   *
   * Ключей здесь нет и быть не может: это внутренний адрес нашего же
   * контейнера.
   */
  PHOTON_URL: optionalText(),

  /**
   * Автоматическое фоновое геокодирование.
   *
   * Отдельный переключатель, а не следствие заданного `PHOTON_URL`. Настроенный
   * геокодер и РАЗРЕШЕНИЕ обрабатывать им всю очередь — разные решения:
   * на новом наборе сначала нужен управляемый проход в два десятка запросов,
   * а не молчаливая обработка всех накопленных заказов сразу.
   *
   * Fail closed: по умолчанию и при пустом значении автоматический режим
   * выключен. Ручной ограниченный проход (`npm run geocode:backfill --limit`)
   * от этого флага не зависит — он и существует для контролируемого пилота.
   */
  PHOTON_AUTO_GEOCODING_ENABLED: z
    .preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(['true', 'false']).default('false'),
    )
    .transform((value) => value === 'true'),

  /**
   * Адрес стиля карты MapLibre. Пусто — карта честно не настроена.
   *
   * Ключей здесь быть не может: значение целиком уходит в браузер. Публичные
   * тайлы OSM и демонстрационные тайлы MapLibre в production запрещены —
   * их условия не допускают продуктовую нагрузку.
   */
  MAP_STYLE_URL: z.string().trim().max(500).optional(),
  /** Подпись правообладателя подложки. Показывается на карте. */
  MAP_ATTRIBUTION: z.string().trim().max(200).optional(),

  /**
   * Каталог картографических артефактов, смонтированный только на чтение.
   *
   * Подложка не хранится ни в Git, ни в образе приложения: PMTiles на регион —
   * это сотни мегабайт, которые навсегда остались бы в истории репозитория
   * и в каждом слое образа. Файлы кладутся на сервер отдельной операцией,
   * а приложение при старте сверяет их с манифестом.
   */
  MAP_ARTIFACTS_PATH: z.string().trim().max(500).optional(),

  // --- Расчёт времени и расстояний ---
  // Собственная Valhalla живёт внутри сети Compose и наружу не публикуется.
  // Адрес известен только серверу: маршрутизатор, доступный из интернета, —
  // это чужой бесплатный вычислитель и способ узнать, куда мы возим.
  VALHALLA_URL: z.string().trim().max(300).optional(),
  /**
   * Идентичность дорожного графа: SHA-256 файла `tiles.tar`.
   *
   * Входит в ключ кэша матриц. Без неё расчёт невозможен: результат нельзя было
   * бы отнести к данным, по которым он получен, и он пережил бы смену графа.
   *
   * Формат строгий — ровно 64 шестнадцатеричных символа. Прежде здесь стояло
   * Unix-время изменения файла: оно менялось при обычном копировании набора
   * на сервер и не менялось при подмене содержимого с сохранением времени.
   * Ограничение формата не даёт такому значению вернуться сюда молча.
   */
  VALHALLA_GRAPH_SHA256: z
    .string()
    .trim()
    .regex(
      /^[0-9a-f]{64}$/,
      'VALHALLA_GRAPH_SHA256 должен быть SHA-256 из 64 шестнадцатеричных символов',
    )
    .optional(),
  // --- Оптимизация маршрутов ---
  // Решатель VROOM живёт в ОТДЕЛЬНОЙ внутренней сети Compose без единого
  // проброса портов. Полностью отрезать его от сети нельзя: мы сами шлём ему
  // HTTP. Поэтому изоляция строится не отсутствием сети, а отсутствием доступа
  // к ней снаружи.
  VROOM_URL: z.string().trim().max(300).optional(),
  /**
   * Версия решателя из закреплённого образа, например `1.15.0`.
   *
   * Записывается в неизменяемый снимок результата: без неё нельзя объяснить,
   * почему одинаковый вход когда-то дал другой план.
   *
   * Возможностью решателя это значение НЕ является. Разное время обслуживания
   * по типам транспорта появилось в 1.15.0, и проверяется оно пробной задачей
   * при старте, а не доверием к переменной окружения: запись легко разойдётся
   * с фактически запущенным образом.
   */
  VROOM_VERSION: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+$/, 'VROOM_VERSION должен иметь вид 1.15.0')
    .optional(),

  /**
   * Подменные решатель и матрица вместо VROOM и Valhalla.
   *
   * Существует ради браузерной приёмки: она обязана проходить через настоящий
   * серверный контракт, а не подменять HTTP-ответ в браузере. Настоящий расчёт
   * требует дорожного графа и отдельных сервисов, которых в проверке нет.
   *
   * Оптимизации подменный решатель не выполняет и выполнять не может: он
   * раскладывает заказы подряд по вместимости. Значение допустимо ТОЛЬКО
   * в локальном окружении — план, выданный им за посчитанный, на staging или
   * в production был бы обманом.
   */
  /**
   * Подменённый HTTP подсказок адреса вместо живой DaData.
   *
   * Существует ради браузерной приёмки: она обязана идти через настоящий
   * серверный контракт подсказок — тот же эндпоинт, тот же разбор ответа, —
   * а живого ключа в проверках нет и быть не должно.
   *
   * Значение допустимо ТОЛЬКО в локальном окружении: подменённые подсказки
   * на staging или в production выдавали бы выдуманные адреса за настоящие.
   */
  DADATA_TEST_SUGGESTIONS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  PLANNING_TEST_SOLVER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Подменённая дорожная геометрия вместо обращения к Valhalla.
   *
   * Нужна ровно для одного: чтобы линия маршрута была видна на локальном
   * стенде, где дорожного графа нет. Подмена стоит на уровне HTTP — клиент,
   * разбор ответа и весь контракт геометрии остаются настоящими.
   *
   * Значение допустимо ТОЛЬКО в локальном окружении: нарисованный путь,
   * выданный за расчёт настоящего маршрутизатора, — это обещание времени
   * и расстояния, которого никто не давал.
   */
  VALHALLA_TEST_ROUTE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Входы, существующие только ради браузерных проверок.
   *
   * Нужны там, где сигнал приходит ИЗВНЕ и в интерфейсе его вызвать нечем:
   * отмена заказа приходит из МоегоСклада проходом импорта, и без такого
   * входа браузерный сценарий не мог бы её воспроизвести вовсе.
   *
   * Допустимо только в local: в staging и production такой вход означал бы
   * возможность менять состояние заказов запросом мимо всех правил.
   */
  E2E_TEST_HOOKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Верхняя граница числа точек матрицы: она растёт квадратично.
   *
   * Значение по умолчанию берётся из общего источника, а не пишется числом:
   * ровно на этот предел собирается бюджет `max_matrix_location_pairs`
   * дорожного графа. Разошедшись, эти два числа дают отказ маршрутизатора
   * на сервере, а не на проверке.
   */
  MATRIX_MAX_POINTS: z.coerce.number().int().min(2).max(200).default(MAX_MATRIX_POINTS),
  /** Срок жизни готовой матрицы. Граф между сборками не меняется. */
  MATRIX_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600)
    .default(86_400),

  /** Ключ AES-256-GCM в base64: ровно 32 байта после декодирования. */
  AUTH_REFRESH_REPLAY_KEY: z
    .string()
    .min(1, 'AUTH_REFRESH_REPLAY_KEY обязателен')
    .refine((value) => decodeBase64Key(value)?.length === 32, {
      message: 'AUTH_REFRESH_REPLAY_KEY должен быть 32 байтами в base64 (ключ AES-256-GCM)',
    }),
});

/** Декодирует base64 без выбрасывания исключения; возвращает null при некорректном значении. */
function decodeBase64Key(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    // Buffer.from не сообщает об ошибке, поэтому проверяем обратимость кодирования.
    return buffer.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')
      ? buffer
      : null;
  } catch {
    return null;
  }
}

/** Значение, которое принимает Fastify в опции `trustProxy`. */
export type TrustProxySetting = false | number | string[];

export type AppConfig = Readonly<z.infer<typeof configSchema>> & {
  readonly isProduction: boolean;
  /** Локальная разработка: только здесь допустимы cookie без флага Secure. */
  readonly isLocal: boolean;
  /**
   * Уровень допуска к живому МоемуСкладу. `denied` означает, что контур
   * выключен целиком: ни worker, ни ручная команда не стартуют.
   */
  readonly moyskladAccess: 'production' | 'staging-read-only' | 'denied';
  readonly trustProxy: TrustProxySetting;
  /** Ключ AES-256-GCM для кратковременного хранения преемника refresh-токена. */
  readonly refreshReplayKey: Buffer;
};

const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+(\/\d{1,3})?$/i;

/**
 * Разбирает и проверяет настройку доверия к прокси.
 * Некорректное значение — причина отказать в запуске, а не молча доверять всем.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? '';

  if (value === '' || value.toLowerCase() === 'false') {
    return false;
  }

  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true запрещено: безусловное доверие заголовкам прокси позволяет ' +
        'подделать IP-адрес клиента. Укажите список IP/CIDR доверенных прокси ' +
        'либо число доверенных переходов.',
    );
  }

  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) {
      throw new Error('TRUST_PROXY: число доверенных переходов должно быть от 1 до 10');
    }
    return hops;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const invalid = entries.filter((entry) => !IP_OR_CIDR.test(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `TRUST_PROXY: ожидается false, число переходов или список IP/CIDR. ` +
        `Не распознано: ${invalid.join(', ')}`,
    );
  }

  return entries;
}

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    // Печатаем только имена переменных и текст правила — без значений,
    // иначе некорректный секрет попал бы в вывод процесса.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Некорректная конфигурация окружения:\n  ${problems}`);
  }

  assertMoyskladEnvironment(parsed.data);
  assertCancelledStateEnvironment(parsed.data);
  assertDadataEnvironment(parsed.data);
  assertTestSolverEnvironment(parsed.data);
  assertTestSuggestionsEnvironment(parsed.data);
  assertTestRouteEnvironment(parsed.data);
  assertTestHooksEnvironment(parsed.data);
  assertGeocodingSource(parsed.data);

  return Object.freeze({
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
    isLocal: parsed.data.APP_ENV === 'local',
    /** Уровень допуска к живому МоемуСкладу; `denied` — контур выключен целиком. */
    moyskladAccess: moyskladAccess(parsed.data),
    trustProxy: parseTrustProxy(parsed.data.TRUST_PROXY),
    refreshReplayKey: Buffer.from(parsed.data.AUTH_REFRESH_REPLAY_KEY, 'base64'),
  });
}

/**
 * Fail closed для интеграции с МоимСкладом.
 *
 * Рабочий токен даёт полный доступ к живому аккаунту с реальными заказами.
 * Поэтому запуск останавливается, а не продолжается с предупреждением: приложение,
 * молча стартовавшее с production-токеном в staging, однажды сходит в чужие данные.
 */
export function moyskladAccess(data: {
  APP_ENV: 'local' | 'staging' | 'production';
  APP_ENVIRONMENT_MARKER: string;
  MOYSKLAD_READ_ONLY?: 'true' | 'false' | undefined;
}): 'production' | 'staging-read-only' | 'denied' {
  // Оба признака обязаны совпасть: смешанная конфигурация вроде
  // APP_ENV=staging с production-маркером означает ошибку развёртывания,
  // и продолжать с рабочим токеном в такой ситуации нельзя.
  if (data.APP_ENV === 'production' && data.APP_ENVIRONMENT_MARKER === 'production') {
    return 'production';
  }
  // Staging допускается только вместе с ЯВНЫМ несекретным режимом чтения.
  // Совпавшего маркера мало, и отсутствующего значения тоже: молчание — это
  // «контур не настраивают», а не согласие включить живую синхронизацию.
  if (
    data.APP_ENV === 'staging' &&
    data.APP_ENVIRONMENT_MARKER === 'staging' &&
    data.MOYSKLAD_READ_ONLY === 'true'
  ) {
    return 'staging-read-only';
  }
  return 'denied';
}

/** Идентификаторы МоегоСклада приходят и уходят только в этом виде. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Признак отмены обязан быть настроен там, где отменённый заказ дорог.
 *
 * В production молчание недопустимо: без идентификатора статус «Отменен»
 * ничем не отличается от обычного, и отменённый заказ поехал бы к клиенту.
 * В local и staging пустое значение — обычное состояние настраиваемого
 * контура, и запуск оно не останавливает.
 *
 * Мусор вместо идентификатора отвергается везде: молча не распознавать
 * отмену из-за опечатки в переменной хуже, чем не стартовать.
 */
function assertCancelledStateEnvironment(data: z.infer<typeof configSchema>): void {
  const raw = data.MOYSKLAD_CANCELLED_STATE_ID;
  const value = raw === undefined || raw === '' ? null : raw;

  if (value !== null && !UUID_PATTERN.test(value)) {
    throw new Error(
      'MOYSKLAD_CANCELLED_STATE_ID должен быть UUID статуса «Отменен» из МоегоСклада: ' +
        'по значению другого вида отмена не распознаётся вовсе',
    );
  }

  if (value === null && data.APP_ENV === 'production') {
    throw new Error(
      'MOYSKLAD_CANCELLED_STATE_ID обязателен при APP_ENV=production: без него ' +
        'отменённые заказы неотличимы от обычных и уезжают клиенту',
    );
  }
}

function assertMoyskladEnvironment(data: z.infer<typeof configSchema>): void {
  // Режима записи не существует ни в одном окружении: клиент отвергает всё,
  // кроме GET и HEAD, безусловно. Настройка, обещающая обратное, — это ошибка
  // развёртывания, а не выбор режима, поэтому запуск останавливается.
  if (data.MOYSKLAD_READ_ONLY === 'false') {
    throw new Error(
      'MOYSKLAD_READ_ONLY=false не поддерживается: серверный контур МоегоСклада ' +
        'работает только на чтение во всех окружениях, включая production. ' +
        'Операции записи вводятся отдельным заданием с идемпотентностью и аудитом',
    );
  }

  const access = moyskladAccess(data);

  if (data.MOYSKLAD_TOKEN !== undefined && access === 'denied') {
    throw new Error(
      'MOYSKLAD_TOKEN допустим только при APP_ENV=production с APP_ENVIRONMENT_MARKER=production ' +
        'либо при APP_ENV=staging с APP_ENVIRONMENT_MARKER=staging и явным MOYSKLAD_READ_ONLY=true: ' +
        'рабочий токен не размещается в local и CI, а на staging — только в режиме чтения',
    );
  }

  if (data.MOYSKLAD_SYNC_ENABLED && access === 'denied') {
    throw new Error(
      'MOYSKLAD_SYNC_ENABLED=true допустим только при совпавших маркерах production ' +
        'либо staging с явным MOYSKLAD_READ_ONLY=true',
    );
  }

  if (data.MOYSKLAD_SYNC_ENABLED && data.MOYSKLAD_TOKEN === undefined) {
    throw new Error('MOYSKLAD_SYNC_ENABLED=true требует MOYSKLAD_TOKEN');
  }

  // Узкая запись состояния допускается ТОЛЬКО в production. На local и staging
  // реальные записи в живой аккаунт запрещены: контракт проверяется подменным
  // сервером в тестах, а не живым МоимСкладом. Так исключается случайная запись
  // в чужие данные при настройке контура.
  if (data.MOYSKLAD_ORDER_STATE_SYNC_ENABLED && access !== 'production') {
    throw new Error(
      'MOYSKLAD_ORDER_STATE_SYNC_ENABLED=true допустим только в production ' +
        '(APP_ENV=production и APP_ENVIRONMENT_MARKER=production): на local и staging ' +
        'реальные записи в МойСклад не выполняются',
    );
  }

  if (data.MOYSKLAD_ORDER_STATE_SYNC_ENABLED && data.MOYSKLAD_TOKEN === undefined) {
    throw new Error('MOYSKLAD_ORDER_STATE_SYNC_ENABLED=true требует MOYSKLAD_TOKEN');
  }
}

/**
 * Окружение, которому разрешён живой DaData.
 *
 * Владелец разрешил серверную DaData на staging с настоящими адресами и принял
 * расход квоты (`docs/OWNER_DECISIONS.md`, `GEO-004`). Прежний абсолютный запрет
 * вне production этим решением заменён, но правило осталось прежним по форме:
 * ОБА признака окружения обязаны совпасть. Смешанная конфигурация —
 * `APP_ENV=staging` с production-маркером или наоборот — это ошибка
 * развёртывания, и продолжать с платным ключом в такой ситуации нельзя.
 *
 * Функция отвечает только за окружение. Наличие ключей и явного включения
 * проверяется отдельно: их отсутствие — это «не настраивали», а несовпавший
 * маркер — «настроили неправильно», и путать эти два случая не нужно.
 */
export function dadataEnvironment(data: {
  APP_ENV: 'local' | 'staging' | 'production';
  APP_ENVIRONMENT_MARKER: string;
}): 'production' | 'staging' | 'denied' {
  if (data.APP_ENV === 'production' && data.APP_ENVIRONMENT_MARKER === 'production') {
    return 'production';
  }
  if (data.APP_ENV === 'staging' && data.APP_ENVIRONMENT_MARKER === 'staging') {
    return 'staging';
  }
  return 'denied';
}

/**
 * Fail closed для геокодирования.
 *
 * Ключ DaData — это платный баланс организации, а каждый запрос несёт адрес
 * клиента. Приложение, молча стартовавшее с рабочим ключом в local или в
 * смешанной конфигурации, однажды отправит наружу настоящие адреса и потратит
 * чужие деньги. Поэтому запуск останавливается, а не продолжается с
 * предупреждением.
 */
function assertDadataEnvironment(data: z.infer<typeof configSchema>): void {
  const environment = dadataEnvironment(data);

  if (data.DADATA_API_KEY !== undefined && environment === 'denied') {
    throw new Error(
      'DADATA_API_KEY допустим только при совпавших маркерах production либо staging: ' +
        'рабочий ключ не размещается в local, CI и в смешанной конфигурации, где ' +
        'APP_ENV и APP_ENVIRONMENT_MARKER расходятся',
    );
  }

  if (data.DADATA_GEOCODING_ENABLED && environment === 'denied') {
    throw new Error(
      'DADATA_GEOCODING_ENABLED=true допустим только при совпавших маркерах ' +
        'production либо staging',
    );
  }

  // Включённые подсказки без ключа — ошибка развёртывания, а не «пока без ключа»:
  // экран обещал бы подсказки, которых не будет.
  if (data.DADATA_GEOCODING_ENABLED && data.DADATA_API_KEY === undefined) {
    throw new Error('DADATA_GEOCODING_ENABLED=true требует DADATA_API_KEY');
  }
}

/**
 * Подменный решатель допустим только в локальном окружении.
 *
 * Он не оптимизирует, а раскладывает заказы подряд. План, выданный им
 * за посчитанный, на staging или в production был бы обманом, и никакой
 * договорённости «включим только на время» здесь недостаточно: проверка
 * происходит до старта приложения.
 */
function assertTestSolverEnvironment(data: z.infer<typeof configSchema>): void {
  if (!data.PLANNING_TEST_SOLVER) {
    return;
  }

  if (data.APP_ENV !== 'local' || data.APP_ENVIRONMENT_MARKER === 'production') {
    throw new Error(
      'PLANNING_TEST_SOLVER=true допустим только при APP_ENV=local: подменный ' +
        'решатель не считает маршруты и его план нельзя выдавать за расчёт',
    );
  }
}

/**
 * Подменённые подсказки допустимы только в локальном окружении.
 *
 * Выдуманный адрес, показанный как подсказка DaData, ничем не отличается
 * от настоящего — и склад встал бы по несуществующей точке.
 */
/**
 * Подменённая геометрия не должна покидать локальное окружение.
 *
 * Линия, нарисованная формулой, выглядит на карте ровно как рассчитанная
 * по дорогам: логист принял бы её за факт и построил бы по ней смену.
 */
function assertTestRouteEnvironment(data: z.infer<typeof configSchema>): void {
  if (!data.VALHALLA_TEST_ROUTE) {
    return;
  }

  if (data.APP_ENV !== 'local' || data.APP_ENVIRONMENT_MARKER === 'production') {
    throw new Error(
      'VALHALLA_TEST_ROUTE=true допустим только при APP_ENV=local: подменённую ' +
        'геометрию нельзя выдавать за расчёт маршрутизатора',
    );
  }
}

/**
 * Тестовые входы недопустимы нигде, кроме локального окружения.
 *
 * Проверка отдельная и жёсткая: этот флаг открывает запрос, меняющий
 * состояние заказа в обход импорта. В рабочем контуре такого входа быть
 * не должно ни на минуту.
 */
function assertTestHooksEnvironment(data: z.infer<typeof configSchema>): void {
  if (!data.E2E_TEST_HOOKS) {
    return;
  }

  if (data.APP_ENV !== 'local' || data.APP_ENVIRONMENT_MARKER === 'production') {
    throw new Error(
      'E2E_TEST_HOOKS=true допустим только при APP_ENV=local: вход, меняющий ' +
        'состояние заказа мимо импорта, в рабочем контуре существовать не может',
    );
  }
}

function assertTestSuggestionsEnvironment(data: z.infer<typeof configSchema>): void {
  if (!data.DADATA_TEST_SUGGESTIONS) {
    return;
  }

  if (data.APP_ENV !== 'local' || data.APP_ENVIRONMENT_MARKER === 'production') {
    throw new Error(
      'DADATA_TEST_SUGGESTIONS=true допустим только при APP_ENV=local: подменённые ' +
        'подсказки нельзя выдавать за ответ DaData',
    );
  }
}

/**
 * Настроенный геокодер обязан иметь источник, который для него что-то даёт.
 *
 * Автоматический путь берёт только `localAddress ?? geocodeAddress`. При
 * источнике `shipmentAddress` разобранный адрес не собирается вовсе, поэтому
 * `geocodeAddress` пуст у всех заказов, и ни одного задания не появится
 * никогда. Молча считаться готовым в таком виде приложение не должно:
 * геокодирование выглядело бы включённым и не работало.
 */
function assertGeocodingSource(data: z.infer<typeof configSchema>): void {
  const photonConfigured = data.PHOTON_URL !== undefined && data.PHOTON_URL.trim() !== '';
  if (photonConfigured && data.MOYSKLAD_GEOCODING_ADDRESS_SOURCE !== 'shipmentAddressFull') {
    throw new Error(
      'PHOTON_URL задан, а MOYSKLAD_GEOCODING_ADDRESS_SOURCE=shipmentAddress: ' +
        'автоматическое геокодирование не создаст ни одного задания, потому что ' +
        'разобранный адрес не собирается, а старый address источником не является. ' +
        'Задайте MOYSKLAD_GEOCODING_ADDRESS_SOURCE=shipmentAddressFull либо уберите PHOTON_URL.',
    );
  }
}

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Только для тестов: сбрасывает закешированную конфигурацию. */
export function resetConfigCache(): void {
  cached = null;
}
