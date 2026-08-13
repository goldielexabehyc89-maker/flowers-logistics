/**
 * Серверные подсказки адреса DaData.
 *
 * Отдельный минимальный адаптер, а не расширение клиента стандартизации:
 * у подсказок другой адрес, другой формат ответа и другой режим работы —
 * человек печатает, и запросы идут пачками по мере ввода.
 *
 * Три границы держатся здесь и нигде больше:
 *
 * 1. **Ключи не покидают сервер.** Браузер не получает ни ключа, ни адреса
 *    DaData: он обращается только к нашему API. Иначе ключ утёк бы в первую же
 *    вкладку с открытой консолью.
 * 2. **Наружу отдаётся только нужное.** Сырой ответ провайдера не пересылается:
 *    он содержит десятки полей, включая те, которых мы не обещали хранить,
 *    и его форма может измениться без предупреждения.
 * 3. **Расход ограничен.** Длина запроса, число подсказок и размер ответа
 *    ограничены до сети: подсказки тратят платную квоту на каждый символ.
 */

import { z } from 'zod';
import { DadataError, type DadataCredentials } from './client.js';
import { parseQcGeo, QC_GEO_EXACT } from './dto.js';

export const DADATA_SUGGEST_ADDRESS_URL =
  'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';

/** Короче трёх символов подсказка бессмысленна, длиннее — это уже не ввод. */
export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 200;
/** Больше десяти вариантов человек всё равно не читает, а квота расходуется. */
export const MAX_SUGGESTIONS = 10;
/** Ответ подсказок укладывается в десятки килобайт; больше — повод прекратить чтение. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

/** Ровно то, что уходит клиенту. Сырого ответа здесь нет ни в каком виде. */
export interface AddressSuggestion {
  /** Стандартизованный адрес одной строкой: его и сохраняет логист. */
  value: string;
  /** Координаты, если DaData их привязала. */
  latMicro: number | null;
  lonMicro: number | null;
  /** Точна ли привязка. Только точная попадает в маршрут без проверки человеком. */
  exact: boolean;
}

const suggestionSchema = z.object({
  value: z.string().min(1),
  data: z
    .object({
      geo_lat: z.union([z.string(), z.number()]).nullable().optional(),
      geo_lon: z.union([z.string(), z.number()]).nullable().optional(),
      qc_geo: z.union([z.string(), z.number()]).nullable().optional(),
    })
    .optional(),
});

const responseSchema = z.object({ suggestions: z.array(suggestionSchema) });

const MICRO = 1_000_000;

/** Координата в целых микроградусах или `null`, если её нет либо она непригодна. */
function toMicro(value: string | number | null | undefined, limit: number): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const micro = Math.round(parsed * MICRO);
  return Math.abs(micro) > limit ? null : micro;
}

export interface SuggestDeps {
  credentials: DadataCredentials;
  /** Инъецируется в тестах: настоящих сетевых обращений там нет. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  url?: string;
}

/**
 * Подсказки адреса.
 *
 * Пустой список — нормальный ответ: ни одна ошибка провайдера не должна
 * превращаться в отказ экрана. Список продолжает работать по данным базы,
 * а логист просто не увидит подсказок (`docs/OWNER_DECISIONS.md`, `GEO-004`).
 */
export async function suggestAddresses(
  deps: SuggestDeps,
  query: string,
): Promise<AddressSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return [];
  }
  if (deps.credentials.apiKey === null || deps.credentials.secretKey === null) {
    // Незаданные ключи — это «не настраивали», а не ошибка запроса.
    return [];
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(deps.url ?? DADATA_SUGGEST_ADDRESS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Token ${deps.credentials.apiKey}`,
      },
      body: JSON.stringify({
        query: trimmed.slice(0, MAX_QUERY_LENGTH),
        count: MAX_SUGGESTIONS,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Текст ответа наружу не идёт: он может содержать сам запрос, то есть адрес.
      throw new DadataError('SERVER_ERROR', response.status);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new DadataError('BAD_RESPONSE');
    }

    const parsed = responseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new DadataError('BAD_RESPONSE');
    }

    return parsed.data.suggestions.slice(0, MAX_SUGGESTIONS).map((item) => {
      const qc = parseQcGeo(item.data?.qc_geo);
      const latMicro = toMicro(item.data?.geo_lat, 90 * MICRO);
      const lonMicro = toMicro(item.data?.geo_lon, 180 * MICRO);
      const exact = qc === QC_GEO_EXACT && latMicro !== null && lonMicro !== null;
      return { value: item.value, latMicro, lonMicro, exact };
    });
  } finally {
    clearTimeout(timer);
  }
}
