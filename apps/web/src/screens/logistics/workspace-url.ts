/**
 * Состояние рабочего дня логистики, живущее в адресе страницы.
 *
 * До этого «Сделки» и «Маршрутизация» держали каждая свою дату в `useState`.
 * Два независимых значения на одном рабочем месте расходились молча: логист
 * переключал день слева, а работал с черновиками другого дня.
 *
 * Здесь только разбор и сборка адреса — чистые функции, проверяемые без
 * браузера. Сам React-хук лежит рядом и ничего не решает сам.
 *
 * В адрес попадают только маленькие значения: день и активный черновик.
 * Выбранные заказы и прочие массивы в адресе не хранятся — ссылка перестала бы
 * быть ссылкой, а длина адреса стала бы ограничением рабочего процесса.
 */

/** Ключ дня. Общий для «Сделок» и «Маршрутизации» намеренно. */
export const DAY_PARAM = 'date';

/**
 * Ключ активного черновика.
 *
 * Имя `route` сохранено, а не заведено новое: «Сделки» уже уводят на
 * `/logistics/routing?route=<id>`, и прежние ссылки обязаны продолжать
 * работать. Раньше этот параметр никто не читал.
 */
export const DRAFT_PARAM = 'route';

/** Календарная дата `ГГГГ-ММ-ДД`. Проверяется существование, а не только форма. */
export function isDayValue(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  // `2026-02-30` прошла бы регулярное выражение и молча превратилась бы
  // в первое марта, показав логисту заказы другого дня.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * День из адреса.
 *
 * Мусор в параметре не показывается как пустой экран и не роняет страницу:
 * он молча заменяется днём по умолчанию, потому что адрес может прийти
 * откуда угодно.
 */
export function readDay(params: URLSearchParams, fallback: string): string {
  const value = params.get(DAY_PARAM);
  return value !== null && isDayValue(value) ? value : fallback;
}

/** Активный черновик из адреса. Не-UUID трактуется как «не выбран». */
export function readDraft(params: URLSearchParams): string | null {
  const value = params.get(DRAFT_PARAM);
  return value !== null && UUID.test(value) ? value : null;
}

/**
 * Ключ открытого расчёта.
 *
 * Превью — видимая стадия работы: логист смотрит предложенные маршруты
 * и решает, применять их или отклонить. Обновление страницы и прямая ссылка
 * обязаны вернуть тот же расчёт, а не общий список.
 */
export const RUN_PARAM = 'run';

/** Открытый расчёт из адреса. Не-UUID трактуется как «не выбран». */
export function readRun(params: URLSearchParams): string | null {
  const value = params.get(RUN_PARAM);
  return value !== null && UUID.test(value) ? value : null;
}

/** Адрес «Маршрутизации» с открытым расчётом того же дня. */
export function previewHref(path: string, next: { day: string; runId: string }): string {
  const params = new URLSearchParams();
  params.set(DAY_PARAM, next.day);
  params.set(RUN_PARAM, next.runId);
  return `${path}?${params.toString()}`;
}

export interface WorkspaceUrl {
  day: string;
  draftId: string | null;
}

/**
 * Собирает следующий адрес.
 *
 * Прочие параметры сохраняются: у экрана могут быть свои, и рабочее место
 * не вправе их терять при смене дня.
 */
export function writeWorkspace(current: URLSearchParams, next: WorkspaceUrl): URLSearchParams {
  const params = new URLSearchParams(current);
  params.set(DAY_PARAM, next.day);
  // Раскрытие черновика закрывает превью: это две разные работы, и показывать
  // их одновременно значило бы предлагать править то, чего ещё нет.
  if (next.draftId !== null) {
    params.delete(RUN_PARAM);
  }
  if (next.draftId === null) {
    params.delete(DRAFT_PARAM);
  } else {
    params.set(DRAFT_PARAM, next.draftId);
  }
  return params;
}

/**
 * Адрес соседней вкладки того же рабочего дня.
 *
 * Переход между «Сделками» и «Маршрутизацией» обязан сохранять день: иначе
 * общая дата снова распалась бы на две.
 */
export function workspaceHref(path: string, next: WorkspaceUrl): string {
  const params = writeWorkspace(new URLSearchParams(), next);
  return `${path}?${params.toString()}`;
}
