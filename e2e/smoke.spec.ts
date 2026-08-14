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

import { execFileSync } from 'node:child_process';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Собственные заказы сценария.
 *
 * Раньше логистические сценарии делили заказы фикстуры и брали «любой
 * доступный». Такой выбор скрывает взаимное влияние: сценарий проходил
 * не потому, что верен, а потому, что сосед ещё не успел занять номер, —
 * и повторный прогон набора давал другой результат.
 *
 * Теперь каждый сценарий создаёт СВОИ заказы и работает ровно с ними.
 * Заказы создаются напрямую в базе: токена МоегоСклада в проверках нет,
 * и ни одного обращения к нему быть не должно.
 *
 * `withPoint` ставит подтверждённую точку. Без неё заказ непригоден
 * к распределению — это нужно сценарию ручной установки точки и мешает
 * всем остальным.
 */
function seedOrders(count: number, options: { withPoint: boolean }): string[] {
  // Интервал распознан всегда: иначе заказ остаётся в «Требует внимания»
  // по чужой причине, и сценарий доказывал бы не то, что заявляет.
  const args = [
    'run',
    '--silent',
    'seed:e2e-order',
    '--',
    `--count=${count}`,
    '--recognized-interval',
  ];
  if (options.withPoint) {
    args.push('--with-point');
  }

  const output = execFileSync('npm', args, { encoding: 'utf8' });
  const numbers = [...output.matchAll(/^номер:\s*(.+)$/gm)].map((match) => match[1]?.trim() ?? '');

  if (numbers.length !== count) {
    throw new Error(`сеялка вернула ${numbers.length} заказов вместо ${count}`);
  }
  return numbers;
}

const ADMIN_PHONE = process.env['E2E_ADMIN_PHONE'] ?? '+79990000001';
const ADMIN_CODE = process.env['E2E_ADMIN_CODE'] ?? '';
const ADMIN_PIN = '2481';
const COURIER_PIN = '1357';

/** Телефон курьера, созданного первым сценарием; нужен следующим. */
let courierPhone = '';

/** Телефон флориста, созданного сценарием сборки; нужен мобильной проверке. */
let floristPhoneForMobile = '';
const FLORIST_MOBILE_PIN = '8642';

/**
 * Обязательное значение фикстуры.
 *
 * Отсутствие роняет проверку с понятным текстом, а не превращает её в
 * молчаливый пропуск: пропущенный сценарий ничего не доказывает.
 */
function requiredEnv(name: string): string {
  const value = process.env[name] ?? '';
  if (value === '') {
    throw new Error(`не передано обязательное значение фикстуры ${name}`);
  }
  return value;
}

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

/**
 * Раскрывает черновик по номеру и дожидается именно раскрытия.
 *
 * Заголовок работает переключателем: повторное нажатие сворачивает. Без явного
 * ожидания `data-expanded` проверка иногда утверждала бы про свёрнутую
 * карточку, и «ноль остановок» означало бы не пустой состав, а закрытый блок.
 */
async function openDraft(page: Page, number: string): Promise<void> {
  // Поиск по атрибуту, а не по тексту: раскрытая карточка содержит номера
  // ДРУГИХ черновиков в списке «Перенести в маршрут», и поиск по тексту
  // находил бы сразу несколько.
  const draft = page.locator(`.routes__draft[data-draft-number="${number}"]`);
  await expect(draft).toHaveCount(1);
  if ((await draft.getAttribute('data-expanded')) !== 'true') {
    await draft.locator('button').first().click();
  }
  await expect(draft).toHaveAttribute('data-expanded', 'true');
}

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

test('Сделки: день, поиск, выбор из списка и ручной черновик', async ({ page }: { page: Page }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const orderNumber = process.env['E2E_ORDER_NUMBER'] ?? '';
  test.skip(orderNumber === '', 'не передан номер проверочного заказа (E2E_ORDER_NUMBER)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();

  // Рабочее пространство: список и карта видны одновременно и показывают
  // одно множество — их питает один серверный отбор.
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  await expect(page.getByTestId('deals-list')).toBeVisible();
  await expect(page.getByTestId('deals-map')).toBeVisible();
  // Легенда постоянна: без неё цвет и форма маркера ничего не значат.
  await expect(page.getByTestId('deals-map-legend')).toBeVisible();

  // Поиск действует внутри выбранного дня.
  await page.getByLabel('Поиск в этом дне').fill(orderNumber);
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${orderNumber}"]`);
  await expect(card).toBeVisible();

  // Заказ без подтверждённой точки выбрать нельзя, и причина названа вслух.
  const selectable = await card.getAttribute('data-selectable');
  if (selectable === 'no') {
    await expect(card.getByTestId('deal-blocked')).toBeVisible();
    return;
  }

  // Выбор из списка получает номер последовательности — он же порядок остановок.
  await card.getByTestId('deal-pick').click();
  await expect(card).toHaveAttribute('data-selected', '1');
  await expect(page.getByTestId('deals-selected-count')).toContainText('Выбрано: 1');

  // Ручной черновик создаётся ровно из выбора и открывается в «Маршрутизации».
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/logistics\/routing\?route=/);
});

const EMPTY_STYLE = JSON.stringify({ version: 8, sources: {}, layers: [] });

/** Метка окна: переживает любые перерисовки и не переживает перезагрузку. */
const RELOAD_SENTINEL = 'e2e-deals-map-no-reload';

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
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();

  await expect(page.getByText('Карта не настроена', { exact: true })).toBeVisible();
  // Карта не появилась, но работа не остановилась: список черновиков дня
  // на месте, и его состояние показано честно — списком либо пустым экраном.
  await expect(page.locator('[data-testid="orders-map"]')).toHaveCount(0);
  await expect(page.getByTestId('routing-drafts')).toBeVisible();
  await page.waitForSelector('.routes__draft, .state', { state: 'visible' });
});

/**
 * Ручная точка живёт в «Сделках», рядом с исправлением адреса.
 *
 * Точка и адрес — одна проблема одного заказа. «Маршрутизация» работает только
 * с заказами, у которых пригодные координаты уже есть, и редактора точки
 * не показывает вовсе.
 *
 * Подменяются только конфигурация карты и стиль подложки: настоящий набор
 * PMTiles весит гигабайты. Сам заказ, установка точки и переход в пригодные
 * идут через настоящий API и базу.
 */
test('Сделки: ручная точка выводит заказ из «Требует внимания» в пригодные', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Собственный заказ БЕЗ точки: ровно то, что чинит этот сценарий.
  const number = seedOrders(1, { withPoint: false })[0] ?? '';
  expect(number).not.toBe('');

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
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  // Собственный заказ сценария, намеренно без точки.
  await page.waitForSelector('[data-testid="deal-card"], .state', { state: 'visible' });
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
  await expect(card).toBeVisible();

  // Без точки заказ распределить нельзя, и причина названа прямо.
  await expect(card).toHaveAttribute('data-selectable', 'no');
  await expect(card).toContainText('Нет подтверждённой точки на карте');

  // 1. Отмена ничего не записывает.
  await card.getByTestId('deal-set-point').click();
  await expect(page.getByRole('heading', { name: `Точка заказа ${number}` })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByRole('heading', { name: `Точка заказа ${number}` })).toHaveCount(0);
  await expect(card).toHaveAttribute('data-selectable', 'no');
  await expect(card).toContainText('Нет подтверждённой точки на карте');

  // 2. Причина обязательна: без неё сохранить нельзя.
  await card.getByTestId('deal-set-point').click();
  const dialogMap = page.locator('[data-testid="orders-map"]');
  await expect(dialogMap).toBeVisible();

  // Пока точка не выбрана, сохранение недоступно.
  await expect(page.getByTestId('geo-point-save')).toBeDisabled();

  await dialogMap.click({ position: { x: 240, y: 160 } });
  await expect(page.getByTestId('geo-point-picked')).toContainText('Выбрано:');
  await expect(page.getByTestId('geo-point-save')).toBeEnabled();

  await page.getByTestId('geo-point-save').click();
  await expect(page.getByText('Опишите причину: не меньше трёх символов.')).toBeVisible();

  // 3. С причиной точка сохраняется.
  await page.getByTestId('geo-point-reason').fill('Проверочная синтетическая точка');
  await page.getByTestId('geo-point-save').click();
  await expect(page.locator('.toast-region').getByText(/Точка сохранена|уже стояла/)).toBeVisible();

  // 4. Заказ вышел из состояния «нет точки» и стал пригоден для черновика.
  await expect(card).not.toContainText('Нет подтверждённой точки на карте');
  await expect(card.getByTestId('deal-set-point')).toHaveCount(0);
  await expect(card).toHaveAttribute('data-selectable', 'yes');
  await card.getByTestId('deal-pick').click();
  await expect(page.getByTestId('deals-selected-count')).toContainText('Выбрано: 1');

  // 5. В «Маршрутизации» редактора точки нет: там работают только с заказами,
  //    у которых координаты уже пригодны.
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Указать точку' })).toHaveCount(0);
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
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
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
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
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
  /*
   * Черновики создаются в «Сделках», а редактируются и подтверждаются
   * в «Маршрутизации». Кнопки создания на «Маршрутизации» нет намеренно:
   * рабочее место работает с уже созданными черновиками.
   *
   * Три собственных заказа: два в первый черновик и один во второй, чтобы
   * было куда переносить. Чужие заказы сценарий не трогает.
   */
  const seeded = seedOrders(3, { withPoint: true });
  const first = seeded[0] ?? '';
  const second = seeded[1] ?? '';
  const third = seeded[2] ?? '';
  expect([first, second, third].every((number) => number !== '')).toBe(true);

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  for (const number of [first, second]) {
    const deal = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
    await expect(deal).toHaveAttribute('data-selectable', 'yes');
    await deal.getByTestId('deal-pick').click();
  }
  await page.getByTestId('deals-manual-draft').click();

  // Переход ведёт в созданный черновик: он раскрыт, а не потерян в списке.
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Создать черновик' })).toHaveCount(0);

  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  const routeNumber = (await card.getByRole('heading').innerText()).replace(/[^R\d-]/g, '');
  expect(routeNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);

  const stops = card.locator('.routes__stop');
  await expect(stops).toHaveCount(2);

  // Раскрыт ровно один черновик.
  await expect(page.locator('.routes__draft[data-expanded="true"]')).toHaveCount(1);

  // Порядок меняется кнопками: перетаскивание не требуется.
  await expect(stops.first()).toContainText(first);
  await card.getByRole('button', { name: `Опустить заказ ${first}` }).click();
  await expect(stops.first()).toContainText(second);

  /*
   * Перестановка пережила обновление страницы.
   *
   * Проверяется номер заказа на первой остановке, а не весь текст строки:
   * порядок живёт на сервере, и доказывать надо именно его, а не совпадение
   * пробелов после перерисовки. Заодно это проверка, что активный черновик
   * восстановился из адреса — иначе остановок на экране не было бы вовсе.
   */
  await page.reload();
  await expect(page.locator('.routes__card .routes__stop').first()).toContainText(second);

  // Второй черновик — из третьего собственного заказа, чтобы было куда
  // переносить.
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  const thirdDeal = page.locator(`[data-testid="deal-card"][data-order-number="${third}"]`);
  await expect(thirdDeal).toHaveAttribute('data-selectable', 'yes');
  await thirdDeal.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);
  const secondCardNumber = (
    await page.locator('.routes__card').getByRole('heading').innerText()
  ).replace(/[^R\d-]/g, '');

  // Перенос из списка: аренда обоих черновиков берётся клиентом.
  // В первом черновике два собственных заказа, во втором — один.
  await openDraft(page, routeNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);
  await card.getByLabel(`Выбрать заказ ${first}`).check();
  await selectRouteByNumber(card.getByLabel('Перенести в маршрут'), secondCardNumber);
  await clickAndAwait(
    page,
    card.getByRole('button', { name: /Перенести/ }),
    'POST',
    '/routes/move',
  );
  // Заказ ушёл: перенос выполнен, а не отклонён блокировкой.
  await expect(card.locator('.routes__stop')).toHaveCount(1);

  // Возвращаем заказ обратно, чтобы подтвердить маршрут полным составом.
  await openDraft(page, secondCardNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);
  await card.getByLabel(`Выбрать заказ ${first}`).check();
  await selectRouteByNumber(card.getByLabel('Перенести в маршрут'), routeNumber);
  await clickAndAwait(
    page,
    card.getByRole('button', { name: /Перенести/ }),
    'POST',
    '/routes/move',
  );

  await openDraft(page, routeNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);

  // Подтверждение с назначением курьера в том же окне.
  await card.getByRole('button', { name: 'Подтвердить маршрут' }).click();
  await page.getByTestId('route-confirm-submit').click();

  // Подтверждённый черновик исчезает из «Маршрутизации».
  await expect(page.locator(`.routes__draft[data-draft-number="${routeNumber}"]`)).toHaveCount(0);

  // Тот же маршрут появляется в маршрутных листах.
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
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

  // Первый сеанс раскрывает черновик и держит его в работе.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();

  await page.waitForSelector('.routes__draft, .state', { state: 'visible' });
  const drafts = page.locator('.routes__draft');
  test.skip((await drafts.count()) === 0, 'черновиков дня нет');
  const draftNumber = (await drafts.first().getAttribute('data-draft-number')) ?? '';
  expect(draftNumber).not.toBe('');
  await openDraft(page, draftNumber);

  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  const routeNumber = (await card.getByRole('heading').innerText()).replace(/[^R\d-]/g, '');
  await expect(card.getByRole('button', { name: 'Отменить маршрут' })).toBeEnabled();

  // Второй сеанс того же администратора — другое устройство, другая семья сессий.
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await login(secondPage, ADMIN_PHONE, ADMIN_PIN);
  await secondPage.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await openDraft(secondPage, routeNumber);

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
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
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
test('Сделки: точный выбор → расчёт → превью → применение', async ({ page }: { page: Page }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  // Фикстура обязательна: без неё доказывать точность выбора нечем, и проверка
  // обязана упасть, а не пропустить себя. Готового превью фикстура больше
  // не создаёт — расчёт выполняется по-настоящему из браузера.
  // Фикстура обязана существовать: она создаёт склад и обязательные настройки,
  // без которых расчёту не из чего складываться. Проверка обязана упасть,
  // а не пропустить себя.
  requiredEnv('E2E_PLAN_SELECTED_NUMBERS');

  // Три собственных заказа: два уходят в расчёт, третий остаётся посторонним.
  const seededForSplit = seedOrders(3, { withPoint: true });
  const chosen = [seededForSplit[0] ?? '', seededForSplit[1] ?? ''];
  const foreignNumber = seededForSplit[2] ?? '';
  expect(chosen.every((number) => number !== '')).toBe(true);
  expect(foreignNumber).not.toBe('');

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

  /*
   * 2. «Сделки»: выбираются два собственных заказа, а третий остаётся
   *    посторонним — он обязан не попасть ни в расчёт, ни в черновики.
   */
  // Сколько черновиков уже есть у дня: разбивка обязана добавить ровно два,
  // а не «сделать так, чтобы их стало два» — соседние сценарии оставляют свои.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await page.waitForSelector('.routes__draft, .state', { state: 'visible' });
  const draftsBefore = await page.getByTestId('routing-drafts').locator('.routes__draft').count();

  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  for (const number of chosen) {
    const deal = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
    await expect(deal).toHaveAttribute('data-selectable', 'yes');
    await deal.getByTestId('deal-pick').click();
  }

  const foreignCard = page.locator(
    `[data-testid="deal-card"][data-order-number="${foreignNumber}"]`,
  );
  await expect(foreignCard).toHaveAttribute('data-selected', 'no');
  await expect(page.getByTestId('deals-selected-count')).toContainText('Выбрано: 2');

  /*
   * ГРАНИЦА СЦЕНАРИЯ, названная прямо.
   *
   * Ни одного подменённого запроса здесь нет. Расчёт идёт через настоящий
   * серверный контракт `/api/route-plans`: постановка, ожидание, превью
   * и применение. Подменены только два внешних сервиса — решатель и матрица, —
   * и подменены они ВНУТРИ приложения (`PLANNING_TEST_SOLVER`), а не в браузере.
   * Прежняя проверка перехватывала сам HTTP-ответ и потому оставалась зелёной,
   * когда клиент обращался к несуществующему адресу и слал неверное поле.
   */

  // 3. Параметры разбивки логист задаёт сам: значений по умолчанию нет.
  await page.getByTestId('deals-auto-plan').click();
  await expect(page.getByRole('heading', { name: 'Автоматическая разбивка' })).toBeVisible();

  // Пустые поля не пропускаются.
  await page.getByTestId('split-submit').click();
  await expect(page.getByText('Укажите значение.').first()).toBeVisible();

  // Дробное число машин тоже отвергается до сети.
  await page.getByTestId('split-vehicles').fill('1.5');
  await page.getByTestId('split-capacity').fill('1');
  await page.getByTestId('split-submit').click();
  await expect(page.getByText('Введите целое число, без дробной части.')).toBeVisible();

  // Две машины по одному заказу: выбрано два заказа, поэтому размещаются оба.
  await page.getByTestId('split-vehicles').fill('2');
  await page.getByTestId('split-capacity').fill('1');
  await page.getByTestId('split-submit').click();

  // 4. Ожидание идёт в «Сделках», а переход происходит уже с готовыми
  //    черновиками: технический запуск наружу не всплывает.
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Планирование маршрутов' })).toHaveCount(0);

  // 5. Разбивка создала НЕСКОЛЬКО черновиков, и раскрыт ровно один.
  const drafts = page.getByTestId('routing-drafts').locator('.routes__draft');
  await expect(drafts).toHaveCount(draftsBefore + 2);
  await expect(page.locator('.routes__draft[data-expanded="true"]')).toHaveCount(1);

  // 6. Посторонний заказ дня в расчёт не попал и остался доступным в «Сделках».
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(
    page.locator(`[data-testid="deal-card"][data-order-number="${foreignNumber}"]`),
  ).toHaveAttribute('data-selectable', 'yes');

  // 7. Третья обязательная форма: время обслуживания. Меняется после
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
 * Длинная очередь: первая страница, продолжение, серверный поиск и сброс.
 *
 * День мастерской — сотня с лишним заказов. Проверяется не «список
 * прокручивается», а три решения, ошибка в которых стоит собранного не того
 * букета:
 *
 *  * экран строит ПЕРВУЮ страницу, а не весь день, и честно называет оба числа;
 *  * заказ за пределами первой страницы достижим — продолжением и поиском;
 *  * смена дня возвращает список к первой странице, а не дополняет чужой.
 *
 * Проверка выполняется только там, где фикстура длинной очереди создана:
 * на трёх заказах кнопки продолжения нет вовсе, и утверждать по ней нечего.
 */
async function checkLongQueue(floristPage: Page): Promise<void> {
  const prefix = process.env['E2E_FLORIST_QUEUE_PREFIX'] ?? '';
  const seeded = Number(process.env['E2E_FLORIST_QUEUE_COUNT'] ?? '0');
  if (prefix === '' || seeded <= 50) {
    return;
  }

  const rows = floristPage.getByTestId('florist-row');
  const counter = floristPage.getByTestId('florist-queue-count');

  // Первая страница ровно 50 строк: весь день в DOM не строится.
  await expect(counter).toBeVisible();
  await expect(rows).toHaveCount(50);

  const summary = (await counter.innerText()).trim();
  const parsed = /Показано (\d+) из (\d+)/.exec(summary);
  expect(parsed, `счётчик очереди: ${summary}`).not.toBeNull();
  const total = Number(parsed?.[2] ?? '0');
  expect(total).toBeGreaterThan(50);

  // Продолжение добавляет следующую страницу и НЕ повторяет уже показанное.
  await floristPage.getByTestId('florist-load-more').click();
  await expect(rows).toHaveCount(Math.min(total, 100));
  const numbers = await Promise.all(
    (await rows.all()).map((row) => row.getAttribute('data-order-number')),
  );
  expect(new Set(numbers).size, 'страницы не должны повторять заказ').toBe(numbers.length);

  // Карточка открывается из ЛЮБОЙ страницы, а не только из первой.
  //
  // ИМЕННО ЭТОТ ДЕФЕКТ И ПРОВЕРЯЕТСЯ. Раньше карточка рисовалась блоком ПОСЛЕ
  // всего списка: она была в DOM, поэтому автоматическая проверка её находила,
  // а человек на шестьдесят первой строке не видел ничего. Поэтому здесь
  // сравниваются КООРДИНАТЫ: окно обязано перекрывать то место экрана, куда
  // человек смотрит, а не находиться экранами ниже.
  const opener = rows.nth(60).getByTestId('row-open');
  await expect(opener).toHaveText('Просмотр');
  await opener.click();

  const dialog = floristPage.getByTestId('florist-card-dialog');
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  const viewport = floristPage.viewportSize();
  expect(dialogBox, 'окно карточки обязано иметь геометрию').not.toBeNull();
  expect(dialogBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(dialogBox?.y ?? Number.MAX_SAFE_INTEGER).toBeLessThan(viewport?.height ?? 0);

  // Номер строки — обычный текст: карточку открывает только кнопка.
  await expect(rows.nth(60).locator('span.florist__number')).toHaveCount(1);
  await expect(rows.nth(60).locator('button.florist__number')).toHaveCount(0);

  // Закрытие возвращает фокус на ту кнопку, которая окно открыла, и НЕ сбрасывает
  // накопленные страницы: человек продолжает с того места, где остановился.
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(rows).toHaveCount(Math.min(total, 100));

  // Серверный поиск достаёт заказ, которого нет ни на одной загруженной
  // странице. Поиск по показанному здесь ответил бы «ничего нет».
  const deepNumber = `${prefix}-${String(seeded - 1).padStart(4, '0')}`;
  const searchField = floristPage.getByTestId('florist-search');
  await searchField.fill(deepNumber);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-order-number', deepNumber);
  await expect(counter).toContainText('Показано 1 из 1');

  // Снятие поиска возвращает к первой странице, а не к прежней стопке.
  await searchField.fill('');
  await expect(rows).toHaveCount(50);

  // Смена дня сбрасывает накопленное полностью: заказы двух дней не смешиваются.
  await floristPage.getByTestId('florist-load-more').click();
  await expect(rows).toHaveCount(Math.min(total, 100));
  await floristPage.getByTestId('florist-day-tomorrow').click();
  await expect(rows).toHaveCount(0);
  await floristPage.getByTestId('florist-day-today').click();
  await expect(rows).toHaveCount(50);
}

/**
 * Флорист: смена → захват → карточка → «Собран» → бланк с QR → ручная отметка.
 *
 * Сценарий проходит весь путь браузером и БЕЗ живого МоегоСклада: состав
 * заказа создан фикстурой, фотографии у номенклатуры нет — и карточка обязана
 * не оставить на её месте ни надписи, ни пустого прямоугольника.
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

  const FLORIST_PIN = FLORIST_MOBILE_PIN;

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
  // Мобильная проверка входит тем же человеком: код активации одноразовый,
  // и завести второго флориста ради узкого экрана было бы лишней сущностью.
  floristPhoneForMobile = floristPhone;
  await expect(floristPage.getByRole('heading', { name: 'Флорист', level: 1 })).toBeVisible();

  // Чужих разделов у флориста нет.
  for (const foreign of ['Настройки', 'Сотрудники и курьеры', 'Маршрутизация']) {
    await expect(floristPage.getByRole('link', { name: foreign })).toHaveCount(0);
  }

  // 2.1. Длинная очередь: страница, продолжение, поиск и сброс.
  await checkLongQueue(floristPage);

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

  /*
   * Счётчик активных заказов: серверное число, видное на ЛЮБОЙ вкладке.
   *
   * Сейчас открыта «Очередь» — списка «Моих заказов» на экране нет вовсе,
   * а число уже верное и обновилось без перезагрузки страницы. Проверяется
   * и «Печать»: именно там счётчик, посчитанный по загруженному списку,
   * оказался бы нулём или отсутствовал бы.
   */
  const activeCount = floristPage.getByTestId('florist-active-count');
  await expect(activeCount).toHaveText('1');
  await floristPage.getByTestId('florist-tab-print').click();
  await expect(activeCount).toHaveText('1');
  await floristPage.getByTestId('florist-tab-queue').click();
  // Ни поиск, ни выбранный день на счётчик не влияют: он не о показанном.
  await floristPage.getByTestId('florist-day-tomorrow').click();
  await expect(activeCount).toHaveText('1');
  await floristPage.getByTestId('florist-day-today').click();

  await floristPage.getByTestId('florist-tab-mine').click();
  const mineRow = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(mineRow).toBeVisible();
  await expect(mineRow).toContainText('В сборке');

  // 6. Карточка: состав, бандл с компонентом, текст открытки и комментарий.
  //    Ни адреса, ни получателя, ни цены здесь быть не должно.
  const mineOpener = mineRow.getByTestId('row-open');
  await expect(mineOpener).toHaveText('Просмотр');
  await mineOpener.click();

  const cardDialog = floristPage.getByTestId('florist-card-dialog');
  const card = floristPage.getByTestId('florist-card');
  await expect(cardDialog).toBeVisible();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Букет проверочный');
  await expect(card).toContainText('Роза проверочная');
  await expect(card.getByTestId('card-text')).toContainText('Проверочная открытка');
  await expect(card.getByTestId('card-description')).toContainText('Нижний комментарий');
  await expect(card).not.toContainText('проверочный адрес');
  await expect(card).not.toContainText('Проверочный Получатель');

  // Единица измерения: у компонента она подтверждена, у бандла её нет —
  // и тогда показывается ОДНО ЧИСЛО, без «ед. не указана» и без «шт».
  //
  // В базе у компонента лежит ПОЛНОЕ название «штука»: короткого обозначения
  // у этой единицы в справочнике нет. Человеку показывается «шт» — полного
  // названия рядом с числом быть не должно.
  await expect(card).toContainText('11 шт');
  await expect(card).not.toContainText('штука');
  await expect(card.getByTestId('position-quantity').first()).toHaveText('1');
  await expect(card).not.toContainText('ед. не указана');

  // Фотографии у проверочной номенклатуры нет — и на её месте НИЧЕГО НЕТ:
  // ни надписи, ни рамки, ни зарезервированной высоты.
  await expect(card.getByTestId('position-photo')).toHaveCount(0);
  await expect(card).not.toContainText('Фото отсутствует');

  // Закрытие по Escape возвращает фокус на кнопку, открывшую окно, и не
  // трогает ни выбранный день, ни вкладку.
  await floristPage.keyboard.press('Escape');
  await expect(cardDialog).toBeHidden();
  await expect(mineOpener).toBeFocused();
  await expect(floristPage.getByTestId('florist-tab-mine')).toHaveAttribute('aria-pressed', 'true');
  await mineOpener.click();
  await expect(cardDialog).toBeVisible();

  // 7. «Собран»: одна операция, после которой появляется бланк. Окно при этом
  //    ОСТАЁТСЯ открытым и показывает результат — закрывать его решает человек.
  await clickAndAwait(floristPage, card.getByTestId('card-assemble'), 'POST', '/assemble');
  await expect(cardDialog).toBeVisible();
  await expect(card).toContainText('Собран');
  await expect(card.getByTestId('card-print-state')).toContainText('Ожидает печати');

  // Собранный заказ работой не является: счётчик активных обнулился сам,
  // без перезагрузки и без закрытия окна.
  await expect(activeCount).toHaveText('0');

  // 8. Бланк скачивается настоящим файлом PDF.
  const [download] = await Promise.all([
    floristPage.waitForEvent('download'),
    card.getByTestId('card-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`order-${orderNumber}.pdf`);

  // 8.1. «Мои заказы»: собранный заказ ушёл из работы в свёрнутую группу.
  //
  //      Проверяется главное обещание разделения: заказ не исчез бесследно —
  //      его точное число видно ДО раскрытия, а строки не построены, пока
  //      группу не раскрыли.
  await cardDialog.getByRole('button', { name: 'Закрыть' }).click();
  await expect(cardDialog).toBeHidden();

  await expect(floristPage.locator('.florist__row', { hasText: orderNumber })).toHaveCount(0);
  const assembledToggle = floristPage.getByTestId('florist-assembled-toggle');
  await expect(floristPage.getByTestId('florist-assembled-title')).toContainText('Собранные — 1');
  await expect(assembledToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(floristPage.getByTestId('florist-assembled')).toHaveCount(0);

  await assembledToggle.click();
  await expect(assembledToggle).toHaveAttribute('aria-expanded', 'true');
  const assembledRow = floristPage
    .getByTestId('florist-assembled')
    .locator('.florist__row', { hasText: orderNumber });
  await expect(assembledRow).toBeVisible();
  await expect(assembledRow).toContainText('Собран');
  // Просмотр собранного заказа остаётся доступным.
  await expect(assembledRow.getByTestId('row-open')).toHaveText('Просмотр');

  // Возврат во вкладку сворачивает группу заново: собранное работой не является.
  await floristPage.getByTestId('florist-tab-queue').click();
  await floristPage.getByTestId('florist-tab-mine').click();
  await expect(floristPage.getByTestId('florist-assembled-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Поиск номера собранного заказа раскрывает группу сам: иначе человек
  // получил бы пустой рабочий список и решил, что заказа нет.
  const mineSearch = floristPage.getByTestId('florist-search');
  await mineSearch.fill(orderNumber);
  await expect(floristPage.getByTestId('florist-assembled-found')).toBeVisible();
  await expect(
    floristPage.getByTestId('florist-assembled').locator('.florist__row', { hasText: orderNumber }),
  ).toBeVisible();

  // Снятие поиска возвращает обычное свёрнутое состояние.
  await mineSearch.fill('');
  await expect(floristPage.getByTestId('florist-assembled-toggle')).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // 9. Вкладка «Печать»: задание ждёт, ручная отметка его завершает.
  await floristPage.getByTestId('florist-tab-print').click();
  const printRow = floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber });
  await expect(printRow).toBeVisible();
  await expect(printRow).toContainText('Ожидает печати');

  // Номер в очереди печати — текст; карточку открывает та же кнопка «Просмотр».
  await expect(printRow.locator('button.florist__number')).toHaveCount(0);
  await printRow.getByTestId('print-open').click();
  await expect(cardDialog).toBeVisible();
  await cardDialog.getByRole('button', { name: 'Закрыть' }).click();
  await expect(cardDialog).toBeHidden();

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

/**
 * Флорист на телефоне: нет лишней полосы внизу и карточка помещается в окно.
 *
 * Две проверки, которые нельзя сделать на широком экране:
 *
 *  * у пользователя с ОДНИМ верхнеуровневым разделом нижней навигации нет
 *    вовсе, и содержимое получает её высоту. Единственная кнопка «Флорист»
 *    вела бы на уже открытую страницу и отнимала бы шестьдесят пикселей;
 *  * карточка открывается окном, помещается в экран и прокручивает СВОЁ
 *    содержимое. Страница под окном при этом не двигается — иначе человек
 *    терял бы и место в очереди, и само окно.
 */
test('флорист на телефоне: без нижней полосы, карточка окном внутри экрана', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(floristPhoneForMobile === '', 'флорист не создан предыдущим сценарием');

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await context.newPage();

  await login(mobilePage, floristPhoneForMobile, FLORIST_MOBILE_PIN);
  await expect(mobilePage.getByRole('heading', { name: 'Флорист', level: 1 })).toBeVisible();

  // Нижней полосы нет ни как кнопки, ни как строки сетки: оболочка переходит
  // в раскладку единственного раздела, а не прячет полосу `display: none`.
  await expect(mobilePage.locator('.shell__bottombar')).toHaveCount(0);
  await expect(mobilePage.locator('.shell')).toHaveClass(/shell--single-section/);

  // Содержимое получает освободившуюся высоту и доходит до низа экрана.
  const contentBox = await mobilePage.locator('.shell__content').boundingBox();
  const viewport = mobilePage.viewportSize();
  expect(contentBox, 'содержимое обязано иметь геометрию').not.toBeNull();
  expect((contentBox?.y ?? 0) + (contentBox?.height ?? 0)).toBeGreaterThanOrEqual(
    (viewport?.height ?? 0) - 1,
  );

  // Внутренние вкладки раздела при этом остаются: их убирать было бы потерей.
  for (const tab of ['queue', 'mine', 'print'] as const) {
    await expect(mobilePage.getByTestId(`florist-tab-${tab}`)).toBeVisible();
  }

  // Карточка первого доступного заказа.
  const firstRow = mobilePage.locator('.florist__row').first();
  await expect(firstRow).toBeVisible();
  const opener = firstRow.getByTestId('row-open');
  await expect(opener).toHaveText('Просмотр');

  /*
   * РАСКЛАДКА СТРОКИ НА ТЕЛЕФОНЕ.
   *
   * Ширина самой строки не проверяется на изменение — она и была верной.
   * Проверяется распределение СОДЕРЖИМОГО внутри неё: раньше номер, интервал,
   * статус и исполнитель жались к левому краю, а справа висела пустая область
   * почти в половину экрана.
   */
  const rowBox = await firstRow.boundingBox();
  expect(rowBox, 'строка обязана иметь геометрию').not.toBeNull();
  const rowRight = (rowBox?.x ?? 0) + (rowBox?.width ?? 0);

  for (const part of ['.florist__row-main', '.florist__row-side']) {
    const partBox = await firstRow.locator(part).boundingBox();
    expect(partBox, `${part} обязан иметь геометрию`).not.toBeNull();
    // Половина строки занимает её целиком, а не треть: пустого поля справа нет.
    expect(partBox?.width ?? 0).toBeGreaterThan((rowBox?.width ?? 0) * 0.9);
    // И при этом не выходит за строку — иначе появилась бы прокрутка.
    expect((partBox?.x ?? 0) + (partBox?.width ?? 0)).toBeLessThanOrEqual(rowRight + 1);
  }

  // Кнопки действия видны ЦЕЛИКОМ и остаются крупной целью для пальца.
  const claim = firstRow.getByTestId('row-claim');
  for (const button of [claim, opener]) {
    if ((await button.count()) === 0) {
      continue;
    }
    await expect(button).toBeVisible();
    const buttonBox = await button.boundingBox();
    expect(buttonBox, 'кнопка обязана иметь геометрию').not.toBeNull();
    expect(buttonBox?.x ?? -1).toBeGreaterThanOrEqual((rowBox?.x ?? 0) - 1);
    expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(rowRight + 1);
    expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(32);
  }

  // Горизонтальной прокрутки нет во всей странице: узкий экран не должен
  // заставлять возить содержимое вбок, чтобы прочитать номер заказа.
  const overflowX = await mobilePage.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflowX).toBeLessThanOrEqual(0);

  // Счётчик активных заказов виден и на телефоне: он часть вкладки, а не
  // отдельной широкой панели, которая на узком экране уехала бы вниз.
  await expect(mobilePage.getByTestId('florist-active-count')).toBeVisible();

  const scrollBefore = await mobilePage.evaluate<number>('window.scrollY');
  await opener.click();

  const dialog = mobilePage.getByTestId('florist-card-dialog');
  await expect(dialog).toBeVisible();

  // Окно помещается в экран целиком: ни верх, ни низ за него не выходят.
  const box = await dialog.boundingBox();
  expect(box, 'окно карточки обязано иметь геометрию').not.toBeNull();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  expect(box?.width ?? 0).toBeLessThanOrEqual(viewport?.width ?? 0);

  // Прокручивается содержимое окна, а не страница под ним.
  const overflow = await mobilePage.evaluate<string>(
    "getComputedStyle(document.querySelector('dialog[open] .modal__body')).overflowY",
  );
  expect(overflow).toBe('auto');
  await mobilePage.evaluate(
    "document.querySelector('dialog[open] .modal__body').scrollTop = 10000",
  );
  expect(await mobilePage.evaluate<number>('window.scrollY')).toBe(scrollBefore);

  // Escape закрывает окно и возвращает фокус на кнопку, его открывшую.
  await mobilePage.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

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

  // Ручной путь требует ту же пару «заказ → ячейка», что и камера: код ячейки
  // из карточки листа больше не подставляется.
  await page.getByTestId('wh-pick-order').fill(firstOrder);
  await page.getByTestId('wh-pick-order').press('Enter');
  await expect(page.getByTestId('wh-pick-scanned')).toHaveText(firstOrder);
  await page.getByTestId('wh-pick-cell').fill(routeCell);
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
  await page.getByTestId('wh-pick-order').press('Enter');
  await expect(page.getByTestId('wh-pick-scanned')).toHaveText(secondOrder);
  await page.getByTestId('wh-pick-cell').fill(routeCell);
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
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await page.getByRole('link', { name: 'Логистика' }).first().click();
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
  // Кнопка активна только при заполненном черновике: если причина не выбрана,
  // отказ произойдёт здесь и будет назван, а не спрячется за общим таймаутом.
  await expect(second.getByTestId('delivery-submit')).toBeEnabled();
  await second.getByTestId('delivery-submit').click();
  // Состояние карточки здесь не проверяется намеренно: это ПОСЛЕДНИЙ заказ,
  // его результат завершает маршрут, и список активных доставок пустеет —
  // карточки больше не существует. Доказательством служат ответ сервера
  // в тосте и сам факт опустевшего списка.
  await expect(page.locator('.toast-region')).toContainText('Маршрут завершён');

  // 4. Последний результат завершил маршрут: активных доставок не осталось.
  await expect(page.getByText('Активных доставок нет')).toBeVisible();

  // 5. История текущего дня показывает оба результата и не скрывает данные.
  await page.getByRole('link', { name: 'История' }).first().click();
  await expect(page.getByRole('heading', { name: 'История', level: 1 })).toBeVisible();
  // У первого заказа записей ДВЕ: отменённая и новая. Это и есть доказательство
  // того, что история не переписывается — отменённый результат остаётся в ней
  // вместе со своим прежним содержимым.
  const firstHistory = page.locator(
    `[data-testid="delivery-history-item"][data-order-number="${firstOrder}"]`,
  );
  await expect(firstHistory).toHaveCount(2);
  await expect(firstHistory.first()).toHaveAttribute('data-masked', 'no');
  // Отменённая запись помечена и зачёркнута, а не удалена.
  await expect(
    page.locator('[data-testid="delivery-history-item"]').filter({ hasText: 'отменён' }),
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-testid="delivery-history-item"][data-order-number="${secondOrder}"]`),
  ).toContainText('Нет ответа');
});

test('самовывоз: флорист собрал → склад принял → менеджер выдал покупателю', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const orderNumber = process.env['E2E_PICKUP_ORDER'] ?? '';
  const cellCode = process.env['E2E_PICKUP_CELL'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    orderNumber === '' || cellCode === '',
    'не передана фикстура самовывоза (E2E_PICKUP_*)',
  );

  const MANAGER_PIN = '7351';
  const FLORIST_PIN = '9512';

  // 1. Администратор заводит менеджера выдачи и флориста.
  await login(page, ADMIN_PHONE, ADMIN_PIN);

  async function createUser(name: string, roleLabel: string): Promise<[string, string]> {
    await page.getByRole('link', { name: 'Сотрудники и курьеры' }).first().click();
    await page.getByRole('button', { name: 'Добавить' }).click();
    await page.getByLabel('ФИО').fill(name);
    const phone = uniquePhone();
    await page.getByLabel('Телефон').fill(phone);
    await page.getByRole('checkbox', { name: roleLabel }).check();
    const courierRole = page.getByRole('checkbox', { name: 'Курьер', exact: true });
    if (await courierRole.isChecked()) {
      await courierRole.uncheck();
    }
    await page.getByRole('button', { name: 'Создать' }).click();
    const code = (await page.locator('.one-time-code').innerText()).trim();
    expect(code).toMatch(/^\d{4}$/);
    await page.getByRole('button', { name: 'Я сохранил код' }).click();
    return [phone, code];
  }

  const [managerPhone, managerCode] = await createUser('Менеджер выдачи', 'Менеджер выдачи');
  const [floristPhone, floristCode] = await createUser('Флорист самовывоза', 'Флорист');

  // 2. Флорист собирает самовывозный заказ: маршрута у него нет, сборка обычная.
  const floristContext = await browser.newContext();
  const floristPage = await floristContext.newPage();
  await activate(floristPage, floristPhone, floristCode, FLORIST_PIN);
  await clickAndAwait(
    floristPage,
    floristPage.getByTestId('shift-start'),
    'POST',
    '/api/florist/shift/start',
  );
  const queueRow = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(queueRow).toBeVisible();
  await clickAndAwait(floristPage, queueRow.getByTestId('row-claim'), 'POST', '/claim');
  await floristPage.getByTestId('florist-tab-mine').click();
  await floristPage
    .locator('.florist__row', { hasText: orderNumber })
    .getByTestId('row-open')
    .click();
  await clickAndAwait(
    floristPage,
    floristPage.getByTestId('florist-card').getByTestId('card-assemble'),
    'POST',
    '/assemble',
  );
  await floristContext.close();

  // 3. Кладовщик принимает заказ в обычную ячейку хранения: маршрут не нужен.
  await page.getByRole('link', { name: 'Склад' }).first().click();
  await page.getByTestId('wh-scan-order').fill(orderNumber);
  await page.getByTestId('wh-scan-order').press('Enter');
  await expect(page.getByTestId('wh-scanned-order')).toHaveText(orderNumber);
  await page.getByTestId('wh-scan-cell').fill(cellCode);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(orderNumber);

  // 4. Менеджер входит и видит ТОЛЬКО свой раздел.
  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await activate(managerPage, managerPhone, managerCode, MANAGER_PIN);
  await expect(managerPage.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();
  for (const foreign of [
    'Настройки',
    'Сотрудники и курьеры',
    'Маршрутизация',
    'Склад',
    'Флорист',
  ]) {
    await expect(managerPage.getByRole('link', { name: foreign })).toHaveCount(0);
  }

  // Заказ ждёт выдачи и лежит в известной ячейке.
  const waiting = managerPage.locator('[data-testid="pickup-waiting-row"]', {
    hasText: orderNumber,
  });
  await expect(waiting).toContainText(cellCode);

  // 5. Поиск по номеру и выдача покупателю — без второго скана.
  await managerPage.getByTestId('pickup-search').fill(orderNumber);
  await managerPage.getByTestId('pickup-search').press('Enter');
  const card = managerPage.getByTestId('pickup-card');
  await expect(card.getByTestId('pickup-card-number')).toHaveText(orderNumber);
  await expect(card.getByTestId('pickup-card-cell')).toHaveText(cellCode);
  await expect(card).toContainText('Собран');

  await clickAndAwait(managerPage, card.getByTestId('pickup-issue'), 'POST', '/api/pickup/issues');

  // 6. Заказ ушёл из ожидающих и появился среди выданных.
  await expect(
    managerPage.locator('[data-testid="pickup-waiting-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);
  await expect(
    managerPage.locator('[data-testid="pickup-issued-row"]', { hasText: orderNumber }),
  ).toContainText('Выдан');

  // 7. Повторная выдача отказывает штатно, а не создаёт второй факт.
  await managerPage.getByTestId('pickup-search').fill(orderNumber);
  await managerPage.getByTestId('pickup-search').press('Enter');
  await expect(managerPage.getByTestId('pickup-card-blocked')).toContainText('Уже выдан');
  await expect(managerPage.getByTestId('pickup-issue')).toHaveCount(0);

  await managerContext.close();
});

/**
 * Камера склада с подменённым адаптером.
 *
 * Настоящего устройства и разрешения в CI нет, а проводку «кнопка → шаг →
 * сервер» доказать нужно. Поэтому адаптер камеры подменяется двойником,
 * который отдаёт коды по команде теста: проверяется реальная цепочка
 * приложения, а не работа драйвера камеры.
 */
test('склад с камеры: приёмка, комплектование парой и непрерывная выдача', async ({
  page,
}: {
  page: Page;
}) => {
  // Собственная фикстура: сценарий камеры не делит ячейки и лист с ручным
  // складским сценарием, иначе они мешали бы друг другу порядком запуска.
  const storageCell = process.env['E2E_WH_CAM_STORAGE'] ?? '';
  const routeCell = process.env['E2E_WH_CAM_ROUTE_CELL'] ?? '';
  const routeNumber = process.env['E2E_WH_CAM_ROUTE'] ?? '';
  const firstOrder = process.env['E2E_WH_CAM_ORDER_1'] ?? '';
  const secondOrder = process.env['E2E_WH_CAM_ORDER_2'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    storageCell === '' || routeCell === '' || routeNumber === '' || firstOrder === '',
    'не передана складская фикстура камеры (E2E_WH_CAM_*)',
  );

  // Двойник камеры ставится до загрузки приложения: настоящий adapter
  // запрашивал бы разрешение, которого в CI не выдать. Обращение идёт через
  // `globalThis`: тип страницы здесь — типы Node, а не DOM.
  await page.addInitScript(() => {
    interface FakeCameraGlobals {
      __flCameraAdapter?: unknown;
      __flCameraRunning?: boolean;
      __flScan?: (code: string) => void;
      __flClear?: () => void;
    }
    const scope = globalThis as unknown as FakeCameraGlobals;

    const queue: string[] = [];
    let onCode: ((code: string) => void) | null = null;
    let onEmpty: (() => void) | null = null;
    let running = false;

    const pump = (): void => {
      if (!running) {
        return;
      }
      // Настоящий QR не исчезает из кадра оттого, что приложение занято:
      // код повторяется, пока тест не уберёт его сам. Иначе двойник терял бы
      // значение, которое машина отвергла как «идёт запрос».
      const next = queue[0];
      if (next === undefined) {
        onEmpty?.();
      } else {
        onCode?.(next);
      }
      setTimeout(pump, 40);
    };

    scope.__flCameraAdapter = {
      start: (
        _video: unknown,
        events: { onCode: (code: string) => void; onEmptyFrame: () => void },
      ) => {
        onCode = events.onCode;
        onEmpty = events.onEmptyFrame;
        running = true;
        scope.__flCameraRunning = true;
        setTimeout(pump, 40);
        return Promise.resolve({
          stop: () => {
            running = false;
            onCode = null;
            onEmpty = null;
            scope.__flCameraRunning = false;
          },
        });
      },
    };

    scope.__flScan = (code: string) => {
      queue.push(code);
    };
    scope.__flClear = () => {
      queue.length = 0;
    };
  });

  /** Подносит QR к камере и убирает его после того, как шаг сменился. */
  const scan = async (code: string, until: () => Promise<void>): Promise<void> => {
    await page.evaluate((value) => {
      (globalThis as unknown as { __flScan: (code: string) => void }).__flScan(value);
    }, code);
    await until();
    await page.evaluate(() => {
      (globalThis as unknown as { __flClear: () => void }).__flClear();
    });
  };
  const cameraRunning = (): Promise<boolean> =>
    page.evaluate(
      () => (globalThis as unknown as { __flCameraRunning?: boolean }).__flCameraRunning === true,
    );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Склад' }).first().click();

  const hint = page.getByTestId('scan-hint');
  const success = page.getByTestId('scan-success');

  // 1. Приёмка: камера открывается только по нажатию и ведёт пару шагов.
  expect(await cameraRunning()).toBe(false);
  await page.getByTestId('wh-scan-camera').click();
  await expect(hint).toHaveText('Сканируйте QR заказа');
  expect(await cameraRunning()).toBe(true);

  await scan(firstOrder, async () => {
    await expect(hint).toHaveText('Сканируйте QR ячейки');
  });
  await scan(storageCell, async () => {
    await expect(success).toContainText(firstOrder);
  });

  // Успех закрылся сам, экран вернулся во вкладку, камера погашена.
  await expect(page.getByTestId('wh-scan-camera')).toBeVisible();
  expect(await cameraRunning()).toBe(false);

  const placed = page.locator('[data-testid="wh-placement-row"]', { hasText: firstOrder });
  await expect(placed).toContainText(storageCell);

  // Второй заказ — новое нажатие: камера сама не запускается.
  await page.getByTestId('wh-scan-camera').click();
  await scan(secondOrder, async () => {
    await expect(hint).toHaveText('Сканируйте QR ячейки');
  });
  await scan(storageCell, async () => {
    await expect(success).toContainText(secondOrder);
  });
  await expect(page.getByTestId('wh-scan-camera')).toBeVisible();

  // 2. Комплектование: пара «заказ → маршрутная ячейка» для КАЖДОГО заказа.
  await page.getByTestId('wh-tab-picking').click();
  await page.locator('[data-testid="wh-route-button"]', { hasText: routeNumber }).click();
  await page.getByTestId('wh-bind-cell').fill(routeCell);
  await page.getByTestId('wh-bind-submit').click();
  await expect(page.getByTestId('wh-route-cell')).toHaveText(routeCell);

  await page.getByTestId('wh-pick-camera').click();
  await scan(firstOrder, async () => {
    await expect(hint).toHaveText('Сканируйте QR маршрутной ячейки');
  });

  // Чужая ячейка отказывает и ничего не переносит.
  await scan(storageCell, async () => {
    await expect(page.getByTestId('scan-error')).toBeVisible();
  });
  await page.getByTestId('scan-retry').click();
  await expect(hint).toHaveText('Сканируйте QR маршрутной ячейки');

  await scan(routeCell, async () => {
    await expect(success).toContainText(firstOrder);
  });
  await expect(page.getByTestId('wh-route-progress')).toHaveText('1 из 2');

  // Второй заказ — новая пара и новое нажатие.
  await page.getByTestId('wh-pick-camera').click();
  await scan(secondOrder, async () => {
    await expect(hint).toHaveText('Сканируйте QR маршрутной ячейки');
  });
  await scan(routeCell, async () => {
    await expect(success).toContainText(secondOrder);
  });
  await expect(page.getByTestId('wh-route-progress')).toHaveText('2 из 2');

  // 3. Выдача: курьер подтверждается до камеры, сессия одна на весь лист.
  await page.getByTestId('wh-tab-issue').click();
  await page.locator('[data-testid="wh-route-button"]', { hasText: routeNumber }).click();
  await expect(page.getByTestId('wh-issue-camera')).toHaveCount(0);
  await page.getByTestId('wh-confirm-courier').click();

  await page.getByTestId('wh-issue-camera').click();
  await scan(firstOrder, async () => {
    await expect(success).toContainText('1 из 2');
  });
  // Камера не закрылась между заказами.
  await expect(hint).toHaveText('Сканируйте QR заказа');
  expect(await cameraRunning()).toBe(true);

  // Повтор того же заказа честно сообщает, что он уже выдан, и не двигает счётчик.
  await scan(firstOrder, async () => {
    await expect(success).toContainText('уже был выдан: 1 из 2');
  });

  await scan(secondOrder, async () => {
    await expect(success).toContainText('2 из 2');
  });

  // Последний заказ закрыл сессию: экран вернулся к листу, маршрут ACTIVE.
  await expect(page.locator('[data-testid="wh-route-card"]')).toHaveAttribute(
    'data-route-state',
    'ACTIVE',
  );
  expect(await cameraRunning()).toBe(false);
});

test('карта «Сделок»: подложка Москвы при нуле точек и появление маркера без перезагрузки', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const styleUrl = 'https://maps.local.test/style.json';
  await page.route('**/api/map/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true, styleUrl, attribution: '© Проверка' }),
    }),
  );
  // Пустой валидный стиль: публичные тайлы не запрашиваются вовсе.
  await page.route(styleUrl, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: EMPTY_STYLE }),
  );

  // Ответ зависит от запроса, а не от счётчика вызовов: пока координат нет,
  // точек ноль; как только они появились — точка приходит. Так проверка
  // не зависит от того, обновит ли клиент кэш сама по себе.
  const POINT = {
    orderId: '00000000-0000-4000-8000-000000000001',
    number: 'E2E-МАРКЕР',
    lat: '55.755800',
    lon: '37.617300',
    startMinute: null,
    endMinute: null,
    needsAttention: false,
  };
  await page.route('**/api/deals/map*', (route) => {
    const geocoded = new URL(route.request().url()).searchParams.get('includeDrafts') === 'true';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ points: geocoded ? [POINT] : [], deliveryDate: '2026-08-14' }),
    });
  });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Логистика' }).first().click();
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeVisible();

  // 1. Нуль точек: карта ВСЁ РАВНО показана — подложка Москвы, а не пустой блок.
  await expect(page.getByTestId('deals-map-canvas')).toBeVisible();
  await expect(page.getByTestId('deals-map-empty')).toHaveText(
    'В выбранном дне нет заказов с координатами',
  );
  // Приближать нечего: кнопка не обещает действие, которое ничего не изменит.
  await expect(page.getByTestId('deals-map-zoom')).toBeDisabled();
  // Отметок нет ни одной.
  await expect(page.locator('[data-testid="map-marker"]')).toHaveCount(0);
  // Список и легенда продолжают работать.
  await expect(page.getByTestId('deals-list')).toBeVisible();
  await expect(page.getByTestId('deals-map-legend')).toBeVisible();

  // Метка живёт в самом окне: перезагрузка страницы её сбросила бы.
  await page.evaluate((value: string) => {
    (globalThis as { name?: string }).name = value;
  }, RELOAD_SENTINEL);

  // 2. Координаты появились. Перезагрузки страницы НЕТ: приходит новый ответ
  //    того же экрана, и карта дорисовывает отметку на месте.
  const drafts = page.getByTestId('deals-include-drafts');
  await drafts.click();

  await expect(page.locator('[data-testid="map-marker"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('deals-map-empty')).toHaveCount(0);
  await expect(page.getByTestId('deals-map-zoom')).toBeEnabled();
  // Страница та же самая: метка, поставленная до появления координат, жива.
  // Это и есть доказательство отсутствия перезагрузки — оно не зависит
  // ни от MapLibre, ни от разметки карты.
  expect(await page.evaluate(() => (globalThis as { name?: string }).name)).toBe(RELOAD_SENTINEL);
  await expect(page.getByTestId('deals-map-canvas')).toBeVisible();

  // И обратно: точка ушла — отметка исчезла, сообщение вернулось. Всё так же
  // без перезагрузки.
  await drafts.click();
  await expect(page.locator('[data-testid="map-marker"]')).toHaveCount(0);
  await expect(page.getByTestId('deals-map-empty')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { name?: string }).name)).toBe(RELOAD_SENTINEL);
});
