/**
 * Сквозные браузерные сценарии этапа 1.
 *
 * Проверяется реальный путь: первый вход администратора, создание курьера,
 * первый вход курьера, разграничение разделов, курьерская навигация на
 * мобильном экране, заморозка и то, что открытые сеансы узнают об изменении
 * без перезагрузки страницы.
 *
 * Сценарии последовательные и опираются на общее состояние, поэтому файл
 * выполняется в режиме serial. Одноразовые коды берутся из ответа API
 * и в отчёт не печатаются.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

const ADMIN_PHONE = process.env['E2E_ADMIN_PHONE'] ?? '+79990000001';
const ADMIN_CODE = process.env['E2E_ADMIN_CODE'] ?? '';
const ADMIN_PIN = '2481';
const COURIER_PIN = '1357';

/** Телефон курьера, созданного первым сценарием; нужен следующим. */
let courierPhone = '';

/** Уникальный телефон: пользователей нельзя удалять, повторный прогон не должен падать. */
function uniquePhone(): string {
  const tail = String(Date.now() % 1_000_000_000).padStart(9, '0');
  return `+79${tail}`;
}

async function activate(page: Page, phone: string, code: string, pin: string): Promise<void> {
  await page.goto('/first-login');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByLabel('Временный код').fill(code);
  await page.getByLabel('Новый PIN').fill(pin);
  await page.getByLabel('Повторите PIN').fill(pin);
  await page.getByRole('button', { name: 'Установить PIN и войти' }).click();
}

async function login(page: Page, phone: string, pin: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Телефон').fill(phone);
  await page.getByLabel('PIN').fill(pin);
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function logout(page: Page): Promise<void> {
  // Кнопка учётной записи подписана именем пользователя, поэтому берётся
  // последняя кнопка верхней строки, а не угадывается текст.
  await page.locator('.shell__topbar button').last().click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/**
 * Выбирает маршрут в списке ПО НОМЕРУ, а не по позиции.
 *
 * Выбор по индексу молча зависит от того, сколько ещё черновиков этого дня
 * существует и как они отсортированы (по номеру). Достаточно одного лишнего
 * черновика — и заказы уезжают не туда, а тест падает на следующем шаге,
 * сообщая про количество остановок вместо настоящей причины.
 */
async function selectRouteByNumber(select: Locator, number: string): Promise<void> {
  const option = select.locator(`option:has-text("${number}")`);
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  expect(value, `в списке нет маршрута ${number}`).not.toBeNull();
  await select.selectOption(value ?? '');
}

/**
 * Нажимает кнопку и дожидается ОТВЕТА на конкретную мутацию.
 *
 * Без этого тест продолжает действовать, не зная, завершилась ли операция:
 * отказ сервера (устаревшая версия, потерянная блокировка, непригодный заказ)
 * превращается в загадочное «остановок не столько» вместо названной причины.
 * Пауза для этого не годится — она гадает о времени вместо наблюдения факта.
 */
async function clickAndAwait(
  page: Page,
  button: Locator,
  method: string,
  pathPart: string,
): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.url().includes(pathPart) && candidate.request().method() === method,
    ),
    button.click(),
  ]);

  expect(
    response.status(),
    `${method} ${pathPart} → ${response.status()}: ${await response.text()}`,
  ).toBeLessThan(300);
}

test.describe.configure({ mode: 'serial' });

test('сквозной сценарий этапа 1', async ({ page, browser }: { page: Page; browser: Browser }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  // 1. Первый вход администратора по одноразовому коду.
  await activate(page, ADMIN_PHONE, ADMIN_CODE, ADMIN_PIN);
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();

  // 2. Обычный выход и вход по PIN.
  await logout(page);
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();

  // 3. Административная навигация: настройки доступны.
  await page.getByRole('link', { name: 'Настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Состояние интеграций' })).toBeVisible();

  // 4. Создание курьера.
  courierPhone = uniquePhone();
  await page.getByRole('link', { name: 'Сотрудники и курьеры' }).click();
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByLabel('ФИО').fill('Курьер проверки');
  await page.getByLabel('Телефон').fill(courierPhone);
  await page.getByRole('button', { name: 'Создать' }).click();

  // Код показывается один раз. В отчёт он не печатается.
  const codeText = await page.locator('.one-time-code').innerText();
  const courierCode = codeText.trim();
  expect(courierCode).toMatch(/^\d{4}$/);
  await page.getByRole('button', { name: 'Я сохранил код' }).click();

  // 5. Первый вход курьера: доступны только курьерские разделы.
  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await activate(courierPage, courierPhone, courierCode, COURIER_PIN);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();
  await expect(courierPage.getByRole('link', { name: 'Настройки' })).toHaveCount(0);
  await expect(courierPage.getByRole('link', { name: 'Сотрудники и курьеры' })).toHaveCount(0);

  // 6. Обычный повторный вход курьера.
  await logout(courierPage);
  await login(courierPage, courierPhone, COURIER_PIN);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  await courierContext.close();
});

test('курьерская навигация на мобильном экране', async ({ browser }: { browser: Browser }) => {
  test.skip(courierPhone === '', 'курьер не создан предыдущим сценарием');

  // Узкий экран телефона: у курьера рабочий инструмент — именно он.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await context.newPage();

  await login(mobilePage, courierPhone, COURIER_PIN);
  await expect(mobilePage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  // Нижняя панель — основной способ перемещения на телефоне.
  const bottomBar = mobilePage.locator('.shell__bottombar');
  await expect(bottomBar).toBeVisible();
  await bottomBar.getByRole('link', { name: 'История' }).click();
  await expect(mobilePage.getByRole('heading', { name: 'История', level: 1 })).toBeVisible();

  // Административные разделы не появляются и на мобильной панели.
  await expect(bottomBar.getByRole('link', { name: 'Настройки' })).toHaveCount(0);
  await expect(bottomBar.getByRole('link', { name: 'Курьеры' })).toHaveCount(0);

  await context.close();
});

test('заморозка доходит до открытых сеансов без перезагрузки', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(courierPhone === '', 'курьер не создан предыдущим сценарием');

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // Открытый курьерский сеанс: перезагрузку страницы делать нельзя,
  // проверяется именно самостоятельный уход на экран входа.
  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await login(courierPage, courierPhone, COURIER_PIN);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  // Второй сеанс администратора: он должен узнать об изменении сам.
  const secondAdminContext = await browser.newContext();
  const secondAdminPage = await secondAdminContext.newPage();
  await login(secondAdminPage, ADMIN_PHONE, ADMIN_PIN);
  await secondAdminPage.getByRole('link', { name: 'Сотрудники и курьеры' }).click();
  await secondAdminPage.getByLabel('Статус').selectOption('FROZEN');

  // Заморозка курьера в первом сеансе.
  await page.getByRole('link', { name: 'Сотрудники и курьеры' }).click();
  await page
    .getByRole('row', { name: /Курьер проверки/ })
    .getByRole('button', { name: 'Заморозить' })
    .click();
  await page.getByRole('button', { name: 'Заморозить', exact: true }).last().click();

  // Второй сеанс администратора получает изменение без перезагрузки страницы.
  await expect(secondAdminPage.getByText('Курьер проверки')).toBeVisible({ timeout: 30_000 });

  // Курьера возвращает на вход сам канал realtime: reload() здесь намеренно нет.
  await expect(courierPage).toHaveURL(/\/login$/, { timeout: 30_000 });

  await courierContext.close();
  await secondAdminContext.close();
});

test('экран «Сделки»: список, поиск и ручной интервал', async ({ page }: { page: Page }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const orderNumber = process.env['E2E_ORDER_NUMBER'] ?? '';
  test.skip(orderNumber === '', 'не передан номер проверочного заказа (E2E_ORDER_NUMBER)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();

  // Заказ без распознанного интервала обязан оказаться в блоке «Требуют внимания».
  const attention = page.locator('.deals__group--attention');
  await expect(attention).toBeVisible();
  const row = attention.locator('.deals__row', { hasText: orderNumber });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Время доставки не распознано');
  // Исходный текст источника показан рядом и не подменяется.
  await expect(row).toContainText('уточнить у клиента');
  // Получатель показан целиком, без сокращений.
  await expect(row).toContainText('Проверочный Получатель');

  // Ручное исправление интервала.
  await row.getByRole('button', { name: 'Интервал' }).click();
  await page.getByLabel('Начало').fill('10:00');
  await page.getByLabel('Окончание').fill('14:00');
  await page.getByRole('button', { name: 'Сохранить интервал' }).click();

  // Заказ уходит из «Требуют внимания» и показывает фактический интервал.
  const updated = page.locator('.deals__row', { hasText: orderNumber });
  await expect(updated).toContainText('10:00 – 14:00');
  await expect(updated).toContainText('исправлено вручную');
  await expect(updated).not.toContainText('Время доставки не распознано');

  // Поиск по номеру находит заказ.
  await page.getByLabel('Поиск по номеру, адресу или получателю').fill(orderNumber);
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.locator('.deals__row', { hasText: orderNumber })).toBeVisible();
});

/**
 * Минимальный валидный стиль MapLibre.
 *
 * Подложки нет намеренно: проверяется поведение приложения, а не качество карты.
 * Настоящие тайлы сюда не скачиваются, к публичным серверам OSM обращений нет.
 */
const EMPTY_STYLE = JSON.stringify({ version: 8, sources: {}, layers: [] });

test('карта не настроена: интерфейс говорит честно, а список продолжает работать', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  // Конфигурация подменяется на «не настроена» независимо от окружения стенда.
  await page.route('**/api/map/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: false, styleUrl: null, attribution: null }),
    }),
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();

  await expect(page.getByText('Карта не настроена', { exact: true })).toBeVisible();
  // Карта не появилась, но работа не остановилась.
  await expect(page.locator('[data-testid="orders-map"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Создать черновик' })).toBeEnabled();
  await page.waitForSelector('.routes__order, .state', { state: 'visible' });
});

test('карта: ручная точка ставится без перезагрузки, строка и маркер связаны', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const first = process.env['E2E_ORDER_NUMBER'] ?? '';
  test.skip(first === '', 'нужен проверочный заказ');

  const styleUrl = 'https://maps.local.test/style.json';
  await page.route('**/api/map/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true, styleUrl, attribution: '© Проверка' }),
    }),
  );
  await page.route(styleUrl, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_STYLE }),
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();

  const map = page.locator('[data-testid="orders-map"]');
  await expect(map).toBeVisible();

  const row = page.locator('.routes__order', { hasText: first });
  await expect(row).toBeVisible();

  // Точки ещё нет: строка объясняет причину и остаётся в работе.
  await expect(row.locator('.routes__geo-hint')).toBeVisible();

  await row.getByRole('button', { name: 'Указать точку' }).click();
  await expect(page.locator('.routes__hint')).toContainText('Укажите точку на карте');

  await map.click({ position: { x: 240, y: 160 } });
  await expect(page.getByRole('heading', { name: 'Подтвердите точку заказа' })).toBeVisible();
  await page.getByLabel('Причина').fill('Проверочная синтетическая точка');
  await page.getByRole('button', { name: 'Сохранить точку' }).click();

  // Маркер появляется без перезагрузки страницы.
  const marker = page.locator(`.map-marker[aria-label="Заказ ${first} на карте"]`);
  await expect(marker).toBeVisible();
  await expect(row.locator('.routes__geo-hint')).toHaveCount(0);

  // Выбор маркера подсвечивает строку…
  await marker.click();
  await expect(row.locator('.routes__number-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(marker).toHaveClass(/map-marker--selected/);

  // …а выбор другой строки снимает подсветку и переносит её.
  const secondNumber = process.env['E2E_ORDER_NUMBER_2'] ?? '';
  test.skip(secondNumber === '', 'нужен второй проверочный заказ');
  const secondRow = page.locator('.routes__order', { hasText: secondNumber });
  await secondRow.locator('.routes__number-button').click();
  await expect(marker).not.toHaveClass(/map-marker--selected/);

  await row.locator('.routes__number-button').click();
  await expect(marker).toHaveClass(/map-marker--selected/);
});

/** Ответ конфигурации карты. Адреса маршрутизатора здесь нет и быть не может. */
interface MapConfigResponse {
  configured: boolean;
  source: string;
  styleUrl: string | null;
  attribution: string | null;
  trafficMode: string;
  routingAvailable: boolean;
}

/** Публичные картографические серверы. Ни одного обращения к ним быть не должно. */
const FORBIDDEN_MAP_HOSTS = [
  'tile.openstreetmap.org',
  'tiles.openstreetmap.org',
  'demotiles.maplibre.org',
  'api.maptiler.com',
  'basemaps.protomaps.com',
  'tiles.protomaps.com',
  'api.mapbox.com',
  'openmaptiles.com',
];

test('собственная подложка: всё с нашего origin и ни одного внешнего запроса', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const external: string[] = [];
  const mapRequests: string[] = [];
  // Контейнер, а не отдельная переменная: значение приходит из обработчика
  // события, и вывод типов не должен считать его навсегда пустым.
  const captured: { config: MapConfigResponse | null } = { config: null };

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (FORBIDDEN_MAP_HOSTS.some((host) => url.hostname.endsWith(host))) {
      external.push(request.url());
    }
    if (url.pathname.startsWith('/maps/')) {
      mapRequests.push(url.pathname);
    }
  });

  // Конфигурацию читаем из ответа, который получило само приложение: свой
  // запрос из страницы пошёл бы без токена доступа и увидел бы только 401.
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/map/config' && response.status() === 200) {
      void response
        .json()
        .then((body: MapConfigResponse) => {
          captured.config = body;
        })
        .catch(() => undefined);
    }
  });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();

  await expect.poll(() => captured.config !== null, { timeout: 15_000 }).toBe(true);

  const config = captured.config;
  if (config === null) {
    throw new Error('приложение не получило конфигурацию карты');
  }

  expect(config.configured).toBe(true);
  // Подложка своя: адрес указывает на наш origin, а не на чужой сервер.
  expect(config.source).toBe('SELF_HOSTED');
  expect(config.styleUrl?.startsWith('/maps/')).toBe(true);
  expect(config.attribution).toContain('OpenStreetMap');
  // Живых пробок в собственном стеке нет, и интерфейс обязан это знать.
  expect(config.trafficMode).toBe('STATIC');

  // Стиль и артефакты доступны без авторизации: это статика нашего origin.
  const style = await page.evaluate(async (url: string) => {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }, config.styleUrl ?? '');

  expect(style.status).toBe(200);
  // Ни одного абсолютного адреса: стиль не может увести браузер наружу.
  expect(style.body).not.toMatch(/https?:\/\//);
  expect(style.body).toContain('OpenStreetMap');

  // Диапазонный запрос к архиву работает: без него PMTiles бесполезен.
  const range = await page.evaluate(async () => {
    const response = await fetch('/maps/tiles-test0001.pmtiles', {
      headers: { Range: 'bytes=0-126' },
    });
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
    };
  });

  expect(range.status).toBe(206);
  expect(range.contentRange).toMatch(/^bytes 0-126\/\d+$/);
  expect(range.acceptRanges).toBe('bytes');

  // Глифы лежат в каталоге «Noto Sans Regular» — с пробелами, как в настоящем
  // наборе. Браузер пришлёт адрес закодированным, и подложка обязана его
  // отдать: из-за отказа принимать пробел карта на staging не работала вовсе.
  const glyphs = await page.evaluate(async () => {
    const response = await fetch('/maps/fonts/Noto%20Sans%20Regular/0-255.pbf');
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  });

  expect(glyphs.status).toBe(200);
  expect(glyphs.type).toBe('application/x-protobuf');
  expect(glyphs.bytes).toBeGreaterThan(0);

  // Адрес глифов в стиле — тоже относительный и с настоящим именем семейства.
  expect(style.body).toContain('{fontstack}');

  // Расчёт времени в этой проверке не настроен, поэтому обещать его нечем:
  // пометка о пробках появляется только вместе с доступным маршрутизатором.
  expect(config.routingAvailable).toBe(false);
  await expect(page.getByTestId('traffic-note')).toHaveCount(0);

  // Главное: ни одного обращения к публичным картографическим серверам.
  expect(external).toEqual([]);
  // И при этом наш origin действительно использовался.
  expect(mapRequests.length).toBeGreaterThan(0);
});

test('адреса подложки: архив запрашивается из /maps и отвечает диапазоном', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const external: string[] = [];
  /** Обращения к архиву тайлов: путь и запрошенный диапазон. */
  const archive: { path: string; range: string | undefined; status?: number }[] = [];
  /** Запросы мимо каталога карты: именно так выглядел дефект. */
  const outsideMaps: string[] = [];
  const spriteRequests: string[] = [];
  /** Ответы на запрос воркера MapLibre: тип содержимого важнее кода. */
  const workerResponses: { path: string; status: number; type: string }[] = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (FORBIDDEN_MAP_HOSTS.some((host) => url.hostname.endsWith(host))) {
      external.push(request.url());
    }
    if (url.pathname.endsWith('.pmtiles')) {
      archive.push({ path: url.pathname, range: request.headers()['range'] });
      if (!url.pathname.startsWith('/maps/')) {
        // Ровно этот запрос уходил раньше: относительный адрес внутри
        // `pmtiles://` разрешался относительно страницы, а не стиля,
        // и вместо архива приходила оболочка приложения.
        outsideMaps.push(url.pathname);
      }
    }
    if (url.pathname.includes('/sprite/')) {
      spriteRequests.push(url.pathname);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('.pmtiles')) {
      const entry = archive.find((item) => item.path === url.pathname && item.status === undefined);
      if (entry !== undefined) {
        entry.status = response.status();
      }
    }
    if (url.pathname.includes('maplibre-gl-worker')) {
      workerResponses.push({
        path: url.pathname,
        status: response.status(),
        type: response.headers()['content-type'] ?? '',
      });
    }
  });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();

  // Стиль и манифест в порядке: карта настроена, и интерфейс об этом не спорит.
  await expect(page.getByText('Карта не настроена')).toHaveCount(0);

  // Архив запрошен, и только из каталога карты.
  await expect
    .poll(() => archive.length, { timeout: 20_000, message: 'архив тайлов не запрошен' })
    .toBeGreaterThan(0);
  expect(outsideMaps).toEqual([]);
  for (const request of archive) {
    expect(request.path.startsWith('/maps/'), request.path).toBe(true);
  }

  // Первый запрос — заголовок архива диапазоном; ответ обязан быть частичным.
  const first = archive[0];
  expect(first?.range).toMatch(/^bytes=0-/);
  await expect
    .poll(() => archive.filter((item) => item.status !== undefined).map((item) => item.status), {
      timeout: 20_000,
    })
    .toContain(206);

  // Спрайты берутся из каталога карты по абсолютному адресу: относительный
  // MapLibre отвергает при разборе стиля целиком.
  await expect
    .poll(() => spriteRequests.length, { timeout: 20_000, message: 'спрайты не запрошены' })
    .toBeGreaterThan(0);
  for (const path of spriteRequests) {
    expect(path.startsWith('/maps/sprite/'), path).toBe(true);
  }

  // Воркер MapLibre обязан быть настоящим скриптом.
  //
  // Свой адрес MapLibre вычисляет от `import.meta.url` собственного модуля,
  // и в собранном приложении это давало `/assets/maplibre-gl-worker.mjs` —
  // файла с таким именем сборка не создаёт. Одностраничное приложение
  // отвечало на этот адрес своей оболочкой: воркер получал HTML вместо кода
  // и молча не отвечал, а карта навсегда оставалась в состоянии загрузки —
  // без единой ошибки в консоли.
  await expect
    .poll(() => workerResponses.length, { timeout: 20_000, message: 'воркер MapLibre не запрошен' })
    .toBeGreaterThan(0);
  for (const response of workerResponses) {
    expect(response.status, response.path).toBe(200);
    expect(response.type, response.path).toContain('javascript');
    expect(response.type, response.path).not.toContain('text/html');
  }

  // И ни одного обращения к публичным картографическим серверам.
  expect(external).toEqual([]);
});

test('маршрут: черновик → состав → порядок → подтверждение → маршрутный лист', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const first = process.env['E2E_ORDER_NUMBER'] ?? '';
  const second = process.env['E2E_ORDER_NUMBER_2'] ?? '';
  test.skip(first === '' || second === '', 'нужны два проверочных заказа');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();

  // Черновик создаётся и сразу открывается: аренда выдаётся создателю.
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  const routeNumber = (await card.getByRole('heading').innerText()).replace(/[^R\d-]/g, '');
  expect(routeNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);

  // Оба заказа отмечаются и добавляются в маршрут.
  await page.getByLabel(`Выбрать заказ ${first}`).check();
  await page.getByLabel(`Выбрать заказ ${second}`).check();
  await selectRouteByNumber(page.getByLabel('Маршрут для добавления'), routeNumber);
  await clickAndAwait(
    page,
    page.getByRole('button', { name: /Добавить выбранные/ }),
    'POST',
    '/orders',
  );

  const stops = card.locator('.routes__stop');
  await expect(stops).toHaveCount(2);
  const firstStopBefore = await stops.first().innerText();

  // Порядок меняется кнопками: перетаскивание не требуется.
  await card.getByRole('button', { name: `Опустить заказ ${first}` }).click();
  await expect(stops.first()).not.toHaveText(firstStopBefore);

  // Настоящий перенос между двумя черновиками: аренда целевого берётся клиентом.
  await page.getByRole('button', { name: 'Создать черновик' }).click();
  // Карточка переключается на новый маршрут не мгновенно: сначала приходит ответ,
  // затем перерисовка. Ждём именно смену номера, а не догадываемся по времени.
  await expect(card.getByRole('heading')).not.toContainText(routeNumber);
  const secondCardNumber = (await card.getByRole('heading').innerText()).replace(/[^R\d-]/g, '');
  await card.getByRole('button', { name: 'Закрыть' }).click();

  await page
    .locator('.routes__list-item', { hasText: routeNumber })
    .getByRole('button', { name: 'Открыть' })
    .click();
  await expect(card.locator('.routes__stop')).toHaveCount(2);

  await card.getByLabel(`Выбрать заказ ${second}`).check();
  await selectRouteByNumber(card.getByLabel('Перенести в маршрут'), secondCardNumber);
  await clickAndAwait(
    page,
    card.getByRole('button', { name: /Перенести/ }),
    'POST',
    '/routes/move',
  );
  // Один заказ ушёл: перенос действительно выполнен, а не отклонён блокировкой.
  await expect(card.locator('.routes__stop')).toHaveCount(1);

  // Возвращаем заказ обратно, чтобы подтвердить маршрут полным составом.
  await page
    .locator('.routes__list-item', { hasText: secondCardNumber })
    .getByRole('button', { name: 'Открыть' })
    .click();
  await expect(card.locator('.routes__stop')).toHaveCount(1);
  await card.getByLabel(`Выбрать заказ ${second}`).check();
  await selectRouteByNumber(card.getByLabel('Перенести в маршрут'), routeNumber);
  await clickAndAwait(
    page,
    card.getByRole('button', { name: /Перенести/ }),
    'POST',
    '/routes/move',
  );
  await expect(card.locator('.routes__stop')).toHaveCount(0);

  await page
    .locator('.routes__list-item', { hasText: routeNumber })
    .getByRole('button', { name: 'Открыть' })
    .click();
  await expect(card.locator('.routes__stop')).toHaveCount(2);

  // Подтверждение: блокировок быть не должно.
  await card.getByRole('button', { name: 'Подтвердить маршрут' }).click();
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).last().click();
  await expect(card.locator('.routes__hint')).toContainText('Маршрут подтверждён');

  // Тот же маршрут появляется в маршрутных листах.
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутные листы', level: 1 })).toBeVisible();
  await page
    .locator('.routes__list-item', { hasText: routeNumber })
    .getByRole('button', { name: 'Открыть лист' })
    .click();

  const sheet = page.locator('.sheet');
  await expect(sheet).toContainText(routeNumber);
  await expect(sheet.locator('.sheet__stop')).toHaveCount(2);
  await expect(sheet).toContainText('К получению');
  // В листе есть адрес и получатель, но нет служебных технических полей.
  await expect(sheet).toContainText('Москва, проверочный адрес 1');
  await expect(sheet).not.toContainText('sumMinor');
  await expect(sheet).not.toContainText('routeOrderId');
});

test('перехват блокировки переводит прежнего редактора в режим просмотра', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  // Первый сеанс создаёт черновик и держит его в работе.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await page.getByRole('button', { name: 'Создать черновик' }).click();

  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  const routeNumber = (await card.getByRole('heading').innerText()).replace(/[^R\d-]/g, '');
  await expect(card.getByRole('button', { name: 'Отменить маршрут' })).toBeEnabled();

  // Второй сеанс того же администратора — другое устройство, другая семья сессий.
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await login(secondPage, ADMIN_PHONE, ADMIN_PIN);
  await secondPage.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await secondPage
    .locator('.routes__list-item', { hasText: routeNumber })
    .getByRole('button', { name: 'Открыть' })
    .click();

  const secondCard = secondPage.locator('.routes__card');
  await expect(secondCard.getByRole('button', { name: 'Перехватить' })).toBeVisible();
  await secondCard.getByRole('button', { name: 'Перехватить' }).click();
  // На экране теперь есть и карта со своим окном подтверждения точки, поэтому
  // поле причины берётся из открытого сейчас окна, а не по всей странице.
  await secondPage
    .locator('dialog[open]')
    .getByLabel('Причина')
    .fill('Продолжаю работу с другого устройства');
  await secondPage.getByRole('button', { name: 'Продолжить' }).click();

  // Первый сеанс узнаёт об этом сам, без перезагрузки страницы.
  await expect(card.getByText(/Маршрут редактирует/)).toBeVisible();
  await expect(card.getByRole('button', { name: 'Отменить маршрут' })).toBeDisabled();

  await secondContext.close();
});

test('печатная версия листа не содержит навигацию и занимает всю ширину', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();

  // Дожидаемся ответа списка: пустой count сразу после перехода означал бы
  // «ещё грузится», а не «маршрутов нет».
  await page.waitForSelector('.routes__list-item, .state', { state: 'visible' });
  const sheets = page.locator('.routes__list-item');
  test.skip((await sheets.count()) === 0, 'подтверждённых маршрутов нет');
  await sheets.first().getByRole('button', { name: 'Открыть лист' }).click();

  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();

  // Переключаем страницу в печатный режим: сравнение скриншотов не нужно,
  // достаточно геометрии и отсутствия служебных элементов.
  await page.emulateMedia({ media: 'print' });

  await expect(page.locator('.shell__sidebar')).toBeHidden();
  await expect(page.locator('.shell__topbar')).toBeHidden();
  await expect(page.locator('.shell__bottombar')).toBeHidden();
  await expect(sheet.getByRole('button', { name: 'Печать' })).toBeHidden();

  const viewport = page.viewportSize();
  const box = await sheet.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null && viewport !== null) {
    // Пустой колонки под боковую панель на бумаге быть не должно.
    expect(box.x).toBeLessThan(24);
    expect(box.width).toBeGreaterThan(viewport.width * 0.9);
  }

  await page.emulateMedia({ media: null });
});

/**
 * Планирование: настройка условий, готовое превью, явное применение.
 *
 * ГРАНИЦА СЦЕНАРИЯ. Сам расчёт здесь не выполняется: он требует дорожного
 * графа Valhalla — гигабайтов, которых в браузерной проверке нет и быть
 * не должно. Превью создаётся фикстурой `seed:e2e-plan` ровно в том виде,
 * в каком его оставил бы расчёт. Контракт решателя и путь расчёта доказаны
 * направленными проверками, где Valhalla и VROOM подменены.
 *
 * Здесь проверяется остальное и целиком: формы обязательных настроек, склад,
 * видимое превью с отдельным блоком неразмещённых заказов, явное применение
 * и появившиеся после него черновики.
 */
test('планирование: настройки, превью и применение', async ({ page }: { page: Page }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // 1. Настройки: обязательные условия задаются формами, а не запросами к API.
  await page.getByRole('link', { name: 'Настройки' }).first().click();
  const settings = page.getByTestId('planning-settings');
  await expect(settings).toBeVisible();

  // Склад уже есть — он создан фикстурой и стал складом по умолчанию.
  // Отметка ищется точным текстом: кнопка «Сделать складом по умолчанию»
  // содержит те же слова, и по вхождению нашлись бы обе.
  const defaultBadge = settings.getByText('по умолчанию', { exact: true });
  await expect(defaultBadge).toHaveCount(1);

  // Второй склад создаётся формой и складом по умолчанию НЕ становится.
  const before = await settings.getByTestId('depot-item').count();
  await settings.getByTestId('depot-name').fill('Запасной склад');
  await settings.getByTestId('depot-address').fill('Москва, запасной адрес');
  await settings.getByTestId('depot-lat').fill('55,800000');
  await settings.getByTestId('depot-lon').fill('37,700000');
  await settings.getByTestId('depot-save').click();
  await expect(settings.getByTestId('depot-item')).toHaveCount(before + 1);
  await expect(defaultBadge).toHaveCount(1);

  // Форма смены отвергает окончание раньше начала — и не даёт сохранить.
  await settings.getByTestId('shift-start').fill('21:00');
  await settings.getByTestId('shift-end').fill('09:00');
  await expect(settings.getByTestId('shift-save')).toBeDisabled();

  // Те же значения, что использовал расчёт: условия плана не меняются.
  await settings.getByTestId('shift-start').fill('09:00');
  await settings.getByTestId('shift-end').fill('21:00');
  await expect(settings.getByTestId('shift-save')).toBeEnabled();
  await settings.getByTestId('shift-save').click();
  await expect(page.locator('.toast-region').getByText('Смена сохранена')).toBeVisible();

  // 2. Планирование: превью видно целиком, включая неразмещённые заказы.
  await page.getByRole('link', { name: 'Планирование' }).first().click();
  await expect(page.getByRole('heading', { name: 'Планирование маршрутов' })).toBeVisible();

  // Условия расчёта показаны до кнопки: логист видит, из чего сложится план.
  await expect(page.getByText('Смена: 09:00 — 21:00')).toBeVisible();

  await page
    .getByRole('button', { name: /^\d{2}\.\d{2}\.\d{4}/ })
    .first()
    .click();

  const unassignedBlock = page.getByTestId('plan-unassigned');
  await expect(unassignedBlock).toBeVisible();
  await expect(unassignedBlock.getByRole('listitem')).toHaveCount(1);

  // 3. Применение требует отдельного подтверждения: заказ, который никто
  //    не повезёт, не должен уехать в черновики молча.
  await page.getByRole('button', { name: 'Применить' }).click();
  await expect(page.getByRole('heading', { name: /неразмещёнными заказами/ })).toBeVisible();
  await page.getByRole('button', { name: 'Применить частично' }).click();

  // Черновики созданы, и запуск перешёл в применённое состояние.
  await expect(page.locator('[data-plan-state="APPLIED"]')).toBeVisible();
  await expect(
    page.locator('[data-plan-state="APPLIED"]').getByText(/Создано черновиков: 1/),
  ).toBeVisible();

  // 4. Черновик действительно появился в маршрутизации.
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();
  await expect(page.locator('.routes__number-button').first()).toBeVisible();

  // 5. Третья обязательная форма: время обслуживания. Меняется после
  //    применения, поэтому условия уже применённого плана не задевает.
  await page.getByRole('link', { name: 'Настройки' }).first().click();
  await settings.getByTestId('service-car').fill('12');
  await settings.getByTestId('service-foot').fill('15');
  await settings.getByTestId('service-save').click();
  await expect(
    page.locator('.toast-region').getByText('Время обслуживания сохранено'),
  ).toBeVisible();

  await page.reload();
  await expect(settings.getByTestId('service-car')).toHaveValue('12');
  await expect(settings.getByTestId('service-foot')).toHaveValue('15');
});

/**
 * Флорист: смена → захват → карточка → «Собран» → бланк с QR → ручная отметка.
 *
 * Сценарий проходит весь путь браузером и БЕЗ живого МоегоСклада: состав
 * заказа создан фикстурой, фотографии нет, и карточка обязана честно сказать
 * «Фото отсутствует», а не сломаться.
 *
 * Сценарий выполняется собственным флористом, а не администратором: право
 * на «Собран» есть только у того, за кем закреплён заказ, и проверять это
 * администратором значило бы проверять не то.
 */
test('флорист: смена, захват, сборка, бланк и отметка печати', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const orderNumber = process.env['E2E_ORDER_NUMBER'] ?? '';
  test.skip(orderNumber === '', 'не передан номер проверочного заказа (E2E_ORDER_NUMBER)');

  const FLORIST_PIN = '8642';

  // 1. Администратор заводит флориста.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  const floristPhone = uniquePhone();
  await page.getByRole('link', { name: 'Сотрудники и курьеры' }).first().click();
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByLabel('ФИО').fill('Флорист проверки');
  await page.getByLabel('Телефон').fill(floristPhone);
  await page.getByRole('checkbox', { name: 'Флорист' }).check();
  const courierRole = page.getByRole('checkbox', { name: 'Курьер', exact: true });
  if (await courierRole.isChecked()) {
    await courierRole.uncheck();
  }
  await page.getByRole('button', { name: 'Создать' }).click();

  const codeText = await page.locator('.one-time-code').innerText();
  const floristCode = codeText.trim();
  expect(floristCode).toMatch(/^\d{4}$/);
  await page.getByRole('button', { name: 'Я сохранил код' }).click();

  // 2. Флорист входит и попадает сразу в свой раздел.
  const context = await browser.newContext({ acceptDownloads: true });
  const floristPage = await context.newPage();
  await activate(floristPage, floristPhone, floristCode, FLORIST_PIN);
  await expect(floristPage.getByRole('heading', { name: 'Флорист', level: 1 })).toBeVisible();

  // Чужих разделов у флориста нет.
  for (const foreign of ['Настройки', 'Сотрудники и курьеры', 'Маршрутизация']) {
    await expect(floristPage.getByRole('link', { name: foreign })).toHaveCount(0);
  }

  // 3. Без смены заказ взять нельзя: кнопка захвата выключена.
  const row = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(row).toBeVisible();
  const claimButton = row.getByTestId('row-claim');
  await expect(claimButton).toBeDisabled();

  // 4. Смена начинается явно.
  await clickAndAwait(
    floristPage,
    floristPage.getByTestId('shift-start'),
    'POST',
    '/api/florist/shift/start',
  );
  await expect(floristPage.getByText(/Смена с /)).toBeVisible();

  // 5. Захват заказа. Общая очередь по умолчанию показывает только свободные
  //    заказы, поэтому взятый уходит из неё — и появляется в «Моих заказах».
  await clickAndAwait(floristPage, claimButton, 'POST', '/claim');
  await expect(floristPage.locator('.florist__row', { hasText: orderNumber })).toHaveCount(0);

  await floristPage.getByTestId('florist-tab-mine').click();
  const mineRow = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(mineRow).toBeVisible();
  await expect(mineRow).toContainText('В сборке');

  // 6. Карточка: состав, бандл с компонентом, текст открытки и комментарий.
  //    Ни адреса, ни получателя, ни цены здесь быть не должно.
  await mineRow.getByRole('button', { name: 'Открыть' }).click();
  const card = floristPage.getByTestId('florist-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Букет проверочный');
  await expect(card).toContainText('Роза проверочная');
  await expect(card.getByTestId('card-text')).toContainText('Проверочная открытка');
  await expect(card.getByTestId('card-description')).toContainText('Нижний комментарий');
  await expect(card).not.toContainText('проверочный адрес');
  await expect(card).not.toContainText('Проверочный Получатель');

  // Фотографии у проверочной номенклатуры нет, и карточка говорит об этом прямо.
  await expect(card.getByTestId('position-photo-empty')).toContainText('Фото отсутствует');

  // 7. «Собран»: одна операция, после которой появляется бланк.
  await clickAndAwait(floristPage, card.getByTestId('card-assemble'), 'POST', '/assemble');
  await expect(card).toContainText('Собран');
  await expect(card.getByTestId('card-print-state')).toContainText('Ожидает печати');

  // 8. Бланк скачивается настоящим файлом PDF.
  const [download] = await Promise.all([
    floristPage.waitForEvent('download'),
    card.getByTestId('card-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`order-${orderNumber}.pdf`);

  // 9. Вкладка «Печать»: задание ждёт, ручная отметка его завершает.
  await floristPage.getByTestId('florist-tab-print').click();
  const printRow = floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber });
  await expect(printRow).toBeVisible();
  await expect(printRow).toContainText('Ожидает печати');

  await clickAndAwait(floristPage, printRow.getByTestId('print-mark'), 'POST', '/printed');

  // Задание ушло из очереди внимания и появилось в напечатанных.
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);
  await floristPage.getByTestId('print-filter-printed').click();
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toContainText('Напечатано');

  await context.close();
});

test('складские ячейки: администратор управляет справочником, кладовщик только смотрит', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const WAREHOUSE_PIN = '9753';
  const code = `E2E-${Date.now() % 100_000}`;

  // 1. Администратор заводит ячейку в настройках.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Настройки' }).first().click();

  const cells = page.locator('section', { hasText: 'Складские ячейки' }).first();
  await expect(cells).toBeVisible();

  // Код вводится в нижнем регистре: сохранён он будет в верхнем, и интерфейс
  // обязан предупредить об этом ДО сохранения, а не после печати этикетки.
  await cells.getByTestId('cell-code').fill(code.toLowerCase());
  await expect(cells.getByText(code, { exact: false })).toBeVisible();
  await cells.getByTestId('cell-kind').selectOption('STORAGE');
  await cells.getByTestId('cell-create').click();

  const row = cells.locator('[data-testid="cell-row"]', { hasText: code });
  await expect(row).toBeVisible();
  await expect(row.getByText('Активна')).toBeVisible();

  // 2. Повторное создание того же кода в другом регистре отклоняется.
  await cells.getByTestId('cell-code').fill(code.toUpperCase());
  await cells.getByTestId('cell-create').click();
  await expect(page.locator('.toast-region')).toContainText(/уже существует/i);

  // 3. Выключение вместо удаления: кнопки «Удалить» не существует.
  await expect(cells.getByRole('button', { name: /Удалить/ })).toHaveCount(0);
  await row.getByTestId('cell-toggle').click();
  await expect(row.getByText('Выключена')).toBeVisible();
  await row.getByTestId('cell-toggle').click();
  await expect(row.getByText('Активна')).toBeVisible();

  // 4. Администратор заводит кладовщика.
  const warehousePhone = uniquePhone();
  await page.getByRole('link', { name: 'Сотрудники и курьеры' }).first().click();
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByLabel('ФИО').fill('Кладовщик проверки');
  await page.getByLabel('Телефон').fill(warehousePhone);
  await page.getByRole('checkbox', { name: 'Кладовщик' }).check();
  const courierRole = page.getByRole('checkbox', { name: 'Курьер', exact: true });
  if (await courierRole.isChecked()) {
    await courierRole.uncheck();
  }
  await page.getByRole('button', { name: 'Создать' }).click();

  const codeText = await page.locator('.one-time-code').innerText();
  const warehouseCode = codeText.trim();
  expect(warehouseCode).toMatch(/^\d{4}$/);
  await page.getByRole('button', { name: 'Я сохранил код' }).click();

  // 5. Кладовщик видит свой раздел и НЕ видит складских операций.
  const context = await browser.newContext();
  const warehousePage = await context.newPage();
  await activate(warehousePage, warehousePhone, warehouseCode, WAREHOUSE_PIN);
  await expect(warehousePage.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

  // У кладовщика рабочий экран с тремя вкладками (этап 6.5), а не заглушка.
  for (const tab of ['storage', 'picking', 'issue']) {
    await expect(warehousePage.getByTestId(`wh-tab-${tab}`)).toBeVisible();
  }
  await expect(warehousePage.getByTestId('wh-scan-order')).toBeVisible();

  // Но управления справочником ячеек у него нет: это раздел настроек.
  await expect(warehousePage.getByTestId('cell-create')).toHaveCount(0);
  await expect(warehousePage.getByText('Складские ячейки')).toHaveCount(0);

  // 6. Управление ячейками кладовщику недоступно даже по прямому адресу.
  for (const foreign of ['Настройки', 'Сотрудники и курьеры']) {
    await expect(warehousePage.getByRole('link', { name: foreign })).toHaveCount(0);
  }
  await warehousePage.goto('/settings');
  await expect(warehousePage.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();
  await expect(warehousePage.getByText('Складские ячейки')).toHaveCount(0);

  await context.close();
});

test('склад: приёмка → комплектование → пауза → курьер → поштучная выдача → ACTIVE', async ({
  page,
}: {
  page: Page;
}) => {
  const storageCell = process.env['E2E_WH_STORAGE_CELL'] ?? '';
  const routeCell = process.env['E2E_WH_ROUTE_CELL'] ?? '';
  const routeNumber = process.env['E2E_WH_ROUTE'] ?? '';
  const firstOrder = process.env['E2E_WH_ORDER_1'] ?? '';
  const secondOrder = process.env['E2E_WH_ORDER_2'] ?? '';

  test.skip(
    storageCell === '' || routeCell === '' || routeNumber === '' || firstOrder === '',
    'не передана складская фикстура (E2E_WH_*)',
  );
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Склад' }).first().click();
  await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

  // 1. Приёмка: пара сканов «заказ + ячейка». До второго скана база не меняется.
  for (const orderNumber of [firstOrder, secondOrder]) {
    await page.getByTestId('wh-scan-order').fill(orderNumber);
    await page.getByTestId('wh-scan-order').press('Enter');
    await expect(page.getByTestId('wh-scanned-order')).toHaveText(orderNumber);

    await page.getByTestId('wh-scan-cell').fill(storageCell);
    await page.getByTestId('wh-place').click();
    await expect(page.locator('.toast-region')).toContainText(orderNumber);
    // Поле снова ждёт заказ: шаг завершён.
    await expect(page.getByTestId('wh-scan-order')).toBeVisible();
  }

  const placed = page.locator('[data-testid="wh-placement-row"]', { hasText: firstOrder });
  await expect(placed).toContainText(storageCell);

  // 2. Комплектование: привязка маршрутной ячейки и перенос первого заказа.
  await page.getByTestId('wh-tab-picking').click();
  await page.locator('[data-testid="wh-route-button"]', { hasText: routeNumber }).click();
  await expect(page.getByTestId('wh-route-cell')).toHaveText('не привязана');

  await page.getByTestId('wh-bind-cell').fill(routeCell);
  await page.getByTestId('wh-bind-submit').click();
  await expect(page.getByTestId('wh-route-cell')).toHaveText(routeCell);

  await page.getByTestId('wh-pick-order').fill(firstOrder);
  await page.getByTestId('wh-pick-submit').click();
  await expect(page.getByTestId('wh-route-progress')).toHaveText('1 из 2');

  // 3. Пауза и продолжение: уходим на другую вкладку и возвращаемся.
  await page.getByTestId('wh-tab-storage').click();
  await expect(page.getByTestId('wh-scan-order')).toBeVisible();
  await page.getByTestId('wh-tab-picking').click();
  await page.locator('[data-testid="wh-route-button"]', { hasText: routeNumber }).click();
  // Прогресс не потерян.
  await expect(page.getByTestId('wh-route-progress')).toHaveText('1 из 2');

  await page.getByTestId('wh-pick-order').fill(secondOrder);
  await page.getByTestId('wh-pick-submit').click();
  await expect(page.getByTestId('wh-route-progress')).toHaveText('2 из 2');

  // 4. Выдача: сначала подтверждение курьера, затем заказы по одному.
  await page.getByTestId('wh-tab-issue').click();
  await page.locator('[data-testid="wh-route-button"]', { hasText: routeNumber }).click();
  await expect(page.getByTestId('wh-route-courier')).not.toHaveText('не назначен');

  // Без подтверждения курьера поля выдачи не существует.
  await expect(page.getByTestId('wh-issue-order')).toHaveCount(0);
  await page.getByTestId('wh-confirm-courier').click();
  await expect(page.getByTestId('wh-issue-order')).toBeVisible();

  await page.getByTestId('wh-issue-order').fill(firstOrder);
  await page.getByTestId('wh-issue-submit').click();
  await expect(page.getByTestId('wh-route-progress')).toHaveText('1 из 2');
  // Маршрут ещё подтверждён: выдан не весь лист.
  await expect(page.locator('[data-testid="wh-route-card"]')).toHaveAttribute(
    'data-route-state',
    'CONFIRMED',
  );

  await page.getByTestId('wh-issue-order').fill(secondOrder);
  await page.getByTestId('wh-issue-submit').click();

  // 5. Последний заказ перевёл маршрут в ACTIVE и освободил маршрутную ячейку.
  await expect(page.locator('[data-testid="wh-route-card"]')).toHaveAttribute(
    'data-route-state',
    'ACTIVE',
  );
  await expect(page.getByTestId('wh-route-active')).toBeVisible();
  await expect(page.getByTestId('wh-route-cell')).toHaveText('не привязана');

  // 6. Лист не исчез из логистики: курьер в дороге, и логист обязан видеть,
  // что именно он повёз, — но уже без изменяющих действий.
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутные листы', level: 1 })).toBeVisible();
  const activeRow = page.locator('.routes__list-item', { hasText: routeNumber });
  await expect(activeRow).toContainText('Передан курьеру');
  await activeRow.getByRole('button', { name: 'Открыть лист' }).click();
  await expect(page.locator('.sheet__footer')).toContainText('передан курьеру');
});

test('курьер: досрочность, «Не доставлен» с причиной, отмена и завершение маршрута', async ({
  page,
}: {
  page: Page;
}) => {
  const courierPhone = process.env['E2E_WH_COURIER_PHONE'] ?? '';
  const courierPin = process.env['E2E_WH_COURIER_PIN'] ?? '';
  const routeNumber = process.env['E2E_WH_ROUTE'] ?? '';
  const firstOrder = process.env['E2E_WH_ORDER_1'] ?? '';
  const secondOrder = process.env['E2E_WH_ORDER_2'] ?? '';

  test.skip(
    courierPhone === '' || courierPin === '' || routeNumber === '' || firstOrder === '',
    'не передана курьерская фикстура (E2E_WH_COURIER_*)',
  );

  // Сценарий продолжает складской: маршрут уже выдан и находится в `ACTIVE`.
  await login(page, courierPhone, courierPin);
  await expect(page.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  // Локаторы по ТОЧНОМУ атрибуту, а не по подстроке: номера заказов фикстуры
  // отличаются одним символом, и `hasText` цеплял соседнюю карточку.
  const route = page.locator(`[data-testid="delivery-route"][data-route-number="${routeNumber}"]`);
  await expect(route).toBeVisible();

  // 1. Первый заказ: обычная доставка. Заказ дня ещё не в интервале, поэтому
  // экран предупреждает о досрочности — но подтвердить разрешает.
  const first = page.locator(`[data-testid="delivery-order"][data-order-number="${firstOrder}"]`);
  await first.getByTestId('delivery-open-delivered').click();
  await first.getByTestId('delivery-submit').click();
  await expect(first).toHaveAttribute('data-result', 'DELIVERED');

  // 2. Ошибку курьер исправляет сам: заказ снова открыт.
  await first.getByTestId('delivery-cancel-result').click();
  await expect(first).toHaveAttribute('data-result', 'none');

  // 3. Повторяем результат и закрываем второй заказ недоставкой с причиной.
  await first.getByTestId('delivery-open-delivered').click();
  await first.getByTestId('delivery-submit').click();
  await expect(first).toHaveAttribute('data-result', 'DELIVERED');

  const second = page.locator(`[data-testid="delivery-order"][data-order-number="${secondOrder}"]`);
  await second.getByTestId('delivery-open-failed').click();
  await second.getByRole('combobox', { name: 'Причина' }).selectOption({ label: 'Нет ответа' });
  await second.getByTestId('delivery-submit').click();
  await expect(second).toHaveAttribute('data-result', 'NOT_DELIVERED');

  // 4. Последний результат завершил маршрут: активных доставок не осталось.
  await expect(page.getByText('Активных доставок нет')).toBeVisible();

  // 5. История текущего дня показывает оба результата и не скрывает данные.
  await page.getByRole('link', { name: 'История' }).first().click();
  await expect(page.getByRole('heading', { name: 'История', level: 1 })).toBeVisible();
  await expect(
    page.locator(`[data-testid="delivery-history-item"][data-order-number="${firstOrder}"]`),
  ).toHaveAttribute('data-masked', 'no');
  await expect(
    page.locator(`[data-testid="delivery-history-item"][data-order-number="${secondOrder}"]`),
  ).toContainText('Нет ответа');
});
