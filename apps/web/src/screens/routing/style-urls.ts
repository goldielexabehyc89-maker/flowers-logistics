/**
 * Разрешение адресов внутри стиля карты.
 *
 * В стиле источник объявлен относительным адресом:
 *
 *     "url": "pmtiles://./tiles-20260806.pmtiles"
 *
 * MapLibre не разрешает такой адрес относительно стиля: строка с собственным
 * протоколом уходит в обработчик как есть, а библиотека PMTiles разрешает её
 * относительно адреса СТРАНИЦЫ. На экране `/routing` это давало запрос
 * `/tiles-20260806.pmtiles` вместо `/maps/tiles-20260806.pmtiles`, в ответ
 * приходила оболочка приложения, и карта не открывалась вовсе.
 *
 * Официальный пример PMTiles использует полный адрес
 * (`pmtiles://https://example.com/file.pmtiles`), поэтому относительный путь
 * разрешается здесь — относительно фактического адреса файла стиля — и дальше
 * протокол получает уже полный адрес.
 *
 * Спрайты и глифы разрешаются здесь же. MapLibre 6 требует у спрайта
 * АБСОЛЮТНЫЙ адрес и отвергает относительный до всякой сети:
 * «Invalid sprite URL "./sprite/sprite", must be absolute». Стиль при этом
 * не применяется вовсе, поэтому оставить спрайт как есть нельзя.
 *
 * Адрес глифов содержит подстановки `{fontstack}` и `{range}`; разбирать его
 * через `new URL` нельзя — фигурные скобки закодировались бы, и подстановка
 * перестала бы работать. Такие адреса склеиваются с каталогом стиля строкой.
 */

/** Префикс собственного протокола. Совпадает с тем, что регистрирует карта. */
export const PMTILES_PREFIX = 'pmtiles://';

export type PmtilesResolution =
  | { ok: true; url: string }
  | { ok: false; reason: 'NOT_PMTILES' | 'INVALID_URL' | 'FOREIGN_ORIGIN' };

/**
 * Приводит адрес источника к полному, оставаясь на нашем origin.
 *
 * Fail closed: адрес, ведущий на чужой хост, отклоняется. Подложка живёт
 * на нашем origin по построению, и архив тайлов с постороннего сервера означал
 * бы либо подмену конфигурации, либо утечку — куда именно мы возим, видно
 * по запрошенным тайлам. Публичного запасного источника нет и быть не может.
 *
 * @param raw       значение `url` источника из стиля;
 * @param styleUrl  фактический адрес файла стиля — база для относительного пути;
 * @param appOrigin origin приложения; домены окружений нигде не зашиты.
 */
export function resolvePmtilesUrl(
  raw: string,
  styleUrl: string,
  appOrigin: string,
): PmtilesResolution {
  if (!raw.startsWith(PMTILES_PREFIX)) {
    return { ok: false, reason: 'NOT_PMTILES' };
  }

  const inner = raw.slice(PMTILES_PREFIX.length);
  if (inner === '') {
    return { ok: false, reason: 'INVALID_URL' };
  }

  let resolved: URL;
  try {
    // Относительный путь разрешается относительно стиля; уже полный адрес
    // остаётся собой — второй аргумент в этом случае не влияет ни на что.
    resolved = new URL(inner, styleUrl);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  let expected: string;
  try {
    expected = new URL(appOrigin).origin;
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  if (resolved.origin !== expected) {
    return { ok: false, reason: 'FOREIGN_ORIGIN' };
  }

  return { ok: true, url: `${PMTILES_PREFIX}${resolved.href}` };
}

/** Понятное объяснение отказа. Адрес наружу не выводится. */
export function describePmtilesProblem(
  reason: Exclude<PmtilesResolution, { ok: true }>['reason'],
): string {
  switch (reason) {
    case 'NOT_PMTILES':
      return 'адрес архива тайлов задан не протоколом pmtiles';
    case 'INVALID_URL':
      return 'адрес архива тайлов не разобран';
    case 'FOREIGN_ORIGIN':
      return 'архив тайлов ведёт на посторонний сервер';
  }
}

/**
 * Приводит адрес ресурса стиля к полному, сохраняя подстановки.
 *
 * `{fontstack}` и `{range}` обязаны дожить до запроса: их подставляет MapLibre.
 * Поэтому относительный путь склеивается с каталогом стиля, а не разбирается
 * как URL.
 */
export function resolveStyleAsset(
  raw: string,
  styleUrl: string,
  appOrigin: string,
): PmtilesResolution {
  if (raw === '') {
    return { ok: false, reason: 'INVALID_URL' };
  }

  let expected: string;
  let directory: string;
  try {
    expected = new URL(appOrigin).origin;
    directory = new URL('.', new URL(styleUrl, appOrigin)).href;
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  let full: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    full = raw;
  } else if (raw.startsWith('//')) {
    full = `${new URL(expected).protocol}${raw}`;
  } else if (raw.startsWith('/')) {
    full = `${expected}${raw}`;
  } else {
    full = `${directory}${raw.replace(/^\.\//, '')}`;
  }

  // Origin проверяется по адресу без подстановок: скобки на принадлежность
  // серверу не влияют, а `new URL` на них спотыкается.
  let origin: string;
  try {
    origin = new URL(full.replace(/\{[^}]*\}/g, 'x')).origin;
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  if (origin !== expected) {
    return { ok: false, reason: 'FOREIGN_ORIGIN' };
  }

  return { ok: true, url: full };
}

/** Стиль MapLibre в объёме, который нас интересует. */
export interface StyleDocument {
  sources?: Record<string, { url?: string } & Record<string, unknown>>;
  sprite?: string;
  glyphs?: string;
  [key: string]: unknown;
}

/**
 * Приводит адреса стиля к полным, оставаясь на нашем origin.
 *
 * Fail closed: неразрешимый или посторонний адрес — исключение. Молча оставить
 * относительный путь значит получить либо оболочку приложения вместо архива,
 * либо отказ MapLibre при разборе стиля.
 */
export function resolveStyleUrls(
  style: StyleDocument,
  styleUrl: string,
  appOrigin: string,
): StyleDocument {
  const fail = (
    what: string,
    reason: Exclude<PmtilesResolution, { ok: true }>['reason'],
  ): never => {
    throw new Error(`Подложка не настроена: ${what} — ${describePmtilesProblem(reason)}`);
  };

  const resolved: StyleDocument = { ...style };

  if (typeof style.sprite === 'string') {
    const sprite = resolveStyleAsset(style.sprite, styleUrl, appOrigin);
    if (sprite.ok) {
      resolved.sprite = sprite.url;
    } else {
      fail('спрайты', sprite.reason);
    }
  }

  if (typeof style.glyphs === 'string') {
    const glyphs = resolveStyleAsset(style.glyphs, styleUrl, appOrigin);
    if (glyphs.ok) {
      resolved.glyphs = glyphs.url;
    } else {
      fail('глифы', glyphs.reason);
    }
  }

  if (style.sources !== undefined) {
    const sources: Record<string, { url?: string } & Record<string, unknown>> = {};
    for (const [name, source] of Object.entries(style.sources)) {
      if (typeof source.url === 'string' && source.url.startsWith(PMTILES_PREFIX)) {
        const archive = resolvePmtilesUrl(source.url, styleUrl, appOrigin);
        if (archive.ok) {
          sources[name] = { ...source, url: archive.url };
          continue;
        }
        fail('архив тайлов', archive.reason);
      }
      sources[name] = source;
    }
    resolved.sources = sources;
  }

  return resolved;
}
