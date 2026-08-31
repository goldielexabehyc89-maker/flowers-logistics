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
import { readFile } from 'node:fs/promises';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

/** Точки на миллиметр: единица PDF — 1/72 дюйма. */
const MM = 72 / 25.4;

/**
 * Скачанный файл — настоящая термоэтикетка 58×40 мм.
 *
 * Размер страницы проверяется по самому файлу, а не по имени и не по ответу
 * сервера: наклейка, уехавшая на принтер листом A4, не наклеится ни на что,
 * и обнаружится это у кладовщика с рулоном в руках.
 *
 * Содержимое QR здесь не разбирается — это делают направленные проверки
 * печати, где картинка декодируется из настоящего файла. Браузерный сценарий
 * отвечает за другое: что кнопка отдаёт именно этот документ.
 */
/**
 * Документ этикеток: одна наклейка 58×40 мм на страницу.
 *
 * Размер проверяется по самому файлу, а не по имени: пакет, уехавший на
 * принтер листами A4, не наклеится ни на что.
 */
async function expectLabelSheet(download: Download, pages: number): Promise<void> {
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(pages);

  for (let index = 0; index < pages; index += 1) {
    const size = pdf.getPage(index).getSize();
    expect(size.width / MM).toBeCloseTo(58, 2);
    expect(size.height / MM).toBeCloseTo(40, 2);
  }
}

async function expectThermalLabel(download: Download, orderNumber: string): Promise<void> {
  const path = await download.path();
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount(), `этикетка ${orderNumber}`).toBe(1);

  const size = pdf.getPage(0).getSize();
  expect(size.width / MM).toBeCloseTo(58, 2);
  expect(size.height / MM).toBeCloseTo(40, 2);
}

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

/** Складская фикстура: маршрут с курьером и заказами, подтверждённый лист. */
function seedWarehouseRoute(): {
  route: string;
  courierPhone: string;
  courierPin: string;
  orders: string[];
} {
  const output = execFileSync('npm', ['run', '--silent', 'seed:e2e-warehouse'], {
    encoding: 'utf8',
  });
  const value = (label: string): string =>
    output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  const orders = [...output.matchAll(/^заказ:\s*(.+)$/gm)].map((match) => match[1]?.trim() ?? '');

  const route = value('маршрут');
  if (route === '' || orders.length === 0) {
    throw new Error('сеялка склада не вернула маршрут и заказы');
  }
  return {
    route,
    courierPhone: value('курьер'),
    courierPin: value('пин курьера'),
    orders,
  };
}

/**
 * Полный складской стенд: все состояния рабочего места сразу.
 *
 * Сценарии выдачи проверяют соседство — лист без ячейки рядом с собранным,
 * два листа одного курьера, лист без курьера, — и делить такой набор с
 * соседним сценарием нельзя: он менял бы состояние под ногами.
 */
function seedWarehouseStand(): Record<string, string> {
  const output = execFileSync('npm', ['run', '--silent', 'seed:e2e-warehouse-stand'], {
    encoding: 'utf8',
  });
  const values: Record<string, string> = {};
  for (const match of output.matchAll(/^([^:\n]+):\s*(.+)$/gm)) {
    const key = (match[1] ?? '').trim();
    if (key !== 'описание') {
      values[key] = (match[2] ?? '').trim();
    }
  }
  if (values['мл собран'] === undefined) {
    throw new Error('сеялка складского стенда не вернула номера листов');
  }
  return values;
}

/**
 * Разворачивает курьера, у которого лежит нужный лист.
 *
 * Свёрнутая карточка курьера номера листа не содержит — в этом и смысл
 * трёх уровней. Поэтому курьер ищется перебором, а не по тексту: выбирать
 * «первого попавшегося» значило бы зависеть от порядка сеялок.
 */
async function openIssueRoute(
  page: Page,
  routeNumber: string,
  courierPhone?: string,
): Promise<Locator> {
  const route = page.locator(`[data-testid="issue-route"][data-route-number="${routeNumber}"]`);
  if ((await route.count()) > 0) {
    return route;
  }

  /*
   * Курьер известен — открываем сразу его карточку.
   *
   * Перебор всех курьеров работает, но растёт вместе с базой: в полном
   * прогоне их накапливаются десятки, и сценарий упирается в собственный
   * предел времени вместо того, чтобы что-то доказать.
   *
   * Ищем по телефону, а не по имени: у стенда своё имя на каждый прогон
   * не выдумывается, и одноимённых курьеров к концу набора становится
   * восемь.
   */
  if (courierPhone !== undefined) {
    await page
      .locator('[data-testid="issue-courier"]', { hasText: courierPhone })
      .getByTestId('issue-courier-toggle')
      .click();
    await route.first().waitFor({ state: 'visible' });
    return route;
  }

  const toggles = page.getByTestId('issue-courier-toggle');
  // Доска грузится запросом: без ожидания перебор шёл бы по пустому списку.
  await expect(toggles.first()).toBeVisible();

  const total = await toggles.count();
  for (let index = 0; index < total; index += 1) {
    await toggles.nth(index).click();
    try {
      await route.first().waitFor({ state: 'visible', timeout: 1000 });
      return route;
    } catch {
      // Не этот курьер: пробуем следующего.
    }
  }
  throw new Error(`лист ${routeNumber} не найден ни у одного курьера в разделе «Выдача»`);
}

/**
 * Разрешает ручной ввод номеров, не трогая браузерный сеанс.
 *
 * Сценарии выдачи не должны зависеть от того, включил ли настройку сосед:
 * общий переключатель — как раз то состояние, которое соседний сценарий
 * меняет под ногами.
 */
async function enableManualEntry(request: APIRequestContext): Promise<void> {
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };

  const settings = await request.get('/api/settings/planning', { headers });
  const current = (
    (await settings.json()) as {
      warehouseManualEntry: { value: { enabled: boolean }; version: number };
    }
  ).warehouseManualEntry;
  if (current.value.enabled) {
    return;
  }

  const saved = await request.put('/api/settings/warehouse/manual-entry', {
    headers,
    data: { value: { enabled: true }, expectedVersion: current.version },
  });
  expect(saved.status()).toBe(200);
}

/** Московский день: тот же, что показывает интерфейс. */
function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
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
  /*
   * Вход считается завершённым, когда экран входа сменился.
   *
   * Токен живёт в памяти вкладки, а сеанс между полными переходами держит
   * cookie обновления — она ставится ответом на вход. Без ожидания следующая
   * же `page.goto` успевала уйти раньше ответа, и сценарий заново получал
   * форму входа: отказ выглядел как «раздел не отрисовался».
   */
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

/**
 * Переход в раздел верхнего уровня.
 *
 * Разделы живут в боковом меню, а оно с некоторых пор выезжает поверх экрана и
 * закрыто по умолчанию: постоянная колонка отнимала у работы ширину. Ссылка
 * при этом никуда не делась — изменился путь к ней, и он разный на разных
 * ширинах: на телефоне разделы дублирует нижняя полоса, там меню открывать
 * незачем. Помощник идёт тем путём, который на этом экране есть.
 */
async function openSection(page: Page, name: string): Promise<void> {
  const direct = page.getByRole('link', { name, exact: true }).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  // Оболочка обязана быть отрисована: сразу после входа кнопок ещё нет,
  // и «не видно» означало бы «не успело», а не «этого пути здесь нет».
  await page.locator('.shell__topbar').waitFor({ state: 'visible', timeout: 15_000 });
  // Кнопок вызова две и они взаимоисключающие: на широком экране — та, что
  // выезжает панель, на телефоне — бургер. Берётся видимая.
  const wide = page.locator('.shell__menu-button');
  const button = (await wide.isVisible().catch(() => false))
    ? wide
    : page.locator('.shell__drawer-button');
  const sidebar = page.locator('#shell-sidebar');
  if (!(await sidebar.isVisible().catch(() => false))) {
    await button.click();
  }
  const link = sidebar.getByRole('link', { name, exact: true }).first();
  await link.waitFor({ state: 'visible', timeout: 15_000 });
  await link.click();
}

async function logout(page: Page): Promise<void> {
  /*
   * Учётная запись живёт в двух местах, и это не дублирование.
   *
   * На обычных экранах имя стоит кнопкой в верхней строке. В логистике верхняя
   * строка занята вкладками раздела, и имя уехало вниз бокового меню, чтобы не
   * отнимать у них ширину. Выход при этом никуда не делся — изменился путь
   * к нему, поэтому помощник идёт тем путём, который на этом экране есть.
   */
  const topbarAccount = page.locator('.shell__topbar-account');
  if (await topbarAccount.isVisible()) {
    await topbarAccount.click();
  } else {
    await page.locator('.shell__menu-button').click();
    await page.locator('#shell-sidebar .shell__account-name').click();
  }
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

/**
 * Курьер, которым сценарий может пользоваться сразу.
 *
 * Раньше два сценария брали курьера у соседа и молча пропускались, если тот
 * ещё не отработал. Пропущенная проверка ничего не доказывает и при этом
 * выглядит в отчёте как успех, поэтому зависимости больше нет: сценарий,
 * которому нужен курьер, создаёт его сам.
 *
 * Созданный курьер запоминается на прогон: заводить нового на каждый сценарий
 * незачем, а один и тот же телефон переиспользуется без побочных эффектов.
 */
async function ensureCourier(browser: Browser): Promise<string> {
  if (courierPhone !== '') {
    return courierPhone;
  }

  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin, ADMIN_PHONE, ADMIN_PIN);

  const phone = uniquePhone();
  await openSection(admin, 'Сотрудники и курьеры');
  await admin.getByRole('button', { name: 'Добавить' }).click();
  await admin.getByLabel('ФИО').fill('Курьер проверки');
  await admin.getByLabel('Телефон').fill(phone);
  await admin.getByRole('button', { name: 'Создать' }).click();

  // Код показывается один раз. В отчёт он не печатается.
  const code = (await admin.locator('.one-time-code').innerText()).trim();
  expect(code).toMatch(/^\d{4}$/);
  await admin.getByRole('button', { name: 'Я сохранил код' }).click();

  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await activate(courierPage, phone, code, COURIER_PIN);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  await courierContext.close();
  await context.close();

  courierPhone = phone;
  return phone;
}

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

  /*
   * 1. Первый вход администратора по одноразовому коду.
   *
   * Заголовок логистического раздела проверяется на НАЛИЧИЕ, а не на показ.
   * В «Логистике» верхняя строка — это сама навигация раздела, и заголовок
   * первого уровня оставлен только для чтения с экрана. Требовать его
   * видимости значило бы закреплять оформление, от которого экран отказался;
   * доказывать он должен другое — что после входа мы оказались в «Сделках»
   * и у страницы есть заголовок первого уровня с нужным именем.
   */
  await activate(page, ADMIN_PHONE, ADMIN_CODE, ADMIN_PIN);
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeAttached();

  // 2. Обычный выход и вход по PIN.
  await logout(page);
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeAttached();

  // 3. Административная навигация: настройки доступны.
  await openSection(page, 'Настройки');
  await expect(page.getByRole('heading', { name: 'Состояние интеграций' })).toBeVisible();

  // 4. Создание курьера.
  courierPhone = uniquePhone();
  await openSection(page, 'Сотрудники и курьеры');
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
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Собственная фикстура: сценарий не зависит от того, отработал ли сосед.
  const phone = await ensureCourier(browser);

  // Узкий экран телефона: у курьера рабочий инструмент — именно он.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await context.newPage();

  await login(mobilePage, phone, COURIER_PIN);
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
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const phone = await ensureCourier(browser);

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // Открытый курьерский сеанс: перезагрузку страницы делать нельзя,
  // проверяется именно самостоятельный уход на экран входа.
  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await login(courierPage, phone, COURIER_PIN);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  // Второй сеанс администратора: он должен узнать об изменении сам.
  const secondAdminContext = await browser.newContext();
  const secondAdminPage = await secondAdminContext.newPage();
  await login(secondAdminPage, ADMIN_PHONE, ADMIN_PIN);
  await openSection(secondAdminPage, 'Сотрудники и курьеры');
  await secondAdminPage.getByLabel('Статус').selectOption('FROZEN');

  // Заморозка курьера в первом сеансе.
  await openSection(page, 'Сотрудники и курьеры');
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

test('администратор задаёт и меняет PIN сотрудника из карточки', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin, ADMIN_PHONE, ADMIN_PIN);

  // Заводим нового сотрудника (PENDING). Временный код НЕ используем: PIN
  // задаст сам администратор — в этом и суть проверки.
  const phone = uniquePhone();
  const name = `Сотрудник PIN ${phone.slice(-4)}`;
  await openSection(admin, 'Сотрудники и курьеры');
  await admin.getByRole('button', { name: 'Добавить' }).click();
  await admin.getByLabel('ФИО').fill(name);
  await admin.getByLabel('Телефон').fill(phone);
  await admin.getByRole('button', { name: 'Создать' }).click();
  await admin.getByRole('button', { name: 'Я сохранил код' }).click();

  // Находим сотрудника в списке ожидающих активации.
  await admin.getByLabel('Статус').selectOption('PENDING_ACTIVATION');
  const pendingRow = admin.getByRole('row', { name: new RegExp(name) });
  await expect(pendingRow).toBeVisible({ timeout: 30_000 });

  // Новый элемент интерфейса: «Задать PIN» (PIN ещё не задан).
  await pendingRow.getByTestId('user-more').click();
  await admin.getByRole('menuitem', { name: 'Задать PIN' }).click();
  await expect(admin.getByTestId('set-pin-modal')).toBeVisible();

  // Несовпадающие значения сервер не увидит вовсе — их отклоняет само окно.
  await admin.getByTestId('set-pin-new').fill('4416');
  await admin.getByTestId('set-pin-repeat').fill('4417');
  await admin.getByTestId('set-pin-submit').click();
  await expect(admin.getByTestId('set-pin-error')).toBeVisible();

  // Совпадающие — сохраняются, окно закрывается, PIN нигде не показан.
  await admin.getByTestId('set-pin-repeat').fill('4416');
  await admin.getByTestId('set-pin-submit').click();
  await expect(admin.getByTestId('set-pin-modal')).not.toBeVisible();

  // Сотрудник стал ACTIVE и входит НОВЫМ PIN сразу.
  const employeeContext = await browser.newContext();
  const employee = await employeeContext.newPage();
  await login(employee, phone, '4416');
  await expect(employee.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  // Администратор меняет PIN действующему сотруднику при открытом его сеансе.
  await admin.getByLabel('Статус').selectOption('ACTIVE');
  const activeRow = admin.getByRole('row', { name: new RegExp(name) });
  await expect(activeRow).toBeVisible({ timeout: 30_000 });
  await activeRow.getByTestId('user-more').click();
  await admin.getByRole('menuitem', { name: 'Изменить PIN' }).click();
  await admin.getByTestId('set-pin-new').fill('2222');
  await admin.getByTestId('set-pin-repeat').fill('2222');
  await admin.getByTestId('set-pin-submit').click();
  await expect(admin.getByTestId('set-pin-modal')).not.toBeVisible();

  // Открытый экран сотрудника завершает сессию сам, каналом realtime: reload()
  // здесь намеренно нет — проверяется именно session-closed.
  await expect(employee).toHaveURL(/\/login$/, { timeout: 30_000 });

  // Новый PIN действует сразу.
  await login(employee, phone, '2222');
  await expect(employee.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  await employeeContext.close();
  await context.close();
});

test('Сделки: адрес не обновляет экран на каждую букву — только по Enter или кнопке', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  await expect(page.getByTestId('deals-list')).toBeVisible();

  // Считаем ТОЛЬКО запросы списка сделок: `/api/deals?…` (не /map и не /selectable).
  let listRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/deals?')) {
      listRequests += 1;
    }
  });

  // Набор нескольких букв: черновик меняется, запросов нет.
  const field = page.getByTestId('deals-search');
  await field.click();
  await page.waitForTimeout(400);
  const baseline = listRequests;
  for (const letter of ['м', 'о', 'с', 'к', 'в', 'а']) {
    await page.keyboard.type(letter);
  }
  // Если бы буквы дергали сеть, за это время запрос бы успел уйти.
  await page.waitForTimeout(700);
  expect(listRequests).toBe(baseline);
  await expect(field).toHaveValue('москва');

  // Применение по Enter — ровно один запрос списка с окончательной строкой.
  const beforeEnter = listRequests;
  await field.press('Enter');
  await expect.poll(() => listRequests).toBe(beforeEnter + 1);

  // Кнопка «Найти» применяет так же. Значение меняем на ДРУГОЕ: повтор той же
  // строки запроса не создаёт — тот же отбор уже загружен, и это правильно.
  await field.fill('садовая');
  await page.waitForTimeout(300);
  const beforeButton = listRequests;
  await page.getByTestId('deals-search-apply').click();
  await expect.poll(() => listRequests).toBe(beforeButton + 1);

  // «Сбросить» одним действием очищает и черновик, и применённое значение:
  // поле пустеет, а лишних запросов на буквы, как и раньше, нет. Сетевого
  // счётчика здесь не проверяем: пустой отбор уже в кэше react-query, и
  // возврат к нему — это правильно НОЛЬ запросов, а не ошибка.
  await page.getByTestId('deals-search-clear').click();
  await expect(field).toHaveValue('');
});

test('Сделки: день, поиск, выбор из списка и ручной черновик', async ({ page }: { page: Page }) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const orderNumber = process.env['E2E_ORDER_NUMBER'] ?? '';
  test.skip(orderNumber === '', 'не передан номер проверочного заказа (E2E_ORDER_NUMBER)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeAttached();

  // Рабочее пространство: список и карта видны одновременно и показывают
  // одно множество — их питает один серверный отбор.
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  await expect(page.getByTestId('deals-list')).toBeVisible();
  await expect(page.getByTestId('deals-map')).toBeVisible();
  // Легенда постоянна: без неё цвет и форма маркера ничего не значат.
  await expect(page.getByTestId('deals-map-legend')).toBeVisible();

  // Поиск действует внутри выбранного дня.
  await page.getByLabel('Поиск в этом дне').fill(orderNumber);
  await page.getByLabel('Поиск в этом дне').press('Enter');
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
  // Кнопка открывает подтверждение состава: до явного выбора ничего не создаётся.
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();
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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();

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
  await openSection(page, 'Логистика');
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
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();
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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();

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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();

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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  for (const number of [first, second]) {
    const deal = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
    await expect(deal).toHaveAttribute('data-selectable', 'yes');
    await deal.getByTestId('deal-pick').click();
  }
  // Кнопка открывает подтверждение состава: до явного выбора ничего не создаётся.
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();

  // Переход ведёт в созданный черновик: он раскрыт, а не потерян в списке.
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Создать черновик' })).toHaveCount(0);

  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  /*
   * Номер берётся из строки списка, которая карточку и раскрыла: собственного
   * заголовка у карточки больше нет — он не повторяется дважды.
   */
  const routeNumber =
    (await page
      .locator('.routes__draft[data-expanded="true"]')
      .getAttribute('data-draft-number')) ?? '';
  expect(routeNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);

  const stops = card.locator('.routes__stop');
  await expect(stops).toHaveCount(2);

  // Раскрыт ровно один черновик.
  await expect(page.locator('.routes__draft[data-expanded="true"]')).toHaveCount(1);

  // Порядок меняется перетаскиванием: стрелок у остановок больше нет.
  await expect(stops.first()).toContainText(first);
  await stops.nth(0).dragTo(stops.nth(1));
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
  // Кнопка открывает подтверждение состава: до явного выбора ничего не создаётся.
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);
  const secondCardNumber =
    (await page
      .locator('.routes__draft[data-expanded="true"]')
      .getAttribute('data-draft-number')) ?? '';
  expect(secondCardNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);

  /*
   * Перенос делается окном заказа на карте.
   *
   * Групповых кнопок в составе больше нет: логист нажимает точку и видит,
   * куда именно уезжает заказ. Операция та же самая — `POST /routes/move`
   * с арендой обоих черновиков.
   */
  await openDraft(page, routeNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);
  /*
   * Нажатие отправляется САМОЙ отметке, а не в точку экрана.
   *
   * Сеялка ставит проверочным заказам один и тот же адрес, и отметки лежат
   * ровно друг на друге: обычное нажатие досталось бы верхней, и сценарий
   * молча двигал бы не тот заказ. У настоящих заказов адреса разные.
   */
  await page.getByRole('button', { name: `Заказ ${first} на карте` }).dispatchEvent('click');
  const window = page.getByTestId('map-selection');
  await expect(window).toBeVisible();
  await clickAndAwait(
    page,
    window.getByRole('button', { name: secondCardNumber }),
    'POST',
    '/routes/move',
  );
  // Заказ ушёл: перенос выполнен, а не отклонён блокировкой.
  await expect(card.locator('.routes__stop')).toHaveCount(1);

  /*
   * Возврат и назначение — тем же окном.
   *
   * Крестик в окне снимает заказ с маршрута, а нераспределённая точка
   * назначается в нужный черновик. Обе операции — существующие серверные.
   */
  await openDraft(page, secondCardNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);
  await page.getByRole('button', { name: `Заказ ${first} на карте` }).dispatchEvent('click');
  await clickAndAwait(page, window.getByTestId('map-order-remove'), 'POST', '/orders/return');
  await expect(card.locator('.routes__stop')).toHaveCount(1);

  await openDraft(page, routeNumber);
  await page.getByTestId('map-unassigned-toggle').check();
  await page.getByRole('button', { name: `Заказ ${first} на карте` }).click({ force: true });
  await clickAndAwait(page, window.getByRole('button', { name: routeNumber }), 'POST', '/orders');

  await openDraft(page, routeNumber);
  await expect(card.locator('.routes__stop')).toHaveCount(2);

  // Подтверждение с назначением курьера в том же окне.
  // Черновик становится маршрутным листом тем же доменным переходом; кнопка
  // называет результат, а не техническое состояние.
  await card.getByRole('button', { name: 'Создать МЛ' }).click();
  await page.getByTestId('route-confirm-submit').click();

  // Подтверждённый черновик исчезает из «Маршрутизации».
  await expect(page.locator(`.routes__draft[data-draft-number="${routeNumber}"]`)).toHaveCount(0);

  // Тот же маршрут появляется в маршрутных листах.
  // Вкладки принадлежат разделу «Логистика»: сначала он, потом вкладка.
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутные листы', level: 1 })).toBeAttached();
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

  // Собственный черновик сценария: чужой мог быть подтверждён соседом,
  // и перехватывать было бы нечего.
  const own = seedOrders(1, { withPoint: true })[0] ?? '';
  expect(own).not.toBe('');

  // Первый сеанс создаёт черновик и держит его в работе.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  const ownDeal = page.locator(`[data-testid="deal-card"][data-order-number="${own}"]`);
  await expect(ownDeal).toHaveAttribute('data-selectable', 'yes');
  await ownDeal.getByTestId('deal-pick').click();
  // Кнопка открывает подтверждение состава: до явного выбора ничего не создаётся.
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);

  const card = page.locator('.routes__card');
  await expect(card).toBeVisible();
  // Номер берётся из строки списка: собственного заголовка у карточки нет.
  const routeNumber =
    (await page
      .locator('.routes__draft[data-expanded="true"]')
      .getAttribute('data-draft-number')) ?? '';
  expect(routeNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);
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

  /*
   * Собственный маршрутный лист.
   *
   * Раньше сценарий брал первый попавшийся лист соседнего сценария и молча
   * пропускался, когда его не было. Пропущенная проверка ничего не доказывает,
   * поэтому лист создаётся здесь же — тем самым путём, которым его создаёт
   * логист: выбор в «Сделках» → диалог → «Создать МЛ».
   */
  const [own] = seedOrders(1, { withPoint: true });
  expect(own).toBeTruthy();

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByLabel('Поиск в этом дне').fill(own ?? '');
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const ownCard = page.locator(`[data-testid="deal-card"][data-order-number="${own}"]`);
  await expect(ownCard).toBeVisible();
  await ownCard.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  /*
   * Ответ сервера дожидается явно.
   *
   * Без этого отказ создания превращался в загадочное «листа нет» на шаг
   * позже, и причина оставалась в логе сервера, а не в отчёте проверки.
   */
  const [sheetResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/from-selection') && response.request().method() === 'POST',
    ),
    page.getByTestId('create-route-sheet').click(),
  ]);
  expect(sheetResponse.status(), await sheetResponse.text()).toBe(201);

  // «Создать МЛ» приводит прямо в «Маршрутные листы».
  await expect(page).toHaveURL(/\/logistics\/route-sheets/);
  /*
   * Ждём именно список, а не «список или любое состояние».
   *
   * Экран открывается на сегодняшнем дне и сначала показывает состояние
   * загрузки: прежнее ожидание засчитывало его за результат и считало листы
   * раньше, чем они отрисовывались.
   */
  await expect(page.locator('.routes__list-item').first()).toBeVisible({ timeout: 15000 });
  const sheets = page.locator('.routes__list-item', { hasText: own ?? '' });
  const anySheet = (await sheets.count()) > 0 ? sheets : page.locator('.routes__list-item');
  if ((await anySheet.count()) === 0) {
    throw new Error(
      'маршрутный лист не создан: печатную форму проверять не на чем. ' +
        'Лист создаётся выбором в «Сделках» и кнопкой «Создать МЛ».',
    );
  }
  await anySheet.first().getByRole('button', { name: 'Открыть лист' }).click();

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
  await openSection(page, 'Настройки');
  const settings = page.getByTestId('planning-settings');
  await expect(settings).toBeVisible();

  // Склад уже есть — он создан фикстурой и стал складом по умолчанию.
  // Отметка ищется точным текстом: кнопка «Сделать складом по умолчанию»
  // содержит те же слова, и по вхождению нашлись бы обе.
  const defaultBadge = settings.getByText('по умолчанию', { exact: true });
  await expect(defaultBadge).toHaveCount(1);

  /*
   * Второй склад создаётся формой через ПОДСКАЗКИ адреса и складом
   * по умолчанию НЕ становится.
   *
   * Полей широты и долготы в форме нет: координаты приходят вместе с выбранной
   * подсказкой. Провайдер подменён внутри приложения — браузер обращается
   * только к нашему API, ключа DaData он не знает.
   */
  const before = await settings.getByTestId('depot-item').count();
  await settings.getByTestId('depot-name').fill('Запасной склад');

  // Напечатанный, но не выбранный адрес сохранить нельзя.
  await settings.getByTestId('depot-address').fill('Москва, ул Цветочная');
  await expect(settings.getByTestId('depot-save')).toBeDisabled();

  const suggestions = settings.getByTestId('depot-suggestions');
  await expect(suggestions).toBeVisible();

  /*
   * Улица без дома текст заполняет, а точку — нет.
   *
   * Погашенная строка внутри списка вела бы себя как ловушка: клавиатура
   * на неё встаёт, а нажатие ничего не делает. Поэтому выбирается любая
   * подсказка, но складом становится только та, у которой есть дом
   * и координаты, — сохранение остаётся закрытым.
   */
  const street = suggestions.getByRole('option', { name: /без точной привязки/ });
  await street.click();
  await expect(settings.getByTestId('depot-point')).toHaveCount(0);
  await expect(settings.getByTestId('depot-save')).toBeDisabled();

  // Возвращаемся к подбору и берём дом с точкой: координаты появляются сами.
  await settings.getByTestId('depot-address').fill('Москва, ул Цветочная');
  await expect(suggestions).toBeVisible();
  await suggestions.getByRole('option', { name: /точка найдена/ }).click();
  await expect(settings.getByTestId('depot-point')).toContainText('55.751244');
  await expect(settings.getByTestId('depot-save')).toBeEnabled();

  // Правка текста после выбора немедленно сбрасывает точку.
  await settings.getByTestId('depot-address').fill('Москва, ул Цветочная, д 1, подъезд 2');
  await expect(settings.getByTestId('depot-point')).toHaveCount(0);
  await expect(settings.getByTestId('depot-save')).toBeDisabled();

  // Повторный выбор возвращает точку — это же путь исправления старой записи.
  await suggestions.getByRole('option', { name: /точка найдена/ }).click();
  await expect(settings.getByTestId('depot-save')).toBeEnabled();

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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  /*
   * Считать черновики можно только после загрузки списка.
   *
   * Прежнее ожидание принимало и состояние «Загружаем черновики…»: список
   * ещё пуст, счёт получался нулевым, и дальше проверка сравнивала его
   * с настоящим числом. Пока у дня не бывало черновиков, ошибка не
   * проявлялась.
   */
  await expect(page.getByText('Загружаем черновики…')).toHaveCount(0);
  await page.waitForSelector('.routes__draft, .state', { state: 'visible' });

  /*
   * Число читается ДВА раза подряд и принимается, только когда совпало.
   *
   * Список черновиков подтягивается запросом, и однократный счёт мог
   * попасть в промежуток между «загрузка кончилась» и «данные пришли»:
   * дальше проверка сравнивала ноль с настоящим числом и падала
   * не там, где ошибка.
   */
  const draftsLocator = page.getByTestId('routing-drafts').locator('.routes__draft');
  let draftsBefore = await draftsLocator.count();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const again = await draftsLocator.count();
    if (again === draftsBefore) {
      break;
    }
    draftsBefore = again;
  }

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

  // 4. Ожидание идёт в «Сделках», а переход ведёт в ВИДИМОЕ предложение:
  //    черновиков ещё нет и не будет до явного «Применить».
  await expect(page).toHaveURL(/\/logistics\/routing\?.*run=/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Предложенный расчёт' })).toBeVisible();

  const drafts = page.getByTestId('routing-drafts').locator('.routes__draft');
  await expect(drafts).toHaveCount(draftsBefore);

  // 5. Предложение проверяемо: два маршрута, номера заказов, порядок остановок,
  //    время и расстояние — а не обрезанные идентификаторы.
  const previewRoutes = page.locator('[data-preview-route]');
  await expect(previewRoutes).toHaveCount(2);
  for (const number of chosen) {
    await expect(page.locator('.routes__preview')).toContainText(number);
  }
  await expect(previewRoutes.first()).toContainText('В пути');
  await expect(previewRoutes.first().locator('.routes__position').first()).toHaveText('1');

  // 6. «Отклонить» не создаёт ни одного черновика.
  await page.getByTestId('preview-dismiss').click();
  await expect(page.getByRole('heading', { name: 'Предложенный расчёт' })).toHaveCount(0);
  await expect(drafts).toHaveCount(draftsBefore);

  // 7. Повторный расчёт того же выбора и применение: черновики появляются
  //    только теперь.
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  for (const number of chosen) {
    await page
      .locator(`[data-testid="deal-card"][data-order-number="${number}"]`)
      .getByTestId('deal-pick')
      .click();
  }
  await page.getByTestId('deals-auto-plan').click();
  await page.getByTestId('split-vehicles').fill('2');
  await page.getByTestId('split-capacity').fill('1');
  await page.getByTestId('split-submit').click();

  await expect(page).toHaveURL(/\/logistics\/routing\?.*run=/, { timeout: 60_000 });
  await expect(page.getByTestId('preview-apply')).toBeEnabled();
  await page.getByTestId('preview-apply').click();

  await expect(page.getByTestId('routing-drafts').locator('.routes__draft')).toHaveCount(
    draftsBefore + 2,
  );
  await expect(page.locator('.routes__draft[data-expanded="true"]')).toHaveCount(1);

  // 6. Посторонний заказ дня в расчёт не попал и остался доступным в «Сделках».
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(
    page.locator(`[data-testid="deal-card"][data-order-number="${foreignNumber}"]`),
  ).toHaveAttribute('data-selectable', 'yes');

  // 7. Третья обязательная форма: время обслуживания. Меняется после
  //    применения, поэтому условия уже применённого плана не задевает.
  await openSection(page, 'Настройки');
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
  await openSection(page, 'Сотрудники и курьеры');
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

  // 8.0. Термоэтикетка: отдельный файл рядом с бланком.
  //
  //      К букету едут оба документа: бумага для человека и наклейка на
  //      коробку. Проверяется не «кнопка есть», а размер страницы: этикетка,
  //      уехавшая на принтер листом A4, не наклеится ни на что.
  const [labelDownload] = await Promise.all([
    floristPage.waitForEvent('download'),
    card.getByTestId('card-label').click(),
  ]);
  expect(labelDownload.suggestedFilename()).toBe(`label-${orderNumber}.pdf`);
  await expectThermalLabel(labelDownload, orderNumber);

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

  // 10. Этикетка доступна и из очереди печати — для КОНКРЕТНОЙ попытки.
  const printedRow = floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber });
  const [jobLabel] = await Promise.all([
    floristPage.waitForEvent('download'),
    printedRow.getByTestId('print-label').click(),
  ]);
  expect(jobLabel.suggestedFilename()).toBe(`label-${orderNumber}.pdf`);
  await expectThermalLabel(jobLabel, orderNumber);

  /*
   * 11. Повторная печать не стирает прошлую попытку.
   *
   *     Печать — физическое действие: бумага уже вышла из принтера, и запись
   *     о ней обязана остаться, даже если человек печатает второй раз. Иначе
   *     на вопрос «печатали ли этот заказ» ответа не будет.
   */
  await printedRow.getByRole('button', { name: 'Повторить печать' }).click();
  await floristPage.getByTestId('print-filter-attention').click();
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toContainText('попытка 2');

  await floristPage.getByTestId('print-filter-printed').click();
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toContainText('попытка 1');

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
  /*
   * Тот же принцип, что и с курьером: пропуск ничего не доказывает.
   * Флориста заводит сценарий сборки — если его нет, это отказ с понятным
   * текстом, а не тихо зелёная проверка.
   */
  if (floristPhoneForMobile === '') {
    throw new Error(
      'флорист не создан: мобильную карточку проверять некому. ' +
        'Флориста заводит сценарий «флорист: смена, захват, сборка, бланк и отметка печати».',
    );
  }

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
  request,
  browser,
}: {
  page: Page;
  request: APIRequestContext;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);

  const WAREHOUSE_PIN = '9753';
  const code = `E2E-${Date.now() % 100_000}`;

  // 1. Администратор заводит ячейку в настройках.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Настройки');

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
  await openSection(page, 'Сотрудники и курьеры');
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

  // У кладовщика рабочий экран со всеми вкладками, а не заглушка. «Ожидают
  // приёмки» стоит рядом с остальными: собранные заказы без ячейки.
  for (const tab of ['storage', 'awaiting', 'picking', 'issue', 'returns']) {
    await expect(warehousePage.getByTestId(`wh-tab-${tab}`)).toBeVisible();
  }
  await expect(warehousePage.getByTestId('wh-scan-order')).toBeVisible();

  // Вкладка «Ожидают приёмки» открывается и показывает свой раздел.
  await warehousePage.getByTestId('wh-tab-awaiting').click();
  await expect(warehousePage.getByTestId('wh-awaiting')).toBeVisible();
  await expect(warehousePage.getByTestId('wh-awaiting-search')).toBeVisible();
  await warehousePage.getByTestId('wh-tab-storage').click();

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

/**
 * Партия ячеек: стеллаж заводится сразу, а не по одной полке.
 *
 * Проверяется то, из-за чего ошибка здесь стоит дороже, чем при одиночном
 * создании: ячейку нельзя удалить, только выключить. Поэтому создание закрыто
 * до проверки, проверка отменяется при любой правке ввода, уже существующие
 * коды видны отдельно и не переписываются, а предел партии называется числом,
 * а не молчаливым обрезанием.
 */
test('складские ячейки: партия диапазоном и списком, второй экран без F5', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Настройки');
  const cells = page.locator('section', { hasText: 'Складские ячейки' }).first();
  await expect(cells).toBeVisible();

  // Второй открытый экран того же справочника: он обязан узнать о партии сам.
  const context = await browser.newContext();
  const second = await context.newPage();
  await login(second, ADMIN_PHONE, ADMIN_PIN);
  await openSection(second, 'Настройки');
  const secondCells = second.locator('section', { hasText: 'Складские ячейки' }).first();
  await expect(secondCells).toBeVisible();

  const prefix = `E2EB-${Date.now() % 100_000}-`;

  await cells.getByTestId('cell-bulk-open').click();
  const bulk = cells.getByTestId('cell-bulk');
  await expect(bulk).toBeVisible();

  await bulk.getByTestId('cell-bulk-prefix').fill(prefix);
  await bulk.getByTestId('cell-bulk-from').fill('1');
  await bulk.getByTestId('cell-bulk-to').fill('5');
  await bulk.getByTestId('cell-bulk-pad').fill('3');

  // Края будущей партии видны до отправки: ошибаются именно в них.
  await expect(bulk.getByTestId('cell-bulk-plan')).toContainText(`${prefix}001 … ${prefix}005`);
  // А создать вслепую нельзя.
  await expect(bulk.getByTestId('cell-bulk-submit')).toBeDisabled();

  await bulk.getByTestId('cell-bulk-preview').click();
  await expect(bulk.getByTestId('cell-bulk-will-create')).toContainText('Будет создано 5 ячеек');
  await expect(bulk.getByTestId('cell-bulk-existing')).toContainText('Уже существуют: 0');

  // Правка ввода отменяет проверку: иначе человек создал бы не ту партию,
  // которую видел на экране.
  await bulk.getByTestId('cell-bulk-to').fill('4');
  await expect(bulk.getByTestId('cell-bulk-summary')).toHaveCount(0);
  await expect(bulk.getByTestId('cell-bulk-submit')).toBeDisabled();

  await bulk.getByTestId('cell-bulk-to').fill('5');
  await bulk.getByTestId('cell-bulk-preview').click();
  await expect(bulk.getByTestId('cell-bulk-will-create')).toContainText('Будет создано 5 ячеек');
  await bulk.getByTestId('cell-bulk-submit').click();

  await expect(page.locator('.toast-region')).toContainText('Создано 5 ячеек');
  // Панель закрылась: партия заведена, повторное нажатие ничего не создаст.
  await expect(cells.getByTestId('cell-bulk')).toHaveCount(0);

  /*
   * Наклейки только что созданной партии — сразу, одной кнопкой.
   *
   * Искать эти пять ячеек потом среди сотен строк справочника — работа,
   * которой быть не должно.
   */
  const batch = cells.getByTestId('cell-batch-labels');
  await expect(batch).toBeVisible();
  const [batchLabels] = await Promise.all([
    page.waitForEvent('download'),
    batch.getByTestId('cell-batch-download').click(),
  ]);
  await expectLabelSheet(batchLabels, 5);

  for (const number of ['001', '003', '005']) {
    await expect(
      cells.locator('[data-testid="cell-row"]', { hasText: `${prefix}${number}` }),
    ).toBeVisible();
  }

  // Второй экран обновился сам, без F5.
  await expect(
    secondCells.locator('[data-testid="cell-row"]', { hasText: `${prefix}005` }),
  ).toBeVisible();

  // Тот же диапазон второй раз: всё уже есть, создавать нечего.
  await cells.getByTestId('cell-bulk-open').click();
  await bulk.getByTestId('cell-bulk-prefix').fill(prefix);
  await bulk.getByTestId('cell-bulk-from').fill('1');
  await bulk.getByTestId('cell-bulk-to').fill('5');
  await bulk.getByTestId('cell-bulk-pad').fill('3');
  await bulk.getByTestId('cell-bulk-preview').click();
  await expect(bulk.getByTestId('cell-bulk-will-create')).toContainText('Создавать нечего');
  await expect(bulk.getByTestId('cell-bulk-existing')).toContainText('Уже существуют: 5');
  await expect(bulk.getByTestId('cell-bulk-submit')).toBeDisabled();

  // Вставленный список: повтор внутри ввода и негодная строка названы,
  // а годные коды из-за них не пропадают.
  await bulk.getByTestId('cell-bulk-mode').selectOption('LIST');
  await bulk
    .getByTestId('cell-bulk-list')
    .fill(`${prefix}101, ${prefix}102\n${prefix.toLowerCase()}101\n${'Z'.repeat(60)}`);
  await bulk.getByTestId('cell-bulk-preview').click();
  await expect(bulk.getByTestId('cell-bulk-duplicates')).toContainText('Повторов внутри списка: 1');
  await expect(bulk.getByTestId('cell-bulk-invalid')).toContainText('Негодных строк: 1');
  await expect(bulk.getByTestId('cell-bulk-will-create')).toContainText('Будет создано 2 ячейки');

  await bulk.getByTestId('cell-bulk-submit').click();
  await expect(page.locator('.toast-region')).toContainText('Создано 2 ячейки');
  await expect(
    cells.locator('[data-testid="cell-row"]', { hasText: `${prefix}102` }),
  ).toBeVisible();

  // Предел партии назван числом до отправки, а не обрезан молча.
  await cells.getByTestId('cell-bulk-open').click();
  // Панель открылась пустой: способ ввода и тип не унаследованы от прошлой
  // партии — иначе следующий стеллаж уехал бы не того назначения.
  await expect(bulk.getByTestId('cell-bulk-mode')).toHaveValue('RANGE');
  await expect(bulk.getByTestId('cell-bulk-kind')).toHaveValue('STORAGE');
  await bulk.getByTestId('cell-bulk-prefix').fill(prefix);
  await bulk.getByTestId('cell-bulk-from').fill('1');
  await bulk.getByTestId('cell-bulk-to').fill('501');
  await expect(bulk.getByTestId('cell-bulk-error')).toContainText('не больше 500');
  await expect(bulk.getByTestId('cell-bulk-preview')).toBeDisabled();
  await bulk.getByTestId('cell-bulk-cancel').click();
  await expect(cells.getByTestId('cell-bulk')).toHaveCount(0);

  // Одиночное создание рядом продолжает работать как прежде.
  await cells.getByTestId('cell-code').fill(`${prefix}one`);
  await cells.getByTestId('cell-create').click();
  await expect(
    cells.locator('[data-testid="cell-row"]', { hasText: `${prefix}ONE` }),
  ).toBeVisible();

  /*
   * Наклейки отмеченных ячеек — одним документом.
   *
   * Печатать сотню наклеек по одной человек не станет, а значит,
   * не напечатает вовсе. Проверяется сам файл: размер страницы физический,
   * и страниц ровно столько, сколько отмечено.
   */
  const firstRow = cells.locator('[data-testid="cell-row"]', { hasText: `${prefix}001` });
  const secondRow = cells.locator('[data-testid="cell-row"]', { hasText: `${prefix}002` });
  await firstRow.getByTestId('cell-select').check();
  await secondRow.getByTestId('cell-select').check();

  const selection = cells.getByTestId('cell-selection');
  await expect(selection).toContainText('Отмечено: 2 ячейки');

  const [selectedLabels] = await Promise.all([
    page.waitForEvent('download'),
    selection.getByTestId('cell-selected-download').click(),
  ]);
  await expectLabelSheet(selectedLabels, 2);

  await context.close();
});

/**
 * Печать наклеек: точка, подключение агента и автоматическая наклейка.
 *
 * Windows-агента здесь нет и быть не может — сценарий воспроизводит ровно его
 * протокол обычными запросами. Это и есть предмет проверки: что сервер отдаёт
 * агенту готовое задание и правильно подводит итог. Физическая печать
 * на XP-318B проверяется отдельно, на настоящей машине.
 */
test('печать: точка, подключение агента и автоматическая наклейка при «Собран»', async ({
  page,
  request,
  browser,
}: {
  page: Page;
  request: APIRequestContext;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const orderNumber = seedOrders(1, { withPoint: false })[0] ?? '';
  const pointName = `Стол ${Date.now() % 100_000}`;

  // 1. Администратор заводит точку печати.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Настройки');

  const printing = page.locator('section', { hasText: 'Точка печати — это компьютер' }).first();
  await expect(printing).toBeVisible();
  await printing.getByTestId('print-point-name').fill(pointName);
  await printing.getByTestId('print-point-create').click();

  const row = printing.locator('[data-testid="print-point-row"]', { hasText: pointName });
  await expect(row).toBeVisible();
  // Пока компьютер не подключён, состояние честное: связи нет.
  await expect(row).toContainText('Нет связи');

  // 2. Код подключения показывается ОДИН раз.
  await row.getByTestId('print-point-pair').click();
  const codeBlock = printing.getByTestId('print-point-code');
  await expect(codeBlock).toBeVisible();
  const code = (await codeBlock.locator('.one-time-code').innerText()).trim();
  expect(code).toMatch(/^\d{8}$/);
  await codeBlock.getByRole('button', { name: 'Я записал код' }).click();
  await expect(codeBlock).toHaveCount(0);

  // 3. Агент подключается этим кодом. Дальше он живёт по токену.
  const paired = await request.post('/api/print-agent/pair', {
    data: { code, computerName: 'E2E-PC', printerName: 'XP-318B' },
  });
  expect(paired.status()).toBe(200);
  const agentToken = ((await paired.json()) as { token: string }).token;
  const agentHeaders = { authorization: `Bearer ${agentToken}` };

  // Тот же код второй раз не работает: второй компьютер не подключится
  // к чужому принтеру.
  const again = await request.post('/api/print-agent/pair', {
    data: { code, computerName: 'E2E-PC-2', printerName: 'XP-318B' },
  });
  expect(again.status()).toBeGreaterThanOrEqual(400);

  // 4. Точка стала «Онлайн» — экран узнал об этом сам.
  await expect(row).toContainText('Онлайн');
  await expect(row).toContainText('E2E-PC');

  // 5. Заводим флориста.
  const floristPhone = uniquePhone();
  await openSection(page, 'Сотрудники и курьеры');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByLabel('ФИО').fill('Флорист печати');
  await page.getByLabel('Телефон').fill(floristPhone);
  await page.getByRole('checkbox', { name: 'Флорист' }).check();
  const courierRole = page.getByRole('checkbox', { name: 'Курьер', exact: true });
  if (await courierRole.isChecked()) {
    await courierRole.uncheck();
  }
  await page.getByRole('button', { name: 'Создать' }).click();
  const floristCode = (await page.locator('.one-time-code').innerText()).trim();
  await page.getByRole('button', { name: 'Я сохранил код' }).click();

  const context = await browser.newContext({ acceptDownloads: true });
  const floristPage = await context.newPage();
  await activate(floristPage, floristPhone, floristCode, '7351');
  await expect(floristPage.getByRole('heading', { name: 'Флорист', level: 1 })).toBeVisible();

  await clickAndAwait(
    floristPage,
    floristPage.getByTestId('shift-start'),
    'POST',
    '/api/florist/shift/start',
  );

  // 6. Точка ещё не выбрана, и интерфейс говорит об этом прямо.
  const pointLine = floristPage.getByTestId('florist-print-point');
  await expect(pointLine).toBeVisible();
  await expect(floristPage.getByTestId('florist-print-point-name')).toHaveText('не выбрана');

  // 7. «Собран» спрашивает точку и продолжает работу сам.
  const orderRow = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(orderRow).toBeVisible();

  // Взятый заказ уходит из общей очереди в «Мои заказы»: строка в очереди
  // исчезает, и открывать карточку нужно уже там.
  await clickAndAwait(floristPage, orderRow.getByTestId('row-claim'), 'POST', '/claim');
  await floristPage.getByTestId('florist-tab-mine').click();

  const mineRow = floristPage.locator('.florist__row', { hasText: orderNumber });
  await expect(mineRow).toBeVisible();
  await mineRow.getByTestId('row-open').click();

  const card = floristPage.getByTestId('florist-card');
  await expect(card).toBeVisible();
  await card.getByTestId('card-assemble').click();

  const picker = floristPage.getByTestId('florist-point-picker');
  await expect(picker).toBeVisible();

  /*
   * Выбор точки продолжает работу сам: второго нажатия «Собран» не требуется.
   *
   * Ожидается именно ответ на сборку, а не текст на экране: кнопка подписана
   * тем же словом «Собран», и проверка по тексту прошла бы ещё до запроса.
   */
  await Promise.all([
    floristPage.waitForResponse(
      (response) => response.url().includes('/assemble') && response.request().method() === 'POST',
    ),
    picker.getByTestId('florist-point-choose').first().click(),
  ]);

  await expect(card.getByTestId('card-print-state')).toContainText('Ожидает печати');
  await expect(floristPage.getByTestId('florist-print-point-name')).toHaveText(pointName);

  // 8. Агент забирает задание и печатает.
  const poll = await request.post('/api/print-agent/poll', { headers: agentHeaders, data: {} });
  expect(poll.status()).toBe(200);
  const job = ((await poll.json()) as { job: { kind: string; jobId: string; tspl: string } | null })
    .job;
  expect(job).not.toBeNull();
  expect(job?.kind).toBe('ORDER_LABEL');

  // В задании настоящий кадр для термоголовки, а не заглушка.
  const tspl = Buffer.from(job?.tspl ?? '', 'base64').toString('latin1');
  expect(tspl).toContain('SIZE 58 mm,40 mm');
  expect(tspl).toContain('PRINT 1,1');

  // Пока агент не ответил, задание держится за ним и второй раз не выдаётся.
  const second = await request.post('/api/print-agent/poll', { headers: agentHeaders, data: {} });
  expect(((await second.json()) as { job: unknown }).job).toBeNull();

  const reported = await request.post(`/api/print-agent/jobs/${job?.jobId ?? ''}/result`, {
    headers: agentHeaders,
    data: { outcome: 'sent' },
  });
  expect(reported.status()).toBe(200);

  // 9. Очередь точки опустела.
  //
  //    Администратор всё это время заводил флориста в другом разделе,
  //    поэтому возвращаемся в настройки — там и видно состояние точки.
  await openSection(page, 'Настройки');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('print-point-queue')).toHaveText('0');
  // И компьютер по-прежнему на связи: отметка приходит с каждым опросом.
  await expect(row).toContainText('Онлайн');

  /*
   * 10. Наклейка ушла, но бланк по-прежнему ждёт человека.
   *
   *     Спулер Windows не подтверждает выход бумаги, поэтому «напечатано»
   *     остаётся именным действием. Задание при этом уходит из рабочего
   *     списка: делать с ним больше нечего.
   */
  // Карточка остаётся открытой после сборки — закрываем её, прежде чем идти
  // во вкладку печати.
  await floristPage
    .getByTestId('florist-card-dialog')
    .getByRole('button', { name: 'Закрыть' })
    .click();
  await floristPage.getByTestId('florist-tab-print').click();
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);

  // А в «Напечатанных» его тоже нет: человек ничего не подтверждал.
  // Задание видно в общем списке — с честной отметкой о передаче принтеру.
  await floristPage.getByTestId('print-filter-printed').click();
  await expect(
    floristPage.locator('[data-testid="print-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);

  // 11. Отключение точки: право печати теряется немедленно.
  await row.getByTestId('print-point-disconnect').click();
  await expect(row).toContainText('Отключена');

  const afterDisconnect = await request.post('/api/print-agent/poll', {
    headers: agentHeaders,
    data: {},
  });
  expect(afterDisconnect.status()).toBe(401);

  await context.close();
});

test('склад: развилка «сборка или хранение», сборка и отгрузка листа целиком', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const storageCell = requiredEnv('E2E_WH_STORAGE_CELL');
  const routeCell = requiredEnv('E2E_WH_ROUTE_CELL');
  const routeNumber = requiredEnv('E2E_WH_ROUTE');
  const firstOrder = requiredEnv('E2E_WH_ORDER_1');
  const secondOrder = requiredEnv('E2E_WH_ORDER_2');
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Склад');
  await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

  /*
   * 1. Приёмка заказа, который уже входит в подтверждённый лист.
   *
   * Развилку выбирает человек: обе дороги законны, и подставленная по
   * умолчанию увела бы коробку не туда молча.
   */
  await page.getByTestId('wh-scan-order').fill(firstOrder);
  await page.getByTestId('wh-scan-order').press('Enter');
  const choice = page.getByTestId('wh-route-choice');
  await expect(choice).toContainText(`уже входит в МЛ ${routeNumber}`);
  // До ответа поля ячейки не существует: шага «куда» ещё не было.
  await expect(page.getByTestId('wh-scan-cell')).toHaveCount(0);

  // «Всё равно в хранение»: коробка ложится в обычную ячейку и поднимается
  // в верхнюю группу — листу её ещё нести.
  await page.getByTestId('wh-choice-storage').click();
  await page.getByTestId('wh-scan-cell').fill(storageCell);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(firstOrder);

  const relocation = page.getByTestId('wh-group-relocation');
  await expect(relocation).toContainText(firstOrder);
  await expect(relocation).toContainText(storageCell);

  /*
   * 2. «В сборку»: полка листа назначается тем же сканом.
   *
   * У листа ещё нет ни одной ячейки, поэтому подсказка зовёт назначить
   * первую, а не искать среди назначенных.
   */
  await page.getByTestId('wh-scan-order').fill(secondOrder);
  await page.getByTestId('wh-scan-order').press('Enter');
  await expect(page.getByTestId('wh-route-choice')).toBeVisible();
  await page.getByTestId('wh-choice-assembly').click();
  await expect(page.getByTestId('wh-route-cell-hint')).toHaveText('Назначьте ячейку маршрута');
  await page.getByTestId('wh-scan-cell').fill(routeCell);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(`для МЛ ${routeNumber}`);

  // 3. Доска сборки: полка появилась у листа, собран один заказ из двух.
  await page.getByTestId('wh-tab-picking').click();
  const routeCard = page.locator(
    `[data-testid="assembly-route"][data-route-number="${routeNumber}"]`,
  );
  await expect(routeCard.getByTestId('assembly-route-cells')).toContainText(routeCell);
  // Короткая строка: сколько заказов в листе и сколько из них готово.
  await expect(routeCard.getByTestId('assembly-route-counts')).toHaveText('2 (1 из 2)');

  /*
   * 4. Выдача: три уровня и отдельная кнопка у каждого листа.
   *
   * По умолчанию всё свёрнуто: кладовщику нужен выбор курьера, а не чтение
   * всего склада.
   */
  await page.getByTestId('wh-tab-issue').click();
  await expect(page.locator('[data-testid="issue-route"]')).toHaveCount(0);
  const issueRoute = await openIssueRoute(page, routeNumber);
  await expect(issueRoute).toBeVisible();

  /*
   * Состояние листа считает сервер и называет словами.
   *
   * Здесь смесь: одна коробка в хранении, вторая на маршрутной полке. Лист
   * отгружается целиком, но по складу ещё придётся пройти — значит «можно
   * выдать», а не более точное «собран».
   */
  const readiness = issueRoute.getByTestId('issue-route-readiness');
  await expect(readiness).toHaveAttribute('data-readiness', 'CAN_ISSUE');
  await expect(readiness).toContainText('Можно выдать');

  /*
   * Шапка курьера отвечает, подходить ли к нему: сколько листов готово
   * и сколько их всего. Счётчики стоят справа, стрелки у самих листов нет —
   * карточка раскрывается шапкой.
   */
  await expect(page.getByTestId('issue-courier-ready').first()).toHaveText(/^\(\d+\)$/);
  await expect(page.locator('.wh-group__count--sunken').first()).toBeVisible();
  await expect(issueRoute.getByTestId('issue-route-toggle')).toHaveCount(0);

  // Строка под номером листа короткая: сколько заказов и сколько внесено.
  await expect(issueRoute.getByTestId('issue-route-counts')).toHaveText(/^\d+ \(\d+ из \d+\)$/);

  // Соседние листы курьера разделены измеримым промежутком.
  const cards = page.locator('[data-testid="issue-route"]');
  if ((await cards.count()) > 1) {
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect((second?.y ?? 0) - ((first?.y ?? 0) + (first?.height ?? 0))).toBeGreaterThanOrEqual(8);
  }

  // Третий уровень: заказы листа раскрываются отдельно и по шапке целиком.
  await expect(issueRoute.locator('.wh-route__order')).toHaveCount(0);
  const issueHead = issueRoute.getByTestId('issue-route-head');
  await expect(issueHead).toHaveAttribute('aria-expanded', 'false');
  await issueHead.getByTestId('issue-route-counts').click();
  await expect(issueHead).toHaveAttribute('aria-expanded', 'true');
  await expect(issueRoute.locator('.wh-route__order')).toHaveCount(2);
  await issueHead.getByTestId('issue-route-counts').click();
  await expect(issueRoute.locator('.wh-route__order')).toHaveCount(0);
  await issueHead.getByTestId('issue-route-counts').click();
  await expect(issueRoute.locator('.wh-route__order')).toHaveCount(2);

  // Ячейка каждого заказа названа, «Не готов» у стоящей коробки не появляется.
  // В строке стоит ТОЛЬКО номер полки: подпись вида убрана по принятому
  // макету — она расширяла колонку и уводила номер заказа вправо.
  await expect(issueRoute.getByTestId('issue-order-cell').first()).toHaveText(/^[^()]+$/);
  // Коробка в хранении больше не подписывается «Не готов»: полка известна.
  await expect(issueRoute.locator('.wh-route__badges', { hasText: 'Не готов' })).toHaveCount(0);

  // «Отгрузить» — своё действие: раскрытие оно не переключает.
  await issueRoute.getByTestId('issue-ship').click();
  await expect(issueHead).toHaveAttribute('aria-expanded', 'true');
  const ship = page.getByTestId('issue-ship-dialog');
  await expect(ship).toBeVisible();

  /*
   * Курьер подтверждается один раз на лист: до этого вносить нечего.
   */
  await page.getByTestId('issue-confirm-courier').click();
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 0 из 2');

  /*
   * Ручного ввода нет: настройка выключена по умолчанию.
   *
   * Набранный руками номер доказывает только то, что человек его набрал,
   * поэтому обычный режим работы — камера и аппаратный сканер.
   */
  await expect(page.getByTestId('issue-manual')).toHaveCount(0);
  await expect(page.getByTestId('issue-scan')).toBeVisible();

  // Администратор разрешает ручной ввод — изменение действует сразу.
  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const settings = await page.request.get('/api/settings/planning', {
    headers: { authorization: `Bearer ${token}` },
  });
  const version = ((await settings.json()) as { warehouseManualEntry: { version: number } })
    .warehouseManualEntry.version;
  const enabled = await page.request.put('/api/settings/warehouse/manual-entry', {
    headers: { authorization: `Bearer ${token}` },
    data: { value: { enabled: true }, expectedVersion: version },
  });
  expect(enabled.status()).toBe(200);

  await page.reload();
  await page.getByTestId('wh-tab-issue').click();
  await openIssueRoute(page, routeNumber);
  await issueRoute.getByTestId('issue-ship').click();
  await expect(page.getByTestId('issue-manual')).toBeVisible();

  // 5. Сессия уже открыта: подтверждать курьера второй раз не нужно.
  await expect(page.getByTestId('issue-confirm-courier')).toHaveCount(0);
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 0 из 2');

  await page.getByTestId('issue-manual-order').fill(secondOrder);
  await ship.getByRole('button', { name: 'Внести' }).click();
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  // Повтор того же заказа честно называется и счётчик не двигает.
  await page.getByTestId('issue-manual-order').fill(secondOrder);
  await ship.getByRole('button', { name: 'Внести' }).click();
  await expect(page.locator('.toast-region')).toContainText('уже внесён');
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  // Частично внесённый лист отгрузить нельзя: коробки уезжают вместе.
  await expect(page.getByTestId('issue-ship-submit')).toBeDisabled();

  /*
   * 6. «Сбросить» очищает только прогресс.
   *
   * Полки при этом не трогаются: собранный заказ остаётся в маршрутной
   * ячейке, и доска сборки этого не замечает.
   */
  await page.getByTestId('issue-reset').click();
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 0 из 2');
  await page.getByTestId('issue-ship-close').click();
  await page.getByTestId('wh-tab-picking').click();
  await expect(routeCard.getByTestId('assembly-route-cells')).toContainText(routeCell);
  // Короткая строка: сколько заказов в листе и сколько из них готово.
  await expect(routeCard.getByTestId('assembly-route-counts')).toHaveText('2 (1 из 2)');

  // 7. Первую коробку переносят из хранения в ячейку листа — теперь полка известна.
  await page.getByTestId('wh-tab-storage').click();
  await page.getByTestId('wh-scan-order').fill(firstOrder);
  await page.getByTestId('wh-scan-order').press('Enter');
  await page.getByTestId('wh-choice-assembly').click();
  await expect(page.getByTestId('wh-route-cell-hint')).toHaveText(`Сканируйте ячейку ${routeCell}`);
  await page.getByTestId('wh-scan-cell').fill(routeCell);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(`для МЛ ${routeNumber}`);

  // Собранный целиком лист ушёл в свёрнутую группу «Собранные».
  await page.getByTestId('wh-tab-picking').click();
  await expect(page.getByTestId('assembly-assembled-count')).not.toHaveText('0');

  // 8. Отгрузка: сначала оба заказа, потом одна атомарная операция.
  await page.getByTestId('wh-tab-issue').click();
  await openIssueRoute(page, routeNumber);
  await issueRoute.getByTestId('issue-ship').click();
  let done = 0;
  for (const order of [firstOrder, secondOrder]) {
    await page.getByTestId('issue-manual-order').fill(order);
    await ship.getByRole('button', { name: 'Внести' }).click();
    done += 1;
    // Каждый заказ вносится отдельно: ждём ответ сервера, а не спешим.
    await expect(page.getByTestId('issue-progress')).toHaveText(`Внесено: ${done} из 2`);
  }

  await page.getByTestId('issue-ship-submit').click();
  await expect(page.locator('.toast-region')).toContainText('отгружен курьеру');

  // Лист уехал: на доске выдачи его больше нет.
  await expect(
    page.locator(`[data-testid="issue-route"][data-route-number="${routeNumber}"]`),
  ).toHaveCount(0);

  /*
   * 9. Лист не исчез из логистики: курьер в дороге, и логист обязан видеть,
   * что именно он повёз, — но уже без изменяющих действий.
   */
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
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
  const dialog = page.getByTestId('delivery-result-dialog');

  /*
   * Результат подтверждается ОКНОМ, а не полями внутри карточки.
   *
   * Карточка при этом не отращивает форму и не сдвигает соседние заказы
   * под пальцем курьера: проверяется и это.
   */
  await first.getByTestId('delivery-open-delivered').click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(firstOrder);
  // У «Доставлен» полей нет вовсе: ни причины, ни комментария.
  await expect(dialog.getByTestId('delivery-reason')).toHaveCount(0);
  await expect(dialog.getByTestId('delivery-comment')).toHaveCount(0);
  await expect(first.locator('.delivery__form')).toHaveCount(0);

  // Отмена ничего не записывает: карточка остаётся без результата.
  await page.getByTestId('delivery-dismiss').click();
  await expect(dialog).toBeHidden();
  await expect(first).toHaveAttribute('data-result', 'none');

  await first.getByTestId('delivery-open-delivered').click();
  await page.getByTestId('delivery-submit').click();
  await expect(first).toHaveAttribute('data-result', 'DELIVERED');

  // 2. Ошибку курьер исправляет сам: заказ снова открыт.
  await first.getByTestId('delivery-cancel-result').click();
  await expect(first).toHaveAttribute('data-result', 'none');

  // 3. Повторяем результат и закрываем второй заказ недоставкой с причиной.
  await first.getByTestId('delivery-open-delivered').click();
  await page.getByTestId('delivery-submit').click();
  await expect(first).toHaveAttribute('data-result', 'DELIVERED');

  const second = page.locator(`[data-testid="delivery-order"][data-order-number="${secondOrder}"]`);
  await second.getByTestId('delivery-open-failed').click();
  await expect(dialog).toBeVisible();

  /*
   * Причины — кнопками, поля комментария нет вовсе.
   *
   * Курьер стоит у двери с коробкой: попасть пальцем в крупную кнопку он
   * может, а раскрывать список и набирать текст — нет. Нажатие только
   * выбирает; записывает «Подтвердить».
   */
  await expect(dialog.getByTestId('delivery-comment')).toHaveCount(0);
  const reasons = dialog.getByTestId('delivery-reason');
  await expect(reasons.first()).toBeVisible();
  // «Другое» не предлагается: она требует пояснения, которого мы не собираем.
  await expect(
    dialog.locator('[data-testid="delivery-reason"][data-reason-code="OTHER"]'),
  ).toHaveCount(0);

  /*
   * Пока причина не выбрана, подтверждение погашено — но упрёка на экране нет.
   *
   * Красная строка в момент, когда человек ещё ничего не сделал, — это
   * замечание за несовершённую ошибку.
   */
  await expect(page.getByTestId('delivery-submit')).toBeDisabled();
  await expect(page.getByTestId('delivery-problem')).toHaveCount(0);

  /*
   * Геометрия кнопок: семь одинаковых прямоугольников, а не лесенка.
   *
   * Меряется на настольной ширине и на телефоне. Двухстрочная подпись
   * «Получатель отсутствует» не имеет права поднимать свою строку сетки:
   * иначе семь равных по смыслу причин выглядят разными по весу.
   */
  const geometry = async (): Promise<{ widths: number[]; heights: number[] }> => {
    // Размеры берутся у каждой кнопки по отдельности: так измерение не зависит
    // от того, что именно вернёт браузер из общего выражения.
    const count = await reasons.count();
    const widths: number[] = [];
    const heights: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const box = await reasons.nth(index).boundingBox();
      expect(box, `кнопка ${index}`).not.toBeNull();
      widths.push(box?.width ?? 0);
      heights.push(box?.height ?? 0);
    }
    return { widths, heights };
  };

  for (const size of [
    { width: 1280, height: 900 },
    { width: 375, height: 780 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);

    const { widths, heights } = await geometry();
    expect(widths, `${size.width}px`).toHaveLength(7);
    expect(Math.max(...widths) - Math.min(...widths), `ширина ${size.width}px`).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.max(...heights) - Math.min(...heights),
      `высота ${size.width}px`,
    ).toBeLessThanOrEqual(1);

    // И само окно не расширяет страницу на телефоне.
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow, `перенос ${size.width}px`).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  const chosen = dialog.locator('[data-testid="delivery-reason"][data-reason-code="NO_ANSWER"]');
  await chosen.click();
  await expect(chosen).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('delivery-submit')).toBeEnabled();

  await page.getByTestId('delivery-submit').click();
  // Состояние карточки здесь не проверяется намеренно: это ПОСЛЕДНИЙ заказ,
  // его результат завершает маршрут, и список активных доставок пустеет —
  // карточки больше не существует. Доказательством служат ответ сервера
  // в тосте и сам факт опустевшего списка.
  await expect(page.locator('.toast-region')).toContainText('Маршрут завершён');

  // 4. Последний результат завершил маршрут: активных доставок не осталось.
  await expect(page.getByText('Активных доставок нет')).toBeVisible();

  /*
   * 4а. Букет из машины никуда не делся вместе с маршрутом.
   *
   * Это главная проверка возврата: маршрут закрыт, список активных пуст,
   * а обязательство вернуть недоставленный заказ на складе осталось на
   * экране красным блоком. Исчезни оно вместе с маршрутом — товар
   * компании уехал бы домой к курьеру без единой записи.
   */
  const returns = page.getByTestId('delivery-returns');
  await expect(returns).toBeVisible();
  const returned = returns.locator(`[data-order-number="${secondOrder}"]`);
  await expect(returned).toContainText('У курьера');
  /*
   * Пояснение стоит один раз на весь блок, а не в каждой строке.
   *
   * Три одинаковых предложения подряд ничего не добавляли, а гарантия
   * та же: пока склад не принял заказ, он числится за курьером.
   */
  await expect(returns).toContainText('Пока склад не принял заказ, он числится за вами');

  await returned.getByTestId('delivery-return-departing').click();
  await expect(returned).toContainText('Возвращается на склад');

  // 5. История текущего дня показывает оба результата и не скрывает данные.
  // Разделы открываются через меню: боковая панель лежит поверх экрана
  // и до нажатия на кнопку меню ссылок не показывает.
  await openSection(page, 'История доставок');
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

test('возврат: логист ждёт склад, склад принимает, повторная доставка открывается', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const orderNumber = process.env['E2E_WH_ORDER_2'] ?? '';
  const storageCell = process.env['E2E_WH_STORAGE_CELL'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  test.skip(orderNumber === '' || storageCell === '', 'не передана складская фикстура (E2E_WH_*)');

  /*
   * Сценарий продолжает курьерский: заказ признан недоставленным и физически
   * едет обратно. Проверяется ровно то, ради чего вкладка существует, —
   * что повторная доставка становится возможной ТОЛЬКО после приёмки складом.
   */
  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // 1. Вкладка называет число нерешённых сервером, а не по видимым строкам.
  // Счётчик появляется вместе с ответом сервера: до него числа нет вовсе,
  // и ноль на экране означал бы «нерешённых нет» вместо «ещё не знаем».
  const tabCount = page.getByTestId('tab-count-resolutions');
  await expect(tabCount).toBeVisible();
  await expect(tabCount).not.toHaveText('0');
  const before = Number((await tabCount.innerText()).trim());
  expect(before).toBeGreaterThan(0);

  /*
   * Счётчик стоит СПРАВА от названия, а не под ним.
   *
   * Проверяется геометрией, а не наличием: у вкладок верхней строки и у
   * нижней мобильной полосы один и тот же класс, и стоит забыть раскладку —
   * вкладка со счётчиком становится колонкой, вырастает вдвое и роняет
   * названия соседних вкладок с общей строки.
   */
  const tabs = page.getByTestId('logistics-tabs').locator('.shell__tab');
  const heights: number[] = [];
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const box = await tabs.nth(index).boundingBox();
    expect(box, `вкладка ${index}`).not.toBeNull();
    heights.push(box?.height ?? 0);
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  const withCounter = await page
    .getByTestId('logistics-tabs')
    .locator('.shell__tab', { has: page.getByTestId('tab-count-resolutions') })
    .boundingBox();
  const counterBox = await tabCount.boundingBox();
  expect(withCounter).not.toBeNull();
  expect(counterBox).not.toBeNull();
  // Число прижато к правому краю своей вкладки: значит, оно рядом с текстом.
  const rightGap =
    (withCounter?.x ?? 0) +
    (withCounter?.width ?? 0) -
    ((counterBox?.x ?? 0) + (counterBox?.width ?? 0));
  expect(rightGap).toBeLessThanOrEqual(14);

  await page.getByRole('link', { name: 'Требуют решения' }).first().click();
  const row = page.locator(`[data-testid="resolution-row"][data-order-number="${orderNumber}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Возвращается на склад');
  await expect(row).toContainText('Нет ответа');

  /*
   * 2. Пока букет не принят, «тот же букет» отправить нельзя.
   *
   * Выбор способа открывается всегда — пересобрать заказ можно и пока
   * старый букет едет обратно. Недоступен ровно один вариант, и рядом
   * написано почему.
   */
  await row.getByTestId('resolution-redeliver').click();
  await expect(page.getByTestId('redelivery-choice')).toBeVisible();
  await expect(page.getByTestId('redelivery-same')).toBeDisabled();
  await expect(page.getByTestId('redelivery-choice')).toContainText('ещё не принят складом');
  await expect(page.getByTestId('redelivery-reassemble')).toBeEnabled();
  await page.getByRole('button', { name: 'Закрыть' }).first().click();

  // 3. Склад принимает возврат: скан заказа и скан обычной ячейки хранения.
  await openSection(page, 'Склад');
  await page.getByTestId('wh-tab-returns').click();
  await page.getByTestId('wh-return-order').fill(orderNumber);
  await page.getByTestId('wh-return-order').press('Enter');
  await expect(page.getByTestId('wh-return-scanned')).toHaveText(orderNumber);
  await page.getByTestId('wh-return-cell').fill(storageCell);
  await page.getByTestId('wh-return-cell').press('Enter');
  await expect(page.locator('.toast-region')).toContainText('принят в ячейку');

  // Повторный скан той же пары — не ошибка и не второе размещение.
  await page.getByTestId('wh-return-order').fill(orderNumber);
  await page.getByTestId('wh-return-order').press('Enter');
  await page.getByTestId('wh-return-cell').fill(storageCell);
  await page.getByTestId('wh-return-cell').press('Enter');
  await expect(page.locator('.toast-region')).toContainText('уже принят');

  // 4. У логиста заказ стал пригодным для нового маршрута — без F5.
  // Вкладки логистики видны только внутри раздела, поэтому сначала раздел.
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Требуют решения' }).first().click();
  const afterRow = page.locator(
    `[data-testid="resolution-row"][data-order-number="${orderNumber}"]`,
  );
  await expect(afterRow).toContainText('Принят складом');

  await afterRow.getByTestId('resolution-redeliver').click();
  await expect(page.getByTestId('redelivery-same')).toBeEnabled();
  await page.getByTestId('redelivery-same').click();
  await expect(page.locator('.toast-region')).toContainText('с тем же букетом');
  // Решённая задача уходит из списка: вкладка называется «Требуют решения»,
  // и разобранному в ней места нет.
  await expect(afterRow).toHaveCount(0);

  // 5. Счётчик вкладки уменьшился: решение закрыло задачу.
  await expect(tabCount).toHaveText(String(before - 1));
});

test('два логиста решают одну задачу: побеждает первый, второй получает конфликт', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const orderNumber = process.env['E2E_RET_WITH_COURIER'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(orderNumber === '', 'не передана фикстура возвратов (E2E_RET_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;

  // Второй участник — настоящий логист, а не второй сеанс того же человека:
  // конфликт обязан разбираться между разными людьми.
  const secondPhone = uniquePhone();
  const created = await page.request.post('/api/users', {
    headers: { authorization: `Bearer ${token}` },
    data: { fullName: 'Логист смены', phone: secondPhone, roles: ['LOGISTICIAN'] },
  });
  expect(created.status()).toBe(201);
  const secondPin = '8642';
  const activation = (await created.json()) as { activationCode: string };
  const activated = await page.request.post('/api/auth/activate', {
    data: { phone: secondPhone, code: activation.activationCode, pin: secondPin },
  });
  expect(activated.status()).toBe(200);

  const secondContext = await browser.newContext();
  /*
   * Поток обновлений второго экрана намеренно оборван.
   *
   * Проверяется именно КОНФЛИКТ: логист, чей экран ещё не обновился, жмёт
   * кнопку по устаревшим данным. С живым потоком строка исчезла бы сама,
   * и нажимать стало бы не на что — сценарий проверял бы realtime, а не
   * разбор одновременных решений.
   */
  await secondContext.route('**/api/realtime/**', (route) => route.abort());
  const secondPage = await secondContext.newPage();

  try {
    await login(secondPage, secondPhone, secondPin);
    await secondPage.getByRole('link', { name: 'Требуют решения' }).first().click();
    const secondRow = secondPage.locator(
      `[data-testid="resolution-row"][data-order-number="${orderNumber}"]`,
    );
    await expect(secondRow).toBeVisible();

    // Первый логист решает задачу.
    await page.getByRole('link', { name: 'Требуют решения' }).first().click();
    const firstRow = page.locator(
      `[data-testid="resolution-row"][data-order-number="${orderNumber}"]`,
    );
    await expect(firstRow).toBeVisible();
    await firstRow.getByTestId('resolution-cancel').click();
    await expect(page.locator('.toast-region')).toContainText('отменён');
    await expect(firstRow).toHaveCount(0);

    // Второй нажимает по устаревшему экрану и получает понятный отказ.
    await secondRow.getByTestId('resolution-cancel').click();
    await expect(secondPage.locator('.toast-region')).toContainText('уже принято');

    // И сразу видит настоящее положение дел: задачи в списке больше нет.
    await expect(secondRow).toHaveCount(0);
  } finally {
    await secondContext.close();
  }
});

test('два сеанса: приёмка возврата складом убирает красный блок у курьера без F5', async ({
  page,
  request,
  browser,
}: {
  page: Page;
  request: APIRequestContext;
  browser: Browser;
}) => {
  const orderNumber = process.env['E2E_RET_RETURNING'] ?? '';
  const cellCode = process.env['E2E_RET_STORAGE_CELL'] ?? '';
  const courierPhone = process.env['E2E_RET_COURIER_PHONE'] ?? '';
  const courierPin = process.env['E2E_RET_COURIER_PIN'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  test.skip(
    orderNumber === '' || cellCode === '' || courierPhone === '' || courierPin === '',
    'не передана фикстура возвратов (E2E_RET_*)',
  );

  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();

  try {
    await login(courierPage, courierPhone, courierPin);
    const block = courierPage.getByTestId('delivery-returns');
    const entry = block.locator(`[data-order-number="${orderNumber}"]`);
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('Возвращается на склад');

    // Кладовщик принимает возврат в другом сеансе.
    await login(page, ADMIN_PHONE, ADMIN_PIN);
    await openSection(page, 'Склад');
    await page.getByTestId('wh-tab-returns').click();
    await page.getByTestId('wh-return-order').fill(orderNumber);
    await page.getByTestId('wh-return-order').press('Enter');
    await page.getByTestId('wh-return-cell').fill(cellCode);
    await page.getByTestId('wh-return-cell').press('Enter');
    await expect(page.locator('.toast-region')).toContainText('принят в ячейку');

    /*
     * Экран курьера обновляется САМ.
     *
     * Ни перезагрузки, ни перехода: обязательство снято приёмкой, и курьер
     * обязан это увидеть — иначе он повезёт на склад то, что там уже лежит.
     */
    await expect(entry).toHaveCount(0);
  } finally {
    await courierContext.close();
  }
});

test('отмена из МоегоСклада видна на стадиях, а её снятие возвращает заказ нераспределённым', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const freeOrder = process.env['E2E_RET_FREE_CANCELLED'] ?? '';
  const draftOrder = process.env['E2E_RET_IN_DRAFT'] ?? '';
  const draftNumber = process.env['E2E_RET_DRAFT'] ?? '';
  const floristPhone = process.env['E2E_RET_FLORIST_PHONE'] ?? '';
  const floristPin = process.env['E2E_RET_FLORIST_PIN'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    freeOrder === '' || draftOrder === '' || draftNumber === '' || floristPhone === '',
    'не передана фикстура возвратов (E2E_RET_*)',
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;

  // 1. Свободная сделка: отменённый заказ помечен и выбрать его нельзя.
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByTestId('deals-search').fill(freeOrder);
  await page.getByTestId('deals-search').press('Enter');
  const freeCard = page.locator(`[data-testid="deal-card"][data-order-number="${freeOrder}"]`);
  await expect(freeCard).toBeVisible();
  await expect(freeCard.getByTestId('deal-blocked')).toHaveText('Заказ отменён');
  await expect(freeCard).toHaveAttribute('data-selectable', 'no');

  // 2. Окно заказа говорит честно: у нас отменён, наружу не ушло.
  await freeCard.getByTestId('order-number').first().click();
  await expect(page.getByTestId('order-window-cancelled')).toContainText('Отменён в МоемСкладе');
  await page.getByRole('button', { name: 'Закрыть' }).first().click();

  // 3. Флорист видит отмену на своём заказе и собирать его не должен.
  const floristContext = await browser.newContext();
  const floristPage = await floristContext.newPage();

  try {
    await login(floristPage, floristPhone, floristPin);
    // Заказ закреплён за этим флористом, поэтому он живёт во вкладке «Мои
    // заказы», а не в общей очереди.
    await floristPage.getByRole('button', { name: 'Мои заказы' }).click();
    const floristRow = floristPage.locator(
      `[data-testid="florist-row"][data-order-number="${draftOrder}"]`,
    );
    await expect(floristRow).toBeVisible();
    await expect(floristRow).toContainText('Отменён — не собирать');

    // 4. В маршруте заказ тоже помечен, а не исчез молча.
    await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
    const draftCard = page.locator(`[data-draft-number="${draftNumber}"]`);
    await expect(draftCard).toBeVisible();
    await draftCard.locator('.routes__draft-head').click();
    await expect(draftCard).toHaveAttribute('data-expanded', 'true');
    // Остановка ищется по номеру заказа в тексте: собственного атрибута
    // у неё нет, а привязка к позиции ломалась бы от любой пересортировки.
    const stop = page.locator('[data-testid="route-stop"]').filter({ hasText: draftOrder });
    await expect(stop).toContainText('Отменён — не выдавать');

    /*
     * 5. Отмену сняли в МоегоСкладе.
     *
     * Сигнал приходит извне — проходом импорта, — и в интерфейсе его вызвать
     * нечем. Локальный вход воспроизводит ровно сигнал, а последствия
     * считает та же доменная функция, что и настоящий импорт.
     */
    const withdrawn = await page.request.post('/api/testing/source-cancellation', {
      headers: { authorization: `Bearer ${token}` },
      data: { orderNumber: draftOrder, cancelled: false },
    });
    expect(withdrawn.status()).toBe(200);

    // 6. Заказ вышел из маршрута сам: прежний черновик не восстанавливается.
    await expect(stop).toHaveCount(0);

    // 7. И у флориста его больше нет: сборка отпущена, заказ снова общий.
    await expect(floristRow).toHaveCount(0);

    // 8. В «Сделках» заказ вернулся обычным: пометки отмены больше нет.
    await page.getByRole('link', { name: 'Сделки' }).first().click();
    await page.getByTestId('deals-search').fill(draftOrder);
    await page.getByTestId('deals-search').press('Enter');
    const returned = page.locator(`[data-testid="deal-card"][data-order-number="${draftOrder}"]`);
    await expect(returned).toBeVisible();
    /*
     * Пометки отмены нет вовсе, и заказ снова можно выбрать.
     *
     * Это и есть «безопасное нераспределённое состояние»: не «отмена снята,
     * но заказ где-то числится», а обычная свободная сделка.
     */
    await expect(returned.getByTestId('deal-blocked')).toHaveCount(0);
    await expect(returned).toHaveAttribute('data-selectable', 'yes');
  } finally {
    await floristContext.close();
  }
});

test('тот же букет: заказ возвращается в «Сделки» без новой сборки, печати и дублей', async ({
  page,
}: {
  page: Page;
}) => {
  const orderNumber = process.env['E2E_RET_RETURNING'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(orderNumber === '', 'не передана фикстура возвратов (E2E_RET_*)');

  /*
   * Сценарий продолжает предыдущий: возврат уже принят складом, а решение
   * «отправить тот же букет» принято. Проверяется его последствие — заказ
   * снова можно везти, и при этом он ОДИН.
   */
  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // Решение принимается здесь же: возврат этого заказа склад уже принял
  // в предыдущем сценарии, и «тот же букет» стал доступен.
  await page.getByRole('link', { name: 'Требуют решения' }).first().click();
  const task = page.locator(`[data-testid="resolution-row"][data-order-number="${orderNumber}"]`);
  await expect(task).toContainText('Принят складом');
  await task.getByTestId('resolution-redeliver').click();
  await page.getByTestId('redelivery-same').click();
  await expect(page.locator('.toast-region')).toContainText('с тем же букетом');

  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByTestId('deals-search').fill(orderNumber);
  await page.getByTestId('deals-search').press('Enter');

  const cards = page.locator(`[data-testid="deal-card"][data-order-number="${orderNumber}"]`);
  // Ровно одна карточка: второго заказа не появилось ни под каким номером.
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute('data-selectable', 'yes');

  // Заказ по-прежнему числится собранным: пересобирать его никто не просил.
  const numberWithSuffix = page.locator('[data-testid="deal-card"]').filter({
    hasText: `${orderNumber}-otm`,
  });
  await expect(numberWithSuffix).toHaveCount(0);

  // Новый маршрут строится тем же обычным путём и принимает заказ.
  await cards.first().click();
  await expect(page.getByTestId('deals-selected-count')).toContainText('Выбрано: 1');
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await clickAndAwait(
    page,
    page.getByTestId('create-route-draft'),
    'POST',
    '/api/routes/from-selection',
  );
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);

  /*
   * Второго активного участия не появилось.
   *
   * Прежнее закрылось решением логиста, и это единственная причина, по
   * которой заказ вообще удалось поставить в новый лист: база не приняла бы
   * два активных участия одного заказа.
   */
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByTestId('deals-search').fill(orderNumber);
  await page.getByTestId('deals-search').press('Enter');
  // Заказы черновиков в рабочем списке скрыты — показываем их явно.
  await page.getByTestId('deals-include-drafts').check();
  const inDraft = page.locator(`[data-testid="deal-card"][data-order-number="${orderNumber}"]`);
  await expect(inDraft).toHaveCount(1);
  await expect(inDraft.getByTestId('deal-blocked')).toHaveText('Уже в черновике маршрута');
});

test('пересборка: заказ возвращается флористу и логисту, номер и связь прежние', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const orderNumber = process.env['E2E_RET_ACCEPTED'] ?? '';
  const floristPhone = process.env['E2E_RET_FLORIST_PHONE'] ?? '';
  const floristPin = process.env['E2E_RET_FLORIST_PIN'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    orderNumber === '' || floristPhone === '',
    'не передана фикстура возвратов (E2E_RET_*)',
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Требуют решения' }).first().click();

  const row = page.locator(`[data-testid="resolution-row"][data-order-number="${orderNumber}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Принят складом');

  // Второй сеанс флориста открыт заранее: пересборка обязана дойти без F5.
  const floristContext = await browser.newContext();
  const floristPage = await floristContext.newPage();

  try {
    await login(floristPage, floristPhone, floristPin);
    /*
     * Поиск по номеру, а не прокрутка.
     *
     * В очереди дня десятки заказов, и нужный лежал бы на второй странице:
     * проверка доказывала бы порядок сортировки вместо появления работы.
     * Поиск считает сервер — ровно так его и используют.
     */
    await floristPage.getByTestId('florist-search').fill(orderNumber);
    const queueRow = floristPage.locator(
      `[data-testid="florist-row"][data-order-number="${orderNumber}"]`,
    );
    await expect(queueRow).toBeVisible();
    // До решения заказ ждёт логиста и в работу флористу не годится: он
    // числится за маршрутом, из которого его ещё не вывели.
    await expect(queueRow.getByTestId('row-claim')).toHaveCount(1);

    await row.getByTestId('resolution-redeliver').click();
    await page.getByTestId('redelivery-reassemble').click();
    await expect(page.locator('.toast-region')).toContainText('передан на пересборку');

    /*
     * Заказ появился в очереди флориста САМ.
     *
     * Это и есть смысл пересборки: работа возвращается людям, а не ждёт,
     * пока кто-нибудь обновит страницу.
     */
    await expect(queueRow).toBeVisible({ timeout: 20_000 });
    await expect(queueRow).toContainText(orderNumber);

    // Номер прежний: «-otm» и «повтор» к номеру заказа не приписываются.
    await expect(
      floristPage.locator('[data-testid="florist-row"]').filter({ hasText: `${orderNumber}-otm` }),
    ).toHaveCount(0);

    // У логиста заказ снова в «Сделках» и ОДИН.
    await page.getByRole('link', { name: 'Сделки' }).first().click();
    await page.getByTestId('deals-search').fill(orderNumber);
    await page.getByTestId('deals-search').press('Enter');
    await expect(
      page.locator(`[data-testid="deal-card"][data-order-number="${orderNumber}"]`),
    ).toHaveCount(1);
  } finally {
    await floristContext.close();
  }
});

test('склад: «Требуется перемещение» и «Отменённые» не показывают заказ дважды', async ({
  page,
}: {
  page: Page;
}) => {
  const inRouteCell = process.env['E2E_RET_IN_ROUTE_CELL'] ?? '';
  const cancelled = process.env['E2E_RET_CANCELLED_LOGIST'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(inRouteCell === '' || cancelled === '', 'не передана фикстура возвратов (E2E_RET_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Склад');

  const relocation = page.getByTestId('wh-group-relocation');
  const cancelledGroup = page.getByTestId('wh-group-cancelled');

  // Отменённый заказ в маршрутной ячейке мешает работе прямо сейчас — он
  // стоит в первой группе и ТОЛЬКО в ней.
  await expect(relocation).toContainText(inRouteCell);
  await expect(cancelledGroup).not.toContainText(inRouteCell);

  // Группа отменённых свёрнута и названа числом.
  const toggle = page.getByTestId('wh-group-cancelled-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('wh-group-cancelled-count')).not.toHaveText('0');
  await expect(cancelledGroup).not.toContainText(cancelled);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(cancelledGroup).toContainText(cancelled);

  /*
   * Четыре группы одного склада, и каждая названа.
   *
   * Прежде спокойное хранение и маршрутные ячейки шли одним безымянным
   * списком, и тип полки приходилось читать у каждой строки.
   */
  for (const [id, title] of [
    ['relocation', 'Требует перемещения'],
    ['cancelled', 'Отменённые'],
    ['storage', 'В хранении'],
    ['route', 'В маршрутных ячейках'],
  ] as [string, string][]) {
    const group = page.getByTestId(`wh-group-${id}`);
    if ((await group.count()) > 0) {
      await expect(group, id).toContainText(title);
      // Счётчик приходит с сервера и считает весь склад, а не загруженное.
      await expect(page.getByTestId(`wh-group-${id}-count`), id).toHaveText(/^\d+$/);
    }
  }

  /*
   * На телефоне строка становится карточкой с четырьмя углами: заказ и вид
   * полки сверху, маршрутный лист и номер ячейки снизу.
   */
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-testid="wh-placement-row"]').first()).toBeVisible();
  const cornerBox = async (cls: string): Promise<{ x: number; y: number }> => {
    const box = await page
      .locator(`[data-testid="wh-placement-row"] .${cls}`)
      .first()
      .boundingBox();
    /*
     * Берётся СЕРЕДИНА, а не верхний край: таблетка ниже строки текста и
     * центрируется по ней, поэтому верхние края у соседей по строке разные,
     * хотя стоят они на одном уровне.
     */
    return {
      x: Math.round(box?.x ?? 0),
      y: Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2),
    };
  };
  const corners = {
    order: await cornerBox('wh-placement__order'),
    kind: await cornerBox('wh-placement__kind'),
    route: await cornerBox('wh-placement__route'),
    cell: await cornerBox('wh-placement__cell'),
  };
  // Верхняя пара выше нижней, левая пара левее правой.
  expect(corners.order.y).toBeLessThan(corners.route.y);
  expect(corners.kind.y).toBeLessThan(corners.cell.y);
  expect(corners.order.x).toBeLessThan(corners.kind.x);
  expect(corners.route.x).toBeLessThan(corners.cell.x);
  // Верхние углы на одной линии, нижние — тоже.
  expect(Math.abs(corners.order.y - corners.kind.y)).toBeLessThanOrEqual(3);
  expect(Math.abs(corners.route.y - corners.cell.y)).toBeLessThanOrEqual(3);
  /*
   * Карточка помещается по ширине на КАЖДОМ уровне.
   *
   * Страница может не выезжать, а прокрутка при этом жить внутри обёртки
   * таблицы — именно так и было: строка требовала себе всю ширину дважды.
   * Поэтому проверяется вся цепочка, а не только документ.
   */
  const overflows = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; clientWidth: number };
        querySelector: (s: string) => { scrollWidth: number; clientWidth: number } | null;
      };
    };
    const doc = scope.document;
    const width = (selector: string): number => {
      const el = doc.querySelector(selector);
      return el === null ? 0 : el.scrollWidth - el.clientWidth;
    };
    return {
      page: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
      plate: width('[data-testid="wh-placement-row"]'),
      wrap: width('.warehouse .table-wrap'),
    };
  });
  expect(overflows.page, 'страница').toBeLessThanOrEqual(1);
  expect(overflows.wrap, 'обёртка таблицы').toBeLessThanOrEqual(1);
  expect(overflows.plate, 'строка').toBeLessThanOrEqual(1);

  /*
   * Пометка «Переместить» убрана: про перенос уже сказали заголовок группы,
   * её точка и тёплый цвет карточки.
   */
  await expect(relocation).not.toContainText('Переместить');

  // Вид полки и номер ячейки — таблетки с заливкой, а не голый текст.
  const fill = (selector: string): Promise<string> =>
    page.evaluate((value: string) => {
      const scope = globalThis as unknown as {
        document: { querySelector: (s: string) => unknown };
        getComputedStyle: (node: unknown) => { backgroundColor: string };
      };
      const node = scope.document.querySelector(value);
      return node === null ? 'нет элемента' : scope.getComputedStyle(node).backgroundColor;
    }, selector);
  expect(await fill('[data-testid="wh-placement-row"] .wh-placement__kind')).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(await fill('[data-testid="wh-placement-row"] .wh-placement__cell')).not.toBe(
    'rgba(0, 0, 0, 0)',
  );

  await page.setViewportSize({ width: 1280, height: 900 });

  // Ровно два выхода у отменённого букета, свободного текста нет.
  const row = cancelledGroup.locator(`tr:has-text("${cancelled}")`);
  await expect(row.getByTestId('wh-withdraw-reassembly')).toBeVisible();
  await expect(row.getByTestId('wh-withdraw-write-off')).toBeVisible();

  await row.getByTestId('wh-withdraw-write-off').click();
  await expect(page.locator('.toast-region')).toContainText('снят с хранения');
  // Заказ ушёл со склада целиком: строки нет ни в одной группе. Пустая
  // группа при этом исчезает сама — показывать заголовок без строк незачем.
  await expect(
    page.locator('[data-testid="wh-placement-row"]').filter({ hasText: cancelled }),
  ).toHaveCount(0);
});

test('склад: «Снять с хранения» освобождает ячейку и убирает строку без F5', async ({
  page,
  request,
  browser,
}: {
  page: Page;
  request: APIRequestContext;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  await enableManualEntry(request);

  // Своя ячейка и свой заказ: сценарий не делит состояние с соседями.
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };

  const cellCode = `RS-${Date.now() % 100_000}`;
  const created = await request.post('/api/storage-cells', {
    headers,
    data: { code: cellCode, kind: 'STORAGE' },
  });
  expect(created.status()).toBe(201);
  const normalizedCell = ((await created.json()) as { normalizedCode: string }).normalizedCode;

  const orderNumber = seedOrders(1, { withPoint: false })[0] ?? '';

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Склад');
  await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

  // Второй открытый склад: строка обязана исчезнуть и там, без перезагрузки.
  const watcher = await browser.newContext();
  const watcherPage = await watcher.newPage();
  await login(watcherPage, ADMIN_PHONE, ADMIN_PIN);
  await openSection(watcherPage, 'Склад');
  await expect(watcherPage.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

  // 1. Приёмка заказа в ячейку хранения.
  await page.getByTestId('wh-scan-order').fill(orderNumber);
  await page.getByTestId('wh-scan-order').press('Enter');
  await page.getByTestId('wh-scan-cell').fill(normalizedCell);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(orderNumber);

  // 2. Заказ стоит в группе «В хранении», и у строки есть явная кнопка.
  const storage = page.getByTestId('wh-group-storage');
  const row = storage.locator('[data-testid="wh-placement-row"]', { hasText: orderNumber });
  await expect(row).toBeVisible();
  await expect(row).toContainText(normalizedCell);
  const remove = row.getByTestId('wh-remove-from-storage');
  await expect(remove).toBeVisible();

  // Он виден и во втором окне — доехал по realtime, без F5.
  await expect(
    watcherPage
      .getByTestId('wh-group-storage')
      .locator('[data-testid="wh-placement-row"]', { hasText: orderNumber }),
  ).toBeVisible();

  // 3. Подтверждение называет номер заказа и ячейку.
  await remove.click();
  const confirm = page.getByTestId('wh-remove-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(orderNumber);
  await expect(confirm).toContainText(normalizedCell);

  await page.getByTestId('wh-remove-confirm-submit').click();
  await expect(page.locator('.toast-region')).toContainText('снят с хранения');

  // 4. Строка исчезла в этом окне и во втором — обоим по realtime.
  await expect(
    page.locator('[data-testid="wh-placement-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);
  await expect(
    watcherPage.locator('[data-testid="wh-placement-row"]', { hasText: orderNumber }),
  ).toHaveCount(0);

  // 5. Ячейка сразу свободна: тот же заказ снова принимается в неё.
  await page.getByTestId('wh-scan-order').fill(orderNumber);
  await page.getByTestId('wh-scan-order').press('Enter');
  await page.getByTestId('wh-scan-cell').fill(normalizedCell);
  await page.getByTestId('wh-place').click();
  await expect(
    page.getByTestId('wh-group-storage').locator('[data-testid="wh-placement-row"]', {
      hasText: orderNumber,
    }),
  ).toBeVisible();

  await watcher.close();
});

test('печать: «Общие» показывают серверный набор за 48 часов, а не свой список', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  /*
   * Администратор не собирает заказы, поэтому «своих» заданий печати у него
   * нет вовсе. Это и делает проверку честной: всё, что появится после
   * включения «Общих», пришло с сервера, а не осталось на экране.
   */
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Флорист');
  await page.getByRole('button', { name: 'Печать' }).click();
  await page.getByTestId('print-filter-printed').click();

  await expect(page.getByTestId('florist-print-list')).toHaveCount(0);

  await page.getByTestId('print-general').locator('input').check();
  const list = page.getByTestId('florist-print-list');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('print-row').first()).toBeVisible();
});

test('карты: собранный заказ окрашен одинаково в «Сделках» и «Маршрутизации»', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const orderNumber = process.env['E2E_RET_WITH_COURIER'] ?? '';
  const cellCode = process.env['E2E_RET_STORAGE_CELL'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  test.skip(orderNumber === '' || cellCode === '', 'не передана фикстура возвратов (E2E_RET_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  /*
   * Готовность создаётся здесь же, а не берётся у соседнего сценария.
   *
   * Букет этого заказа ещё у курьера; склад принимает возврат, и заказ
   * становится готовым к отправке — по второму признаку готовности,
   * «лежит в ячейке». Именно его и проверяет цвет.
   */
  await openSection(page, 'Склад');
  await page.getByTestId('wh-tab-returns').click();
  await page.getByTestId('wh-return-order').fill(orderNumber);
  await page.getByTestId('wh-return-order').press('Enter');
  await page.getByTestId('wh-return-cell').fill(cellCode);
  await page.getByTestId('wh-return-cell').press('Enter');
  await expect(page.locator('.toast-region')).toContainText('принят в ячейку');

  /*
   * Цвет собранного один на обе карты и задан владельцем.
   *
   * Проверяется вычисленный цвет, а не имя класса: класс можно оставить,
   * а правило переписать — и точка станет другого цвета, не сломав ни одной
   * проверки.
   */
  const expected = 'rgb(176, 201, 101)';

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  const dealsDot = page.locator('.map-point--assembled .map-point__dot').first();
  await expect(dealsDot).toBeVisible();
  await expect(dealsDot).toHaveCSS('background-color', expected);

  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  /*
   * Карта маршрутизации по умолчанию показывает только состав раскрытого
   * черновика. Наш заказ ни в один черновик не входит, поэтому включаем
   * нераспределённые явно — это тот самый переключатель, которым логист
   * и смотрит на свободные сделки дня.
   *
   * Раньше сценарий на него не нажимал и держался на постороннем состоянии,
   * оставленном соседями: в полном наборе он падал, в одиночку проходил.
   */
  await expect(page.getByTestId('routing-map-surface')).toBeVisible();
  await page.getByTestId('map-unassigned-toggle').check();
  await expect(page.locator('.map-point').first()).toBeVisible({ timeout: 30_000 });
  const routingDot = page.locator('.map-point--assembled .map-point__dot').first();
  await expect(routingDot).toBeVisible({ timeout: 30_000 });
  await expect(routingDot).toHaveCSS('background-color', expected);
});

test('самовывоз: флорист собрал → склад принял → менеджер выдал покупателю', async ({
  page,
  browser,
  request,
}: {
  page: Page;
  browser: Browser;
  request: APIRequestContext;
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
    await openSection(page, 'Сотрудники и курьеры');
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
  floristPage.on('pageerror', (error) => console.log('FLORIST_PAGEERROR:', error.message));
  floristPage.on('console', (msg) => {
    if (msg.type() === 'error') console.log('FLORIST_CONSOLE_ERROR:', msg.text());
  });
  floristPage.on('requestfailed', (req) =>
    console.log('FLORIST_REQ_FAILED:', req.url(), req.failure()?.errorText),
  );
  await activate(floristPage, floristPhone, floristCode, FLORIST_PIN);
  await floristPage.waitForLoadState('networkidle').catch(() => undefined);
  console.log(
    'FLORIST_PROBE url=',
    floristPage.url(),
    'shiftStartCount=',
    await floristPage.getByTestId('shift-start').count(),
    'heading=',
    await floristPage
      .getByRole('heading', { level: 1 })
      .first()
      .innerText()
      .catch(() => '<none>'),
    'body=',
    (
      await floristPage
        .locator('body')
        .innerText()
        .catch(() => '<none>')
    ).slice(0, 400),
  );
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
  await openSection(page, 'Склад');
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
  for (const foreign of ['Настройки', 'Сотрудники и курьеры', 'Маршрутизация', 'Флорист']) {
    await expect(managerPage.getByRole('link', { name: foreign })).toHaveCount(0);
  }

  // «Склад» менеджеру выдачи открыт — но ровно ради одной вкладки «Ожидают
  // приёмки»: рабочих вкладок кладовщика (Склад/Сборка/Выдача/Возвраты) у него
  // нет. Дом при этом остался «Самовывозом» (проверено выше).
  await openSection(managerPage, 'Склад');
  await expect(managerPage.getByTestId('wh-tab-awaiting')).toBeVisible();
  for (const hidden of ['storage', 'picking', 'issue', 'returns']) {
    await expect(managerPage.getByTestId(`wh-tab-${hidden}`)).toHaveCount(0);
  }
  await expect(managerPage.getByTestId('wh-awaiting')).toBeVisible();
  // Возврат к «Самовывозу» для продолжения сценария выдачи.
  await openSection(managerPage, 'Самовывоз');
  await expect(managerPage.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();

  // Заказ ждёт выдачи и лежит в известной ячейке.
  const waiting = managerPage.locator('[data-testid="pickup-waiting-row"]', {
    hasText: orderNumber,
  });
  await expect(waiting).toContainText(cellCode);

  /*
   * 5. Выдача покупателю без второго скана.
   *
   * Обычный путь прилавка — скан QR-кода с телефона покупателя. Здесь
   * камеры нет, поэтому администратор разрешает ручной ввод: та же доменная
   * операция, другой способ её вызвать.
   */
  /*
   * Настройка общая на всё приложение, поэтому сценарий приводит её
   * в известное состояние сам: полагаться на порядок соседей значило бы
   * проверять их, а не себя.
   */
  await disableManualEntry(request);
  await expect(managerPage.getByTestId('pickup-manual-open')).toHaveCount(0, { timeout: 25_000 });
  await enableManualEntry(request);
  await expect(managerPage.getByTestId('pickup-manual-open')).toBeVisible({ timeout: 25_000 });
  await managerPage.getByTestId('pickup-manual-open').click();

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
  // После выдачи поле закрывается само: следующий покупатель начинает
  // со скана, а не с чужого номера в поле.
  await managerPage.getByTestId('pickup-manual-open').click();
  await managerPage.getByTestId('pickup-search').fill(orderNumber);
  await managerPage.getByTestId('pickup-search').press('Enter');
  await expect(managerPage.getByTestId('pickup-card-blocked')).toContainText('Заказ уже выдан');
  await expect(managerPage.getByTestId('pickup-issue')).toHaveCount(0);

  // Настройка возвращается к умолчанию: соседние сценарии ждут выключенной.
  await disableManualEntry(request);
  await managerContext.close();
});

/**
 * Исход складского сканирования — отдельное окно поверх кадра.
 *
 * Раньше результат появлялся подписью под камерой: человек смотрит в рамку
 * считывания, и об отказе узнавал только по тому, что дальше ничего не
 * происходит. Проверяется именно это — где окно, сколько живёт успех, ждёт ли
 * отказ решения и одинаково ли ведёт себя технический отказ камеры.
 */
test('склад: исход сканирования показывается окном поверх камеры', async ({
  page,
}: {
  page: Page;
}) => {
  const storageCell = requiredEnv('E2E_WH_STORAGE_CELL');
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  // Двойник камеры с двумя режимами: обычным и «камера не запускается».
  await page.addInitScript(() => {
    interface FakeCameraGlobals {
      __flCameraAdapter?: unknown;
      __flCameraRunning?: boolean;
      __flCameraFails?: boolean;
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
        if (scope.__flCameraFails === true) {
          // Тот же класс отказа, что у запрещённого доступа: поток не открылся.
          return Promise.reject(new Error('camera failed'));
        }
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

  const scan = async (code: string): Promise<void> => {
    await page.evaluate((value) => {
      (globalThis as unknown as { __flScan: (code: string) => void }).__flScan(value);
    }, code);
  };
  const clearFrame = (): Promise<void> =>
    page.evaluate(() => {
      (globalThis as unknown as { __flClear: () => void }).__flClear();
    });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Склад');
  await page.getByTestId('wh-scan-camera').click();

  /*
   * 1. Отказ: окно лежит ПОВЕРХ кадра, а не под ним.
   *
   * Ячейка хранения вместо заказа — понятный человеку случай «не тот предмет».
   */
  await scan(storageCell);
  const error = page.getByTestId('scan-error');
  await expect(error).toBeVisible();
  await clearFrame();

  const videoBox = await page.getByTestId('scan-video').boundingBox();
  const errorBox = await error.boundingBox();
  expect(videoBox).not.toBeNull();
  expect(errorBox).not.toBeNull();
  // Центр окна лежит внутри кадра: подпись под камерой этого не давала.
  const centerY = errorBox!.y + errorBox!.height / 2;
  expect(centerY).toBeGreaterThanOrEqual(videoBox!.y);
  expect(centerY).toBeLessThanOrEqual(videoBox!.y + videoBox!.height);

  // Что распознано и что ожидалось — обе строки на месте.
  await expect(page.getByTestId('scan-error-scanned')).toContainText(storageCell);
  await expect(page.getByTestId('scan-error-expected')).toContainText('заказа');

  // 2. Отказ сам не закрывается: он ждёт решения человека.
  await page.waitForTimeout(2500);
  await expect(error).toBeVisible();
  await expect(page.getByTestId('scan-retry')).toBeVisible();
  await expect(page.getByTestId('scan-error-cancel')).toBeVisible();

  // 3. «Отмена» закрывает сканер и возвращает на рабочий экран.
  await page.getByTestId('scan-error-cancel').click();
  await expect(page.getByTestId('scan-video')).toHaveCount(0);
  await expect(page.getByTestId('wh-scan-camera')).toBeVisible();

  /*
   * 4. Технический отказ камеры показывается тем же окном.
   *
   * Для человека это одно событие — «отсканировать сейчас не получилось», —
   * и разные способы сообщить о нём заставляли бы искать, куда смотреть.
   */
  await page.evaluate(() => {
    (globalThis as unknown as { __flCameraFails: boolean }).__flCameraFails = true;
  });
  await page.getByTestId('wh-scan-camera').click();
  await expect(page.getByTestId('scan-error')).toBeVisible();
  await expect(page.getByTestId('scan-retry')).toBeVisible();
  await expect(page.getByTestId('scan-error-cancel')).toBeVisible();

  // «Повторить» пробует запустить камеру заново: разрешение могли выдать.
  await page.evaluate(() => {
    (globalThis as unknown as { __flCameraFails: boolean }).__flCameraFails = false;
  });
  await page.getByTestId('scan-retry').click();
  await expect(page.getByTestId('scan-error')).toHaveCount(0);
  await expect(page.getByTestId('scan-hint')).toBeVisible();

  await page.getByTestId('scan-close').click();
});

/**
 * Камера склада с подменённым адаптером.
 *
 * Настоящего устройства и разрешения в CI нет, а проводку «кнопка → шаг →
 * сервер» доказать нужно. Поэтому адаптер камеры подменяется двойником,
 * который отдаёт коды по команде теста: проверяется реальная цепочка
 * приложения, а не работа драйвера камеры.
 */
test('склад с камеры: окно, промежуточный успех, названная ошибка и сборка парой', async ({
  page,
}: {
  page: Page;
}) => {
  // Собственная фикстура: сценарий камеры не делит ячейки и лист с ручным
  // складским сценарием, иначе они мешали бы друг другу порядком запуска.
  const storageCell = requiredEnv('E2E_WH_CAM_STORAGE');
  const routeCell = requiredEnv('E2E_WH_CAM_ROUTE_CELL');
  const routeNumber = requiredEnv('E2E_WH_CAM_ROUTE');
  const firstOrder = requiredEnv('E2E_WH_CAM_ORDER_1');
  const secondOrder = requiredEnv('E2E_WH_CAM_ORDER_2');

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

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
  await openSection(page, 'Склад');

  const hint = page.getByTestId('scan-hint');
  const title = page.getByTestId('scan-title');
  const success = page.getByTestId('scan-success');

  /*
   * 1. Окно, а не весь экран.
   *
   * Камера во весь экран не оставляет человеку ориентира: не видно, где он
   * находится и что происходит под окном.
   */
  expect(await cameraRunning()).toBe(false);
  await page.getByTestId('wh-scan-camera').click();
  expect(await cameraRunning()).toBe(true);
  await expect(title).toHaveText('Сканирование заказа');
  await expect(hint).toHaveText('Наведите камеру на QR-код заказа');

  const viewport = page.viewportSize();
  const windowBox = await page.locator('.scanner').boundingBox();
  expect(windowBox).not.toBeNull();
  expect(windowBox!.width).toBeLessThan((viewport?.width ?? 0) - 8);
  expect(windowBox!.height).toBeLessThan((viewport?.height ?? 0) - 8);
  await expect(page.locator('.scanner__reticle')).toBeVisible();
  await expect(page.getByTestId('scan-cancel')).toBeVisible();
  await expect(page.getByTestId('scan-close')).toBeVisible();

  /*
   * 2. Промежуточный успех: заказ распознан, но в базе ещё ничего нет.
   *
   * Заказ входит в подтверждённый лист, поэтому сразу за уведомлением
   * человека спрашивают, сборка это или хранение.
   */
  await scan(firstOrder, async () => {
    await expect(success).toContainText(`Заказ ${firstOrder} отсканирован`);
  });
  const routeChoice = page.getByTestId('scan-route-choice');
  await expect(routeChoice).toContainText(`уже входит в МЛ ${routeNumber}`);

  // «Всё равно в хранение»: обычная ячейка и заголовок про ячейку.
  await page.getByTestId('scan-route-storage').click();
  await expect(hint).toHaveText('Наведите камеру на QR-код ячейки');
  await scan(storageCell, async () => {
    await expect(success).toContainText(`помещён в ячейку ${storageCell}`);
  });

  // Итог показан, экран закрылся сам, камера погашена.
  await expect(page.getByTestId('wh-scan-camera')).toBeVisible();
  expect(await cameraRunning()).toBe(false);
  const placed = page.locator('[data-testid="wh-placement-row"]', { hasText: firstOrder });
  await expect(placed).toContainText(storageCell);

  /*
   * 3. Незавершённая пара не оставляет следа.
   *
   * Заказ распознан, ячейка не отсканирована, окно закрыто крестиком —
   * в базе не должно появиться ничего.
   */
  await page.getByTestId('wh-scan-camera').click();
  await scan(secondOrder, async () => {
    await expect(page.getByTestId('scan-route-choice')).toBeVisible();
  });
  await page.getByTestId('scan-close').click();
  await expect(page.getByTestId('wh-scan-camera')).toBeVisible();
  await expect(
    page.locator('[data-testid="wh-placement-row"]', { hasText: secondOrder }),
  ).toHaveCount(0);

  /*
   * 4. Ошибка называет и распознанное, и ожидаемое.
   *
   * «Не подходит» без этих двух строк заставляет подносить к камере тот же
   * самый код ещё раз.
   */
  await page.getByTestId('wh-scan-camera').click();
  await scan(secondOrder, async () => {
    await expect(page.getByTestId('scan-route-choice')).toBeVisible();
  });
  await page.getByTestId('scan-route-assembly').click();
  await expect(hint).toHaveText('Назначьте ячейку маршрута');

  await scan(storageCell, async () => {
    await expect(page.getByTestId('scan-error')).toBeVisible();
  });
  await expect(page.getByTestId('scan-error-scanned')).toContainText(storageCell);
  await expect(page.getByTestId('scan-error-expected')).toContainText('маршрутной ячейки');

  // «Повторить» возвращает к тому же ожидаемому шагу.
  await page.getByTestId('scan-retry').click();
  await expect(hint).toHaveText('Назначьте ячейку маршрута');

  await scan(routeCell, async () => {
    await expect(success).toContainText(`для МЛ ${routeNumber}`);
  });

  /*
   * 5. Быстрое сканирование из «Сборки»: пара «заказ → маршрутная ячейка».
   *
   * Полка листа уже назначена, поэтому заголовок называет её по коду.
   */
  await page.getByTestId('wh-tab-picking').click();
  await page.getByTestId('assembly-scan').click();
  await scan(firstOrder, async () => {
    await expect(success).toContainText(`Заказ ${firstOrder} отсканирован`);
  });
  await expect(hint).toHaveText('Наведите камеру на QR-код маршрутной ячейки');
  await scan(routeCell, async () => {
    // Именно итог операции, а не промежуточное «отсканирован»: иначе
    // проверка засчитала бы уведомление предыдущего шага.
    await expect(success).toContainText(`перемещён в ячейку ${routeCell}`);
  });

  // Лист собран целиком и ушёл в свёрнутую группу «Собранные».
  await expect(page.getByTestId('assembly-assembled-count')).not.toHaveText('0');

  /*
   * 6. Отмена «Повторить/Отмена» и защита от соседних кадров.
   *
   * Один неподвижный QR перед камерой — это одно действие, а не поток
   * одинаковых операций: повтор внесения честно называется повтором.
   */
  await page.getByTestId('wh-tab-issue').click();
  const issueRoute = await openIssueRoute(page, routeNumber);
  await issueRoute.getByTestId('issue-ship').click();
  const confirm = page.getByTestId('issue-confirm-courier');
  if ((await confirm.count()) > 0) {
    await confirm.click();
  }

  await page.getByTestId('issue-scan').click();
  await expect(page.getByTestId('scan-title')).toHaveText('Сканирование заказа');
  await scan(firstOrder, async () => {
    await expect(success).toContainText(`Заказ ${firstOrder} внесён`);
  });

  /*
   * Заказ проверен — сканер закрывается и возвращает к списку.
   *
   * Так человек видит обновлённый прогресс и новое состояние строки, а не
   * гадает, засчиталась ли проверка. Следующий заказ сканируется отдельным
   * нажатием: камера сама не открывается.
   */
  await expect(page.getByTestId('scan-video')).toHaveCount(0);
  expect(await cameraRunning()).toBe(false);
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  // Повтор того же заказа честно называется повтором и прогресс не двигает.
  await page.getByTestId('issue-scan').click();
  await scan(firstOrder, async () => {
    await expect(success).toContainText('уже внесён');
  });
  await expect(page.getByTestId('scan-video')).toHaveCount(0);
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  await page.getByTestId('issue-scan').click();
  await scan(secondOrder, async () => {
    await expect(success).toContainText(`Заказ ${secondOrder} внесён`);
  });
  await expect(page.getByTestId('scan-video')).toHaveCount(0);
  expect(await cameraRunning()).toBe(false);

  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 2 из 2');
  await page.getByTestId('issue-ship-submit').click();
  await expect(page.locator('.toast-region')).toContainText('отгружен курьеру');
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
    address: 'Москва, Цветочная улица, 1',
    assembled: false,
    selectable: true,
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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByRole('heading', { name: 'Сделки', level: 1 })).toBeAttached();

  // 1. Нуль точек: карта ВСЁ РАВНО показана — подложка Москвы, а не пустой блок.
  await expect(page.getByTestId('deals-map-canvas')).toBeVisible();
  // Пустая карта называет причину, а не только следствие: заголовок, объяснение
  // и действие, которым её и закрывают.
  await expect(page.getByTestId('deals-map-empty')).toContainText('Ни одного заказа на карте');
  // Приближать нечего: кнопка не обещает действие, которое ничего не изменит.
  await expect(page.getByTestId('deals-map-zoom')).toBeDisabled();
  // Отметок заказов нет ни одной. Склад при этом показан всегда: маршрут
  // начинается с него, и его место логист обязан видеть и в пустой день.
  await expect(page.locator('[data-testid="map-marker"][data-order-id]')).toHaveCount(0);
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

  await expect(page.locator('[data-testid="map-marker"][data-order-id]')).toHaveCount(1, {
    timeout: 15_000,
  });
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
  await expect(page.locator('[data-testid="map-marker"][data-order-id]')).toHaveCount(0);
  await expect(page.getByTestId('deals-map-empty')).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { name?: string }).name)).toBe(RELOAD_SENTINEL);
});

/**
 * Рабочее место логиста на большом экране.
 *
 * Проверяется то, что раньше приходилось проверять глазами и о чём пришли
 * замечания приёмки: доля колонки и карты, собственное окно прокрутки списка,
 * неподвижность карты и фильтров, закреплённая панель действий вне прокрутки,
 * а на телефоне — отсутствие горизонтального выезда.
 *
 * ГРАНИЦА СЦЕНАРИЯ, названная прямо. Список и точки здесь подменены: раскладку
 * доказывает предсказуемое число карточек, а не то, сколько заказов оказалось
 * в базе к моменту прогона. Сам контракт `/api/deals` и `/api/deals/map`
 * проверяется серверными критическими тестами, а не отсюда.
 */
test('«Сделки» на большом экране: доли, своя прокрутка и закреплённая панель', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  /*
   * Подложка — пустой валидный стиль.
   *
   * Проверяется раскладка, а не отрисовка тайлов: крошечный проверочный набор
   * PMTiles на большом экране отдаёт не все запрошенные тайлы, и карта честно
   * сообщила бы об отказе подложки. Внешних обращений при этом по-прежнему нет.
   */
  const styleUrl = 'https://maps.local.test/deals-layout.json';
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

  const item = (index: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    number: `E2E-РАБ-${index}`,
    address: 'Москва, Цветочная улица, 1',
    sourceAddress: 'Москва, Цветочная улица, 1',
    addressCorrected: false,
    addressConflict: false,
    recipient: 'Получатель проверки',
    comment: null,
    deliveryDate: '2026-08-15',
    startMinute: 600,
    endMinute: 720,
    intervalCorrected: false,
    needsAttention: false,
    attentionReasons: [],
    geoState: 'RESOLVED',
    draftRouteId: null,
    draftRouteNumber: null,
    selectable: true,
    sourceStartMinute: 600,
    sourceEndMinute: 720,
    sourceIntervalRaw: 'с 10:00 по 12:00',
    version: 1,
    assembled: false,
    ...over,
  });

  const items = [
    // Один заказ с нераспознанным интервалом: он обязан быть назван причиной
    // в списке и не попасть на карту вовсе.
    item(1, {
      needsAttention: true,
      attentionReasons: ['UNRECOGNIZED_INTERVAL'],
      startMinute: null,
      endMinute: null,
      selectable: false,
    }),
    item(2, { assembled: true }),
    item(3, {
      comment:
        'Позвонить за час.\nПодъезд со двора, домофон не работает, встречает охрана у шлагбаума.',
    }),
    ...Array.from({ length: 37 }, (_unused, index) => item(index + 4)),
  ];

  await page.route(
    (url) => url.pathname === '/api/deals',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          total: items.length,
          withoutPoint: 3,
          limit: 50,
          offset: 0,
          hasMore: false,
          deliveryDate: '2026-08-15',
        }),
      }),
  );

  // Пригодные заказы всего отбора: их и выбирает кнопка «Выбрать все».
  await page.route(
    (url) => url.pathname === '/api/deals/selectable',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          orderIds: items.filter((row) => row['selectable'] === true).map((row) => row['id']),
        }),
      }),
  );

  // На карте — все, кроме требующего внимания: сервер такие точки не отдаёт.
  await page.route(
    (url) => url.pathname === '/api/deals/map',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          points: items
            .filter((row) => row['needsAttention'] === false)
            .map((row, index) => ({
              orderId: row['id'],
              number: row['number'],
              address: row['address'],
              lat: String(55.75 + index * 0.001),
              lon: String(37.61 + index * 0.001),
              startMinute: row['startMinute'],
              endMinute: row['endMinute'],
              assembled: row['assembled'],
              selectable: row['selectable'],
            })),
          deliveryDate: '2026-08-15',
        }),
      }),
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  // 1. Доли колонок: список — заметно меньшая доля, карта — остальное.
  const body = await page.getByTestId('deals-body').boundingBox();
  const column = await page.getByTestId('deals-column').boundingBox();
  const mapColumn = await page.getByTestId('deals-map-column').boundingBox();
  expect(body).not.toBeNull();
  expect(column).not.toBeNull();
  expect(mapColumn).not.toBeNull();

  const bodyWidth = body?.width ?? 0;
  const columnWidth = column?.width ?? 0;
  const mapWidth = mapColumn?.width ?? 0;

  // Утверждённая раскладка: список — clamp(460px, 38%, 760px), карта — остаток.
  expect(columnWidth).toBeGreaterThanOrEqual(460);
  expect(columnWidth).toBeLessThanOrEqual(760);
  expect(columnWidth / bodyWidth).toBeGreaterThanOrEqual(0.34);
  expect(columnWidth / bodyWidth).toBeLessThanOrEqual(0.42);
  expect(mapWidth / bodyWidth).toBeGreaterThanOrEqual(0.56);
  expect(mapWidth / bodyWidth).toBeLessThanOrEqual(0.65);

  // 2. Карта видна целиком и занимает рабочую высоту, а не полосу сверху.
  const surface = await page.getByTestId('deals-map-canvas').boundingBox();
  expect(surface?.height ?? 0).toBeGreaterThan(400);
  expect((surface?.y ?? 0) + (surface?.height ?? 0)).toBeLessThanOrEqual(900);

  // 3. Список прокручивается ВНУТРИ своего окна: страница при этом стоит.
  const scroll = page.getByTestId('deals-scroll');
  const mapBefore = await page.getByTestId('deals-map-canvas').boundingBox();
  const filtersBefore = await page.getByTestId('deals-total').boundingBox();

  // Типы DOM в браузерной проверке намеренно не подключены: нужные свойства
  // называются по месту, а не тянут за собой всю библиотеку.
  await scroll.evaluate((element: { scrollTop: number; scrollHeight: number }) => {
    element.scrollTop = element.scrollHeight;
  });

  const scrolled = await scroll.evaluate((element: { scrollTop: number }) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  expect(await page.evaluate(() => (globalThis as { scrollY?: number }).scrollY ?? 0)).toBe(0);

  // Карта и шапка списка при этом не сдвинулись ни на пиксель.
  const mapAfter = await page.getByTestId('deals-map-canvas').boundingBox();
  const filtersAfter = await page.getByTestId('deals-total').boundingBox();
  expect(mapAfter?.y).toBe(mapBefore?.y);
  expect(filtersAfter?.y).toBe(filtersBefore?.y);

  // 4. Панель закреплена всегда: набор действий виден до первого выбора,
  // а недоступность показана состоянием кнопок, а не их отсутствием.
  await expect(page.getByTestId('deals-summary')).toBeVisible();
  await expect(page.getByTestId('deals-manual-draft')).toBeDisabled();
  await expect(page.getByTestId('deals-auto-plan')).toBeDisabled();

  // С первым выбранным заказом действия становятся доступны.
  await page
    .locator('[data-testid="deal-card"][data-order-number="E2E-РАБ-2"]')
    .getByTestId('deal-pick')
    .click();
  const summary = page.getByTestId('deals-summary');
  await expect(summary).toBeVisible();
  const summaryBox = await summary.boundingBox();
  expect((summaryBox?.y ?? 0) + (summaryBox?.height ?? 0)).toBeLessThanOrEqual(900);
  const insideScroll = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: {
          querySelector: (selector: string) => { contains: (node: unknown) => boolean } | null;
        };
      }
    ).document;
    const area = doc.querySelector('[data-testid="deals-scroll"]');
    const panel = doc.querySelector('[data-testid="deals-summary"]');
    return area !== null && panel !== null && area.contains(panel);
  });
  expect(insideScroll).toBe(false);

  // Действия стоят одной строкой и не переносятся: ряд держится целиком.
  const manual = await page.getByTestId('deals-manual-draft').boundingBox();
  const auto = await page.getByTestId('deals-auto-plan').boundingBox();
  expect(manual?.y).toBe(auto?.y);
  expect(Math.round(manual?.height ?? 0)).toBe(Math.round(auto?.height ?? 0));
  expect(manual?.width ?? 0).toBeGreaterThan(60);
  expect(auto?.width ?? 0).toBeGreaterThan(60);
  expect((manual?.width ?? 0) + (auto?.width ?? 0)).toBeLessThanOrEqual(columnWidth);

  // Снятие всего выбора снова закрывает действия, панель при этом остаётся.
  await page.getByTestId('deals-clear').click();
  await expect(page.getByTestId('deals-summary')).toBeVisible();
  await expect(page.getByTestId('deals-manual-draft')).toBeDisabled();
  await expect(page.getByTestId('deals-auto-plan')).toBeDisabled();

  // 5. Счётчик называет и общее число, и заказы без координат.
  await expect(page.getByTestId('deals-total')).toContainText('Заказов: 40');
  await expect(page.getByTestId('deals-total')).toContainText('без координат: 3');

  /*
   * 5а. Вся поверхность карточки переключает выбор, а её кнопки — нет.
   *
   * Раньше попасть требовалось точно в кружок 18 px. Кнопки при этом обязаны
   * остаться своими: нажатие на «Интервал» не должно выбирать заказ.
   */
  const clickable = page.locator('[data-testid="deal-card"][data-order-number="E2E-РАБ-5"]');
  await expect(clickable).toHaveAttribute('data-selected', 'no');
  await clickable.click({ position: { x: 200, y: 8 } });
  await expect(clickable).toHaveAttribute('data-selected', '1');
  await expect(clickable).toHaveAttribute('aria-pressed', 'true');

  // Повторное нажатие по свободному месту снимает выбор.
  await clickable.click({ position: { x: 200, y: 8 } });
  await expect(clickable).toHaveAttribute('data-selected', 'no');

  // Кнопка внутри карточки выбор не трогает.
  await clickable.getByTestId('deal-edit-interval').click();
  await expect(clickable).toHaveAttribute('data-selected', 'no');
  await expect(clickable.getByTestId('deal-interval-form')).toBeVisible();
  await clickable.getByRole('button', { name: 'Отмена' }).click();

  // Клавиатура делает то же самое.
  await clickable.focus();
  await clickable.press('Enter');
  await expect(clickable).toHaveAttribute('data-selected', '1');
  await clickable.press('Enter');
  await expect(clickable).toHaveAttribute('data-selected', 'no');

  // 6. Требующий внимания заказ: красный в списке, названа причина и действие.
  const attention = page.locator('[data-testid="deal-card"][data-order-number="E2E-РАБ-1"]');
  await expect(attention).toHaveAttribute('data-attention', 'yes');
  await expect(attention.getByTestId('deal-attention')).toContainText('Не распознан интервал');
  await expect(attention.getByTestId('deal-attention-action')).toHaveText('Задать интервал');

  // 7. Готовность к отправке видна словом в списке.
  const assembled = page.locator('[data-testid="deal-card"][data-order-number="E2E-РАБ-2"]');
  await expect(assembled.getByTestId('deal-assembled')).toHaveText('Собран');

  /*
   * 1а. Одна рабочая поверхность из двух соединённых панелей.
   *
   * Отдельного ряда фильтров над панелями нет: всё, что относится к списку,
   * лежит внутри левой панели, всё, что относится к карте, — поверх холста.
   */
  const boxOf = async (
    selector: string,
  ): Promise<{ x: number; y: number; w: number; h: number }> => {
    const box = await page.locator(selector).first().boundingBox();
    return { x: box?.x ?? 0, y: box?.y ?? 0, w: box?.width ?? 0, h: box?.height ?? 0 };
  };

  const leftBox = await boxOf('[data-testid="deals-column"]');
  const rightBox = await boxOf('[data-testid="deals-map-column"]');
  const leftEdge = leftBox.x + leftBox.w;

  // Панели начинаются и заканчиваются на одних линиях.
  expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftBox.y + leftBox.h - (rightBox.y + rightBox.h))).toBeLessThanOrEqual(1);
  // Между ними ровно один шаг сетки (--space-3): панели разделяет промежуток
  // и собственная тень каждой, общей рамки вокруг нет.
  expect(rightBox.x - leftEdge).toBeGreaterThanOrEqual(11);
  expect(rightBox.x - leftEdge).toBeLessThanOrEqual(13);

  // Всё управление списком — внутри левой панели.
  for (const selector of [
    '[data-testid="deals-day"]',
    '[data-testid="deals-search"]',
    '[data-testid="deals-include-drafts"]',
    '[data-testid="deals-total"]',
    '[data-testid="deals-select-all"]',
    '[data-testid="deals-scroll"]',
  ]) {
    const box = await boxOf(selector);
    expect(box.x).toBeGreaterThanOrEqual(leftBox.x - 1);
    expect(box.x + box.w).toBeLessThanOrEqual(leftEdge + 1);
    expect(box.y).toBeGreaterThanOrEqual(leftBox.y - 1);
  }

  // Шапка карты держится одной строкой: слева — что показано, справа — чем менять.
  const infoRow = await boxOf('[data-testid="deals-map-head-count"]');
  const controlRow = await boxOf('[data-testid="deals-map-from"]');
  expect(infoRow.x + infoRow.w).toBeLessThanOrEqual(controlRow.x);
  const headOneRow =
    infoRow.y < controlRow.y + controlRow.h && controlRow.y < infoRow.y + infoRow.h;
  expect(headOneRow).toBe(true);

  // Шапка — над холстом, легенда — подписью под ним: холст ничем не перекрыт.
  const canvas = await boxOf('[data-testid="deals-map-canvas"]');
  for (const selector of [
    '[data-testid="deals-map-head-count"]',
    '[data-testid="deals-map-from"]',
  ]) {
    const box = await boxOf(selector);
    expect(box.y + box.h).toBeLessThanOrEqual(canvas.y + 1);
  }
  const legend = await boxOf('[data-testid="deals-map-legend"]');
  expect(legend.y).toBeGreaterThanOrEqual(canvas.y + canvas.h - 1);
  // Масштаб — во второй строке шапки, холст ничем не перекрыт.
  const zoom = await boxOf('[data-testid="deals-map-zoom"]');
  expect(zoom.y + zoom.h).toBeLessThanOrEqual(canvas.y + 1);

  // Холст лежит внутри панели с равными полями и занимает её основную высоту.
  const insetLeft = canvas.x - rightBox.x;
  const insetRight = rightBox.x + rightBox.w - (canvas.x + canvas.w);
  expect(insetLeft).toBeGreaterThanOrEqual(0);
  expect(insetLeft).toBeLessThanOrEqual(20);
  expect(Math.abs(insetLeft - insetRight)).toBeLessThanOrEqual(1);
  expect(canvas.h / rightBox.h).toBeGreaterThanOrEqual(0.6);
  expect(canvas.y + canvas.h).toBeLessThanOrEqual(rightBox.y + rightBox.h + 1);

  // 7а. Плотность списка: сколько сделок видно в начале списка без прокрутки.
  await scroll.evaluate((element: { scrollTop: number }) => {
    element.scrollTop = 0;
  });
  const visibleCards = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: {
          querySelector: (selector: string) => {
            getBoundingClientRect: () => { top: number; bottom: number };
          } | null;
          querySelectorAll: (selector: string) => ArrayLike<{
            getBoundingClientRect: () => { top: number; bottom: number };
          }>;
        };
      }
    ).document;
    const area = doc.querySelector('[data-testid="deals-scroll"]');
    if (area === null) {
      return 0;
    }
    const window_ = area.getBoundingClientRect();
    return Array.from(doc.querySelectorAll('[data-testid="deal-card"]')).filter((card) => {
      const box = card.getBoundingClientRect();
      return box.top >= window_.top - 1 && box.bottom <= window_.bottom + 1;
    }).length;
  });
  // Полезная высота окна списка: измеряется, а не предполагается.
  const geometry = await page.evaluate(() => {
    const doc = (
      globalThis as unknown as {
        document: {
          querySelector: (s: string) => { getBoundingClientRect: () => { height: number } } | null;
        };
      }
    ).document;
    const area = doc.querySelector('[data-testid="deals-scroll"]');
    return { window: area?.getBoundingClientRect().height ?? 0 };
  });
  expect(geometry.window).toBeGreaterThan(600);
  /*
   * Плотность принятой карточки: на 1600×900 в окно списка помещается 5 карточек.
   * Прежние 10–12 относились к карточке вдвое ниже; нынешняя высота — 102 px,
   * у карточек с дополнительной строкой — 150 px. Верхняя граница высоты стоит
   * рядом, чтобы дальнейший рост карточки падал заметно, а не тихо.
   */
  expect(visibleCards).toBeGreaterThanOrEqual(5);
  const cardHeight = (await page.getByTestId('deal-card').first().boundingBox())?.height ?? 0;
  expect(cardHeight).toBeLessThanOrEqual(160);

  // 8. Переключатель группировки назван действием, а не масштабом.
  await expect(page.getByTestId('deals-map-zoom')).toHaveText(/Показать отдельно|Сгруппировать/);

  // 8а. Верхняя строка — сама навигация раздела, второго ряда нет.
  const tabs = page.getByTestId('logistics-tabs');
  await expect(tabs).toBeVisible();
  for (const name of ['Сделки', 'Маршрутизация', 'Маршрутные листы', 'История', 'Отчёты']) {
    await expect(tabs.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(tabs.getByRole('link', { name: 'Сделки', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Ровно один ряд: прежний дублирующий ряд вкладок удалён.
  await expect(page.locator('nav[aria-label="Разделы логистики"]')).toHaveCount(1);

  // 2а. Геометрия контролов карты не зависит от данных и обновлений.
  const geometryBefore = await Promise.all([
    page.getByTestId('deals-map-from').boundingBox(),
    page.getByTestId('deals-map-to').boundingBox(),
    page.getByTestId('deals-map-zoom').boundingBox(),
  ]);
  await page.getByTestId('deals-map-zoom').click();
  const geometryAfter = await Promise.all([
    page.getByTestId('deals-map-from').boundingBox(),
    page.getByTestId('deals-map-to').boundingBox(),
    page.getByTestId('deals-map-zoom').boundingBox(),
  ]);
  for (let index = 0; index < geometryBefore.length; index += 1) {
    expect(geometryAfter[index]?.x).toBe(geometryBefore[index]?.x);
    expect(geometryAfter[index]?.y).toBe(geometryBefore[index]?.y);
  }

  // 9. Поля времени карты применяются кнопкой «Применить» или Enter, а не самим
  //    вводом; и сужают они только карту — список остаётся прежним.
  const cardsBefore = await page.locator('[data-testid="deal-card"]').count();
  await page.getByTestId('deals-map-from').fill('20:00');
  // Один только ввод ничего не применяет: карта показывает прежний отбор.
  await expect(page.getByTestId('deals-map-head-count')).not.toContainText('скрыто фильтром');
  // Enter в поле времени применяет значение — карта сужается.
  await page.getByTestId('deals-map-from').press('Enter');
  await expect(page.getByTestId('deals-map-head-count')).toContainText('скрыто фильтром');
  // Список при этом не изменился: время сужает только карту.
  expect(await page.locator('[data-testid="deal-card"]').count()).toBe(cardsBefore);

  // Применённый фильтр переживает перезагрузку страницы: он сохранён по userId,
  // а не живёт лишь в памяти вкладки.
  await page.reload();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  await expect(page.getByTestId('deals-map-from')).toHaveValue('20:00');
  await expect(page.getByTestId('deals-map-head-count')).toContainText('скрыто фильтром');

  // «Сбросить» очищает применённое значение и стирает сохранённое — и это тоже
  // переживает перезагрузку: фильтр не возвращается.
  await page.getByTestId('deals-map-reset').click();
  await expect(page.getByTestId('deals-map-from')).toHaveValue('');
  await expect(page.getByTestId('deals-map-head-count')).not.toContainText('скрыто фильтром');
  await page.reload();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();
  await expect(page.getByTestId('deals-map-from')).toHaveValue('');
  await expect(page.getByTestId('deals-map-head-count')).not.toContainText('скрыто фильтром');

  // 4а. Одна кнопка с двумя состояниями: выбрать весь отбор и снять его.
  const selectAll = page.getByTestId('deals-select-all');
  await expect(selectAll).toHaveText('Выбрать все');
  await selectAll.click();
  await expect(page.getByTestId('deals-selected-count')).toContainText('Выбрано: 39');
  await expect(selectAll).toHaveText('Снять все');
  await selectAll.click();
  await expect(page.getByTestId('deals-manual-draft')).toBeDisabled();
  await expect(page.getByTestId('deals-auto-plan')).toBeDisabled();
  await expect(selectAll).toHaveText('Выбрать все');

  // 9а. Комментарий раскрывается доступной иконкой, а не отдельной строкой.
  const commented = page.locator('[data-testid="deal-card"][data-order-number="E2E-РАБ-3"]');
  const toggle = commented.getByTestId('deal-comment-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAccessibleName(/комментарий/i);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // 10. Телефон: обе части на месте и страница не едет вбок.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('deals-list')).toBeVisible();
  await expect(page.getByTestId('deals-map')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);

  await context.close();
});

/**
 * Правка в одном сеансе доходит до другого сама.
 *
 * Перезагрузки здесь нет намеренно: проверяется именно канал событий и то,
 * что экран «Сделок» на него подписан. Прежде таблица подписок вела события
 * заказа на ключи, которых на живых экранах нет, и список молчал до F5.
 */
test('«Сделки»: правка интервала доходит до второго сеанса без перезагрузки', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const [number] = seedOrders(1, { withPoint: true });
  expect(number).toBeTruthy();

  const first = await browser.newContext();
  const second = await browser.newContext();
  const editor = await first.newPage();
  const watcher = await second.newPage();

  const openDeals = async (target: Page): Promise<void> => {
    await login(target, ADMIN_PHONE, ADMIN_PIN);
    await openSection(target, 'Логистика');
    await target.getByRole('link', { name: 'Сделки' }).first().click();
    await expect(target.getByTestId('deals-workspace')).toBeVisible();
    await target.getByLabel('Поиск в этом дне').fill(number ?? '');
    await target.getByLabel('Поиск в этом дне').press('Enter');
  };

  await openDeals(editor);
  await openDeals(watcher);

  const watched = watcher.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
  await expect(watched).toBeVisible();

  // Метка живёт в самом окне: перезагрузка страницы её сбросила бы.
  await watcher.evaluate((value: string) => {
    (globalThis as { name?: string }).name = value;
  }, RELOAD_SENTINEL);

  const edited = editor.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
  await edited.getByTestId('deal-edit-interval').click();
  await edited.getByTestId('deal-interval-from').fill('09:00');
  await edited.getByTestId('deal-interval-to').fill('11:00');
  await edited.getByTestId('deal-interval-save').click();

  // Второй сеанс узнаёт об изменении сам.
  await expect(watched).toContainText('09:00–11:00', { timeout: 30_000 });
  expect(await watcher.evaluate(() => (globalThis as { name?: string }).name)).toBe(
    RELOAD_SENTINEL,
  );

  await first.close();
  await second.close();
});

/**
 * Критический контракт карты: место заказа задаёт география, а не экран.
 *
 * Масштаб меняет только проекцию. Проверяется после каждого масштабирования,
 * сдвига, изменения размера окна и переключения группировки: координата
 * доменного объекта не изменилась, а центр кружка совпал с тем, куда эту
 * координату проецирует сама MapLibre.
 *
 * ГРАНИЦА СЦЕНАРИЯ. Точки и подложка подменены: проверяется геометрия, а не
 * содержимое дня. Проекцию считает настоящая MapLibre — её здесь не подменяют,
 * иначе ошибка кода совпала бы с ошибкой проверки.
 */
test('карта «Сделок»: отметка стоит на своей координате при любом масштабе', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const styleUrl = 'https://maps.local.test/deals-geometry.json';
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

  const LNG = 37.617_3;
  const LAT = 55.755_8;
  await page.route(
    (url) => url.pathname === '/api/deals/map',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          points: [
            {
              orderId: '00000000-0000-4000-8000-00000000ab01',
              number: 'E2E-ГЕО',
              address: 'Москва, Красная площадь, 1',
              lat: String(LAT),
              lon: String(LNG),
              startMinute: 600,
              endMinute: 720,
              assembled: false,
              selectable: true,
            },
          ],
          deliveryDate: '2026-08-15',
        }),
      }),
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-map-canvas')).toBeVisible();

  // Отметка заказа, а не склада: у склада своя отметка и нет заказа.
  const marker = page.locator('[data-testid="map-marker"][data-order-id]').first();
  await expect(marker).toBeVisible();
  // Заодно видно, что склад показан отдельной отметкой (пункт 12).
  await expect(page.locator('[data-testid="map-marker"]:not([data-order-id])')).toHaveCount(1);

  /** Расхождение центра кружка с проекцией координаты, в пикселях. */
  const drift = async (): Promise<{ dx: number; dy: number; lng: number; lat: number }> => {
    await page.waitForTimeout(150);
    const box = await marker.boundingBox();
    const lng = Number(await marker.getAttribute('data-lng'));
    const lat = Number(await marker.getAttribute('data-lat'));
    const projected = await page.evaluate(
      ([lngValue, latValue]: [number, number]) => {
        const map = (
          globalThis as unknown as {
            __dealsMap: { project: (lngLat: [number, number]) => { x: number; y: number } };
          }
        ).__dealsMap;
        const point = map.project([lngValue, latValue]);
        return { x: point.x, y: point.y };
      },
      [lng, lat] as [number, number],
    );
    const canvas = await page.getByTestId('deals-map-canvas').boundingBox();
    const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2 - (canvas?.x ?? 0);
    const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2 - (canvas?.y ?? 0);
    return { dx: centerX - projected.x, dy: centerY - projected.y, lng, lat };
  };

  const zoomBy = async (delta: number): Promise<void> => {
    await page.evaluate((value: number) => {
      const map = (
        globalThis as unknown as {
          __dealsMap: { setZoom: (z: number) => void; getZoom: () => number };
        }
      ).__dealsMap;
      map.setZoom(map.getZoom() + value);
    }, delta);
  };

  const start = await drift();
  expect(start.lng).toBeCloseTo(LNG, 6);
  expect(start.lat).toBeCloseTo(LAT, 6);
  // Один и тот же допуск на всех шагах: полпикселя округления, не больше.
  expect(Math.abs(start.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(start.dy)).toBeLessThanOrEqual(1);

  for (const step of [4, -2, -3, 5]) {
    await zoomBy(step);
    const after = await drift();
    // Координата доменного объекта неизменна: масштаб её не касается.
    expect(after.lng).toBe(start.lng);
    expect(after.lat).toBe(start.lat);
    expect(Math.abs(after.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.dy)).toBeLessThanOrEqual(1);
  }

  // Сдвиг карты.
  await page.evaluate(() => {
    const map = (
      globalThis as unknown as {
        __dealsMap: { panBy: (offset: [number, number], options: { duration: number }) => void };
      }
    ).__dealsMap;
    map.panBy([180, -120], { duration: 0 });
  });
  const afterPan = await drift();
  expect(afterPan.lng).toBe(start.lng);
  expect(Math.abs(afterPan.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPan.dy)).toBeLessThanOrEqual(1);

  // Изменение размера окна.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => {
    (globalThis as unknown as { __dealsMap: { resize: () => void } }).__dealsMap.resize();
  });
  const afterResize = await drift();
  expect(afterResize.lat).toBe(start.lat);
  expect(Math.abs(afterResize.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterResize.dy)).toBeLessThanOrEqual(1);

  // Переключение группировки.
  await page.getByTestId('deals-map-zoom').click();
  const afterToggle = await drift();

  expect(afterToggle.lng).toBe(start.lng);
  expect(afterToggle.lat).toBe(start.lat);
  expect(Math.abs(afterToggle.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterToggle.dy)).toBeLessThanOrEqual(1);

  await context.close();
});

/**
 * Линия маршрута: строится от склада и меняется вместе с порядком.
 *
 * ГРАНИЦА СЦЕНАРИЯ. Подменён ТОЛЬКО транспорт маршрутизатора
 * (`VALHALLA_TEST_ROUTE=true`, разрешён лишь при `APP_ENV=local`): дорожного
 * графа в проверке нет. Клиент Valhalla, разбор закодированной геометрии,
 * серверный контракт и отрисовка слоя — настоящие.
 */
test('маршрутизация: линия идёт от склада и меняется вместе с порядком', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const [first, second] = seedOrders(2, { withPoint: true });
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();

  /*
   * Подложка — пустой валидный стиль.
   *
   * Проверяется линия маршрута, а не отрисовка тайлов: крошечный проверочный
   * набор PMTiles отдаёт не все запрошенные тайлы, карта честно сообщает
   * об отказе подложки и снимает слои вместе с собой. Внешних обращений
   * при этом по-прежнему нет.
   */
  const styleUrl = 'https://maps.local.test/routing-line.json';
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
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();

  for (const number of [first, second]) {
    await page.getByLabel('Поиск в этом дне').fill(number ?? '');
    await page.getByLabel('Поиск в этом дне').press('Enter');
    const card = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('deal-pick').click();
  }

  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);

  /**
   * Линия, которую слой получил последней.
   *
   * Спрашивается сама карта: отрисованные объекты видит только тот, кто попал
   * в кадр, а описание источника возвращает данные его создания — и то и другое
   * скрывало бы именно то, что проверка обязана поймать.
   */
  const drawnLine = async (): Promise<string> =>
    page.evaluate(() => {
      const map = (globalThis as unknown as { __routingMap?: { __routeLine?: unknown } })
        .__routingMap;
      return JSON.stringify(map?.__routeLine ?? []);
    });

  // 1. Сервер построил линию: столько точек пришло в браузер.
  await expect
    .poll(
      async () => Number(await page.getByTestId('route-line-points').getAttribute('data-points')),
      { timeout: 45_000 },
    )
    .toBeGreaterThan(2);

  // 2. Склад показан отдельной отметкой: маршрут начинается с него.
  await expect(page.locator('[data-testid="map-depot"]')).toHaveCount(1);

  /*
   * 3. Линия действительно нарисована, а не только получена.
   *
   * Срок с запасом: в полном наборе машина занята, и первая отрисовка карты
   * законно занимает дольше, чем в одиночном прогоне. Проверяется факт, а не
   * скорость.
   */
  /*
   * Карта отдаляется до города.
   *
   * Отрисованные объекты видит только тот, кто попал в кадр: склад и остановки
   * фикстуры могут стоять дальше друг от друга, чем видно на стартовом
   * масштабе, и проверка доказывала бы не отсутствие линии, а край экрана.
   */
  await page.evaluate(() => {
    (
      globalThis as unknown as { __routingMap?: { setZoom: (value: number) => void } }
    ).__routingMap?.setZoom(8);
  });
  await expect.poll(async () => (await drawnLine()).length, { timeout: 45_000 }).toBeGreaterThan(2);
  const before = await drawnLine();

  const stops = page.locator('.routes__card [data-testid="route-stop"]');
  await expect(stops).toHaveCount(2);
  const firstBefore = await stops.first().innerText();

  // 4. Порядок меняется перетаскиванием — той же атомарной операцией.
  await stops.nth(0).dragTo(stops.nth(1));
  await expect(stops.first()).toContainText(second ?? '');

  // 5. Линия догоняет новый порядок: иначе карта показывала бы прежний
  //    маршрут как действующий.
  await expect.poll(async () => (await drawnLine()) !== before, { timeout: 45_000 }).toBe(true);
  expect(firstBefore).not.toBe(await stops.first().innerText());

  /*
   * 6. Одна цельная рабочая поверхность, как в «Сделках».
   *
   * Проверяется геометрия, а не наличие классов: панели начинаются от общей
   * верхней линии, между ними нет зазора, карта занимает всю высоту своей
   * половины, а служебная строка лежит внутри полотна, а не над ним.
   */
  await page.setViewportSize({ width: 1600, height: 900 });
  const [list, mapPanel, surface, header] = await Promise.all([
    page.getByTestId('routing-drafts').boundingBox(),
    page.getByTestId('routing-map-panel').boundingBox(),
    page.getByTestId('routing-map-surface').boundingBox(),
    page.locator('.routes__map-header').boundingBox(),
  ]);

  expect(Math.abs((list?.y ?? 0) - (mapPanel?.y ?? -1))).toBeLessThanOrEqual(1);
  expect(Math.abs((list?.height ?? 0) - (mapPanel?.height ?? -1))).toBeLessThanOrEqual(1);
  /*
   * Та же геометрия, что в «Сделках»: список — clamp(460px, 38%, 760px),
   * между половинами ровно один шаг сетки (--space-3).
   */
  const routesGap = (mapPanel?.x ?? 0) - ((list?.x ?? 0) + (list?.width ?? 0));
  expect(routesGap).toBeGreaterThanOrEqual(11);
  expect(routesGap).toBeLessThanOrEqual(13);
  expect(list?.width ?? 0).toBeGreaterThanOrEqual(460);
  expect(list?.width ?? 0).toBeLessThanOrEqual(760);

  expect(surface?.height ?? 0).toBeGreaterThan(400);
  expect((surface?.y ?? 0) + (surface?.height ?? 0)).toBeLessThanOrEqual(901);
  // Шапка карты стоит НАД холстом и его не перекрывает.
  expect((header?.y ?? 0) + (header?.height ?? 0)).toBeLessThanOrEqual((surface?.y ?? 0) + 1);

  /*
   * 7. Свёрнутый черновик — только шапка по макету: номер, состояние,
   * «дата · машина · остановок N» и ряд блокировки. Остановки при этом
   * убраны из разметки, а не спрятаны высотой, — поэтому карточка
   * заметно ниже развёрнутой.
   */
  const expandedDraft = page.locator('.routes__draft[data-expanded="true"]').first();
  const expandedHeight = (await expandedDraft.boundingBox())?.height ?? 0;
  await expandedDraft.locator('.routes__draft-head').click();
  const collapsed = page.locator('.routes__draft[data-expanded="false"]').first();
  await expect(collapsed).toBeVisible();
  await expect(collapsed.locator('.routes__card')).toHaveCount(0);
  const collapsedHeight = (await collapsed.boundingBox())?.height ?? 0;
  expect(collapsedHeight).toBeLessThan(expandedHeight / 2);
});

/**
 * Маршрутные листы: три раздела, дни, назначение курьера, отгрузка и отмена.
 *
 * Сквозной путь A+B+C одним сценарием: сделки → диалог → маршрутный лист →
 * курьер → ручная отгрузка → отмена отгрузки. Ни один шаг не подменён:
 * это те же серверные операции, которыми пользуется логист.
 */
test('маршрутные листы: разделы, курьер, ручная отгрузка и отмена', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const [own] = seedOrders(1, { withPoint: true });
  expect(own).toBeTruthy();
  // Действующий курьер обязан существовать: без него отгружать нечем.
  await ensureCourier(page.context().browser() as Browser);

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();

  // 1. Сделки → диалог → сразу маршрутный лист (сквозной сценарий 2).
  await page.getByLabel('Поиск в этом дне').fill(own ?? '');
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${own}"]`);
  await expect(card).toBeVisible();
  await card.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-sheet').click();
  await expect(page).toHaveURL(/\/logistics\/route-sheets/);

  /*
   * Поиск по номеру заказа изолирует ИМЕННО наш лист.
   *
   * Соседние сценарии оставляют свои неотгруженные листы, и «первая строка
   * раздела» доказывала бы не то: сценарий обязан работать со своим листом,
   * а не с тем, который случайно оказался сверху.
   */
  await page.getByTestId('sheets-search').fill(own ?? '');

  // 2. Три раздела существуют и различимы.
  for (const section of ['UNSHIPPED', 'SHIPPED', 'DELIVERED']) {
    await expect(page.getByTestId(`sheets-${section}`)).toBeVisible();
  }

  // 3. Лист без курьера: отгрузка недоступна и причина названа.
  const unshipped = page.getByTestId('sheets-UNSHIPPED');
  const sheet = unshipped.locator('[data-testid="sheet-row"]').first();
  await expect(sheet).toBeVisible();
  /*
   * Курьер в листе показан таблеткой: пока его нет, она прямо это и говорит.
   * Поле с подсказками открывается по нажатию на таблетку, а не висит всегда.
   */
  await expect(sheet.getByTestId('sheet-courier-pick')).toHaveText(/Курьер не назначен/);
  await expect(sheet.getByTestId('sheet-ship')).toBeDisabled();

  /*
   * 3а. Свёрнутый лист не прячет пустое тело, а раскрытый показывает состав.
   *
   * Проверяется именно наш заказ: без этого «какие заказы внутри» оставалось бы
   * вопросом, ответ на который есть только в печатной форме.
   */
  await expect(sheet).toHaveAttribute('data-expanded', 'false');
  await expect(sheet.getByTestId('sheet-orders')).toHaveCount(0);
  await sheet.getByTestId('sheet-expand').click();
  await expect(sheet.getByTestId('sheet-orders')).toBeVisible();
  await expect(sheet.locator(`[data-order-number="${own}"]`)).toBeVisible();

  /*
   * 3б. Номер заказа открывает окно со всей информацией.
   *
   * Проверяется и то, что деньги показаны только для чтения: их правит
   * МойСклад, и кнопки изменения у них быть не должно.
   */
  await sheet.locator(`[data-order-number="${own}"]`).getByTestId('order-number').click();
  const orderWindow = page.getByTestId('order-window');
  await expect(orderWindow).toBeVisible();
  await expect(orderWindow).toContainText('Сумма');
  await expect(orderWindow).toContainText('меняется в МоёмСкладе');
  await expect(orderWindow.getByTestId('order-window-address')).toBeVisible();
  await expect(orderWindow.getByTestId('order-window-interval')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).first().click();
  await expect(orderWindow).toHaveCount(0);

  await sheet.getByTestId('sheet-expand').click();
  await expect(sheet.getByTestId('sheet-orders')).toHaveCount(0);

  /*
   * 4. Курьер назначается прямо в листе.
   *
   * Берётся любой ДЕЙСТВУЮЩИЙ курьер из списка: соседний сценарий замораживает
   * своего, и жёсткая привязка к конкретному телефону доказывала бы лишь
   * порядок сценариев.
   */
  await sheet.getByTestId('sheet-courier-pick').click();
  await sheet.getByTestId('sheet-courier-combobox-field').click();
  // Список подсказок выносится порталом, чтобы не обрезаться прокруткой листа,
  // поэтому ищется на странице, а не внутри строки.
  const options = page.getByTestId('sheet-courier-combobox-option');
  await expect(options.first()).toBeVisible();
  await options.first().click();
  // Выбор закрывает поле и возвращает таблетку — уже с именем курьера.
  await expect(sheet.getByTestId('sheet-courier-pick')).not.toHaveText(/Курьер не назначен/);

  // 5. После назначения ручная отгрузка проходит.
  await expect(sheet.getByTestId('sheet-ship')).toBeEnabled();
  const sheetNumber = (await sheet.getAttribute('data-sheet-number')) ?? '';
  await sheet.getByTestId('sheet-ship').click();

  const shipped = page.getByTestId('sheets-SHIPPED');
  const shippedRow = shipped.locator(`[data-sheet-number="${sheetNumber}"]`);
  await expect(shippedRow).toBeVisible({ timeout: 20_000 });

  // 6. Отмена отгрузки без доставленных заказов: обычное подтверждение.
  await shippedRow.getByTestId('sheet-cancel-shipment').click();
  await expect(page.getByTestId('cancel-shipment-dialog')).toBeVisible();
  await page.getByTestId('cancel-confirm').click();

  await expect(unshipped.locator(`[data-sheet-number="${sheetNumber}"]`)).toBeVisible({
    timeout: 20_000,
  });

  // 7. Поиск работает на полном серверном наборе: и по номеру заказа
  //    (им мы пользовались всё время), и по номеру самого листа.
  await page.getByTestId('sheets-search').fill(sheetNumber);
  await expect(unshipped.locator('[data-testid="sheet-row"]')).toHaveCount(1);

  // 8. Телефон: разделы и действия остаются доступны, страница не едет вбок.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('sheets-UNSHIPPED')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } };
      }
    ).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * Выбор курьера: один контрол на всех вкладках.
 *
 * Проверяется поведение, а не оформление: поле открывает список, ввод его
 * сужает, выбор закрывает, Escape закрывает без изменения, клик снаружи тоже
 * закрывает, а список не растягивает карточку.
 */
test('выбор курьера: открытие полем, фильтрация вводом, Escape и клик снаружи', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const [own] = seedOrders(1, { withPoint: true });
  expect(own).toBeTruthy();
  await ensureCourier(page.context().browser() as Browser);

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByLabel('Поиск в этом дне').fill(own ?? '');
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${own}"]`);
  await expect(card).toBeVisible();
  await card.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();

  const field = page.getByTestId('create-route-courier-field');
  const list = page.getByTestId('create-route-courier-list');

  // 1. Список закрыт, пока в поле не нажали.
  await expect(list).toHaveCount(0);

  // 2. Нажатие в поле открывает список, а первой строкой идёт «не назначен».
  await field.click();
  await expect(list).toBeVisible();
  await expect(page.getByTestId('create-route-courier-clear')).toBeVisible();
  /*
   * Строки списка ждутся локатором, а не считаются сразу.
   *
   * Список рисуется раньше, чем приходит справочник курьеров: `count()`
   * не ждёт, и на загруженной машине проверка получала ноль там, где
   * курьер есть. Считалась бы скорость ответа, а не поведение поля.
   */
  await expect(page.getByTestId('create-route-courier-option').first()).toBeVisible();
  const total = await page.getByTestId('create-route-courier-option').count();
  expect(total).toBeGreaterThan(0);

  // 3. Ввод сужает список, не закрывая его.
  await field.fill('Курьер');
  await expect(list).toBeVisible();
  const filtered = await page.getByTestId('create-route-courier-option').count();
  expect(filtered).toBeLessThanOrEqual(total);

  // 4. Заведомо несуществующий запрос оставляет честное сообщение.
  await field.fill('такого курьера нет');
  await expect(page.getByTestId('create-route-courier-nothing')).toBeVisible();

  // 5. Escape закрывает и НИЧЕГО не выбирает.
  await field.press('Escape');
  await expect(list).toHaveCount(0);
  // Ничего не выбрано: поле пусто, а значит назначения нет.
  await expect(field).toHaveValue('');

  // 6. Выбор строки закрывает список и подставляет курьера в поле.
  await field.click();
  await page.getByTestId('create-route-courier-option').first().click();
  await expect(list).toHaveCount(0);
  await expect(field).not.toHaveValue('');

  // 7. Клик вне списка закрывает его.
  await field.click();
  await expect(list).toBeVisible();
  await page.getByTestId('create-route-count').click();
  await expect(list).toHaveCount(0);
});

/**
 * Логист для кассы.
 *
 * Наличные лежат у конкретного человека: без сотрудника с ролью логиста
 * кассы не существует вовсе, и передавать деньги некуда.
 */
async function seedOwnLogist(page: Page, token: string): Promise<{ id: string; fullName: string }> {
  const phone = uniquePhone();
  const fullName = 'Логист кассы';

  const created = await page.request.post('/api/users', {
    headers: { authorization: `Bearer ${token}` },
    data: { fullName, phone, roles: ['LOGISTICIAN'] },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { user: { id: string }; activationCode: string };

  const activated = await page.request.post('/api/auth/activate', {
    data: { phone, code: body.activationCode, pin: '9753' },
  });
  expect(activated.status()).toBe(200);

  return { id: body.user.id, fullName };
}

/**
 * Отдельный курьер для этого сценария.
 *
 * Общий курьер набора не годится: соседняя проверка его замораживает, и он
 * пропадает из списка действующих — маршрут достался бы другому человеку,
 * а экран курьера оказался бы пуст. Заводится через тот же API, которым
 * пользуется администратор.
 */
async function seedOwnCourier(
  page: Page,
  token: string,
): Promise<{ phone: string; pin: string; fullName: string }> {
  const phone = uniquePhone();
  const fullName = 'Курьер отчётов';

  const created = await page.request.post('/api/users', {
    headers: { authorization: `Bearer ${token}` },
    data: { fullName, phone, roles: ['COURIER'], defaultVehicleType: 'CAR' },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { activationCode: string };

  const activated = await page.request.post('/api/auth/activate', {
    data: { phone, code: body.activationCode, pin: COURIER_PIN },
  });
  expect(activated.status()).toBe(200);

  return { phone, pin: COURIER_PIN, fullName };
}

/**
 * «История» и «Отчёты»: журнал прошлого и расчёты с курьером.
 *
 * ГРАНИЦА СЦЕНАРИЯ. Подменяются только те же локальные флаги, что и раньше
 * (решатель, подсказки, маршрутизатор). Деньги, тарифы и учёт настоящие:
 * тариф заводится через API администратора, учёт включается им же, а
 * начисления делает сам продукт при доставке.
 */
test('история и отчёты: тариф, доставка, расчёт с курьером и выгрузки', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const [own] = seedOrders(1, { withPoint: true });
  expect(own).toBeTruthy();

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  /*
   * Тариф и включение учёта заводятся через API администратора.
   *
   * Экран настройки тарифов — отдельная работа; здесь важно, что ставки
   * задаёт человек с правом ADMIN, а не сеялка и не значение по умолчанию.
   */
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()),
  );

  /*
   * Запросы идут через контекст страницы с настоящим токеном.
   *
   * Токен приложения живёт в памяти вкладки и в браузерный `fetch` сам собой
   * не попадает: без явного заголовка сервер честно отвечает 401, и проверка
   * доказывала бы только это.
   */
  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  expect(auth.status()).toBe(200);
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const authorized = { authorization: `Bearer ${token}` };

  const courier = await seedOwnCourier(page, token);
  const logist = await seedOwnLogist(page, token);

  /*
   * Тариф, включение учёта и геометрия МКАД заводятся ЭКРАНОМ настроек:
   * проверяется тот путь, которым пользуется администратор, а не только API.
   */
  await openSection(page, 'Настройки');
  await expect(page.getByTestId('finance-settings')).toBeVisible();

  await page.getByTestId('tariff-from').fill(today);
  await page.getByTestId('tariff-per-order').fill('200');
  await page.getByTestId('tariff-per-km').fill('30');
  await page.getByTestId('tariff-note').fill('проверочный тариф');
  await page.getByTestId('tariff-submit').click();
  await expect(page.getByTestId('tariff-list')).toContainText('200,00 ₽');

  await page.getByTestId('finance-activation-date').fill(today);
  await page.getByTestId('finance-activate').click();
  await expect(page.getByTestId('finance-ledger-off')).toHaveCount(0);

  /*
   * Геометрия МКАД приходит с поставкой: загрузки через интерфейс нет.
   * Настройки показывают только состояние — версию, источник и лицензию.
   */
  const mkad = page.getByTestId('mkad-active');
  await expect(mkad).toContainText('OpenStreetMap');
  await expect(mkad).toContainText('ODbL');
  // Отношение, датированный снимок и версия названы прямо на экране.
  await expect(mkad).toContainText('2094222');
  await expect(mkad).toContainText('geofabrik');
  await expect(page.getByTestId('mkad-sha')).toContainText('Отпечаток');

  /*
   * Управлять геометрией отсюда нельзя.
   *
   * Ни поля файла, ни кнопки загрузки: кольцо входит в поставку, и правятся
   * здесь только тариф и стоимость километра за МКАД.
   */
  const settings = page.getByTestId('finance-settings');
  await expect(settings.locator('input[type="file"]')).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /геометри/i })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /Загрузить/i })).toHaveCount(0);

  // 1. Обычный путь: сделка → лист → курьер → отгрузка.
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByLabel('Поиск в этом дне').fill(own ?? '');
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${own}"]`);
  await expect(card).toBeVisible();
  await card.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await page.getByTestId('create-route-sheet').click();
  await expect(page).toHaveURL(/\/logistics\/route-sheets/);

  await page.getByTestId('sheets-search').fill(own ?? '');
  const sheet = page.getByTestId('sheets-UNSHIPPED').locator('[data-testid="sheet-row"]').first();
  await expect(sheet).toBeVisible();
  /*
   * Курьер выбирается ИМЕННО тот, под которым дальше входит проверка.
   *
   * «Первый в списке» здесь не годится: соседние сценарии заводят своих
   * курьеров, и маршрут достался бы чужому — экран курьера оказался бы пуст.
   */
  await sheet.getByTestId('sheet-courier-pick').click();
  await sheet.getByTestId('sheet-courier-combobox-field').fill(courier.phone);
  // Подсказки выносятся порталом: ищутся на странице, а не внутри строки.
  await expect(page.getByTestId('sheet-courier-combobox-option')).toHaveCount(1);
  await page.getByTestId('sheet-courier-combobox-option').first().click();
  await expect(sheet.getByTestId('sheet-ship')).toBeEnabled();
  const sheetNumber = (await sheet.getAttribute('data-sheet-number')) ?? '';
  await sheet.getByTestId('sheet-ship').click();
  await expect(
    page.getByTestId('sheets-SHIPPED').locator(`[data-sheet-number="${sheetNumber}"]`),
  ).toBeVisible({ timeout: 20_000 });

  // 2. Курьер сообщает результат: деньги в учёт попадают отсюда, а не из формы.
  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await login(courierPage, courier.phone, courier.pin);
  const courierCard = courierPage.locator(
    `[data-testid="delivery-order"][data-order-number="${own}"]`,
  );
  await expect(courierCard).toBeVisible({ timeout: 20_000 });
  await courierCard.getByTestId('delivery-open-delivered').click();
  // Подтверждение живёт в окне, а не в карточке: карточка только открывает его.
  await courierPage.getByTestId('delivery-submit').click();
  /*
   * Состояние карточки не проверяется: это единственный заказ маршрута, его
   * результат завершает маршрут, и список активных доставок пустеет. Факт
   * доставки доказывается дальше — в истории и в расчёте с курьером.
   */
  await expect(courierPage.locator('.toast-region')).toContainText('Маршрут завершён', {
    timeout: 20_000,
  });
  await courierContext.close();

  // 3. «История» показывает маршрут, его состав и хронологию.
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'История' }).first().click();
  await expect(page.getByTestId('history-screen')).toBeVisible();
  await page.getByTestId('history-search').fill(own ?? '');

  const historyRow = page.locator(
    `[data-testid="history-route"][data-route-number="${sheetNumber}"]`,
  );
  await expect(historyRow).toBeVisible({ timeout: 20_000 });
  await historyRow.getByTestId('history-expand').click();
  await expect(historyRow.locator(`[data-order-number="${own}"]`)).toBeVisible();
  await expect(historyRow.getByTestId('history-events')).toContainText('Отгружен курьеру');
  await expect(historyRow.getByTestId('history-events')).toContainText('Доставлен');

  // 4. «Отчёты»: расчёт с курьером и денежная операция.
  await page.getByRole('link', { name: 'Отчёты' }).first().click();
  await expect(page.getByTestId('reports-screen')).toBeVisible();
  await expect(page.getByTestId('reports-summary')).toBeVisible();

  /*
   * Иерархия: свёрнутая группа курьера с итогами дня, подробности —
   * по раскрытию.
   */
  const rows = page.getByTestId('reports-rows');
  const group = rows.locator(`[data-testid="reports-group"][data-group-date="${today}"]`).first();
  await expect(group).toBeVisible({ timeout: 20_000 });
  await expect(group).toHaveAttribute('data-expanded', 'false');
  await expect(rows.locator(`[data-order-number="${own}"]`)).toHaveCount(0);
  await expect(group).toContainText(courier.fullName);
  await expect(group).toContainText(courier.phone.replace(/\s/g, ''));

  await group.getByTestId('reports-group-toggle').click();
  await expect(rows.locator(`[data-order-number="${own}"]`)).toBeVisible();

  /*
   * Баланс до и после операции.
   *
   * Проверяется именно изменение: конкретная сумма зависит от наличных
   * фикстуры, а вот направление и факт учёта операции — нет.
   */
  const before = (await page.getByTestId('reports-closing').innerText()).trim();

  /*
   * Операции заводятся ИЗ ЯЧЕЙКИ: день и курьер берутся из строки, поэтому
   * ни того, ни другого выбирать не нужно. Универсальной кнопки больше нет.
   */
  await expect(page.getByTestId('reports-add-operation')).toHaveCount(0);

  await group.getByTestId('reports-cell-handed').click();
  await expect(page.getByTestId('cell-editor')).toBeVisible();
  // Администратор обязан назвать кассу: своей у него нет.
  await page.getByTestId('cell-desk').selectOption(logist.id);
  // Поле суммы работает как калькулятор: «1000+500=» даёт 1500.
  await page.getByTestId('cell-amount').fill('1000+500=');
  await expect(page.getByTestId('cell-preview')).toContainText('1500,00 ₽');
  await page.getByTestId('cell-submit').click();
  await expect(page.getByTestId('cell-editor')).toHaveCount(0);

  // Ячейка и итог пересчитались без перезагрузки страницы.
  await expect(group.getByTestId('reports-cell-handed')).toContainText('1500,00 ₽', {
    timeout: 20_000,
  });

  // Дополнительный расход требует пояснения.
  await group.getByTestId('reports-cell-expense').click();
  await page.getByTestId('cell-amount').fill('200');
  await page.getByTestId('cell-submit').click();
  await expect(page.getByTestId('cell-error')).toBeVisible();
  await page.getByTestId('cell-reason').fill('парковка у адреса');
  await page.getByTestId('cell-submit').click();
  // Отказ обязан быть назван словами, а не превратиться в тихое «ничего не произошло».
  await expect(page.getByTestId('cell-error')).toHaveCount(0);
  await expect(page.locator('.toast-region')).toContainText('Операция записана', {
    timeout: 20_000,
  });
  await expect(group.getByTestId('reports-cell-expense')).toContainText('200,00 ₽', {
    timeout: 20_000,
  });

  // Журнал платежей виден в раскрытой группе: вид, сумма и автор.
  const payments = page.getByTestId('reports-payment');
  await expect(payments.first()).toBeVisible();
  await expect(payments.filter({ hasText: 'Курьер сдал' })).toHaveCount(1);
  await expect(payments.filter({ hasText: 'Дополнительный расход' })).toHaveCount(1);

  const after = (await page.getByTestId('reports-closing').innerText()).trim();
  expect(after).not.toBe(before);

  // Те же операции видны в «Истории» с датой, временем, суммой и автором.
  await page.getByRole('link', { name: 'История' }).first().click();
  await expect(page.getByTestId('history-payments').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('history-payments').first()).toContainText('Курьер сдал');
  await expect(page.getByTestId('history-payments').first()).toContainText('1500,00 ₽');

  await page.getByRole('link', { name: 'Отчёты' }).first().click();
  await expect(page.getByTestId('reports-screen')).toBeVisible();

  const period = `from=${today}&to=${today}`;
  const xlsx = await page.request.get(`/api/logistics/reports/settlements.xlsx?${period}`, {
    headers: authorized,
  });
  const pdf = await page.request.get(`/api/logistics/reports/settlements.pdf?${period}`, {
    headers: authorized,
  });

  expect(xlsx.status()).toBe(200);
  expect(pdf.status()).toBe(200);
  // Сигнатуры файлов: XLSX — это zip, PDF — это PDF, а не страница с ошибкой.
  expect((await xlsx.body()).subarray(0, 2).toString('latin1')).toBe('PK');
  expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(pdf.headers()['content-type']).toContain('application/pdf');

  // 6. Операционные показатели считаются тем же периодом.
  await page.getByTestId('reports-mode-operations').click();
  await expect(page.getByTestId('operations-summary')).toBeVisible();
  await expect(page.getByTestId('operations-summary')).toContainText('Доставлено');

  /*
   * 6а. Касса логистов: полный цикл наличных.
   *
   * Проверяется, что одна фактическая передача существует на двух сторонах:
   * сдача курьера уже попала в кассу, из кассы можно взять и сдать деньги,
   * а отрицательный остаток невозможен.
   */
  await page.getByTestId('reports-mode-cash').click();
  await expect(page.getByTestId('cash-panel')).toBeVisible();
  await expect(page.getByTestId('cash-summary')).toContainText('Ожидается к сдаче');

  const cashGroup = page.getByTestId('cash-group').first();
  await expect(cashGroup).toBeVisible({ timeout: 20_000 });
  // Сдача курьера, записанная в расчётах, уже лежит в кассе логиста.
  await expect(cashGroup).toContainText('1500,00 ₽');

  await expect(cashGroup).toHaveAttribute('data-expanded', 'false');
  await cashGroup.getByTestId('cash-group-toggle').click();
  await expect(page.getByTestId('cash-entry').first()).toBeVisible();
  await expect(page.getByTestId('cash-entry').first()).toContainText('Получено от курьера');

  // Взять наличные из компании: тот же безопасный калькулятор.
  const cashBefore = (await page.getByTestId('cash-closing').innerText()).trim();
  await page.getByTestId('cash-take').click();
  await expect(page.getByTestId('cash-editor')).toBeVisible();
  await page.getByTestId('cash-amount').fill('900+100');
  await expect(page.getByTestId('cash-preview')).toContainText('1000,00 ₽');
  await page.getByTestId('cash-submit').click();
  await expect(page.getByTestId('cash-editor')).toHaveCount(0);
  await expect
    .poll(async () => (await page.getByTestId('cash-closing').innerText()).trim(), {
      timeout: 20_000,
    })
    .not.toBe(cashBefore);

  // Сдать больше, чем есть в кассе, нельзя.
  await page.getByTestId('cash-hand').click();
  await page.getByTestId('cash-amount').fill('1000000');
  await page.getByTestId('cash-submit').click();
  await expect(page.getByTestId('cash-error')).toContainText('недостаточно наличных');
  await page.getByTestId('cash-cancel').click();

  // Обычная сдача проходит и уменьшает остаток.
  const beforeHand = (await page.getByTestId('cash-closing').innerText()).trim();
  await page.getByTestId('cash-hand').click();
  await page.getByTestId('cash-amount').fill('500');
  await page.getByTestId('cash-submit').click();
  await expect
    .poll(async () => (await page.getByTestId('cash-closing').innerText()).trim(), {
      timeout: 20_000,
    })
    .not.toBe(beforeHand);

  // Выгрузки кассы — настоящие файлы.
  const cashXlsx = await page.request.get(
    `/api/logistics/reports/cash.xlsx?from=${today}&to=${today}`,
    { headers: authorized },
  );
  const cashPdf = await page.request.get(
    `/api/logistics/reports/cash.pdf?from=${today}&to=${today}`,
    { headers: authorized },
  );
  expect((await cashXlsx.body()).subarray(0, 2).toString('latin1')).toBe('PK');
  expect((await cashPdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // 7. Телефон: обе вкладки без горизонтального выезда.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, testId] of [
    ['История', 'history-screen'],
    ['Отчёты', 'reports-screen'],
  ]) {
    await page
      .getByRole('link', { name: name ?? '' })
      .first()
      .click();
    await expect(page.getByTestId(testId ?? '')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = (
        globalThis as unknown as {
          document: { documentElement: { scrollWidth: number; clientWidth: number } };
        }
      ).document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

/**
 * «Отчёты» открываются на сегодняшнем московском дне.
 *
 * Логист приходит в отчёты за сегодняшней кассой и сегодняшним расчётом.
 * Экран открывался на неделе, и недельная сумма читалась как дневная —
 * ошибка тихая: цифра правдоподобная, просто не та.
 */
test('«Отчёты»: при открытии выбран день и все запросы идут одним диапазоном', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext();
  const page = await context.newPage();

  // Диапазон запросов записывается ДО перехода в раздел: важен самый первый.
  const ranged: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    // Собираются запросы С ДИАПАЗОНОМ: справочники вроде списка касс границ
    // не имеют и к выбранному периоду отношения не имеют тоже.
    if (url.includes('/api/logistics/') && url.includes('from=')) {
      ranged.push(url);
    }
  });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  const today = await page.evaluate(() =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()),
  );

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Отчёты' }).first().click();
  await expect(page.getByTestId('reports-screen')).toBeVisible();

  // 1. Выбран «День», а не «Неделя».
  await expect(page.getByTestId('reports-period-day')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('reports-period-week')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('reports-from')).toHaveValue(today);
  await expect(page.getByTestId('reports-to')).toHaveValue(today);

  // 2. Тем же диапазоном ушли и запросы: касса и отчёт спрашивают один день.
  await expect.poll(() => ranged.length, { timeout: 15_000 }).toBeGreaterThan(0);
  for (const url of ranged) {
    expect(url, url).toContain(`from=${today}`);
    expect(url, url).toContain(`to=${today}`);
  }

  // 3. «Неделя» по-прежнему сдвигает начало и оставляет конец на сегодня.
  await page.getByTestId('reports-period-week').click();
  await expect(page.getByTestId('reports-period-week')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('reports-to')).toHaveValue(today);
  const from = await page.getByTestId('reports-from').inputValue();
  expect(from).not.toBe(today);
  expect(Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)).toBe(
    7 * 24 * 60 * 60 * 1000,
  );

  // 4. Возврат ко «Дню» снова сводит границы к сегодняшней дате.
  await page.getByTestId('reports-period-day').click();
  await expect(page.getByTestId('reports-from')).toHaveValue(today);
  await expect(page.getByTestId('reports-to')).toHaveValue(today);
});

/**
 * «Маршрутизация»: нераспределённая сделка выглядит как в «Сделках»,
 * а пустой черновик заводится кнопкой.
 *
 * Обе правки проверяются одним сеансом намеренно: заведённый пустой черновик
 * тут же наполняется той самой нераспределённой точкой, вид которой проверен
 * шагом раньше. Разнести это по двум сценариям значило бы дважды поднимать
 * карту ради одного и того же дня.
 */
test('маршрутизация: точка дня без номера и пустой черновик кнопкой', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const own = seedOrders(1, { withPoint: true })[0] ?? '';
  expect(own).not.toBe('');

  /*
   * Тела запросов создания собираются по ходу сценария.
   *
   * Ключ должен принадлежать НАЖАТИЮ: один ключ на дату или на экран означал
   * бы, что второе осознанное нажатие молча возвращает первый черновик.
   * Увидеть это можно только в том, что реально ушло на сервер.
   */
  const pressed: { creationKey: string; deliveryDate: string; vehicleType: string }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/routes/empty')) {
      pressed.push(
        request.postDataJSON() as {
          creationKey: string;
          deliveryDate: string;
          vehicleType: string;
        },
      );
    }
  });

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутизация', level: 1 })).toBeAttached();

  /*
   * 1. Пустой черновик одним нажатием.
   *
   * Ждём именно ответа операции: список обновляется запросом, и без ожидания
   * сценарий проверял бы состояние до её завершения.
   */
  /*
   * Список сначала обязан загрузиться.
   *
   * Пока идёт запрос, черновиков на экране ноль, и посчитанное «до» означало
   * бы не состояние дня, а незавершённую загрузку.
   */
  await expect(page.getByTestId('routing-drafts')).toBeVisible();
  await expect
    .poll(async () =>
      (await page.locator('.routes__draft').count()) > 0
        ? 'есть'
        : (await page.getByText('Черновиков на этот день нет').count()) > 0
          ? 'пусто'
          : 'ждём',
    )
    .not.toBe('ждём');
  const draftsBefore = await page.locator('.routes__draft').count();

  const add = page.getByRole('button', { name: 'Добавить пустой черновик' });
  await expect(add).toBeVisible();
  await clickAndAwait(page, add, 'POST', '/api/routes/empty');

  // Появился ровно один новый черновик — и без перезагрузки страницы.
  await expect(page.locator('.routes__draft')).toHaveCount(draftsBefore + 1);
  // Он раскрыт и активен: логисту он нужен открытым, чтобы начать наполнять.
  const opened = page.locator('.routes__draft[data-expanded="true"]');
  await expect(opened).toHaveCount(1);
  const emptyNumber = (await opened.getAttribute('data-draft-number')) ?? '';
  expect(emptyNumber).toMatch(/^R-\d{4}-\d{2}-\d{2}-\d{3}/);
  // Заказов в нём нет, курьера тоже.
  await expect(page.locator('.routes__card .routes__stop')).toHaveCount(0);

  /*
   * 2. Вид нераспределённой точки.
   *
   * Круг пуст: номер внутри означал бы позицию остановки, которой у этой
   * сделки нет. Время стоит подписью над кругом, номер и адрес — в подсказке.
   */
  await page.getByTestId('map-unassigned-toggle').check();
  const marker = page.getByRole('button', { name: `Заказ ${own} на карте` });
  await expect(marker).toBeVisible();
  await expect(marker.locator('.map-point__dot')).toHaveText('');
  await expect(marker.locator('.map-point__time')).toBeVisible();
  await expect(marker.locator('.map-point__time')).not.toHaveText('');
  const hint = marker.locator('.map-point__hint');
  await expect(hint).toHaveAttribute('role', 'tooltip');
  await expect(hint).toContainText(own);
  await expect(hint).toContainText('Москва');

  /*
   * Подсказка появляется по наведению и достаётся клавиатуре.
   *
   * Наведение проверяется на ВЕРХНЕЙ отметке: у проверочных заказов сеялки
   * один адрес, отметки лежат друг на друге, и мышь физически достаётся
   * верхней. Правило показа общее для всех отметок, поэтому доказывает его
   * любая из них. Видимость меряется прозрачностью, а не `toBeVisible`:
   * скрытая подсказка занимает место и по размерам считалась бы видимой.
   */
  const opacityOf = (selector: string): Promise<string> =>
    page.evaluate<string>(`getComputedStyle(document.querySelector('${selector}')).opacity`);

  const ownHint = `[aria-label="Заказ ${own} на карте"] .map-point__hint`;
  expect(await opacityOf(ownHint)).toBe('0');

  const topMarker = page.locator('[data-testid="map-marker"][data-order-id]').last();
  const topLabel = (await topMarker.getAttribute('aria-label')) ?? '';
  await topMarker.hover();
  await expect.poll(() => opacityOf(`[aria-label="${topLabel}"] .map-point__hint`)).toBe('1');

  // Отметка — обычная кнопка: клавиатура до неё доходит и имя у неё есть.
  await marker.focus();
  expect(await page.evaluate<string>("document.activeElement.getAttribute('aria-label')")).toBe(
    `Заказ ${own} на карте`,
  );

  /*
   * 3. Координата точки не зависит от масштаба, сдвига и обновления данных.
   *
   * Сверяется положение кружка на экране с проекцией той самой координаты,
   * которую отметка о себе объявляет.
   */
  const drift = async (): Promise<{ dx: number; dy: number; lng: number; lat: number }> => {
    await page.waitForTimeout(150);
    const box = await marker.boundingBox();
    const lng = Number(await marker.getAttribute('data-lng'));
    const lat = Number(await marker.getAttribute('data-lat'));
    const projected = await page.evaluate(
      ([lngValue, latValue]: [number, number]) => {
        const map = (
          globalThis as unknown as {
            __routingMap: { project: (lngLat: [number, number]) => { x: number; y: number } };
          }
        ).__routingMap;
        const point = map.project([lngValue, latValue]);
        return { x: point.x, y: point.y };
      },
      [lng, lat] as [number, number],
    );
    const canvas = await page.getByTestId('orders-map').boundingBox();
    const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2 - (canvas?.x ?? 0);
    const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2 - (canvas?.y ?? 0);
    return { dx: centerX - projected.x, dy: centerY - projected.y, lng, lat };
  };

  const start = await drift();
  expect(Math.abs(start.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(start.dy)).toBeLessThanOrEqual(1);

  for (const step of [3, -2]) {
    await page.evaluate((value: number) => {
      const map = (
        globalThis as unknown as {
          __routingMap: { setZoom: (z: number) => void; getZoom: () => number };
        }
      ).__routingMap;
      map.setZoom(map.getZoom() + value);
    }, step);
    const after = await drift();
    // Координата доменного объекта неизменна: масштаб её не касается.
    expect(after.lng).toBe(start.lng);
    expect(after.lat).toBe(start.lat);
    expect(Math.abs(after.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.dy)).toBeLessThanOrEqual(1);
  }

  await page.evaluate(() => {
    const map = (
      globalThis as unknown as {
        __routingMap: { panBy: (offset: [number, number], options: { duration: number }) => void };
      }
    ).__routingMap;
    map.panBy([160, -110], { duration: 0 });
  });
  const afterPan = await drift();
  expect(afterPan.lng).toBe(start.lng);
  expect(Math.abs(afterPan.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterPan.dy)).toBeLessThanOrEqual(1);

  // Обновление данных списка отметку не двигает.
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const afterRefresh = await drift();
  expect(afterRefresh.lat).toBe(start.lat);
  expect(Math.abs(afterRefresh.dx)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterRefresh.dy)).toBeLessThanOrEqual(1);

  /*
   * 4. В пустой черновик кладётся нераспределённый заказ, и его точка
   * становится нумерованной остановкой.
   */
  /*
   * Нажатие отправляется САМОЙ отметке.
   *
   * У проверочных заказов сеялки один адрес, и отметки лежат друг на друге:
   * обычное нажатие досталось бы верхней, и в черновик уехал бы чужой заказ.
   */
  await marker.dispatchEvent('click');
  const window = page.getByTestId('map-selection');
  await expect(window).toBeVisible();
  await clickAndAwait(page, window.getByRole('button', { name: emptyNumber }), 'POST', '/orders');
  await openDraft(page, emptyNumber);
  await expect(page.locator('.routes__card .routes__stop')).toHaveCount(1);
  // Остановка активного черновика — единственный случай цифры в кружке.
  await expect(
    page.getByRole('button', { name: `Заказ ${own} на карте` }).locator('.map-point__dot'),
  ).toHaveText('1');

  /*
   * 5. Пустой черновик отменяется с причиной обычным способом.
   */
  const second = page.getByRole('button', { name: 'Добавить пустой черновик' });
  await clickAndAwait(page, second, 'POST', '/api/routes/empty');
  // Раскрытым становится именно новый черновик: ждём смены номера, а не
  // мгновенного перерисовывания списка.
  await expect
    .poll(async () =>
      page.locator('.routes__draft[data-expanded="true"]').getAttribute('data-draft-number'),
    )
    .not.toBe(emptyNumber);
  const secondNumber =
    (await page
      .locator('.routes__draft[data-expanded="true"]')
      .getAttribute('data-draft-number')) ?? '';

  /*
   * Два нажатия — два черновика; повтор первого запроса — по-прежнему два.
   *
   * Ключи двух нажатий обязаны различаться: одинаковый означал бы, что второе
   * нажатие ничего не создаёт. А повтор ровно того тела, что ушло с первым
   * нажатием, обязан вернуть первый черновик и не завести третий.
   */
  expect(pressed).toHaveLength(2);
  expect(pressed[0]?.creationKey).not.toBe(pressed[1]?.creationKey);
  expect(pressed[0]?.deliveryDate).toBe(pressed[1]?.deliveryDate);
  await expect(page.locator('.routes__draft')).toHaveCount(draftsBefore + 2);

  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  expect(auth.status()).toBe(200);
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const again = await page.request.post('/api/routes/empty', {
    headers: { authorization: `Bearer ${token}` },
    data: pressed[0],
  });
  // 200, а не 201: третьего черновика не появилось.
  expect(again.status()).toBe(200);
  expect(((await again.json()) as { number: string }).number).toBe(emptyNumber);

  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.routes__draft')).toHaveCount(draftsBefore + 2);

  await page.locator('.routes__card').getByRole('button', { name: 'Отменить маршрут' }).click();
  await page.getByLabel('Причина').fill('Заведён по ошибке');
  await clickAndAwait(page, page.getByRole('button', { name: 'Продолжить' }), 'POST', '/cancel');
  await expect(page.locator(`.routes__draft[data-draft-number="${secondNumber}"]`)).toHaveCount(0);

  // 6. Телефон и настольный экран: полоса действий не уезжает вбок.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.getByRole('button', { name: 'Добавить пустой черновик' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = (
        globalThis as unknown as {
          document: { documentElement: { scrollWidth: number; clientWidth: number } };
        }
      ).document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  }
});

/**
 * Рабочий адрес, ручной интервал и подтверждение результата.
 *
 * Один сеанс логиста правит адрес и интервал, второй сеанс — курьерский —
 * обязан увидеть правку без перезагрузки. Проверяется то, ради чего всё это
 * и делается: курьер едет по адресу логиста, ко времени логиста и строит
 * маршрут к подтверждённой точке.
 */
test('«Активные»: рабочий адрес, интервал 10:00–14:00 и ссылка на карты', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  /*
   * Собственная фикстура сценария.
   *
   * Чужие маршруты к этому месту уже завершены соседними сценариями, а нам
   * нужен ЖИВОЙ активный маршрут с курьером: иначе «Активные» пусты, и
   * проверять нечего.
   */
  const seeded = seedWarehouseRoute();

  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, ADMIN_PHONE, ADMIN_PIN);

  const auth = await page.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  expect(auth.status()).toBe(200);
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const authorized = { authorization: `Bearer ${token}` };

  /*
   * Лист отгружается ТОЙ ЖЕ доменной операцией, что и кнопкой в интерфейсе.
   *
   * Складской путь со сканированием проверяет отдельный сценарий; здесь нужен
   * лишь активный маршрут, и подделывать состояние базы ради него нельзя.
   */
  const sheets = await page.request.get('/api/route-sheets?section=UNSHIPPED&limit=100', {
    headers: authorized,
  });
  const sheetList = (await sheets.json()) as {
    days: { sheets: { id: string; number: string; version: number }[] }[];
  };
  const target = sheetList.days
    .flatMap((day) => day.sheets)
    .find((item) => item.number === seeded.route);
  expect(target, 'маршрут фикстуры не найден в листах').toBeTruthy();

  const shipped = await page.request.post(`/api/routes/${target?.id ?? ''}/ship`, {
    headers: authorized,
    data: { expectedVersion: target?.version ?? 0 },
  });
  expect(shipped.status(), await shipped.text()).toBe(200);

  /*
   * 1. Ручной интервал 10:00–14:00 сохраняется из окна заказа.
   *
   * Прежде окно посылало версию под чужим именем поля, и совершенно
   * корректный интервал получал общее «Проверьте правильность заполнения
   * полей». Проверяется именно этот путь — тот, которым пользуется логист.
   */
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутные листы', level: 1 })).toBeAttached();

  const sheet = page.locator(`[data-sheet-number="${seeded.route}"]`).first();
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  if ((await sheet.getAttribute('data-expanded')) !== 'true') {
    await sheet.getByTestId('sheet-expand').click();
  }
  await sheet
    .locator(`[data-order-number="${seeded.orders[0] ?? ''}"]`)
    .getByTestId('order-number')
    .click();

  const orderWindow = page.getByTestId('order-window');
  await expect(orderWindow).toBeVisible();
  await orderWindow.getByTestId('order-window-interval').click();

  await page.getByLabel('Начало').fill('10:00');
  await page.getByLabel('Окончание').fill('14:00');
  await clickAndAwait(
    page,
    page.getByRole('button', { name: 'Сохранить интервал' }),
    'PUT',
    '/interval',
  );
  await expect(page.locator('.toast-region')).toContainText('Интервал сохранён');

  // 2. Рабочий адрес: правка логиста сильнее исходного значения источника.
  const localAddress = `Москва, проверочный адрес логиста ${Date.now() % 100000}`;
  const order = await page.request.get(
    `/api/orders?deliveryDate=${today()}&search=${encodeURIComponent(seeded.orders[0] ?? '')}`,
    { headers: authorized },
  );
  const found = (await order.json()) as { items: { id: string; version: number }[] };
  const orderId = found.items[0]?.id ?? '';
  expect(orderId).not.toBe('');

  /*
   * Вместе с адресом логист подтверждает точку.
   *
   * Именно она потом уходит в ссылку на карты: строка адреса для маршрута
   * не годится — по ней карты находят «примерно тот» дом.
   */
  const saved = await page.request.put(`/api/orders/${orderId}/address`, {
    headers: authorized,
    data: { address: localAddress, point: { latMicro: 55_751_244, lonMicro: 37_618_423 } },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  /*
   * 3. Второй сеанс — курьер — видит и адрес, и интервал БЕЗ перезагрузки.
   *
   * Страница курьера открывается заранее и больше не перезагружается:
   * доказательство держится на канале событий, а не на F5.
   */
  const courierContext = await browser.newContext();
  const courierPage = await courierContext.newPage();
  await login(courierPage, seeded.courierPhone, seeded.courierPin);
  await expect(courierPage.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();

  const card = courierPage.locator(
    `[data-testid="delivery-order"][data-order-number="${seeded.orders[0] ?? ''}"]`,
  );
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId('delivery-address')).toHaveText(localAddress, { timeout: 20_000 });
  await expect(card).toContainText('10:00–14:00', { timeout: 20_000 });

  /*
   * 4. Адрес ведёт в Яндекс Карты — к подтверждённой точке заказа.
   *
   * Проверяется именно координата, а не строка адреса: карты по строке
   * находят «примерно тот» дом, а курьеру нужен подтверждённый логистом.
   */
  const href = (await card.getByTestId('delivery-address').getAttribute('href')) ?? '';
  expect(href).toBe('https://yandex.ru/maps/?rtext=~55.751244,37.618423&rtt=auto');
  await expect(card.getByTestId('delivery-address')).toHaveAttribute('target', '_blank');
  await expect(card.getByTestId('delivery-address')).toHaveAttribute('rel', /noopener/);

  // Ключей и подключаемых сценариев карт в странице нет: обычная ссылка.
  const scripts = await courierPage.evaluate<number>(
    'document.querySelectorAll(\'script[src*="yandex"], script[src*="api-maps"]\').length',
  );
  expect(scripts).toBe(0);

  // 5. Телефон и настольный экран: карточка не уезжает вбок.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await courierPage.setViewportSize(size);
    await expect(card).toBeVisible();
    const overflow = await courierPage.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }

  await courierContext.close();
  await context.close();
});

/**
 * Ручная отгрузка настраивается администратором и видна логисту сразу.
 *
 * Кнопка «Отгрузить» существует ровно тогда, когда владелец это разрешил:
 * погашенная кнопка обещала бы действие, которого в контуре нет.
 */
test('настройки: переключатель ручной отгрузки прячет и возвращает кнопку', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Настройки');
  const toggle = page.getByTestId('manual-issue-toggle');
  await expect(toggle).toBeVisible();
  // Значение по умолчанию сохранено и показано, а не придумано экраном.
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId('manual-issue-form')).toContainText('фактически переданы курьеру');

  // Выключение доходит до вкладки листов без перезагрузки.
  await clickAndAwait(page, toggle, 'PUT', '/settings/planning/manual-issue');
  await expect(toggle).not.toBeChecked();

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByRole('heading', { name: 'Маршрутные листы', level: 1 })).toBeAttached();
  await expect(page.getByTestId('sheet-ship')).toHaveCount(0);

  // Возвращаем разрешение: кнопка снова на месте.
  await openSection(page, 'Настройки');
  await clickAndAwait(page, page.getByTestId('manual-issue-toggle'), 'PUT', '/manual-issue');
  await expect(page.getByTestId('manual-issue-toggle')).toBeChecked();

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  const unshipped = page.getByTestId('sheets-UNSHIPPED');
  await expect(unshipped).toBeVisible();
  const anySheet = unshipped.locator('[data-testid="sheet-row"]').first();
  if ((await anySheet.count()) > 0) {
    // Кнопка есть; без курьера она недоступна и объясняет причину.
    const ship = anySheet.getByTestId('sheet-ship');
    await expect(ship).toHaveCount(1);
    // Назначен ли курьер, видно по таблетке: поле открывается только по нажатию.
    const courier = await anySheet.getByTestId('sheet-courier-pick').innerText();
    if (courier.includes('Курьер не назначен')) {
      await expect(ship).toBeDisabled();
      await expect(ship).toHaveAttribute('title', /курьера/i);
    } else {
      await expect(ship).toBeEnabled();
    }
  }
});

/** Сотрудник любой роли, заведённый через API и сразу активированный. */
async function seedRole(
  page: Page,
  token: string,
  role: 'LOGISTICIAN' | 'FLORIST' | 'WAREHOUSE',
  pin: string,
): Promise<{ phone: string; pin: string; fullName: string }> {
  const phone = uniquePhone();
  const fullName = `Сотрудник ${role}`;

  const created = await page.request.post('/api/users', {
    headers: { authorization: `Bearer ${token}` },
    data: { fullName, phone, roles: [role] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { activationCode: string };

  const activated = await page.request.post('/api/auth/activate', {
    data: { phone, code: body.activationCode, pin },
  });
  expect(activated.status()).toBe(200);

  return { phone, pin, fullName };
}

/**
 * Два сеанса: логист подтверждает лист — флорист и кладовщик видят это сами.
 *
 * Проверяется канал событий, а не перезагрузка: страницы производства
 * открываются ДО действия логиста и больше не обновляются руками.
 */
test('два сеанса: подтверждение листа доходит до флориста и кладовщика без F5', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const numbers = seedOrders(1, { withPoint: true });
  const orderNumber = numbers[0] ?? '';
  expect(orderNumber).not.toBe('');

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, ADMIN_PHONE, ADMIN_PIN);

  const auth = await admin.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;

  const florist = await seedRole(admin, token, 'FLORIST', '5511');
  const keeper = await seedRole(admin, token, 'WAREHOUSE', '5522');

  // Производство открыто заранее: доказательство держится на событиях.
  const floristContext = await browser.newContext();
  const floristPage = await floristContext.newPage();
  await login(floristPage, florist.phone, florist.pin);
  await expect(floristPage.getByRole('heading', { name: 'Флорист', level: 1 })).toBeVisible();

  const keeperContext = await browser.newContext();
  const keeperPage = await keeperContext.newPage();
  await login(keeperPage, keeper.phone, keeper.pin);
  await expect(keeperPage.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();
  await keeperPage.getByTestId('wh-tab-picking').click();
  await expect(keeperPage.getByTestId('assembly-scan')).toBeVisible();

  /*
   * Логист собирает лист из «Сделок» и подтверждает его.
   *
   * Черновик производство не трогает: собирать под него нечего, и до
   * подтверждения ни очередь флориста, ни склад о нём знать не обязаны.
   */
  await openSection(admin, 'Логистика');
  await admin.getByRole('link', { name: 'Сделки' }).first().click();
  const deal = admin.locator(`[data-testid="deal-card"][data-order-number="${orderNumber}"]`);
  await expect(deal).toHaveAttribute('data-selectable', 'yes');
  await deal.getByTestId('deal-pick').click();
  await admin.getByTestId('deals-manual-draft').click();
  await expect(admin.getByTestId('create-route-dialog')).toBeVisible();
  /*
   * Номер листа берётся из ответа сервера, а не из списка черновиков:
   * подтверждённый лист черновиком уже не является и там не появляется.
   */
  const [created] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url().includes('/from-selection') && response.request().method() === 'POST',
    ),
    admin.getByTestId('create-route-sheet').click(),
  ]);
  expect(created.status(), await created.text()).toBe(201);
  const sheetNumber = ((await created.json()) as { number: string }).number;
  expect(sheetNumber).toMatch(/^R-/);

  // Склад увидел подтверждённый лист сам, без перезагрузки.
  await expect(
    keeperPage.locator(`[data-testid="assembly-route"][data-route-number="${sheetNumber}"]`),
  ).toHaveCount(1, { timeout: 25_000 });

  // Флорист увидел заказ листа в очереди — приоритет задаёт именно лист.
  /*
   * Очередь разбита на группы (маршрут, затем без маршрута), поэтому списков
   * несколько: заказ ищется по всем сразу и должен встретиться ровно в одной.
   */
  await expect(
    floristPage.locator('[data-testid="florist-queue"]').filter({ hasText: orderNumber }),
  ).toHaveCount(1, { timeout: 25_000 });

  /*
   * Возврат листа в черновик убирает его из складской работы так же сразу.
   */
  await admin.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  const sheetRow = admin.locator(`[data-sheet-number="${sheetNumber}"]`).first();
  await expect(sheetRow).toBeVisible();
  await clickAndAwait(
    admin,
    sheetRow.getByTestId('sheet-return-to-draft'),
    'POST',
    '/return-to-draft',
  );

  await expect(
    keeperPage.getByTestId('wh-route-button').filter({ hasText: sheetNumber }),
  ).toHaveCount(0, { timeout: 25_000 });

  await keeperContext.close();
  await floristContext.close();
  await adminContext.close();
});

/**
 * Два сеанса: логист меняет курьера — склад видит это сам.
 *
 * Смена курьера в листе меняет то, кому склад выдаёт заказы. Пока событие
 * не доходило до складских вкладок, кладовщик выдавал маршрут человеку,
 * которого уже сняли.
 */
test('два сеанса: смена курьера доходит до склада без F5', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const seeded = seedWarehouseRoute();

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, ADMIN_PHONE, ADMIN_PIN);
  const auth = await admin.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const authorized = { authorization: `Bearer ${token}` };

  const keeper = await seedRole(admin, token, 'WAREHOUSE', '5533');
  const keeperContext = await browser.newContext();
  const keeperPage = await keeperContext.newPage();
  await login(keeperPage, keeper.phone, keeper.pin);
  // Курьер листа виден в «Выдаче»: именно там кладовщик его подтверждает.
  await keeperPage.getByTestId('wh-tab-issue').click();

  const issueRoute = await openIssueRoute(keeperPage, seeded.route);
  await expect(issueRoute).toHaveCount(1);
  const before =
    (await keeperPage
      .locator('[data-testid="issue-courier"]', { has: issueRoute })
      .getAttribute('data-courier')) ?? '';
  expect(before).not.toBe('');

  /*
   * Логист назначает другого курьера — тем же путём, что и в интерфейсе листов.
   */
  const replacement = await seedRole(admin, token, 'LOGISTICIAN', '5544');
  expect(replacement.phone).not.toBe('');

  const sheets = await admin.request.get('/api/route-sheets?section=UNSHIPPED&limit=100', {
    headers: authorized,
  });
  const list = (await sheets.json()) as {
    days: { sheets: { id: string; number: string; version: number }[] }[];
  };
  const target = list.days
    .flatMap((day) => day.sheets)
    .find((item) => item.number === seeded.route);
  expect(target, 'лист фикстуры не найден').toBeTruthy();

  const couriers = await admin.request.get('/api/users?role=COURIER&status=ACTIVE&limit=100', {
    headers: authorized,
  });
  const options = ((await couriers.json()) as { items: { id: string; fullName: string }[] }).items;
  const other = options.find((item) => item.fullName !== before);
  expect(other, 'нужен второй курьер').toBeTruthy();

  const assigned = await admin.request.put(`/api/routes/${target?.id ?? ''}/courier`, {
    headers: authorized,
    data: { courierUserId: other?.id ?? null, expectedVersion: target?.version ?? 0 },
  });
  expect(assigned.status(), await assigned.text()).toBe(200);

  /*
   * Кладовщик ничего не нажимал: лист ушёл из раскрытой карточки прежнего
   * курьера сам. Отдать коробки человеку, которого сняли с маршрута, нельзя.
   */
  await expect(issueRoute).toHaveCount(0, { timeout: 25_000 });

  // И нашёлся у нового курьера — под его именем.
  const moved = await openIssueRoute(keeperPage, seeded.route);
  await expect(keeperPage.locator('[data-testid="issue-courier"]', { has: moved })).toHaveAttribute(
    'data-courier',
    other?.fullName ?? '',
  );

  await keeperContext.close();
  await adminContext.close();
});

/**
 * Справочник в двух сеансах: администратор и логист.
 *
 * Логист видит одну вкладку — курьеров, и заводит именно курьера. Чужие роли
 * ему не показывает не экран, а сервер: проверяется и это.
 */
test('два сеанса: справочник курьеров у администратора и логиста', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, ADMIN_PHONE, ADMIN_PIN);
  const auth = await admin.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const logist = await seedRole(admin, token, 'LOGISTICIAN', '5566');

  await openSection(admin, 'Сотрудники и курьеры');
  // Вкладки ролей вместо выпадающего фильтра, «Добавить» — в рабочей панели.
  // Семь ролей: курьер, флорист, кладовщик, менеджер, логист, управляющий, администратор.
  await expect(admin.getByTestId('user-role-tab')).toHaveCount(7);
  await expect(admin.getByTestId('user-add')).toBeVisible();
  await expect(admin.getByLabel('Роль')).toHaveCount(0);
  // Отдельного блока с пояснением про заморозку больше нет.
  await expect(admin.getByText('Сотрудники не удаляются')).toHaveCount(0);

  // Вкладка показывает только свою роль.
  await admin.getByTestId('user-role-tab').filter({ hasText: 'Логист' }).click();
  await expect(admin.locator('.table tbody tr').first()).toContainText('Логист');

  const logistContext = await browser.newContext();
  const logistPage = await logistContext.newPage();
  await login(logistPage, logist.phone, logist.pin);
  await openSection(logistPage, 'Сотрудники и курьеры');

  // У логиста одна вкладка — «Курьеры», и кнопка называет, кого он заводит.
  await expect(logistPage.getByTestId('user-role-tab')).toHaveCount(1);
  await expect(logistPage.getByTestId('user-role-tab')).toHaveText('Курьер');
  await expect(logistPage.getByTestId('user-add')).toHaveText('Добавить курьера');

  /*
   * Строка таблицы: текст на уровне середины кнопок действий.
   *
   * Высоту строки задаёт самый высокий элемент — ряд кнопок. При выравнивании
   * по верху данные оказывались выше их середины, и строка читалась как две
   * несвязанные половины: слева сведения, справа действия.
   */
  await admin.getByTestId('user-role-tab').filter({ hasText: 'Курьер' }).click();
  const firstRow = admin.locator('.table tbody tr').first();
  await expect(firstRow).toBeVisible();

  /*
   * Меряется центр САМОГО ТЕКСТА, а не ячейки.
   *
   * Ячейка растягивается на всю высоту строки при любом выравнивании, поэтому
   * её середина совпала бы с кнопками даже тогда, когда текст прижат к
   * верхнему краю. Диапазон по содержимому даёт настоящий прямоугольник
   * строки текста.
   *
   * Опорой служит БЛОК действий, а не первая кнопка: на узком экране кнопки
   * переносятся в две строки, и центр первой из них выше середины строки
   * по построению.
   */
  const centers = (await admin.evaluate(`(() => {
    const row = document.querySelector('.table tbody tr');
    if (row === null) {
      return null;
    }
    const middleOf = (rect) => rect.top + rect.height / 2;
    const textMiddle = (cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const rect = range.getBoundingClientRect();
      return rect.height === 0 ? null : middleOf(rect);
    };

    const actions = row.querySelector('td .row');
    return {
      button: actions === null ? null : middleOf(actions.getBoundingClientRect()),
      cells: Array.from(row.querySelectorAll('td'))
        .filter((cell) => cell.textContent.trim() !== '' && cell.querySelector('button') === null)
        .map((cell) => ({
          text: cell.textContent.trim().slice(0, 20),
          middle: textMiddle(cell),
        })),
    };
  })()`)) as { button: number | null; cells: { text: string; middle: number | null }[] } | null;

  expect(centers, 'строка таблицы не найдена').not.toBeNull();
  expect(centers?.button).not.toBeNull();
  expect(centers?.cells.length ?? 0).toBeGreaterThanOrEqual(4);
  for (const cell of centers?.cells ?? []) {
    expect(cell.middle, cell.text).not.toBeNull();
    expect(Math.abs((cell.middle ?? 0) - (centers?.button ?? 0)), cell.text).toBeLessThanOrEqual(2);
  }

  // Сервер тоже не отдаёт логисту чужие роли.
  const foreign = await logistPage.request.get('/api/users?role=FLORIST&status=ACTIVE', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(foreign.status()).toBe(200);

  const asLogist = await logistPage.request.post('/api/auth/login', {
    data: { phone: logist.phone, pin: logist.pin },
  });
  const logistToken = ((await asLogist.json()) as { accessToken: string }).accessToken;
  const denied = await logistPage.request.post('/api/users', {
    headers: { authorization: `Bearer ${logistToken}` },
    data: { fullName: 'Чужая роль', phone: uniquePhone(), roles: ['FLORIST'] },
  });
  expect(denied.status()).toBe(403);

  await logistContext.close();
  await adminContext.close();
});

/**
 * Телефон: ширина совпадает с экраном и ввод не приближает страницу.
 *
 * Проверяются три распространённые ширины и все рабочие роли. Приближение
 * лечится размером текста в полях, а не запретом масштабирования: отнимать
 * у людей возможность приблизить экран нельзя.
 */
test('телефон: 390/375/360 без горизонтального выезда и без приближения при вводе', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const setupContext = await browser.newContext();
  const setup = await setupContext.newPage();
  await login(setup, ADMIN_PHONE, ADMIN_PIN);
  const auth = await setup.request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;

  const florist = await seedRole(setup, token, 'FLORIST', '6611');
  const keeper = await seedRole(setup, token, 'WAREHOUSE', '6622');
  const logist = await seedRole(setup, token, 'LOGISTICIAN', '6633');
  await setupContext.close();

  const roles: { name: string; phone: string; pin: string; paths: string[] }[] = [
    {
      name: 'администратор',
      phone: ADMIN_PHONE,
      pin: ADMIN_PIN,
      paths: ['/logistics/deals', '/logistics/route-sheets', '/logistics/reports', '/couriers'],
    },
    {
      name: 'логист',
      phone: logist.phone,
      pin: logist.pin,
      paths: ['/logistics/deals', '/couriers'],
    },
    { name: 'флорист', phone: florist.phone, pin: florist.pin, paths: ['/florist'] },
    { name: 'кладовщик', phone: keeper.phone, pin: keeper.pin, paths: ['/warehouse'] },
  ];

  for (const width of [390, 375, 360]) {
    for (const role of roles) {
      const context = await browser.newContext({ viewport: { width, height: 780 } });
      const page = await context.newPage();
      await login(page, role.phone, role.pin);

      for (const path of role.paths) {
        await page.goto(path);
        /*
         * Экран обязан отрисоваться ДО измерения.
         *
         * Пустая страница шире экрана не бывает, и без этого ожидания
         * проверка доказывала бы лишь то, что успела ничего не загрузить.
         */
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(500);

        const overflow = await page.evaluate<number>(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        );
        expect(overflow, `${role.name} ${width}px ${path}`).toBeLessThanOrEqual(1);

        /*
         * Заодно размер текста в полях: именно им iOS решает, приближать ли
         * страницу при фокусе. Меряется вычисленный размер, а не наличие
         * правила — правило могло быть перекрыто.
         */
        const fields = await page.evaluate<number[]>(
          "Array.from(document.querySelectorAll('input, select, textarea')).map((node) => parseFloat(getComputedStyle(node).fontSize))",
        );
        for (const size of fields) {
          expect(size, `${role.name} ${width}px ${path}`).toBeGreaterThanOrEqual(16);
        }
      }

      await context.close();
    }
  }

  /*
   * Размер текста в полях — не меньше 16 пикселей.
   *
   * Именно этим iOS решает, приближать ли страницу при фокусе. Проверяется
   * вычисленный размер, а не наличие правила: правило могло быть перекрыто.
   */
  /*
   * Поля страницы входа — тоже не меньше шестнадцати.
   *
   * Это первый экран, который человек видит с телефона, и приближение здесь
   * оставляет его в увеличенном интерфейсе на всё дальнейшее время работы.
   */
  const phone = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const phonePage = await phone.newPage();
  await phonePage.goto('/login');
  await expect(phonePage.getByLabel('Телефон')).toBeVisible();
  const loginFields = await phonePage.evaluate<number[]>(
    "Array.from(document.querySelectorAll('input')).map((node) => parseFloat(getComputedStyle(node).fontSize))",
  );
  expect(loginFields.length).toBeGreaterThan(0);
  for (const size of loginFields) {
    expect(size).toBeGreaterThanOrEqual(16);
  }

  // Масштабирование пальцами при этом не запрещено.
  const viewport = await phonePage.evaluate<string>(
    "document.querySelector('meta[name=viewport]').getAttribute('content')",
  );
  expect(viewport).not.toContain('user-scalable=no');
  expect(viewport).not.toContain('maximum-scale');

  await phone.close();
});

/*
 * Раздел «Выдача» на полном стенде.
 *
 * Здесь проверяется соседство, а не одиночная операция: два листа одного
 * курьера, лист без курьера и лист без ячейки лежат рядом, и отгрузка
 * обязана трогать РОВНО один из них.
 */
test('выдача: три уровня, отгрузка одного листа и неприкосновенность соседнего', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);
  const assembled = stand['мл собран'] ?? '';
  const withoutCell = stand['мл без ячейки'] ?? '';
  const partial = stand['мл частично'] ?? '';
  const withoutCourier = stand['мл без курьера'] ?? '';

  await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();
  await page.getByTestId('wh-tab-issue').click();

  /*
   * Первый уровень — курьеры. Листы свёрнуты: кладовщику нужен выбор
   * человека, стоящего перед ним, а не чтение всего склада.
   */
  const courierOne = page.locator('[data-testid="issue-courier"]', {
    hasText: 'Курьер стенда один',
  });
  await expect(courierOne).toBeVisible();
  await expect(page.locator('[data-testid="issue-route"]')).toHaveCount(0);

  // Лист без курьера в выдаче не показывается: отдавать его некому.
  await expect(page.getByTestId('issue-couriers')).not.toContainText(withoutCourier);

  await courierOne.getByTestId('issue-courier-toggle').click();
  const assembledRoute = page.locator(
    `[data-testid="issue-route"][data-route-number="${assembled}"]`,
  );
  const emptyRoute = page.locator(
    `[data-testid="issue-route"][data-route-number="${withoutCell}"]`,
  );
  await expect(assembledRoute).toBeVisible();
  await expect(emptyRoute).toBeVisible();
  // Чужой курьер остался свёрнутым.
  await expect(
    page.locator(`[data-testid="issue-route"][data-route-number="${partial}"]`),
  ).toHaveCount(0);

  // Второй лист того же курьера отгружается отдельной кнопкой.
  await expect(assembledRoute.getByTestId('issue-ship')).toBeVisible();
  await expect(emptyRoute.getByTestId('issue-ship')).toBeVisible();

  /*
   * Лист, коробки которого ещё не на полке, отгрузить нельзя: внести
   * нечего, и кнопка отгрузки остаётся недоступной.
   */
  await emptyRoute.getByTestId('issue-ship').click();
  await expect(page.getByTestId('issue-progress')).toHaveText('Внесено: 0 из 2');
  await expect(page.getByTestId('issue-ship-submit')).toBeDisabled();
  await page.getByTestId('issue-ship-close').click();

  // Собранный лист вносится и уезжает целиком.
  await assembledRoute.getByTestId('issue-ship').click();
  const ship = page.getByTestId('issue-ship-dialog');
  const confirm = page.getByTestId('issue-confirm-courier');
  if ((await confirm.count()) > 0) {
    await confirm.click();
  }
  let entered = 0;
  for (const key of ['заказ готов 1', 'заказ готов 2']) {
    await page.getByTestId('issue-manual-order').fill(stand[key] ?? '');
    await ship.getByRole('button', { name: 'Внести' }).click();
    entered += 1;
    await expect(page.getByTestId('issue-progress')).toHaveText(`Внесено: ${entered} из 2`);
  }
  await page.getByTestId('issue-ship-submit').click();
  await expect(page.locator('.toast-region')).toContainText('отгружен курьеру');

  // Уехал ровно один лист: соседний остался на месте и не тронут.
  await expect(assembledRoute).toHaveCount(0);
  await expect(emptyRoute).toBeVisible();
  // Соседний лист не тронут: ни один его заказ не внесён.
  await expect(emptyRoute.getByTestId('issue-route-counts')).toHaveText('2 (0 из 2)');
});

/*
 * Доска сборки: переход «Активные ↔ Собранные» по фактическому состоянию.
 */
test('сборка: лист уходит в «Собранные» и возвращается, когда коробку унесли', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  const stand = seedWarehouseStand();
  const assembled = stand['мл собран'] ?? '';
  const movedOrder = stand['заказ готов 2'] ?? '';
  const storage = stand['ячейка хранения A'] ?? '';

  await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await page.getByTestId('wh-tab-picking').click();

  // Собранный лист лежит в свёрнутой группе и в активных его нет.
  await expect(
    page.getByTestId('assembly-active').locator(`[data-route-number="${assembled}"]`),
  ).toHaveCount(0);
  await page.getByTestId('assembly-assembled-toggle').click();
  await expect(
    page.getByTestId('assembly-assembled').locator(`[data-route-number="${assembled}"]`),
  ).toBeVisible();

  /*
   * Коробку унесли в обычное хранение — лист снова не собран.
   *
   * Источник истины здесь фактический: где стоят коробки, а не отдельный
   * флаг, который однажды остался бы включённым.
   */
  await page.getByTestId('wh-tab-storage').click();
  await page.getByTestId('wh-scan-order').fill(movedOrder);
  await page.getByTestId('wh-scan-order').press('Enter');
  await page.getByTestId('wh-choice-storage').click();
  await page.getByTestId('wh-scan-cell').fill(storage);
  await page.getByTestId('wh-place').click();
  await expect(page.locator('.toast-region')).toContainText(movedOrder);

  await page.getByTestId('wh-tab-picking').click();
  /*
   * Лист уходит из «Собранных» — но не к тем, где чего-то не хватает.
   *
   * Все коробки на складе, одна вернулась в хранение: остался ровно перенос,
   * и лист попадает в очередь готовой работы «Можно переносить».
   */
  await expect(
    page.getByTestId('assembly-assembled').locator(`[data-route-number="${assembled}"]`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('assembly-relocatable').locator(`[data-route-number="${assembled}"]`),
  ).toBeVisible();
  // Группа готовой работы раскрыта сразу и стоит выше обычных активных листов.
  await expect(page.getByTestId('assembly-relocatable-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByTestId('assembly-relocatable-count')).not.toHaveText('0');

  /*
   * Порядок групп: «Можно переносить» всегда выше остальных.
   *
   * Это очередь готовой работы, и она обязана попадаться на глаза первой.
   * Сравниваются только те группы, которые сейчас есть на доске: пустая
   * группа не показывается вовсе.
   */
  const groupTop = async (id: string): Promise<number | null> => {
    const group = page.getByTestId(`assembly-${id}`);
    if ((await group.count()) === 0) {
      return null;
    }
    return (await group.boundingBox())?.y ?? null;
  };
  const relocatableTop = await groupTop('relocatable');
  expect(relocatableTop).not.toBeNull();
  for (const id of ['active', 'assembled']) {
    const top = await groupTop(id);
    if (top !== null) {
      expect(top, id).toBeGreaterThan(relocatableTop!);
    }
  }

  // У каждой группы своя точка, заголовок и вдавленный счётчик.
  await expect(page.getByTestId('assembly-relocatable-toggle')).toContainText('Можно переносить');
  await expect(page.locator('.wh-group__dot--ready')).toBeVisible();
  await expect(page.getByTestId('assembly-relocatable-count')).toHaveClass(
    /wh-group__count--sunken/,
  );

  /*
   * Листы, которым чего-то не хватает, собраны в свою группу с янтарной точкой.
   *
   * Раньше они лежали общим списком без заголовка, и понять, почему лист здесь,
   * можно было только раскрыв его.
   */
  const notAssembled = page.getByTestId('assembly-active');
  if ((await notAssembled.count()) > 0) {
    await expect(page.getByTestId('assembly-active-toggle')).toContainText('Не всё собрано');
    await expect(page.locator('.wh-group__dot--waiting')).toBeVisible();
  }

  // Стрелки у самих карточек нет: раскрывает шапка целиком.
  await expect(page.locator('[data-testid="assembly-route-toggle"]')).toHaveCount(0);

  // Строка под номером листа короткая: сколько заказов и сколько готово.
  await expect(page.getByTestId('assembly-route-counts').first()).toHaveText(
    /^\d+ \(\d+ из \d+\)$/,
  );
});

/*
 * Два кладовщика над одним листом.
 *
 * Прогресс проверки серверный, поэтому у обоих он обязан быть одним и тем же
 * без перезагрузки: расходящиеся счётчики означали бы, что один из них
 * отгрузит недособранный лист.
 */
test('два сеанса: прогресс проверки одинаков у обоих кладовщиков', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);
  const assembled = stand['мл собран'] ?? '';

  const first = await browser.newContext();
  const second = await browser.newContext();
  const one = await first.newPage();
  const two = await second.newPage();

  const open = async (page: Page): Promise<void> => {
    await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
    await page.getByTestId('wh-tab-issue').click();
    const route = await openIssueRoute(page, assembled);
    await route.getByTestId('issue-ship').click();
  };

  await open(one);
  await open(two);

  const confirm = one.getByTestId('issue-confirm-courier');
  if ((await confirm.count()) > 0) {
    await confirm.click();
  }

  await one.getByTestId('issue-manual-order').fill(stand['заказ готов 1'] ?? '');
  await one.getByTestId('issue-ship-dialog').getByRole('button', { name: 'Внести' }).click();
  await expect(one.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  // Второй сеанс узнаёт о чужой проверке сам.
  await expect(two.getByTestId('issue-progress')).toHaveText('Внесено: 1 из 2');

  // Сброс в одном сеансе виден во втором и полок не трогает.
  await two.getByTestId('issue-reset').click();
  await expect(one.getByTestId('issue-progress')).toHaveText('Внесено: 0 из 2');

  await first.close();
  await second.close();
});

/*
 * Отгрузка доходит до курьера.
 *
 * До отгрузки у курьера пусто; заново открывать приложение, уже сидя
 * в машине, он не должен.
 */
test('два сеанса: отгруженный лист появляется у курьера без перезагрузки', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);
  const assembled = stand['мл собран'] ?? '';

  const keeperContext = await browser.newContext();
  const courierContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const courier = await courierContext.newPage();

  await login(courier, stand['курьер один'] ?? '', stand['пин'] ?? '');
  await expect(courier.getByRole('heading', { name: 'Активные', level: 1 })).toBeVisible();
  await expect(courier.locator('body')).not.toContainText(assembled);

  await login(keeper, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await keeper.getByTestId('wh-tab-issue').click();
  const shipped = await openIssueRoute(keeper, assembled);
  await shipped.getByTestId('issue-ship').click();
  const confirm = keeper.getByTestId('issue-confirm-courier');
  if ((await confirm.count()) > 0) {
    await confirm.click();
  }
  let checked = 0;
  for (const key of ['заказ готов 1', 'заказ готов 2']) {
    await keeper.getByTestId('issue-manual-order').fill(stand[key] ?? '');
    await keeper.getByTestId('issue-ship-dialog').getByRole('button', { name: 'Внести' }).click();
    checked += 1;
    await expect(keeper.getByTestId('issue-progress')).toHaveText(`Внесено: ${checked} из 2`);
  }
  await keeper.getByTestId('issue-ship-submit').click();
  await expect(keeper.locator('.toast-region')).toContainText('отгружен курьеру');

  // Курьер видит свой лист, не трогая страницу.
  await expect(courier.locator('body')).toContainText(assembled);

  await keeperContext.close();
  await courierContext.close();
});

/*
 * Самовывоз виден менеджеру СРАЗУ после импорта — ещё до складской приёмки, —
 * но с честной причиной «нет ячейки» и без права выдачи. Приёмка склада не
 * добавляет заказ в очередь, а лишь проставляет ему ячейку.
 */
test('два сеанса: самовывоз виден у менеджера сразу, ячейка появляется после приёмки', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  const stand = seedWarehouseStand();
  const pickupOrder = stand['заказ самовывоза'] ?? '';
  const cell = stand['ячейка хранения A'] ?? '';

  const managerContext = await browser.newContext();
  const keeperContext = await browser.newContext();
  const manager = await managerContext.newPage();
  const keeper = await keeperContext.newPage();

  await login(manager, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await expect(manager.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();
  // До приёмки заказ уже в очереди, но без ячейки: наличие ячейки не условие показа.
  const managerRow = manager.locator('[data-testid="pickup-waiting-row"]', {
    hasText: pickupOrder,
  });
  await expect(managerRow).toHaveCount(1);
  await expect(managerRow).toContainText('Нет ячейки');

  await login(keeper, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await keeper.getByTestId('wh-scan-order').fill(pickupOrder);
  await keeper.getByTestId('wh-scan-order').press('Enter');
  await keeper.getByTestId('wh-scan-cell').fill(cell);
  await keeper.getByTestId('wh-place').click();
  await expect(keeper.locator('.toast-region')).toContainText(pickupOrder);

  // После приёмки та же строка получает номер ячейки — без перезагрузки страницы.
  await expect(managerRow).toContainText(cell);

  await managerContext.close();
  await keeperContext.close();
});

/*
 * Телефон: четыре вкладки склада читаются целиком и ничего не уезжает
 * за правый край.
 */
test('телефон: четыре вкладки склада без выезда и без второго заголовка', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();

  for (const width of [390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 780 } });
    const page = await context.newPage();
    await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
    await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

    /*
     * Раздел представляется ровно один раз — системной шапкой.
     *
     * Второй заголовок и объяснение приёмки занимали треть экрана телефона
     * у человека, который приходит сюда работать, а не читать.
     */
    await expect(page.getByRole('heading', { name: 'Склад', level: 1, exact: true })).toHaveCount(
      1,
    );
    await expect(
      page.locator('main').getByRole('heading', { name: 'Склад', exact: true }),
    ).toHaveCount(0);

    const tabs = ['wh-tab-storage', 'wh-tab-returns', 'wh-tab-picking', 'wh-tab-issue'];
    const boxes = [];
    for (const id of tabs) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} на ширине ${width}`).not.toBeNull();
      boxes.push(box!);
    }

    // Все четыре вкладки стоят в один ряд и помещаются в экран.
    const top = boxes[0]!.y;
    for (const box of boxes) {
      expect(Math.abs(box.y - top)).toBeLessThan(2);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }

    for (const id of tabs) {
      await page.getByTestId(id).click();
      const overflow = await page.evaluate(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );
      expect(overflow, `${id} на ширине ${width}`).toBeLessThanOrEqual(1);
    }

    await context.close();
  }
});

/*
 * Окно последовательной проверки листа.
 *
 * Прогресс здесь не хранится в окне: «проверено» — это коробки, которые
 * физически стоят в маршрутных ячейках листа. Поэтому он переживает
 * закрытие окна, а «Готово» ничего не завершает.
 */
test('сборка: последовательная проверка, пауза и «Готово» не завершает лист', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);

  const partial = stand['мл частично'] ?? '';
  const missing = stand['заказ требует перемещения'] ?? '';
  const routeCellB = stand['маршрутная ячейка B'] ?? '';

  await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await page.getByTestId('wh-tab-picking').click();

  const card = page.locator(`[data-testid="assembly-route"][data-route-number="${partial}"]`);
  await expect(card).toBeVisible();
  await card.getByTestId('assembly-route-number').click();
  await expect(page.getByTestId('assembly-check-progress')).toHaveText('Проверено: 2 из 3');

  /*
   * Пока проверено не всё, сканирование доступно, а полоса не зелёная.
   * Ячейка в строке заказа стоит в скобках вплотную к статусу.
   */
  await expect(page.getByTestId('assembly-check-scan')).toBeEnabled();
  await expect(page.locator('.wh-check__bar--done')).toHaveCount(0);
  await expect(page.getByTestId('assembly-check-cell').first()).toHaveText(
    /^(—|\(.+ · (Хранение|Маршрутная)\))$/,
  );

  /*
   * «Готово» закрывает окно и ничего не завершает.
   *
   * Третья коробка лежит в обычном хранении, поэтому лист не собран — но и
   * не ждёт ничего со стороны: все коробки на складе, остался перенос.
   * Такой лист стоит в очереди готовой работы, а не среди «Собранных».
   */
  await page.getByTestId('assembly-check-done').click();
  await expect(page.getByTestId('assembly-check')).toHaveCount(0);
  await expect(
    page.getByTestId('assembly-relocatable').locator(`[data-route-number="${partial}"]`),
  ).toBeVisible();
  await expect(
    page.getByTestId('assembly-assembled').locator(`[data-route-number="${partial}"]`),
  ).toHaveCount(0);

  // Пауза: уходим на другую вкладку и возвращаемся — прогресс не потерян.
  await page.getByTestId('wh-tab-storage').click();
  await expect(page.getByTestId('wh-scan-order')).toBeVisible();
  await page.getByTestId('wh-tab-picking').click();
  await card.getByTestId('assembly-route-number').click();
  await expect(page.getByTestId('assembly-check-progress')).toHaveText('Проверено: 2 из 3');

  /*
   * Пока проверено не всё, сканирование доступно, а полоса не зелёная.
   * Ячейка в строке заказа стоит в скобках вплотную к статусу.
   */
  await expect(page.getByTestId('assembly-check-scan')).toBeEnabled();
  await expect(page.locator('.wh-check__bar--done')).toHaveCount(0);
  await expect(page.getByTestId('assembly-check-cell').first()).toHaveText(
    /^(—|\(.+ · (Хранение|Маршрутная)\))$/,
  );

  // Последняя коробка переносится парой «заказ + ячейка».
  await page.getByTestId('assembly-check-manual-order').fill(missing);
  await page.getByTestId('assembly-check-manual-cell').fill(routeCellB);
  await page.getByTestId('assembly-check').getByRole('button', { name: 'Внести' }).click();
  await expect(page.getByTestId('assembly-check-progress')).toHaveText('Проверено: 3 из 3');

  // Собранный целиком лист ушёл в свёрнутую группу «Собранные».
  await page.getByTestId('assembly-check-done').click();
  await expect(
    page.getByTestId('assembly-active').locator(`[data-route-number="${partial}"]`),
  ).toHaveCount(0);
  await page.getByTestId('assembly-assembled-toggle').click();
  await expect(
    page.getByTestId('assembly-assembled').locator(`[data-route-number="${partial}"]`),
  ).toBeVisible();
});

/*
 * Пять размеров экрана: от узкого телефона до настольного.
 *
 * Проверяется не «красиво», а работоспособно: ничего не уезжает за правый
 * край, четыре вкладки помещаются в один ряд, окно отгрузки целиком внутри
 * экрана, нижняя кнопка доступна, а длинные имя курьера, номер листа
 * и номер заказа разметку не рвут.
 */
test('склад на пяти размерах: вкладки, окна, длинные значения и поля', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);
  const longRoute = stand['мл длинный'] ?? '';

  /*
   * Сенсорный ввод объявляется честно.
   *
   * Приближение при фокусе — поведение сенсорных устройств, и проверять его
   * на настольном профиле бессмысленно: правило размера текста написано
   * ровно для `pointer: coarse` и узкого экрана.
   */
  const sizes = [
    { width: 320, height: 568, touch: true },
    { width: 375, height: 667, touch: true },
    { width: 390, height: 844, touch: true },
    { width: 768, height: 1024, touch: true },
    { width: 1440, height: 900, touch: false },
  ];

  for (const size of sizes) {
    const label = `${size.width}×${size.height}`;
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
    });
    const page = await context.newPage();
    await login(page, stand['кладовщик'] ?? '', stand['пин'] ?? '');
    await expect(page.getByRole('heading', { name: 'Склад', level: 1 })).toBeVisible();

    const overflow = async (): Promise<number> =>
      page.evaluate<number>(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );

    // 1. Четыре вкладки: один ряд, целиком в экране, ничего не уезжает.
    const tabs = ['wh-tab-storage', 'wh-tab-returns', 'wh-tab-picking', 'wh-tab-issue'];
    const boxes = [];
    for (const id of tabs) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} ${label}`).not.toBeNull();
      boxes.push(box!);
    }
    const top = boxes[0]!.y;
    for (const box of boxes) {
      expect(Math.abs(box.y - top), `вкладки в один ряд ${label}`).toBeLessThan(2);
      expect(box.x, label).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, label).toBeLessThanOrEqual(size.width + 1);
    }

    /*
     * Название вкладки не обрезано.
     *
     * Обрезанное слово читается как другое, а нажимать приходится наугад:
     * поместиться обязан весь текст, а не только рамка кнопки.
     */
    const clipped = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('.wh-tabs__item'))
         .filter((node) => node.scrollWidth > node.clientWidth + 1)
         .map((node) => node.textContent ?? '')`,
    );
    expect(clipped, `обрезанные названия вкладок ${label}`).toEqual([]);

    for (const id of tabs) {
      await page.getByTestId(id).click();
      expect(await overflow(), `${id} ${label}`).toBeLessThanOrEqual(1);
    }

    /*
     * 2. Три уровня выдачи раскрываются, и страница не раздаётся вбок
     * даже на длинном имени курьера и длинном номере листа.
     */
    await page.getByTestId('wh-tab-issue').click();
    const route = await openIssueRoute(page, longRoute, stand['курьер длинное имя'] ?? '');
    await expect(route).toContainText(longRoute);
    expect(await overflow(), `раскрытый курьер ${label}`).toBeLessThanOrEqual(1);

    await route.getByTestId('issue-route-counts').click();
    await expect(route.locator('.wh-route__order')).toHaveCount(1);
    expect(await overflow(), `раскрытые заказы ${label}`).toBeLessThanOrEqual(1);

    // 3. Окно отгрузки целиком внутри экрана, нижняя кнопка доступна.
    await route.getByTestId('issue-ship').click();
    const dialog = page.getByTestId('issue-ship-dialog');
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox, label).not.toBeNull();
    expect(dialogBox!.x, `окно слева ${label}`).toBeGreaterThanOrEqual(-1);
    expect(dialogBox!.x + dialogBox!.width, `окно справа ${label}`).toBeLessThanOrEqual(
      size.width + 1,
    );
    expect(dialogBox!.y, `окно сверху ${label}`).toBeGreaterThanOrEqual(-1);
    expect(dialogBox!.y + dialogBox!.height, `окно снизу ${label}`).toBeLessThanOrEqual(
      size.height + 1,
    );
    expect(await overflow(), `окно отгрузки ${label}`).toBeLessThanOrEqual(1);

    const submit = page.getByTestId('issue-ship-submit');
    await submit.scrollIntoViewIfNeeded();
    const submitBox = await submit.boundingBox();
    expect(submitBox, `нижняя кнопка ${label}`).not.toBeNull();
    expect(submitBox!.y + submitBox!.height, `нижняя кнопка видна ${label}`).toBeLessThanOrEqual(
      size.height + 1,
    );

    // 4. Поля не вызывают приближения страницы на телефоне.
    // Курьер подтверждается один раз на лист: на следующем размере экрана
    // сессия уже открыта, и кнопки нет.
    const confirmCourier = page.getByTestId('issue-confirm-courier');
    if ((await confirmCourier.count()) > 0) {
      await confirmCourier.click();
    }
    await expect(page.getByTestId('issue-manual-order')).toBeVisible();
    if (size.touch) {
      const fontSizes = await page.evaluate<number[]>(
        "Array.from(document.querySelectorAll('input, select, textarea')).map((node) => parseFloat(getComputedStyle(node).fontSize))",
      );
      for (const font of fontSizes) {
        expect(font, `размер шрифта поля ${label}`).toBeGreaterThanOrEqual(16);
      }
    }

    // 5. Фокус видим: у поля в фокусе есть собственная обводка или тень.
    await page.getByTestId('issue-manual-order').focus();
    const focusRing = await page.evaluate<string>(
      "(() => { const node = document.activeElement; if (node === null) { return ''; } const style = getComputedStyle(node); return [style.outlineStyle, style.outlineWidth, style.boxShadow, style.borderColor].join('|'); })()",
    );
    expect(focusRing, `видимый фокус ${label}`).not.toBe('');
    expect(
      focusRing.includes('none|0px|none') ? 'нет признака фокуса' : 'есть',
      `видимый фокус ${label}`,
    ).toBe('есть');

    // 6. Фон под окном не прокручивается.
    const scrollLocked = await page.evaluate<boolean>(
      "getComputedStyle(document.body).overflow === 'hidden' || document.body.scrollHeight <= window.innerHeight",
    );
    expect(scrollLocked, `фон под окном ${label}`).toBe(true);

    // 7. Escape закрывает ВЕРХНЕЕ окно, а не всё сразу.
    await page.getByTestId('issue-scan').click();
    await expect(page.getByTestId('scan-title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('scan-title')).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await context.close();
  }
});

/*
 * Камера отказала — работа не останавливается.
 *
 * Отказ доступа, отсутствие устройства и оборванный поток не должны ни
 * оставлять незавершённую операцию, ни блокировать аппаратный сканер:
 * коробка стоит перед человеком, и склад обязан продолжать работать.
 */
test('камера: отказ, отсутствие устройства, обрыв потока и аппаратный сканер', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedWarehouseStand();
  await enableManualEntry(request);
  const order = stand['заказ без размещения'] ?? '';
  const storage = stand['ячейка хранения A'] ?? '';

  /** Подменяет `getUserMedia`: проверяется НАШЕ сопоставление причин. */
  const denyCamera = async (page: Page, name: string): Promise<void> => {
    await page.addInitScript(`
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(new DOMException('нет доступа', '${name}')),
        },
      });
    `);
  };

  // 1. Разрешение отклонено.
  const denied = await browser.newContext();
  const deniedPage = await denied.newPage();
  await denyCamera(deniedPage, 'NotAllowedError');
  await login(deniedPage, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await deniedPage.getByTestId('wh-scan-camera').click();
  /*
   * Технический отказ камеры показывается тем же окном, что и непринятый код.
   *
   * Для человека это одно событие — «отсканировать сейчас не получилось», —
   * и отдельная подпись под кадром заставляла бы искать, куда смотреть.
   */
  const deniedResult = deniedPage.getByTestId('scan-error');
  await expect(deniedResult).toContainText('Доступ к камере');
  // Подсказка называет обходные пути, а не техническую причину.
  await expect(deniedResult).toContainText('сканер');
  await expect(deniedPage.getByTestId('scan-retry')).toBeVisible();
  await deniedPage.getByTestId('scan-error-cancel').click();

  // Аппаратный сканер работает: пара сканов доводится до конца без камеры.
  await deniedPage.getByTestId('wh-scan-order').fill(order);
  await deniedPage.getByTestId('wh-scan-order').press('Enter');
  await deniedPage.getByTestId('wh-scan-cell').fill(storage);
  await deniedPage.getByTestId('wh-place').click();
  await expect(deniedPage.locator('.toast-region')).toContainText(order);
  await denied.close();

  // 2. Камера отсутствует.
  const absent = await browser.newContext();
  const absentPage = await absent.newPage();
  await denyCamera(absentPage, 'NotFoundError');
  await login(absentPage, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await absentPage.getByTestId('wh-scan-camera').click();
  await expect(absentPage.getByTestId('scan-error')).toContainText('Камера не найдена');
  await absentPage.getByTestId('scan-close').click();
  await expect(absentPage.getByTestId('wh-scan-order')).toBeVisible();
  await absent.close();

  /*
   * 3. Поток оборвался посреди пары сканов.
   *
   * Заказ распознан, ячейка — нет. Незавершённая пара не создаёт складских
   * записей, поэтому после отмены заказ по-прежнему нигде не числится.
   */
  const broken = await browser.newContext();
  const brokenPage = await broken.newPage();
  await brokenPage.addInitScript(() => {
    interface Globals {
      __flCameraAdapter?: unknown;
      __flScan?: (code: string) => void;
      __flBreak?: () => void;
    }
    const scope = globalThis as unknown as Globals;
    let onCode: ((code: string) => void) | null = null;
    let alive = true;

    scope.__flCameraAdapter = {
      start: (_video: unknown, events: { onCode: (code: string) => void }) => {
        onCode = events.onCode;
        alive = true;
        return Promise.resolve({
          stop: () => {
            alive = false;
            onCode = null;
          },
        });
      },
    };
    scope.__flScan = (code: string) => {
      if (alive) {
        onCode?.(code);
      }
    };
    // Обрыв потока: кадры больше не приходят, само окно остаётся открытым.
    scope.__flBreak = () => {
      alive = false;
    };
  });
  await login(brokenPage, stand['кладовщик'] ?? '', stand['пин'] ?? '');

  const second = stand['заказ не собран'] ?? '';
  await brokenPage.getByTestId('wh-scan-camera').click();
  await brokenPage.evaluate((code) => {
    (globalThis as unknown as { __flScan: (value: string) => void }).__flScan(code);
  }, second);
  await expect(brokenPage.getByTestId('scan-success')).toContainText(second);

  await brokenPage.evaluate(() => {
    (globalThis as unknown as { __flBreak: () => void }).__flBreak();
  });
  // Кадры не приходят — человек закрывает окно сам.
  await brokenPage.getByTestId('scan-cancel').click();
  await expect(brokenPage.getByTestId('wh-scan-camera')).toBeVisible();

  // Незавершённая пара следа не оставила.
  await expect(
    brokenPage.locator('[data-testid="wh-placement-row"]', { hasText: second }),
  ).toHaveCount(0);

  // И аппаратный сканер по-прежнему доводит ту же коробку до полки.
  await brokenPage.getByTestId('wh-scan-order').fill(second);
  await brokenPage.getByTestId('wh-scan-order').press('Enter');
  // Заказ входит в лист, поэтому склад сначала спрашивает, куда его нести.
  await brokenPage.getByTestId('wh-choice-storage').click();
  await brokenPage.getByTestId('wh-scan-cell').fill(storage);
  await brokenPage.getByTestId('wh-place').click();
  await expect(brokenPage.locator('.toast-region')).toContainText(second);
  await broken.close();
});

/*
 * Второй кладовщик видит чужую работу без перезагрузки.
 *
 * Назначенная полка, коробка, оставленная в хранении, и собранный целиком
 * лист — всё это меняет работу второго человека прямо сейчас, а не после F5.
 */
test('два сеанса: ячейка, «Требуется перемещение» и переход в «Собранные»', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  const stand = seedWarehouseStand();
  const route = stand['мл без ячейки'] ?? '';
  const freeCell = stand['маршрутная ячейка свободная'] ?? '';
  const storage = stand['ячейка хранения A'] ?? '';
  const first = stand['заказ ждёт приёмки'] ?? '';
  const second = stand['заказ не собран'] ?? '';

  const workerContext = await browser.newContext();
  const watcherContext = await browser.newContext();
  const worker = await workerContext.newPage();
  const watcher = await watcherContext.newPage();

  await login(watcher, stand['кладовщик'] ?? '', stand['пин'] ?? '');
  await watcher.getByTestId('wh-tab-picking').click();
  const card = watcher.locator(`[data-testid="assembly-route"][data-route-number="${route}"]`);
  await expect(card.getByTestId('assembly-route-cells')).toContainText('без ячейки');

  /*
   * Карточка раскрывается нажатием на любое свободное место шапки.
   *
   * Стрелка осталась указателем состояния: попасть в значок 32 на 32 точки
   * пальцем на телефоне трудно, а свободного места в шапке много.
   */
  const head = card.getByTestId('assembly-route-head');
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  // Нажатие мимо кнопок — по строке с числом заказов.
  await head.getByTestId('assembly-route-counts').click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toHaveAttribute('data-expanded', 'true');

  // Повторное нажатие сворачивает.
  await head.getByTestId('assembly-route-counts').click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  // Клавиатура делает то же самое.
  await head.focus();
  await head.press('Enter');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await head.press(' ');
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  /*
   * Самостоятельные кнопки карточки раскрытие не переключают.
   *
   * «+ Ячейка» стоит в РАСКРЫТОЙ карточке: свёрнутая по принятому макету —
   * ровно две строки, и кнопка не отнимает у них место. Открывает она
   * сканирование полки, а не состав листа, поэтому карточка остаётся
   * раскрытой и после закрытия окна.
   */
  await head.getByTestId('assembly-route-counts').click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await card.getByTestId('assembly-add-cell').click();
  await expect(watcher.getByTestId('scan-video')).toBeVisible();
  await watcher.getByTestId('scan-close').click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');

  await login(worker, stand['кладовщик'] ?? '', stand['пин'] ?? '');

  // 1. Первая коробка едет сразу в сборку и занимает свободную полку.
  await worker.getByTestId('wh-scan-order').fill(first);
  await worker.getByTestId('wh-scan-order').press('Enter');
  await worker.getByTestId('wh-choice-assembly').click();
  await worker.getByTestId('wh-scan-cell').fill(freeCell);
  await worker.getByTestId('wh-place').click();
  await expect(worker.locator('.toast-region')).toContainText(freeCell);

  // Второй сеанс узнал о полке сам.
  await expect(card.getByTestId('assembly-route-cells')).toContainText(freeCell);

  // 2. Вторая коробка остаётся в хранении — это незаконченная работа.
  await worker.getByTestId('wh-scan-order').fill(second);
  await worker.getByTestId('wh-scan-order').press('Enter');
  await worker.getByTestId('wh-choice-storage').click();
  await worker.getByTestId('wh-scan-cell').fill(storage);
  await worker.getByTestId('wh-place').click();
  await expect(worker.locator('.toast-region')).toContainText(second);

  /*
   * Второй сеанс видит и коробку в хранении, и её пометку.
   *
   * Обе коробки листа теперь на складе, одна из них в хранении — значит
   * ждать нечего, остался перенос, и лист стоит в очереди готовой работы.
   */
  const stored = card.locator('.wh-route__order', { hasText: second });
  // Отдельной пометки больше нет: про хранение говорят ячейка и стадия.
  await expect(stored).not.toContainText('Требуется перемещение');
  // Подпись вида полки из строки убрана: в ней стоит НОМЕР полки, а «где
  // именно лежит коробка» договаривает стадия.
  await expect(stored).toContainText(storage);
  await expect(stored).toContainText('В хранении');
  await expect(
    watcher.getByTestId('assembly-relocatable').locator(`[data-route-number="${route}"]`),
  ).toBeVisible();

  // 3. Коробку доносят до полки листа — лист собран целиком.
  await worker.getByTestId('wh-scan-order').fill(second);
  await worker.getByTestId('wh-scan-order').press('Enter');
  await worker.getByTestId('wh-choice-assembly').click();
  await worker.getByTestId('wh-scan-cell').fill(freeCell);
  await worker.getByTestId('wh-place').click();
  await expect(worker.locator('.toast-region')).toContainText(freeCell);

  // Переход «Активные → Собранные» дошёл до второго сеанса без перезагрузки.
  await expect(
    watcher.getByTestId('assembly-active').locator(`[data-route-number="${route}"]`),
  ).toHaveCount(0);
  await watcher.getByTestId('assembly-assembled-toggle').click();
  await expect(
    watcher.getByTestId('assembly-assembled').locator(`[data-route-number="${route}"]`),
  ).toBeVisible();

  await workerContext.close();
  await watcherContext.close();
});

/**
 * Стенд прилавка самовывоза: все состояния очереди сразу.
 *
 * Как и складской стенд, ставится каждым сценарием заново: очередь проверяется
 * соседством состояний, и делить её с соседом означало бы зависеть от порядка.
 */
function seedPickupStand(): Record<string, string> {
  const output = execFileSync('npm', ['run', '--silent', 'seed:e2e-pickup-stand'], {
    encoding: 'utf8',
  });
  const values: Record<string, string> = {};
  for (const match of output.matchAll(/^([^:\n]+):\s*(.+)$/gm)) {
    const key = (match[1] ?? '').trim();
    if (key !== 'описание') {
      values[key] = (match[2] ?? '').trim();
    }
  }
  if (values['заказ сегодня'] === undefined) {
    throw new Error('сеялка прилавка не вернула номера заказов');
  }
  return values;
}

/** Выключает ручной ввод: обычное состояние продукта. */
async function disableManualEntry(request: APIRequestContext): Promise<void> {
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };

  const settings = await request.get('/api/settings/planning', { headers });
  const current = (
    (await settings.json()) as {
      warehouseManualEntry: { value: { enabled: boolean }; version: number };
    }
  ).warehouseManualEntry;
  if (!current.value.enabled) {
    return;
  }

  const saved = await request.put('/api/settings/warehouse/manual-entry', {
    headers,
    data: { value: { enabled: false }, expectedVersion: current.version },
  });
  expect(saved.status()).toBe(200);
}

/*
 * Очередь прилавка: состав, счётчик и блокирующие состояния.
 *
 * Покупатель приходит когда придёт, поэтому вчерашняя коробка стоит в очереди
 * рядом с завтрашней, а календарь ничего не прячет.
 */
test('самовывоз: очередь без привязки к дню, счётчик и блокирующие состояния', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  // Ручной ввод по умолчанию выключен: сценарий набирает номера руками,
  // поэтому включает настройку так же, как это сделал бы администратор.
  await enableManualEntry(request);
  const stand = seedPickupStand();
  await disableManualEntry(request);

  await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await expect(page.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();

  const rows = page.locator('[data-testid="pickup-waiting-row"]');
  const rowOf = (number: string): Locator =>
    page.locator(`[data-testid="pickup-waiting-row"][data-order-number="${number}"]`);

  // 1. Три дня в одной очереди: календарь ничего не фильтрует.
  for (const key of ['заказ вчера', 'заказ сегодня', 'заказ завтра']) {
    await expect(rowOf(stand[key] ?? ''), key).toBeVisible();
  }

  // 2. Коробки нет на полке — строка осталась и честно называет причину.
  const withoutCell = rowOf(stand['заказ без ячейки'] ?? '');
  await expect(withoutCell).toContainText('Нет ячейки');
  await expect(withoutCell).toContainText('Нет фактической ячейки');

  // 3. Отменённый и выданный из очереди ушли, доставка в неё не попадала.
  for (const key of ['заказ отменён', 'заказ выдан', 'заказ доставки']) {
    await expect(rowOf(stand[key] ?? ''), key).toHaveCount(0);
  }

  // 4. Пропавший источник виден, но заблокирован.
  await expect(rowOf(stand['заказ пропал'] ?? '')).toContainText('Заказ помечен проблемным');

  // 5. Счётчик считает сервер по всему отбору, а не по показанным строкам.
  const shown = await rows.count();
  const counter = Number((await page.getByTestId('pickup-waiting-count').innerText()).trim());
  expect(counter).toBeGreaterThanOrEqual(shown);
  expect(counter).toBeGreaterThanOrEqual(5);

  // 6. Ручного ввода нет: настройка выключена, выдача — только сканированием.
  await expect(page.getByTestId('pickup-manual-open')).toHaveCount(0);
  await expect(page.getByTestId('pickup-search')).toHaveCount(0);
  await expect(page.getByTestId('pickup-scan')).toBeVisible();

  // 7. Выданный заказ лежит в справочном списке и очередь не трогает.
  await expect(
    page.locator('[data-testid="pickup-issued-row"]', { hasText: stand['заказ выдан'] ?? '' }),
  ).toBeVisible();
});

/*
 * Карточка самовывоза: время доставки и ручные действия «Выдан» и «Отмена».
 *
 * «Выдан» отдаёт коробку через существующую выдачу; «Отмена» локально убирает
 * карточку из очереди, не трогая заказ и не уходя в МойСклад.
 */
test('самовывоз: время на карточке, кнопки «Выдан» и «Отмена» с подтверждением', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();

  await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await expect(page.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();

  const rowOf = (number: string): Locator =>
    page.locator(`[data-testid="pickup-waiting-row"][data-order-number="${number}"]`);

  // 0. Поиск над очередью: по всей очереди, частичное совпадение, без учёта
  //    регистра; пустой запрос возвращает полный список — всё без F5.
  const target = stand['заказ сегодня'] ?? '';
  await expect(rowOf(target)).toBeVisible();
  const search = page.getByTestId('pickup-queue-search');
  // Частичное совпадение по хвосту номера находит заказ.
  await search.fill(target.slice(-4).toLowerCase());
  await expect(rowOf(target)).toBeVisible();
  // Заведомо отсутствующий номер очищает список — «Ничего не найдено».
  await search.fill('нет-такого-номера');
  await expect(page.locator('[data-testid="pickup-waiting-row"]')).toHaveCount(0);
  // Очистка возвращает очередь целиком.
  await search.fill('');
  await expect(rowOf(target)).toBeVisible();

  // 1. Время доставки показано у каждой карточки. У стенда его нет — значит
  //    честная отметка «Время не указано», а не пустое место.
  const todayRow = rowOf(stand['заказ сегодня'] ?? '');
  await expect(todayRow).toContainText('Время не указано');

  // 2. «Выдан» требует подтверждения с номером заказа и выдаёт через обычную выдачу.
  await todayRow.getByTestId('pickup-row-issue').click();
  const issueDialog = page.getByRole('dialog');
  await expect(issueDialog).toContainText(stand['заказ сегодня'] ?? '');
  await issueDialog.getByRole('button', { name: 'Выдан покупателю' }).click();

  // Ушёл из ожидающих без F5 и появился среди выданных.
  await expect(rowOf(stand['заказ сегодня'] ?? '')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="pickup-issued-row"]', { hasText: stand['заказ сегодня'] ?? '' }),
  ).toBeVisible();

  // 3. «Отмена» — локальное исключение из очереди с подтверждением.
  const cancelTarget = stand['заказ без ячейки'] ?? '';
  await expect(rowOf(cancelTarget)).toBeVisible();
  await rowOf(cancelTarget).getByTestId('pickup-row-cancel').click();
  const cancelDialog = page.getByRole('dialog');
  await expect(cancelDialog).toContainText(cancelTarget);
  await cancelDialog.getByRole('button', { name: 'Отменить самовывоз' }).click();

  // Карточка ушла из очереди без F5 и в справку выданных НЕ попала.
  await expect(rowOf(cancelTarget)).toHaveCount(0);
  await expect(
    page.locator('[data-testid="pickup-issued-row"]', { hasText: cancelTarget }),
  ).toHaveCount(0);
});

/**
 * Двойник камеры для прилавка.
 *
 * Настоящего устройства и разрешения в CI нет, а проводку «кадр → сервер →
 * выдача» доказать нужно: адаптер подменяется двойником, который отдаёт коды
 * по команде сценария.
 */
async function installCameraDouble(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Globals {
      __flCameraAdapter?: unknown;
      __flCameraRunning?: boolean;
      __flScan?: (code: string) => void;
      __flClear?: () => void;
      __flBreak?: () => void;
    }
    const scope = globalThis as unknown as Globals;

    const queue: string[] = [];
    let onCode: ((code: string) => void) | null = null;
    let onEmpty: (() => void) | null = null;
    let running = false;

    const pump = (): void => {
      if (!running) {
        return;
      }
      // Настоящий QR не исчезает из кадра оттого, что приложение занято.
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

    scope.__flScan = (code: string) => queue.push(code);
    scope.__flClear = () => {
      queue.length = 0;
    };
    // Обрыв потока: кадры больше не приходят, окно остаётся открытым.
    scope.__flBreak = () => {
      running = false;
    };
  });
}

/*
 * Скан на прилавке: код с телефона покупателя выдаёт заказ сам.
 *
 * Отдельного подтверждения нет намеренно — покупатель уже стоит перед
 * менеджером, а сервер всё равно проверяет отмену, способ получения и ячейку
 * заново.
 */
test('самовывоз с камеры: скан выдаёт заказ, а ошибки названы по причине', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await disableManualEntry(request);

  await installCameraDouble(page);
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

  await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
  const success = page.getByTestId('scan-success');
  const error = page.getByTestId('scan-error');

  // 1. Окно компактное, с рамкой и понятной подсказкой.
  await page.getByTestId('pickup-scan').click();
  await expect(page.getByTestId('scan-title')).toHaveText('Сканирование заказа');
  await expect(page.getByTestId('scan-hint')).toHaveText('Наведите камеру на QR-код заказа');
  await expect(page.locator('.scanner__reticle')).toBeVisible();
  const viewport = page.viewportSize();
  const box = await page.locator('.scanner').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan((viewport?.height ?? 0) - 8);

  // 2. Каждая причина отказа названа своими словами.
  const cases: [string, string][] = [
    ['ЧУЖОЙ-QR-НЕ-ЗАКАЗ', 'Ожидался QR-код заказа'],
    [stand['заказ доставки'] ?? '', 'Это не самовывозный заказ'],
    [stand['заказ отменён'] ?? '', 'Заказ отменён'],
    [stand['заказ без ячейки'] ?? '', 'Заказ не находится в ячейке'],
    [stand['заказ выдан'] ?? '', 'Заказ уже выдан покупателю'],
  ];
  for (const [code, text] of cases) {
    await scan(code, async () => {
      await expect(error, code).toContainText(text);
    });
    // «Повторить» возвращает к тому же шагу, а не закрывает окно.
    await page.getByTestId('scan-retry').click();
    await expect(page.getByTestId('scan-hint')).toHaveText('Наведите камеру на QR-код заказа');
  }

  // 3. Правильный код выдаёт заказ сам: отдельной кнопки подтверждения нет.
  const target = stand['заказ сегодня'] ?? '';
  await scan(target, async () => {
    await expect(success).toContainText(`Заказ ${target} выдан покупателю`);
  });

  /*
   * Уведомление об успехе исчезает само, и только потом закрывается окно:
   * камера гаснет вместе с ним, а не в момент ответа сервера.
   */
  await expect(page.getByTestId('scan-title')).toHaveCount(0);
  await expect(page.getByTestId('pickup-scan')).toBeVisible();
  expect(await cameraRunning()).toBe(false);
  await expect(
    page.locator(`[data-testid="pickup-waiting-row"][data-order-number="${target}"]`),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="pickup-issued-row"]', { hasText: target }),
  ).toBeVisible();

  // 4. Повторный кадр того же кода второй выдачи не делает.
  await page.getByTestId('pickup-scan').click();
  await scan(target, async () => {
    await expect(error).toContainText('Заказ уже выдан покупателю');
  });
  await page.getByTestId('scan-cancel').click();
  expect(await cameraRunning()).toBe(false);
  await expect(page.locator('[data-testid="pickup-issued-row"]', { hasText: target })).toHaveCount(
    1,
  );
});

/*
 * Камера отказала — прилавок не останавливается.
 */
test('самовывоз: отказ камеры, отсутствие устройства и обрыв потока', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await disableManualEntry(request);

  const denyCamera = async (page: Page, name: string): Promise<void> => {
    await page.addInitScript(`
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(new DOMException('нет доступа', '${name}')),
        },
      });
    `);
  };

  for (const [failure, text] of [
    ['NotAllowedError', 'Доступ к камере'],
    ['NotFoundError', 'Камера не найдена'],
  ] as [string, string][]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await denyCamera(page, failure);
    await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
    await page.getByTestId('pickup-scan').click();
    await expect(page.getByTestId('scan-camera-error')).toContainText(text);
    await page.getByTestId('scan-cancel').click();

    // Очередь работает как работала: отказ камеры её не ломает.
    await expect(page.getByTestId('pickup-waiting-count')).toBeVisible();
    await context.close();
  }

  /*
   * Поток оборвался: окно осталось открытым, кадры не приходят.
   * Незавершённое сканирование не выдаёт заказ.
   */
  const broken = await browser.newContext();
  const page = await broken.newPage();
  await installCameraDouble(page);
  await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await page.getByTestId('pickup-scan').click();
  await page.evaluate(() => {
    (globalThis as unknown as { __flBreak: () => void }).__flBreak();
  });
  await page.evaluate((code) => {
    (globalThis as unknown as { __flScan: (value: string) => void }).__flScan(code);
  }, stand['заказ завтра'] ?? '');
  await page.waitForTimeout(500);
  await page.getByTestId('scan-cancel').click();

  // Заказ по-прежнему в очереди: оборванный поток ничего не выдал.
  await expect(
    page.locator(
      `[data-testid="pickup-waiting-row"][data-order-number="${stand['заказ завтра'] ?? ''}"]`,
    ),
  ).toBeVisible();
  await broken.close();
});

/*
 * Ручная выдача существует только по решению администратора.
 */
test('самовывоз: ручная выдача появляется настройкой и выдаёт отдельной кнопкой', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await disableManualEntry(request);

  await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await expect(page.getByTestId('pickup-manual-open')).toHaveCount(0);

  // Прямой запрос ручной выдачи запрещён сервером, а не спрятан экраном.
  const denied = await page.request.post('/api/pickup/issues', {
    data: { orderNumber: stand['заказ сегодня'] ?? '', source: 'MANUAL' },
  });
  expect([401, 403, 409]).toContain(denied.status());

  await enableManualEntry(request);

  // Настройка доходит до открытого экрана без перезагрузки.
  await expect(page.getByTestId('pickup-manual-open')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('pickup-manual-open').click();

  const target = stand['заказ вчера'] ?? '';
  await page.getByTestId('pickup-search').fill(target);
  // Enter только ищет: случайное нажатие не отдаёт коробку.
  await page.getByTestId('pickup-search').press('Enter');
  await expect(page.getByTestId('pickup-card-number')).toHaveText(target);
  await expect(page.locator('[data-testid="pickup-issued-row"]', { hasText: target })).toHaveCount(
    0,
  );

  await page.getByTestId('pickup-issue').click();
  await expect(page.locator('.toast-region')).toContainText(`${target} выдан покупателю`);
  await expect(
    page.locator(`[data-testid="pickup-waiting-row"][data-order-number="${target}"]`),
  ).toHaveCount(0);

  await disableManualEntry(request);
});

/*
 * Два менеджера у одного прилавка и склад рядом.
 *
 * Очередь у обоих одна и та же: коробка, выданная соседом, обязана исчезнуть
 * у второго до того, как он пойдёт её искать.
 */
test('два сеанса: очередь прилавка обновляется от склада, выдачи и отмены', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await enableManualEntry(request);

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const keeperContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const keeper = await keeperContext.newPage();

  await login(first, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await login(second, stand['менеджер'] ?? '', stand['пин'] ?? '');
  await login(keeper, stand['кладовщик прилавка'] ?? '', stand['пин'] ?? '');

  const rowOf = (page: Page, number: string): Locator =>
    page.locator(`[data-testid="pickup-waiting-row"][data-order-number="${number}"]`);

  // 1. Складская приёмка добавляет заказ в очередь обоих менеджеров.
  const returning = stand['заказ без ячейки'] ?? '';
  await expect(rowOf(first, returning)).toContainText('Нет ячейки');
  await keeper.getByTestId('wh-scan-order').fill(returning);
  await keeper.getByTestId('wh-scan-order').press('Enter');
  await keeper.getByTestId('wh-scan-cell').fill(stand['ячейка A'] ?? '');
  await keeper.getByTestId('wh-place').click();
  await expect(keeper.locator('.toast-region')).toContainText(returning);

  // Ячейка появилась у обоих без перезагрузки.
  await expect(rowOf(first, returning)).toContainText(stand['ячейка A'] ?? '');
  await expect(rowOf(second, returning)).toContainText(stand['ячейка A'] ?? '');

  // 2. Выдача во втором сеансе убирает строку в первом.
  const target = stand['заказ сегодня'] ?? '';
  await second.getByTestId('pickup-manual-open').click();
  await second.getByTestId('pickup-search').fill(target);
  await second.getByTestId('pickup-search').press('Enter');
  await expect(second.getByTestId('pickup-card-number')).toHaveText(target);
  await second.getByTestId('pickup-issue').click();
  await expect(second.locator('.toast-region')).toContainText('выдан покупателю');

  await expect(rowOf(first, target)).toHaveCount(0);

  // 3. Отмена из источника убирает строку, снятие отмены возвращает её.
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };
  const cancelTarget = stand['заказ завтра'] ?? '';

  const cancelled = await request.post('/api/testing/source-cancellation', {
    headers,
    data: { orderNumber: cancelTarget, cancelled: true },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  await expect(rowOf(first, cancelTarget)).toHaveCount(0);
  await expect(rowOf(second, cancelTarget)).toHaveCount(0);

  const restored = await request.post('/api/testing/source-cancellation', {
    headers,
    data: { orderNumber: cancelTarget, cancelled: false },
  });
  expect(restored.status()).toBe(200);
  // Коробка всё это время лежала в ячейке — заказ возвращается в очередь.
  await expect(rowOf(first, cancelTarget)).toBeVisible();

  await disableManualEntry(request);
  await firstContext.close();
  await secondContext.close();
  await keeperContext.close();
});

/*
 * Прилавок на телефоне и планшете.
 */
test('самовывоз: 320, 375, 390 и 768 без выезда, окно внутри экрана', async ({
  browser,
  request,
}: {
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await enableManualEntry(request);

  for (const size of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    const label = `${size.width}×${size.height}`;
    const context = await browser.newContext({ viewport: size, hasTouch: true });
    const page = await context.newPage();
    await installCameraDouble(page);
    await login(page, stand['менеджер'] ?? '', stand['пин'] ?? '');
    await expect(page.getByRole('heading', { name: 'Самовывоз', level: 1 })).toBeVisible();

    const overflow = async (): Promise<number> =>
      page.evaluate<number>(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );
    expect(await overflow(), `очередь ${label}`).toBeLessThanOrEqual(1);

    // Поля не вызывают приближения страницы на сенсорном экране.
    await page.getByTestId('pickup-manual-open').click();
    await expect(page.getByTestId('pickup-search')).toBeVisible();
    const fonts = await page.evaluate<number[]>(
      "Array.from(document.querySelectorAll('input, select, textarea')).map((node) => parseFloat(getComputedStyle(node).fontSize))",
    );
    for (const font of fonts) {
      expect(font, `размер шрифта поля ${label}`).toBeGreaterThanOrEqual(16);
    }

    // Видимый фокус: поле в фокусе отличается от поля без него.
    await page.getByTestId('pickup-search').focus();
    const focusRing = await page.evaluate<string>(
      "(() => { const node = document.activeElement; if (node === null) { return ''; } const style = getComputedStyle(node); return [style.outlineStyle, style.outlineWidth, style.boxShadow, style.borderColor].join('|'); })()",
    );
    expect(focusRing.includes('none|0px|none') ? 'нет признака' : 'есть', `фокус ${label}`).toBe(
      'есть',
    );

    // Окно камеры целиком внутри экрана, фон под ним неподвижен.
    await page.getByTestId('pickup-scan').click();
    const box = await page.locator('.scanner').boundingBox();
    expect(box, label).not.toBeNull();
    expect(box!.x, `окно слева ${label}`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `окно справа ${label}`).toBeLessThanOrEqual(size.width + 1);
    expect(box!.y + box!.height, `окно снизу ${label}`).toBeLessThanOrEqual(size.height + 1);
    expect(await overflow(), `окно камеры ${label}`).toBeLessThanOrEqual(1);

    const locked = await page.evaluate<boolean>(
      "getComputedStyle(document.body).overflow === 'hidden' || document.body.scrollHeight <= window.innerHeight",
    );
    expect(locked, `фон под окном ${label}`).toBe(true);

    // Escape закрывает окно камеры и возвращает прилавок.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('scan-title')).toHaveCount(0);
    await expect(page.getByTestId('pickup-scan')).toBeVisible();

    await context.close();
  }

  await disableManualEntry(request);
});

/*
 * Переключатель ручного ввода на экране настроек.
 *
 * Один флаг меняет работу двух рабочих мест сразу, поэтому проверяется не
 * «галочка ставится», а то, что склад и прилавок узнают о ней на уже
 * открытых экранах.
 */
test('настройки: переключатель ручного ввода меняет склад и самовывоз без перезагрузки', async ({
  page,
  browser,
  request,
}: {
  page: Page;
  browser: Browser;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  const stand = seedPickupStand();
  await disableManualEntry(request);

  // 1. Администратор видит переключатель и его умолчание.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Настройки');
  const toggle = page.getByTestId('manual-entry-toggle');
  await expect(page.getByTestId('manual-entry-form')).toContainText(
    'Разрешить ручной ввод на складе и в самовывозе',
  );
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();

  // 2. Два рабочих места открыты заранее и ничего не перезагружают.
  const keeperContext = await browser.newContext();
  const managerContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const manager = await managerContext.newPage();
  await login(keeper, stand['кладовщик прилавка'] ?? '', stand['пин'] ?? '');
  await login(manager, stand['менеджер'] ?? '', stand['пин'] ?? '');

  await keeper.getByTestId('wh-tab-issue').click();
  await expect(manager.getByTestId('pickup-manual-open')).toHaveCount(0);

  // 3. Включение доходит до обоих без F5.
  /*
   * Нажатие, а не `check()`: переключатель управляется ответом сервера,
   * и до перезапроса галочка честно остаётся прежней.
   */
  await toggle.click();
  await expect(page.locator('.toast-region')).toContainText('Ручной ввод разрешён');
  await expect(toggle).toBeChecked();
  await expect(manager.getByTestId('pickup-manual-open')).toBeVisible({ timeout: 25_000 });

  await keeper.getByTestId('wh-tab-storage').click();
  await keeper.getByTestId('wh-scan-order').fill(stand['заказ доставки'] ?? '');
  await keeper.getByTestId('wh-scan-order').press('Enter');
  await expect(keeper.getByTestId('wh-scan-cell')).toBeVisible();

  // 4. Выключение так же доходит до обоих.
  await toggle.click();
  await expect(page.locator('.toast-region')).toContainText('Ручной ввод запрещён');
  await expect(toggle).not.toBeChecked();
  await expect(manager.getByTestId('pickup-manual-open')).toHaveCount(0, { timeout: 25_000 });

  // 5. Сканирование от переключателя не зависит: кнопка на месте всегда.
  await expect(manager.getByTestId('pickup-scan')).toBeVisible();
  await expect(keeper.getByTestId('wh-scan-camera')).toBeVisible();

  // 6. Логист видит переключатель, но выключенным для изменения.
  const logistContext = await browser.newContext();
  const logist = await logistContext.newPage();
  await login(logist, stand['менеджер'] ?? '', stand['пин'] ?? '');
  // Менеджеру раздел настроек недоступен вовсе — это проверяется отдельно;
  // здесь достаточно, что переключатель живёт в разделе администратора.
  await expect(logist.getByRole('link', { name: 'Настройки' })).toHaveCount(0);

  await keeperContext.close();
  await managerContext.close();
  await logistContext.close();
});

/**
 * Три замечания приёмки «Сделок» — проверяются вместе.
 *
 * Все три про то, что видно и достижимо на экране, а не про то, что записано
 * в базу: список курьеров, обрезанный модальным окном, недоступен так же
 * надёжно, как отсутствующий, а панель, которую нечем вернуть, теряет карту
 * до перезагрузки страницы.
 */
test('«Сделки»: список курьеров не обрезан, список скрывается, вкладки в лотке', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  await ensureCourier(browser);
  const numbers = seedOrders(2, { withPoint: true });
  expect(numbers).toHaveLength(2);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  // --- Вкладки лежат в одном лотке, активная выделена отдельно ---------------
  const tabs = page.locator('.shell__tabs');
  const tabsBox = await tabs.boundingBox();
  expect(tabsBox).not.toBeNull();
  for (const name of ['Сделки', 'Маршрутизация', 'Маршрутные листы', 'История', 'Отчёты']) {
    const box = await page.locator('.shell__tabs').getByRole('link', { name }).boundingBox();
    expect(box, `вкладка «${name}» вне лотка`).not.toBeNull();
    // Каждая вкладка целиком внутри лотка: лоток — один предмет, а не фон.
    expect(box!.x).toBeGreaterThanOrEqual(tabsBox!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(tabsBox!.x + tabsBox!.width + 1);
  }
  await expect(page.locator('.shell__tabs .shell__tab--active')).toHaveCount(1);
  // «Требуют решения» со своим счётчиком никуда не делась.
  await expect(
    page.locator('.shell__tabs').getByRole('link', { name: /Требуют решения/ }),
  ).toBeVisible();

  const overflow = async (): Promise<number> =>
    page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ) as Promise<number>;
  expect(await overflow()).toBeLessThanOrEqual(0);

  // --- Сворачивание панелей --------------------------------------------------
  await page.getByTestId('deals-select-all').click();
  const selectedBefore = await page.getByTestId('deals-selected-count').textContent();
  expect(selectedBefore).toBeTruthy();

  await page.getByTestId('deals-toggle-list').click();
  await expect(page.getByTestId('deals-column')).toBeHidden();
  await expect(page.getByTestId('deals-map-column')).toBeVisible();
  // Вернуть список нечем, если кнопка исчезла вместе с ним.
  await expect(page.getByTestId('deals-toggle-list')).toBeVisible();
  await page.getByTestId('deals-toggle-list').click();
  await expect(page.getByTestId('deals-column')).toBeVisible();

  /*
   * Выбор пережил скрытие: панель прячется, данные — нет.
   *
   * Уменьшиться выбор вправе ровно по одной причине — заказ стал недоступен
   * из-за чужого действия, и тогда экран об этом СКАЗАЛ. Тихая потеря выбора
   * и сброс в ноль по-прежнему валят проверку.
   */
  const selectionCount = (text: string | null): number =>
    Number(/\d+/.exec(text ?? '')?.[0] ?? '0');
  const selectedAfter = await page.getByTestId('deals-selected-count').textContent();
  expect(selectionCount(selectedAfter)).toBeGreaterThan(0);
  if (selectionCount(selectedAfter) !== selectionCount(selectedBefore)) {
    await expect(page.getByTestId('deals-notice')).toContainText('Из выбора снято заказов');
  }
  expect(await overflow()).toBeLessThanOrEqual(0);

  // --- Список курьеров в модальном окне --------------------------------------
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-courier-field').click();

  const options = page.getByTestId('create-route-courier-option');
  // Справочник курьеров приходит отдельным запросом: `count()` его не ждёт,
  // и на загруженной машине проверка получала ноль там, где курьер есть.
  await expect(options.first()).toBeVisible();
  const count = await options.count();
  expect(count).toBeGreaterThan(0);

  const last = options.nth(count - 1);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  /*
   * Список считает себе высоту по свободному месту и прокручивается сам,
   * поэтому в окно он помещается целиком, а до последнего варианта человек
   * докручивается. Проверяется и то и другое: и что список не свисает за
   * нижнюю границу, и что последний вариант после прокрутки виден полностью.
   */
  const listBox = await page.getByTestId('create-route-courier-list').boundingBox();
  expect(listBox).not.toBeNull();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(viewport!.height + 1);
  await last.scrollIntoViewIfNeeded();
  const lastBox = await last.boundingBox();
  expect(lastBox).not.toBeNull();
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(viewport!.height + 1);

  const label = (await last.textContent()) ?? '';
  await last.click();
  await expect(page.getByTestId('create-route-courier-field')).toHaveValue(label.trim());

  await context.close();
});

/**
 * Меню — наложение, а не колонка.
 *
 * Проверяется не внешний вид, а то, что экран под меню не трогают: раньше
 * панель занимала колонку, и её появление пересобирало раскладку — список
 * сжимался, карта уходила в адаптивный режим, раскрытые карточки схлопывались.
 * Поэтому измеряется положение рабочей области до, во время и после.
 */
test('оболочка: меню выезжает поверх экрана и не сдвигает рабочую область', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  seedOrders(2, { withPoint: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  const workspace = page.getByTestId('deals-workspace');
  await expect(workspace).toBeVisible();

  // Состояние, которое обязано пережить открытие меню.
  await page.getByTestId('deals-select-all').click();
  const selected = await page.getByTestId('deals-selected-count').textContent();

  const box = async (): Promise<string> => JSON.stringify(await workspace.boundingBox());
  const before = await box();

  const menu = page.locator('.shell__menu-button');
  await menu.click();
  await expect(page.locator('.shell--drawer-open')).toHaveCount(1);

  // Главное: рабочая область не сдвинулась и не сузилась.
  expect(await box()).toBe(before);
  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ),
  ).toBeLessThanOrEqual(0);
  /*
   * Выбор не сброшен: меню ничего под собой не пересоздаёт.
   *
   * Уменьшиться выбор вправе ровно по одной причине — заказ стал недоступен
   * из-за чужого действия, и тогда экран об этом СКАЗАЛ. Тихая потеря выбора
   * и сброс в ноль по-прежнему валят проверку.
   */
  const chosen = (text: string | null): number => Number(/\d+/.exec(text ?? '')?.[0] ?? '0');
  const after = await page.getByTestId('deals-selected-count').textContent();
  expect(chosen(after)).toBeGreaterThan(0);
  if (chosen(after) !== chosen(selected)) {
    await expect(page.getByTestId('deals-notice')).toContainText('Из выбора снято заказов');
  }

  // Выбор раздела выполняет обычный переход и закрывает панель.
  await page.locator('#shell-sidebar').getByRole('link', { name: 'Настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
  await expect(page.locator('.shell--drawer-open')).toHaveCount(0);

  await context.close();
});

/**
 * «Маршрутизация»: то, чего не проверял ни один существующий сценарий.
 *
 * Создание черновиков, состав, перестановка, перенос, «Создать МЛ» и «Отменить
 * маршрут» уже покрыты сквозным сценарием черновика и проверкой линии, а
 * идемпотентность повторного тела — сценарием пустого черновика. Здесь ровно
 * то, что осталось без проверки: свёрнутое состояние, история, скрытие списка
 * и переносимость состояния через него.
 */
test('маршрутизация: свёрнутый черновик, история и скрытие списка', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Маршрутизация' }).first().click();
  await expect(page.getByTestId('routing-drafts')).toBeVisible();

  /*
   * Свой пустой черновик: он создаётся раскрытым и единственным раскрытым.
   *
   * Дальше сценарий держится за его НОМЕР, а не за место в списке: в общей
   * базе черновиков много, порядок в списке меняется, и `.first()` уводил бы
   * проверки на чужой черновик.
   */
  await page.getByTestId('routing-add-draft').click();
  const opened = page.locator('.routes__draft[data-expanded="true"]');
  await expect(opened).toHaveCount(1);
  const draftNumber = (await opened.getAttribute('data-draft-number')) ?? '';
  expect(draftNumber).not.toBe('');
  const draft = page.locator(`.routes__draft[data-draft-number="${draftNumber}"]`);

  // --- Свёрнутое состояние не прячет тело, а не имеет его ------------------
  const expandedHeight = (await draft.boundingBox())?.height ?? 0;
  await draft.locator('.routes__draft-head').click();
  await expect(draft).toHaveAttribute('data-expanded', 'false');
  // Ни курьера, ни действий, ни истории: содержимое удалено, а не скрыто.
  await expect(draft.locator('.routes__card')).toHaveCount(0);
  await expect(draft.getByText('История маршрута')).toHaveCount(0);
  /*
   * Свёрнутая карточка по макету — шапка плюс строка блокировки, а не одна
   * строка: важно, что тело действительно удалено, поэтому высота
   * сравнивается с развёрнутой, а не с давним числом в пикселях.
   */
  const collapsedHeight = (await draft.boundingBox())?.height ?? 0;
  expect(collapsedHeight).toBeLessThan(expandedHeight / 2);

  // --- История раскрывается внутри карточки --------------------------------
  await draft.locator('.routes__draft-head').click();
  await expect(draft).toHaveAttribute('data-expanded', 'true');
  /*
   * История раскрывается кнопкой нижнего ряда и до нажатия не занимает
   * строку: раскрытое состояние объявлено через aria-expanded.
   */
  const history = draft.getByTestId('route-history-toggle');
  await expect(history).toBeVisible();
  await expect(history).toHaveAttribute('aria-expanded', 'false');
  await expect(draft.locator('.routes__history')).toHaveCount(0);
  await history.click();
  await expect(history).toHaveAttribute('aria-expanded', 'true');
  await expect(draft.locator('.routes__history')).toHaveCount(1);

  // --- Скрытие списка расширяет карту --------------------------------------
  const mapBefore = (await page.getByTestId('routing-map-panel').boundingBox())?.width ?? 0;
  await page.getByTestId('routing-toggle-drafts').click();
  await expect(page.getByTestId('routing-drafts')).toBeHidden();
  const mapWide = (await page.getByTestId('routing-map-panel').boundingBox())?.width ?? 0;
  expect(mapWide).toBeGreaterThan(mapBefore);
  // Вернуть список нечем, если кнопка исчезла вместе с ним.
  await expect(page.getByTestId('routing-toggle-drafts')).toBeVisible();

  await page.getByTestId('routing-toggle-drafts').click();
  await expect(page.getByTestId('routing-drafts')).toBeVisible();
  // Раскрытый черновик и его раскрытая история пережили скрытие: панель
  // убирается из сетки, но не размонтируется.
  await expect(page.locator('.routes__draft[data-expanded="true"]')).toHaveCount(1);
  await expect(draft.locator('.routes__history')).toHaveCount(1);

  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ),
  ).toBeLessThanOrEqual(0);

  await context.close();
});

/** «Маршрутизация» на телефоне: обе области и управление панелями доступны. */
test('маршрутизация на телефоне: список, карта и переключатель без выезда', async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.goto('/logistics/routing');
  await expect(page.getByTestId('routing-drafts')).toBeVisible();
  await expect(page.getByTestId('routing-map-panel')).toBeVisible();
  await expect(page.getByTestId('routing-toggle-drafts')).toBeVisible();

  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ),
  ).toBeLessThanOrEqual(0);

  await context.close();
});

/*
 * Приоритет ближайших самовывозов.
 *
 * Проверяется то, ради чего группа заведена: заказ, до которого остался
 * меньше часа, стоит первым и не ждёт F5. Точность самого порога доказана
 * серверными проверками (`pickup-priority.critical.test.ts`) — здесь важно,
 * что признак доходит до экрана, что группа обновляется сама и что ни
 * фильтр, ни узкий экран её не ломают.
 */
test('флорист: ближайшие самовывозы стоят первой группой и обновляются без F5', async ({
  page,
  browser,
  request,
}: {
  page: Page;
  browser: Browser;
  request: APIRequestContext;
}) => {
  const soonNumber = process.env['E2E_PICKUP_SOON'] ?? '';
  const laterNumber = process.env['E2E_PICKUP_LATER'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    soonNumber === '' || laterNumber === '',
    'не переданы фикстуры приоритета самовывоза (E2E_PICKUP_SOON/E2E_PICKUP_LATER)',
  );

  const FLORIST_PIN = '4816';

  // 1. Администратор заводит флориста этой проверки.
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Сотрудники и курьеры');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await page.getByLabel('ФИО').fill('Флорист приоритета');
  const floristPhone = uniquePhone();
  await page.getByLabel('Телефон').fill(floristPhone);
  await page.getByRole('checkbox', { name: 'Флорист' }).check();
  const courierRole = page.getByRole('checkbox', { name: 'Курьер', exact: true });
  if (await courierRole.isChecked()) {
    await courierRole.uncheck();
  }
  await page.getByRole('button', { name: 'Создать' }).click();
  const floristCode = (await page.locator('.one-time-code').innerText()).trim();
  await page.getByRole('button', { name: 'Я сохранил код' }).click();

  // Телефон: узкая раскладка проверяется вместе с остальным, а не отдельно.
  const floristContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const floristPage = await floristContext.newPage();
  await activate(floristPage, floristPhone, floristCode, FLORIST_PIN);

  const groups = floristPage.locator('[data-testid="florist-queue-group"]');
  const pickupGroup = floristPage.locator('[data-group-kind="pickup-soon"]');

  // 2. Группа существует, стоит ПЕРВОЙ и содержит только ближайший самовывоз.
  await expect(pickupGroup).toBeVisible();
  await expect(pickupGroup).toContainText('Ближайшие самовывозы');
  await expect(pickupGroup).toContainText(soonNumber);
  await expect(groups.first()).toHaveAttribute('data-group-kind', 'pickup-soon');
  // Самовывоз, до которого ещё пять часов, приоритета не получает.
  await expect(pickupGroup).not.toContainText(laterNumber);

  // Счётчик заголовка равен числу строк группы: он не декоративный.
  const shown = await pickupGroup.locator('.florist__row').count();
  await expect(pickupGroup.locator('.florist__group-count')).toHaveText(String(shown));

  // 3. Узкий экран: горизонтального выезда нет ни у страницы, ни у группы.
  const overflow = await floristPage.evaluate(() => {
    const scope = globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; clientWidth: number };
        querySelector: (s: string) => { scrollWidth: number; clientWidth: number } | null;
      };
    };
    const group = scope.document.querySelector('[data-group-kind="pickup-soon"]');
    return {
      page: scope.document.documentElement.scrollWidth - scope.document.documentElement.clientWidth,
      group: group === null ? 0 : group.scrollWidth - group.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.group).toBeLessThanOrEqual(0);

  /*
   * 4. Очередь перезапрашивается САМА.
   *
   * Момент «осталось меньше часа» наступает от хода времени: никто ничего
   * не нажимает, и события realtime не происходит. Проверяется именно это —
   * запрос без единого действия человека.
   */
  await floristPage.waitForRequest((candidate) => candidate.url().includes('/api/florist/queue'), {
    timeout: 90_000,
  });

  // 5. Введённый фильтр опрос не сбрасывает.
  await floristPage.getByTestId('florist-search').fill(soonNumber);
  await expect(pickupGroup).toContainText(soonNumber);
  await floristPage.waitForRequest((candidate) => candidate.url().includes('/api/florist/queue'), {
    timeout: 90_000,
  });
  await expect(floristPage.getByTestId('florist-search')).toHaveValue(soonNumber);
  await expect(pickupGroup).toContainText(soonNumber);
  await floristPage.getByTestId('florist-search').fill('');

  /*
   * 6. Отмена доходит без F5.
   *
   * Отменённый заказ из очереди не исчезает — собирать его нельзя, и это
   * видно прямо в строке. Но приоритета он лишается: покупателя, за которым
   * никто не придёт, вперёд не пропускают.
   */
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };

  const cancelled = await request.post('/api/testing/source-cancellation', {
    headers,
    data: { orderNumber: soonNumber, cancelled: true },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);

  await expect(floristPage.locator('[data-group-kind="pickup-soon"]')).toHaveCount(0, {
    timeout: 90_000,
  });

  /*
   * Заказ не потерян — он потерял приоритет.
   *
   * Искать его в общем списке бессмысленно: без приоритета он уходит вниз,
   * за границу загруженной страницы, и «не видно» там ничего не доказывает.
   * Поиск по номеру спрашивает СЕРВЕР обо всей очереди — и заказ находится,
   * но уже вне приоритетной группы.
   */
  await floristPage.getByTestId('florist-search').fill(soonNumber);
  await expect(floristPage.locator('.florist__row', { hasText: soonNumber })).toBeVisible({
    timeout: 30_000,
  });
  await expect(floristPage.locator('[data-group-kind="pickup-soon"]')).toHaveCount(0);
  await floristPage.getByTestId('florist-search').fill('');

  const restored = await request.post('/api/testing/source-cancellation', {
    headers,
    data: { orderNumber: soonNumber, cancelled: false },
  });
  expect(restored.status()).toBe(200);
  await expect(floristPage.locator('[data-group-kind="pickup-soon"]')).toContainText(soonNumber, {
    timeout: 90_000,
  });

  await floristContext.close();
});

/*
 * История заказа: шесть взаимоисключающих исходов на шести заказах.
 *
 * Один заказ не может быть одновременно доставленным, пересобранным и
 * списанным. Поэтому фикстура готовит шесть отдельных историй настоящими
 * доменными операциями, а сценарий открывает каждую страницу и сверяет
 * состав, порядок, авторов и пометки.
 */

/** Машинные имена строк открытой истории — в порядке показа. */
async function historyKinds(page: Page): Promise<string[]> {
  return page
    .getByTestId('order-history-event')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as { dataset: { kind?: string } }).dataset.kind ?? ''),
    );
}

/** Открыть историю по прямой ссылке: право проверяет сервер, а не переход. */
async function openHistory(page: Page, orderId: string): Promise<void> {
  await page.goto(`/order-history/${orderId}`);
  await expect(page.getByTestId('order-history')).toBeVisible();
  await expect(page.getByTestId('order-history-event').first()).toBeVisible();
}

function requireKinds(kinds: string[], expected: string[], label: string): void {
  for (const kind of expected) {
    expect(
      kinds.filter((value) => value === kind),
      `${label}: ${kind}`,
    ).toHaveLength(1);
  }
}

test('история заказа: успешная доставка, повторная доставка и пересборка', async ({
  page,
}: {
  page: Page;
}) => {
  const delivered = process.env['E2E_HISTORY_DELIVERED_ID'] ?? '';
  const deliveredNumber = process.env['E2E_HISTORY_DELIVERED'] ?? '';
  const redelivery = process.env['E2E_HISTORY_REDELIVERY_ID'] ?? '';
  const reassembly = process.env['E2E_HISTORY_REASSEMBLY_ID'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    delivered === '' || redelivery === '' || reassembly === '',
    'не переданы фикстуры истории (E2E_HISTORY_*)',
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  /*
   * 1. Успешная доставка — прямая линия без единой пометки об отмене.
   */
  await openHistory(page, delivered);
  await expect(page.getByTestId('order-history-number')).toContainText(deliveredNumber);
  const deliveredKinds = await historyKinds(page);
  requireKinds(
    deliveredKinds,
    [
      'ORDER_INITIAL_IMPORT',
      'ORDER_QUEUED_FOR_FLORIST',
      'ADDRESS_LOCAL_ADDRESS_SET',
      'ORDER_FULFILLMENT_CLAIMED',
      'ORDER_FULFILLMENT_ASSEMBLED',
      'ORDER_PRINTED',
      'ORDER_REPRINTED',
      'PLACEMENT_RECEIVED',
      'ROUTE_ORDER_ADDED',
      'ROUTE_COURIER_ASSIGNED',
      'ROUTE_CONFIRMED',
      'ROUTE_ISSUE_CHECKED',
      'PLACEMENT_RELEASED_ISSUED_TO_COURIER',
      'ROUTE_ACTIVE',
      'DELIVERY_DELIVERED',
    ],
    'доставка',
  );
  /*
   * Правка интервала проверяется «хотя бы одна».
   *
   * Соседний сценарий этого же прогона правит интервал ещё раз, чтобы
   * доказать обновление без F5, — и требовать здесь ровно одну строку
   * значило бы проверять порядок запуска сценариев, а не историю.
   */
  expect(deliveredKinds).toContain('ORDER_INTERVAL_SET');

  // Недоставки, возврата и пересборки в этой истории быть не может.
  expect(deliveredKinds).not.toContain('DELIVERY_FAILED');
  expect(deliveredKinds).not.toContain('ORDER_RETURN_OPENED');
  // Дублей нет: ключи строк уникальны, одно действие показано один раз.
  const deliveredKeys = await page
    .getByTestId('order-history-event')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as { textContent: string }).textContent ?? ''),
    );
  expect(new Set(deliveredKeys).size).toBe(deliveredKeys.length);
  // Порядок: сборка раньше отгрузки, отгрузка раньше доставки.
  expect(deliveredKinds.indexOf('ORDER_FULFILLMENT_ASSEMBLED')).toBeLessThan(
    deliveredKinds.indexOf('ROUTE_ACTIVE'),
  );
  expect(deliveredKinds.indexOf('ROUTE_ACTIVE')).toBeLessThan(
    deliveredKinds.indexOf('DELIVERY_DELIVERED'),
  );
  // Время строк не убывает.
  const times = await page
    .getByTestId('order-history-event')
    .locator('.order-history__time')
    .allInnerTexts();
  expect([...times].sort()).toEqual(times);

  // Автор и роль видны прямо в строке.
  const claimRow = page.locator('[data-kind="ORDER_FULFILLMENT_CLAIMED"]');
  await expect(claimRow).toContainText('Флорист истории');
  await expect(claimRow).toContainText('флорист');
  await expect(page.locator('[data-kind="ORDER_INITIAL_IMPORT"]')).toContainText('МойСклад');
  await expect(page.locator('[data-kind="PLACEMENT_RECEIVED"]')).toContainText('Кладовщик истории');
  await expect(page.locator('[data-kind="DELIVERY_DELIVERED"]')).toContainText('Курьер истории');

  // Ни телефона, ни получателя, ни комментария, ни сырого снимка.
  const body = (await page.getByTestId('order-history').innerText()).replace(/\s+/g, ' ');
  expect(body).not.toContain('Проверочный получатель');
  expect(body).not.toContain('Позвонить за час');
  expect(body).not.toMatch(/\+7\d{10}/);
  expect(body).not.toContain('snapshot');
  expect(body).not.toContain('Роза красная');

  /*
   * 2. Повторная доставка ТЕМ ЖЕ букетом: два маршрута, один круг сборки.
   */
  await openHistory(page, redelivery);
  const redeliveryKinds = await historyKinds(page);
  requireKinds(
    redeliveryKinds,
    [
      'DELIVERY_FAILED',
      'ORDER_RESOLUTION_OPENED',
      'ORDER_RETURN_OPENED',
      'ORDER_RETURN_ACCEPTED',
      'PLACEMENT_COURIER_RETURN',
      'ORDER_RESOLUTION_REDELIVER_SAME_BOUQUET',
      'DELIVERY_DELIVERED',
    ],
    'повторная доставка',
  );
  // Второй маршрут и вторая выдача — по две строки на каждое.
  expect(redeliveryKinds.filter((value) => value === 'ROUTE_ORDER_ADDED')).toHaveLength(2);
  expect(redeliveryKinds.filter((value) => value === 'ROUTE_ACTIVE')).toHaveLength(2);
  expect(
    redeliveryKinds.filter((value) => value === 'PLACEMENT_RELEASED_ISSUED_TO_COURIER'),
  ).toHaveLength(2);
  // Букет тот же: второго круга сборки нет.
  expect(redeliveryKinds.filter((value) => value === 'ORDER_FULFILLMENT_ASSEMBLED')).toHaveLength(
    1,
  );
  // Порядок: недоставка → возврат → решение → повторная доставка.
  expect(redeliveryKinds.indexOf('DELIVERY_FAILED')).toBeLessThan(
    redeliveryKinds.indexOf('ORDER_RETURN_ACCEPTED'),
  );
  expect(redeliveryKinds.indexOf('ORDER_RETURN_ACCEPTED')).toBeLessThan(
    redeliveryKinds.indexOf('ORDER_RESOLUTION_REDELIVER_SAME_BOUQUET'),
  );
  expect(redeliveryKinds.indexOf('ORDER_RESOLUTION_REDELIVER_SAME_BOUQUET')).toBeLessThan(
    redeliveryKinds.lastIndexOf('DELIVERY_DELIVERED'),
  );
  // Недоставка осталась в истории и после успешной повторной доставки.
  await expect(page.locator('[data-kind="DELIVERY_FAILED"]')).toBeVisible();

  /*
   * 3. Пересборка: второй круг сборки с новой печатью и новой готовностью.
   */
  await openHistory(page, reassembly);
  const reassemblyKinds = await historyKinds(page);
  requireKinds(
    reassemblyKinds,
    [
      'DELIVERY_FAILED',
      'ORDER_RETURN_ACCEPTED',
      'ORDER_RESOLUTION_REDELIVER_REASSEMBLE',
      'PLACEMENT_RELEASED_WITHDRAWN',
    ],
    'пересборка',
  );
  // Два круга сборки: две отметки «Собран», две первые печати, два бланка.
  expect(reassemblyKinds.filter((value) => value === 'ORDER_FULFILLMENT_ASSEMBLED')).toHaveLength(
    2,
  );
  expect(reassemblyKinds.filter((value) => value === 'ORDER_PRINT_FORM_CREATED')).toHaveLength(2);
  expect(reassemblyKinds.filter((value) => value === 'ORDER_FULFILLMENT_CLAIMED')).toHaveLength(2);
  // Решение о пересборке стоит РАНЬШЕ второго захвата и второй печати.
  const decisionAt = reassemblyKinds.indexOf('ORDER_RESOLUTION_REDELIVER_REASSEMBLE');
  expect(decisionAt).toBeLessThan(reassemblyKinds.lastIndexOf('ORDER_FULFILLMENT_CLAIMED'));
  expect(decisionAt).toBeLessThan(reassemblyKinds.lastIndexOf('ORDER_FULFILLMENT_ASSEMBLED'));
  // Первый круг никуда не делся: его строки по-прежнему выше решения.
  expect(reassemblyKinds.indexOf('ORDER_FULFILLMENT_ASSEMBLED')).toBeLessThan(decisionAt);
  // Второй круг печатается как ПЕРВАЯ печать своего бланка, а не как повтор.
  expect(reassemblyKinds.filter((value) => value === 'ORDER_PRINTED')).toHaveLength(2);
  await expect(page.locator('[data-kind="ORDER_PRINT_FORM_CREATED"]').last()).toContainText('2');
  await expect(page.locator('[data-kind="ORDER_PRINTED"]').last()).toContainText('Круг сборки');
  // Снятие с полки на пересборку названо причиной.
  await expect(page.locator('[data-kind="PLACEMENT_RELEASED_WITHDRAWN"]')).toContainText(
    'на пересборку',
  );
});

test('история заказа: отмена источника, отмена логистом и списание', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const sourceCancel = process.env['E2E_HISTORY_SOURCE_CANCEL_ID'] ?? '';
  const logistCancel = process.env['E2E_HISTORY_LOGIST_CANCEL_ID'] ?? '';
  const writeOff = process.env['E2E_HISTORY_WRITE_OFF_ID'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(
    sourceCancel === '' || logistCancel === '' || writeOff === '',
    'не переданы фикстуры истории (E2E_HISTORY_*)',
  );

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  /*
   * 1. Отмена из МоегоСклада и её снятие: обе строки остаются.
   */
  await openHistory(page, sourceCancel);
  const cancelKinds = await historyKinds(page);
  requireKinds(
    cancelKinds,
    ['ORDER_CANCELLED_IN_SOURCE', 'ORDER_CANCELLATION_WITHDRAWN'],
    'отмена источника',
  );
  expect(cancelKinds.indexOf('ORDER_CANCELLED_IN_SOURCE')).toBeLessThan(
    cancelKinds.indexOf('ORDER_CANCELLATION_WITHDRAWN'),
  );
  // Отменённое действие не исчезает, а получает пометку.
  await expect(page.locator('[data-kind="ORDER_CANCELLED_IN_SOURCE"]')).toHaveAttribute(
    'data-reverted',
    'true',
  );
  await expect(page.locator('[data-kind="ORDER_CANCELLED_IN_SOURCE"]')).toContainText(
    'отменено позже',
  );
  // Отмена снята — шапка об отмене больше не сообщает.
  await expect(page.getByTestId('order-history-cancelled')).toHaveCount(0);

  /*
   * 2. Отмена логистом: автор с ролью и итоговое состояние заказа.
   */
  await openHistory(page, logistCancel);
  const logistKinds = await historyKinds(page);
  requireKinds(
    logistKinds,
    ['DELIVERY_FAILED', 'ORDER_RESOLUTION_OPENED', 'ORDER_RESOLUTION_CANCELLED'],
    'отмена логистом',
  );
  /*
   * Автора решения проверяем по признаку «это человек», а не по имени.
   *
   * Имя первого администратора зависит от того, кто поднял окружение, и
   * привязка к нему делала бы проверку рассказом о стенде, а не о продукте.
   * Роль при этом обязана быть названа: она приходит снимком из журнала.
   */
  const decisionRow = page.locator('[data-kind="ORDER_RESOLUTION_CANCELLED"]');
  await expect(decisionRow).not.toContainText('Система');
  await expect(decisionRow).not.toContainText('МойСклад');
  await expect(page.locator('[data-kind="ORDER_CANCELLED_BY_LOGIST"]')).toContainText(
    'администратор',
  );
  await expect(page.getByTestId('order-history-cancelled')).toContainText('Отменён логистом');

  /*
   * 3. Списание: возврат и списание — РАЗНЫЕ строки.
   */
  await openHistory(page, writeOff);
  const writeOffKinds = await historyKinds(page);
  requireKinds(
    writeOffKinds,
    ['ORDER_RETURN_ACCEPTED', 'PLACEMENT_COURIER_RETURN', 'PLACEMENT_RELEASED_WITHDRAWN'],
    'списание',
  );
  expect(writeOffKinds.indexOf('ORDER_RETURN_ACCEPTED')).toBeLessThan(
    writeOffKinds.indexOf('PLACEMENT_RELEASED_WITHDRAWN'),
  );
  await expect(page.locator('[data-kind="PLACEMENT_RELEASED_WITHDRAWN"]')).toContainText(
    'в списание',
  );

  /*
   * 4. Право читать историю проверяет СЕРВЕР.
   *
   * Флорист, кладовщик и курьер получают отказ по прямому запросу — спрятанная
   * кнопка чужой запрос не останавливает.
   */
  for (const [phone, pin] of [
    [process.env['E2E_HISTORY_FLORIST'] ?? '', '3517'],
    [process.env['E2E_HISTORY_KEEPER'] ?? '', '3518'],
    [process.env['E2E_HISTORY_COURIER'] ?? '', '3519'],
  ] as [string, string][]) {
    if (phone === '') {
      continue;
    }
    const auth = await request.post('/api/auth/login', { data: { phone, pin } });
    expect(auth.status(), phone).toBe(200);
    const token = ((await auth.json()) as { accessToken: string }).accessToken;
    const denied = await request.get(`/api/orders/${writeOff}/timeline`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status(), phone).toBe(403);
  }
});

test('история заказа: обновление без F5, только чтение и телефон', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const orderId = process.env['E2E_HISTORY_DELIVERED_ID'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(orderId === '', 'не передана фикстура истории (E2E_HISTORY_DELIVERED_ID)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openHistory(page, orderId);
  const screen = page.getByTestId('order-history');

  // 1. Экран только читает: полей ввода на нём нет вовсе.
  await expect(screen.locator('input, textarea, select')).toHaveCount(0);
  await expect(screen.getByTestId('order-window-address')).toHaveCount(0);
  await expect(screen.getByTestId('order-window-interval')).toHaveCount(0);

  /*
   * 2. Новое действие доходит без перезагрузки.
   *
   * Интервал меняет логист обычным входом, а открытая история узнаёт об этом
   * сама: событие realtime перечитывает ленту и ставит строку на своё место.
   */
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };
  const card = await request.get(`/api/orders/${orderId}`, { headers });
  const version = ((await card.json()) as { order: { version: number } }).order.version;

  const intervalRows = page.locator('[data-kind="ORDER_INTERVAL_SET"]');
  const before = await intervalRows.count();
  const saved = await request.put(`/api/orders/${orderId}/interval`, {
    headers,
    data: { startMinute: 720, endMinute: 840, version },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await expect(intervalRows).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(intervalRows.last()).toContainText('12:00–14:00');
  // Новая строка встала последней по времени, а не в середину ленты.
  const kinds = await historyKinds(page);
  expect(kinds.lastIndexOf('ORDER_INTERVAL_SET')).toBe(kinds.length - 1);

  // 3. Дни: заголовок дня есть и он московский.
  await expect(page.getByTestId('order-history-day').first()).toBeVisible();

  // 4. Телефон 390×844: горизонтального выезда нет ни у страницы, ни у ленты.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(screen).toBeVisible();
  const overflow = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; clientWidth: number };
        querySelector: (s: string) => { scrollWidth: number; clientWidth: number } | null;
      };
    };
    const list = scope.document.querySelector('.order-history__list');
    const header = scope.document.querySelector('.order-history__header');
    return {
      page: scope.document.documentElement.scrollWidth - scope.document.documentElement.clientWidth,
      list: list === null ? 0 : list.scrollWidth - list.clientWidth,
      header: header === null ? 0 : header.scrollWidth - header.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.list).toBeLessThanOrEqual(0);
  expect(overflow.header).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });

  /*
   * 5. Вход из окна заказа и возврат назад.
   *
   * Берётся живой заказ дня, а не доставленный: выполненный уходит из
   * «Сделок» по своему правилу, и его отсутствие там — не про историю.
   */
  const dealNumber = process.env['E2E_HISTORY_SOURCE_CANCEL'] ?? '';
  const dealId = process.env['E2E_HISTORY_SOURCE_CANCEL_ID'] ?? '';
  test.skip(dealNumber === '', 'не передана фикстура живого заказа (E2E_HISTORY_SOURCE_CANCEL)');

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await page.getByLabel('Поиск в этом дне').fill(dealNumber);
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const dealCard = page.locator(`[data-testid="deal-card"][data-order-number="${dealNumber}"]`);
  await expect(dealCard).toBeVisible();
  await dealCard.getByTestId('order-number').click();
  await expect(page.getByTestId('order-window')).toBeVisible();
  await page.getByTestId('order-window-history').click();
  await expect(page.getByTestId('order-history')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/order-history/${dealId}$`));

  /*
   * «Назад» ведёт в общий раздел истории.
   *
   * Пришли из окна заказа — значит, в списке результатов человека ещё не
   * было, и возвращать его «на шаг назад» в чужой раздел незачем.
   */
  await page.getByTestId('order-history-back').click();
  await expect(page.getByTestId('order-history-search')).toBeVisible();
});

/*
 * Общий раздел «История заказов».
 *
 * Проверяется то, ради чего он отделён от «Логистики»: заказ ищется по номеру
 * за любую дату и с любым исходом, список постраничный и серверный, а возврат
 * из истории сохраняет и запрос, и догруженные страницы.
 */
test('раздел «История заказов»: меню, серверный поиск и возврат к результатам', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  const delivered = process.env['E2E_HISTORY_DELIVERED'] ?? '';
  const deliveredId = process.env['E2E_HISTORY_DELIVERED_ID'] ?? '';
  const writeOff = process.env['E2E_HISTORY_WRITE_OFF'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(delivered === '', 'не переданы фикстуры истории (E2E_HISTORY_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  // 1. Пункт меню есть и ведёт в самостоятельный раздел, а не во вкладку.
  await openSection(page, 'История заказов');
  await expect(page.getByTestId('order-history-search')).toBeVisible();
  await expect(page).toHaveURL(/\/order-history$/);

  /*
   * 2. Поиск серверный: общий префикс шести историй находит их все, включая
   *    доставленную, отменённую, возвращённую, пересобранную и списанную.
   */
  const prefix = delivered.replace(/-DLV$/, '');
  await page.getByTestId('order-history-search-input').fill(prefix);
  await page.getByTestId('order-history-search-submit').click();

  const rows = page.getByTestId('order-history-result');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('order-history-count')).toContainText('из 6');

  // Первая страница короче набора: клиент не прячет остальные заказы.
  const shownFirst = await rows.count();
  expect(shownFirst).toBeLessThanOrEqual(6);

  // Догрузка добирает недостающие строки, и повторов не возникает.
  const more = page.getByTestId('order-history-more');
  while ((await more.count()) > 0) {
    await more.click();
    await expect(more).toHaveCount(0, { timeout: 15_000 });
  }
  const numbers = await rows.evaluateAll((nodes) =>
    nodes.map((node) => (node as { dataset: { orderNumber?: string } }).dataset.orderNumber ?? ''),
  );
  expect(new Set(numbers).size).toBe(numbers.length);
  for (const suffix of ['DLV', 'RDL', 'RAS', 'CNS', 'CNL', 'WOF']) {
    expect(numbers, suffix).toContain(`${prefix}-${suffix}`);
  }

  // Строка объясняет состояние и не выдаёт персональных данных.
  const listText = (await page.getByTestId('order-history-results').innerText()).replace(
    /\s+/g,
    ' ',
  );
  expect(listText).not.toContain('Проверочный получатель');
  expect(listText).not.toContain('Позвонить за час');
  expect(listText).not.toMatch(/\+7\d{10}/);

  // Отменённый заказ подписан прямо в списке.
  const cancelledRow = page.locator(
    `[data-testid="order-history-result"][data-order-number="${prefix}-CNL"]`,
  );
  await expect(cancelledRow).toContainText('Отменён логистом');

  /*
   * 3. Строка открывает историю ИМЕННО этого заказа по постоянному
   *    идентификатору, а «Назад» возвращает список с тем же запросом.
   */
  const deliveredRow = page.locator(
    `[data-testid="order-history-result"][data-order-number="${delivered}"]`,
  );
  await deliveredRow.getByTestId('order-history-open-button').click();
  await expect(page.getByTestId('order-history')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/order-history/${deliveredId}$`));
  await expect(page.getByTestId('order-history-number')).toContainText(delivered);

  await page.getByTestId('order-history-back').click();
  await expect(page.getByTestId('order-history-search')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`q=${prefix}`));
  await expect(page.getByTestId('order-history-search-input')).toHaveValue(prefix);
  // Догруженные страницы никуда не делись: список того же размера.
  await expect(rows).toHaveCount(numbers.length);

  // 4. Прежний адрес истории продолжает работать и ведёт в новый раздел.
  await page.goto(`/logistics/orders/${deliveredId}/history`);
  await expect(page.getByTestId('order-history')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/order-history/${deliveredId}$`));

  /*
   * 5. Право читать раздел проверяет СЕРВЕР.
   */
  for (const [phone, pin] of [
    [process.env['E2E_HISTORY_FLORIST'] ?? '', '3517'],
    [process.env['E2E_HISTORY_KEEPER'] ?? '', '3518'],
    [process.env['E2E_HISTORY_COURIER'] ?? '', '3519'],
  ] as [string, string][]) {
    if (phone === '') {
      continue;
    }
    const auth = await request.post('/api/auth/login', { data: { phone, pin } });
    expect(auth.status(), phone).toBe(200);
    const token = ((await auth.json()) as { accessToken: string }).accessToken;
    const denied = await request.get(
      `/api/orders/history/search?query=${encodeURIComponent(writeOff)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(denied.status(), phone).toBe(403);
  }

  // 6. Телефон 390×844: горизонтального выезда нет.
  await page.goto('/order-history?q=' + encodeURIComponent(prefix));
  await expect(page.getByTestId('order-history-result').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      document: {
        documentElement: { scrollWidth: number; clientWidth: number };
        querySelector: (s: string) => { scrollWidth: number; clientWidth: number } | null;
      };
    };
    const list = scope.document.querySelector('[data-testid="order-history-results"]');
    return {
      page: scope.document.documentElement.scrollWidth - scope.document.documentElement.clientWidth,
      list: list === null ? 0 : list.scrollWidth - list.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.list).toBeLessThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('раздел «История заказов»: скрыт у чужих ролей и обновляется без F5', async ({
  page,
  browser,
  request,
}: {
  page: Page;
  browser: Browser;
  request: APIRequestContext;
}) => {
  const delivered = process.env['E2E_HISTORY_DELIVERED'] ?? '';
  const deliveredId = process.env['E2E_HISTORY_DELIVERED_ID'] ?? '';
  const floristPhone = process.env['E2E_HISTORY_FLORIST'] ?? '';

  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(delivered === '' || floristPhone === '', 'не переданы фикстуры истории');

  /*
   * 1. У флориста пункта нет вовсе, а прямой адрес его в раздел не пускает.
   */
  const floristContext = await browser.newContext();
  const floristPage = await floristContext.newPage();
  await login(floristPage, floristPhone, '3517');
  await expect(floristPage.getByRole('link', { name: 'История заказов' })).toHaveCount(0);
  await floristPage.goto(`/order-history/${deliveredId}`);
  await expect(floristPage.getByTestId('order-history')).toHaveCount(0);
  await floristContext.close();

  /*
   * 2. Краткое состояние в результатах обновляется без перезагрузки.
   *
   * Логист правит интервал обычным входом, а открытый список узнаёт об этом
   * сам: событие realtime перечитывает и ленту, и результаты поиска.
   */
  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await page.goto(`/order-history?q=${encodeURIComponent(delivered)}`);
  const row = page.locator(
    `[data-testid="order-history-result"][data-order-number="${delivered}"]`,
  );
  await expect(row).toBeVisible();
  const before = await row.innerText();

  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };
  const card = await request.get(`/api/orders/${deliveredId}`, { headers });
  const version = ((await card.json()) as { order: { version: number } }).order.version;
  /*
   * Новое значение выбирается от текущего.
   *
   * Прогон идёт по общей базе, и заказ мог получить этот интервал в соседнем
   * сценарии. Постоянная пара чисел проверяла бы порядок запуска, а не
   * обновление без F5.
   */
  const alreadyEvening = before.includes('13:00–15:00');
  const expected = alreadyEvening ? '14:00–16:00' : '13:00–15:00';
  const saved = await request.put(`/api/orders/${deliveredId}/interval`, {
    headers,
    data: alreadyEvening
      ? { startMinute: 840, endMinute: 960, version }
      : { startMinute: 780, endMinute: 900, version },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  expect(before).not.toContain(expected);
  await expect(row).toContainText(expected, { timeout: 30_000 });
});

/*
 * Два адресных контракта рядом.
 *
 * Проверяется не «видно ли строку», а то, из-за чего заказ уедет не туда:
 * рабочий адрес заказа версии 2 не содержит квартиры, детали идут отдельной
 * строкой и не склеиваются с адресом, у заказа прежнего контракта их нет
 * вовсе, а заказ без дома виден человеку, а не молча уходит в геокодер.
 *
 * Заказы приходят фикстурой `seed:e2e-structured-address` — настоящим путём
 * импорта, поэтому на экране видно то же, что придёт из МоегоСклада.
 */
const SA_LEGACY = process.env['E2E_SA_LEGACY'] ?? '';
const SA_FULL = process.env['E2E_SA_FULL'] ?? '';
const SA_FULL_DETAILS = process.env['E2E_SA_FULL_DETAILS'] ?? '';
const SA_FULL_ADDRESS = process.env['E2E_SA_FULL_ADDRESS'] ?? '';
const SA_NODETAILS = process.env['E2E_SA_NODETAILS'] ?? '';
const SA_NOHOUSE = process.env['E2E_SA_NOHOUSE'] ?? '';
const SA_MANUAL = process.env['E2E_SA_MANUAL'] ?? '';
const SA_LATE = process.env['E2E_SA_LATE'] ?? '';

/** Карточка «Сделок» по номеру: поиск действует внутри выбранного дня. */
async function dealCard(page: Page, number: string): Promise<Locator> {
  await page.getByLabel('Поиск в этом дне').fill(number);
  await page.getByLabel('Поиск в этом дне').press('Enter');
  const card = page.locator(`[data-testid="deal-card"][data-order-number="${number}"]`);
  await expect(card).toBeVisible();
  return card;
}

test('адрес: детали отдельной строкой, а прежний контракт не изменился', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(SA_FULL === '', 'не переданы фикстуры адресного контракта (E2E_SA_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  await expect(page.getByTestId('deals-workspace')).toBeVisible();

  /*
   * 1. Заказ версии 2: адрес и детали — ДВЕ строки.
   *
   * Строка адреса проверяется на отсутствие квартиры и домофона: именно её
   * копируют в поиск и именно она уходит в геокодер.
   */
  const full = await dealCard(page, SA_FULL);
  const fullDetails = full.getByTestId('deal-address-details');
  await expect(fullDetails).toBeVisible();
  await expect(fullDetails).toContainText('Кв./офис: 55');
  await expect(fullDetails).toContainText('домофон 42');
  if (SA_FULL_ADDRESS !== '') {
    await expect(full.locator('.deals__line')).toHaveText(SA_FULL_ADDRESS);
  }
  await expect(full.locator('.deals__line')).not.toContainText('Кв./офис');
  await expect(full.locator('.deals__line')).not.toContainText('домофон');

  // 2. Заказ прежнего контракта выглядит ровно как прежде: второй строки нет.
  const legacy = await dealCard(page, SA_LEGACY);
  await expect(legacy.getByTestId('deal-address-details')).toHaveCount(0);
  // Операционная строка источника показывается целиком — так было и до перехода.
  await expect(legacy.locator('.deals__line')).toContainText('кв. 12');

  // 3. Версия 2 без деталей: пустой блок не рисуется.
  const noDetails = await dealCard(page, SA_NODETAILS);
  await expect(noDetails.getByTestId('deal-address-details')).toHaveCount(0);

  /*
   * 4. Версия 2 без дома: рабочего адреса нет, и запасного пути тоже.
   *
   * Операционная строка источника у этого заказа заполнена — и всё равно
   * не показывается: ради её замены контракт и вводился.
   */
  const noHouse = await dealCard(page, SA_NOHOUSE);
  await expect(noHouse.locator('.deals__line')).toHaveText('Адрес не указан');
  await expect(noHouse.locator('.deals__line')).not.toContainText('Русаковской');
  await expect(noHouse.getByTestId('deal-address-details')).toContainText('Кв./офис: 7');
  await expect(noHouse.getByTestId('deal-attention')).toContainText(/адрес/i);

  // 5. Ручная правка логиста сильнее источника, а детали при ней остаются.
  const manual = await dealCard(page, SA_MANUAL);
  await expect(manual.locator('.deals__line')).toContainText('Сокольническая площадь');
  await expect(manual.getByTestId('deal-address-details')).toContainText('Кв./офис: 3');

  /*
   * 6. Окно заказа: те же два значения и в том же порядке.
   */
  await dealCard(page, SA_FULL);
  await page
    .locator(`[data-testid="deal-card"][data-order-number="${SA_FULL}"]`)
    .getByTestId('order-number')
    .click();
  const window = page.getByTestId('order-window');
  await expect(window).toBeVisible();
  const windowDetails = window.getByTestId('order-window-address-details');
  await expect(windowDetails).toBeVisible();
  if (SA_FULL_DETAILS !== '') {
    await expect(windowDetails).toHaveText(SA_FULL_DETAILS);
  }

  // Детали стоят НИЖЕ адреса, а не сбоку от него и не выше.
  const addressBox = await window.locator('.order-window__value').first().boundingBox();
  const detailsBox = await windowDetails.boundingBox();
  expect(addressBox).not.toBeNull();
  expect(detailsBox).not.toBeNull();
  expect(detailsBox?.y ?? 0).toBeGreaterThanOrEqual(addressBox?.y ?? 0);

  /*
   * 7. История заказа: рабочий адрес и детали — разные поля шапки.
   */
  await page.getByTestId('order-window-history').click();
  await expect(page.getByTestId('order-history')).toBeVisible();
  const header = page.getByTestId('order-history-header');
  await expect(header).toContainText('Рабочий адрес');
  await expect(header).toContainText('Детали адреса');
  if (SA_FULL_ADDRESS !== '') {
    await expect(header).toContainText(SA_FULL_ADDRESS);
  }
});

test('адрес: обновление источника без F5, точка и отдельные строки истории', async ({
  page,
  request,
}: {
  page: Page;
  request: APIRequestContext;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(SA_LATE === '', 'не переданы фикстуры адресного контракта (E2E_SA_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);

  /*
   * Сигнал источника подаётся отдельным запросом с собственным входом.
   *
   * Токен берётся своим входом, а не из браузера: страница остаётся открытой
   * и обязана обновиться сама — этим и проверяется отсутствие F5.
   */
  const auth = await request.post('/api/auth/login', {
    data: { phone: ADMIN_PHONE, pin: ADMIN_PIN },
  });
  const token = ((await auth.json()) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${token}` };

  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();
  const card = await dealCard(page, SA_LATE);
  await expect(card.getByTestId('deal-address-details')).toContainText('Кв./офис: 19');

  /*
   * 1. Источник поправил ТОЛЬКО квартиру.
   *
   * Экран обязан показать новое значение без перезагрузки, а координатное
   * состояние — остаться прежним: дом не менялся, и повторно искать его
   * незачем.
   */
  const geoBefore = await card.getAttribute('data-selectable');
  const detailsChange = await request.post('/api/testing/source-address', {
    headers,
    data: {
      orderNumber: SA_LATE,
      city: 'г. Москва',
      street: 'Стромынка',
      house: '21',
      apartment: '19А',
      addInfo: 'код у двери 1917',
    },
  });
  expect(detailsChange.ok(), await detailsChange.text()).toBeTruthy();

  await expect(card.getByTestId('deal-address-details')).toContainText('Кв./офис: 19А');
  await expect(card.getByTestId('deal-address-details')).toContainText('код у двери 1917');
  // Адрес не дрогнул, и заказ по-прежнему пригоден к маршруту.
  await expect(card.locator('.deals__line')).toContainText('Стромынка, 21');
  expect(await card.getAttribute('data-selectable')).toBe(geoBefore);

  /*
   * 2. Источник сменил ДОМ.
   *
   * Прежняя точка к новому дому не относится: она снимается, и заказ уходит
   * на повторное определение. Оставить её пригодной опаснее, чем потерять.
   */
  const houseChange = await request.post('/api/testing/source-address', {
    headers,
    data: {
      orderNumber: SA_LATE,
      city: 'г. Москва',
      street: 'Стромынка',
      house: '23',
      apartment: '19А',
      addInfo: 'код у двери 1917',
    },
  });
  expect(houseChange.ok(), await houseChange.text()).toBeTruthy();

  await expect(card.locator('.deals__line')).toContainText('Стромынка, 23');
  await expect(card).toHaveAttribute('data-selectable', 'no');

  /*
   * 3. История различает два события.
   *
   * Изменение адреса и изменение деталей — разные строки: слитое «адрес
   * изменился» заставляло бы каждый раз выяснять, надо ли перепроверять
   * маршрут.
   */
  await page
    .locator(`[data-testid="deal-card"][data-order-number="${SA_LATE}"]`)
    .getByTestId('order-number')
    .click();
  await expect(page.getByTestId('order-window')).toBeVisible();
  await page.getByTestId('order-window-history').click();
  await expect(page.getByTestId('order-history')).toBeVisible();

  // Строки ждутся локаторами, а не читаются массивом: массив вернул бы
  // пустоту раньше, чем лента успела отрисоваться, и проверка доказывала бы
  // скорость браузера вместо содержимого истории.
  const detailsRow = page
    .locator('[data-testid="order-history-event"][data-kind="STRUCTURED_ADDRESS_DETAILS"]')
    .first();
  await expect(detailsRow).toBeVisible();
  await expect(detailsRow).toContainText('детали адреса');

  const addressRow = page
    .locator('[data-testid="order-history-event"][data-kind="STRUCTURED_ADDRESS_ADDRESS"]')
    .first();
  await expect(addressRow).toBeVisible();
  await expect(addressRow).toContainText('адрес доставки');

  // Событий ровно два вида, и они не слиты в одно: по адресу перепроверяют
  // маршрут, по деталям — нет.
  const kinds = await historyKinds(page);
  expect(kinds.filter((kind) => kind === 'STRUCTURED_ADDRESS_DETAILS').length).toBeGreaterThan(0);
  expect(kinds.filter((kind) => kind === 'STRUCTURED_ADDRESS_ADDRESS').length).toBeGreaterThan(0);
});

test('адрес: маршрутный лист и печатная форма показывают оба значения', async ({
  page,
}: {
  page: Page;
}) => {
  test.skip(ADMIN_CODE === '', 'не передан одноразовый код администратора (E2E_ADMIN_CODE)');
  test.skip(SA_FULL === '', 'не переданы фикстуры адресного контракта (E2E_SA_*)');

  await login(page, ADMIN_PHONE, ADMIN_PIN);
  await openSection(page, 'Логистика');
  await page.getByRole('link', { name: 'Сделки' }).first().click();

  // Черновик из одного заказа версии 2: маршрут строится по рабочему адресу.
  const card = await dealCard(page, SA_FULL);
  await expect(card).toHaveAttribute('data-selectable', 'yes');
  await card.getByTestId('deal-pick').click();
  await page.getByTestId('deals-manual-draft').click();
  await expect(page.getByTestId('create-route-dialog')).toBeVisible();
  await page.getByTestId('create-route-draft').click();
  // Черновик открывается в «Маршрутизации» выбранным днём: порядок параметров
  // адреса к делу не относится, важен сам переход к созданному маршруту.
  await expect(page).toHaveURL(/\/logistics\/routing\?.*route=/);

  /*
   * Карточка маршрута показывает адрес и детали разными строками.
   *
   * По первому считается порядок объезда, второе курьер читает у двери.
   */
  const ownStop = page.locator('[data-testid="route-stop"]', { hasText: SA_FULL });
  const stopDetails = ownStop.getByTestId('route-stop-address-details');
  await expect(stopDetails).toBeVisible();
  await expect(stopDetails).toContainText('Кв./офис: 55');
  const stopAddress = ownStop.locator('.routes__stop-address').first();
  await expect(stopAddress).toContainText('Маленковская');
  await expect(stopAddress).not.toContainText('Кв./офис');

  /*
   * Печатная форма листа: лист берут с собой, и спросить недостающее
   * в пути будет не у кого — поэтому там оба значения.
   */
  /*
   * Черновик подтверждается в маршрутный лист.
   *
   * Курьер для этого не нужен: лист живёт и без него, а проверяется здесь
   * состав, а не отгрузка.
   */
  // Черновик ищется по СВОЕМУ заказу: соседние сценарии оставляют свои,
  // и «первый в списке» доказывал бы порядок запуска, а не поведение.
  const draft = page.locator('.routes__draft', { hasText: SA_FULL });
  await draft.getByRole('button', { name: 'Создать МЛ' }).click();
  await page.getByTestId('route-confirm-submit').click();

  await page.getByRole('link', { name: 'Маршрутные листы' }).first().click();
  await expect(page.getByTestId('sheets-search')).toBeVisible();
  await page.getByTestId('sheets-search').fill(SA_FULL);

  const sheet = page.locator('[data-testid="sheet-row"]').first();
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('sheet-expand').click();
  const sheetOrder = sheet.locator(`[data-order-number="${SA_FULL}"] .sheets__order-address`);
  await expect(sheetOrder).toBeVisible();
  await expect(sheetOrder).toContainText('Маленковская');
  await expect(sheetOrder).toContainText('Кв./офис: 55');

  /*
   * Печатная форма: оба значения и разными строками.
   *
   * Лист берут с собой, и спросить недостающее в пути будет не у кого —
   * поэтому квартира обязана быть на бумаге рядом с домом.
   */
  await sheet.getByTestId('sheet-open').click();
  const printable = page.locator('.sheet');
  await expect(printable).toBeVisible();
  const stop = printable.locator('.sheet__stop').first();
  await expect(stop).toContainText('Маленковская');
  await expect(stop).toContainText('Кв./офис: 55');
  await expect(stop).toContainText('домофон 42');
});
