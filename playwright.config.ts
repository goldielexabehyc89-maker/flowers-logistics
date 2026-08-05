/**
 * Конфигурация браузерной проверки.
 *
 * Тест запускается ТОЛЬКО внутри зафиксированного образа
 * mcr.microsoft.com/playwright:v1.62.1-noble — версия пакета и версия образа
 * обязаны совпадать. Хостовым Node браузерные проверки не выполняются.
 *
 * Сценарий один и последовательный: он проверяет сквозной путь, а не верстку.
 * Скриншоты и видео выключены: в кадр попали бы одноразовые коды и PIN.
 */

import { defineConfig } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  // Один рабочий процесс: сценарий последовательный и опирается на общее состояние.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    // Ни скриншотов, ни видео, ни trace: они сохранили бы коды активации и PIN.
    screenshot: 'off',
    video: 'off',
    trace: 'off',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
