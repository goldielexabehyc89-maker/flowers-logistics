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

import { expect, test, type Browser, type Page } from '@playwright/test';

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
