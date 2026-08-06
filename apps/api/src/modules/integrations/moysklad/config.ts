/**
 * Конфигурация интеграции с МоимСкладом.
 *
 * Токен — только секрет окружения. В `SystemSetting` он не попадает никогда:
 * та таблица предназначена для несекретных настроек и читается administrator-API.
 *
 * Подтверждённые исследованием UUID (docs/MOYSKLAD_MAPPING.md) — несекретная
 * конфигурация. Маппинг выполняется по ним, а не по названиям: названия
 * в рабочем аккаунте переименовываются, UUID стабилен.
 *
 * Отсутствие токена не ломает запуск приложения: интеграция остаётся
 * NOT_CONFIGURED, а фоновый обработчик в ветке 3.2 просто не стартует.
 */

/** Базовый адрес фиксирован и пользователем не задаётся. */
export const MOYSKLAD_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

/** Подтверждённые UUID метаданных аккаунта. */
export const MOYSKLAD_IDS = {
  /** Склад «Москва 01 - Маленковская 14, к1 (Ласфлор)». */
  store: '3d520ee3-76c1-11f0-0a80-142900354c8e',
  /** Атрибут «Способ доставки». */
  deliveryMethodAttribute: 'ca290db8-d33e-11ef-0a80-16bc000f09e7',
  /** Справочник, на который ссылается атрибут «Способ доставки». */
  deliveryMethodDictionary: '5e4775b4-d33e-11ef-0a80-0614000ebd8f',
  /** Значение справочника «Доставка» — единственное, относящееся к нашей области. */
  deliveryMethodDelivery: 'd2b6ee53-e91a-11ef-0a80-0f4900447d25',
  /** Атрибут «Время доставки». */
  intervalAttribute: 'a9121214-23ce-11ee-0a80-08cc002243ce',
  /** Атрибут «Получатель». */
  recipientAttribute: '142848c6-23d1-11ee-0a80-13e90022d4cb',
  /** Атрибут «Комментарий по доставке». */
  commentAttribute: '40e77db5-82bd-11f0-0a80-04bd001712b4',
  /** Атрибут «Тип Оплаты». */
  paymentTypeAttribute: '8b89a9c4-bad2-11ed-0a80-06e0002109c7',
  /** Значение «Наличные/карта на ТТ» — единственный случай наличных у курьера. */
  paymentTypeCash: '677a1868-bad2-11ed-0a80-10d0001f8f40',
} as const;

export interface MoyskladConfig {
  baseUrl: string;
  /** `null`, если токен не задан: интеграция остаётся не настроенной. */
  token: string | null;
  ids: typeof MOYSKLAD_IDS;
}

/**
 * Собирает конфигурацию интеграции.
 *
 * Токен читается только отсюда и дальше передаётся клиенту как значение,
 * а не как глобальная переменная окружения.
 */
export function loadMoyskladConfig(env: NodeJS.ProcessEnv = process.env): MoyskladConfig {
  const raw = env['MOYSKLAD_TOKEN'];
  const token = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

  return { baseUrl: MOYSKLAD_BASE_URL, token, ids: MOYSKLAD_IDS };
}

/** Интеграция считается настроенной только при наличии токена. */
export function isMoyskladConfigured(config: MoyskladConfig): boolean {
  return config.token !== null;
}
