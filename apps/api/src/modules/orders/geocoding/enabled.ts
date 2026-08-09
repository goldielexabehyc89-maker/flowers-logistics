/**
 * Условия автоматического геокодирования.
 *
 * Вынесено отдельной функцией, чтобы правило можно было проверить тестом
 * напрямую, не поднимая приложение: «не обращаемся к платному сервису вне
 * production» — это не деталь запуска, а обещание, которое нужно доказывать.
 *
 * Условий четыре и они обязаны выполниться одновременно. Каждое закрывает свою
 * ошибку развёртывания: маркер и APP_ENV вместе не дают перепутать окружение,
 * флаг требует осознанного включения, а ключи — их фактического наличия.
 */

import type { AppConfig } from '../../../platform/config.js';

export function shouldGeocodeAutomatically(config: AppConfig): boolean {
  return (
    config.APP_ENV === 'production' &&
    config.APP_ENVIRONMENT_MARKER === 'production' &&
    config.DADATA_GEOCODING_ENABLED &&
    config.DADATA_API_KEY !== undefined &&
    config.DADATA_SECRET_KEY !== undefined
  );
}
