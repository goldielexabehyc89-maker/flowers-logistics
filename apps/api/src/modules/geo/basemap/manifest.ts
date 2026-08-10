/**
 * Манифест картографических артефактов.
 *
 * Подложка живёт вне Git и вне образа приложения: PMTiles на регион — это
 * сотни мегабайт, которые навсегда остались бы в истории репозитория и в каждом
 * слое образа. Артефакты кладутся на сервер отдельной операцией и монтируются
 * приложению только на чтение.
 *
 * Раз файлы приходят снаружи, приложение обязано убедиться, что это именно те
 * файлы. Манифест перечисляет каждый артефакт с его размером и SHA-256; при
 * старте всё пересчитывается заново. Несовпадение — не повод «попробовать»:
 * подложка объявляется ненастроенной, интерфейс честно об этом говорит,
 * а к публичным серверам приложение не идёт ни при каких условиях.
 *
 * Имена файлов содержат ревизию, поэтому артефакт никогда не перезаписывается
 * на месте: новая сборка — новые имена, а старый файл остаётся, пока его
 * не уберут отдельно. Это позволяет отдавать их с бессрочным кэшированием.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/** Версия формата манифеста: чужой или устаревший формат не принимается. */
export const BASEMAP_MANIFEST_FORMAT = 'flowers-logistics/basemap-manifest@1';

export const MANIFEST_FILE_NAME = 'manifest.json';

/** Предел длины пути артефакта. Тот же, что в `deploy/scripts/verify-geo.mjs`. */
const MAX_ARTIFACT_PATH = 200;

/**
 * Допустим ли путь артефакта. Возвращает причину отказа или `null`.
 *
 * Манифест приходит вместе с файлами, и его запись превращается в чтение
 * с диска и в адрес HTTP. Проверка здесь — самое дешёвое место, где это можно
 * остановить.
 *
 * Внутренние пробелы РАЗРЕШЕНЫ: настоящее имя семейства шрифтов —
 * «Noto Sans Regular», и 256 файлов глифов законно лежат в каталоге с пробелами.
 * Прежнее выражение `^[A-Za-z0-9._-]+…$` их отвергало, и подложка объявлялась
 * ненастроенной при совершенно исправном наборе.
 *
 * Разрешение пробела ничего не ослабляет. Опасны не пробелы, а выход за корень,
 * и он запрещён отдельно: одного регулярного выражения мало, потому что
 * `^[^/]+(/[^/]+)*$` пропускает сегменты «.» и «..», из которых обход
 * каталога и собирается. Поэтому путь разбирается посегментно, а фактическое
 * расположение файла дополнительно сверяется с realpath корня.
 *
 * ЭТИ ПРАВИЛА ОБЯЗАНЫ СОВПАДАТЬ с `artifactPathProblem` в
 * `deploy/scripts/verify-geo.mjs`. Совпадение закреплено общим корпусом
 * проверок `deploy/manifest-path-contract.critical.test.ts`: расхождение
 * означало бы, что выкатка одобряет набор, который приложение не примет, —
 * ровно это и случилось на staging.
 */
export function artifactPathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') {
    return 'пустой путь';
  }
  if (value.length > MAX_ARTIFACT_PATH) {
    return 'слишком длинный путь';
  }
  if (value.startsWith('/')) {
    return 'абсолютный путь';
  }
  if (value.includes('\\')) {
    return 'обратный слэш';
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return 'управляющий символ';
    }
  }
  // Percent-encoding в ИМЕНИ файла: путь уже разобран, и «%2e%2e» здесь —
  // попытка провести обход мимо посегментной проверки.
  if (value.includes('%')) {
    return 'percent-encoding в имени';
  }

  for (const segment of value.split('/')) {
    if (segment === '') {
      return 'пустой сегмент';
    }
    if (segment === '.' || segment === '..') {
      return `сегмент «${segment}»`;
    }
    if (segment !== segment.trim()) {
      return 'пробел в начале или конце сегмента';
    }
  }

  return null;
}

const relativePath = z
  .string()
  .min(1)
  .max(MAX_ARTIFACT_PATH)
  .refine((value) => artifactPathProblem(value) === null, {
    message: 'Недопустимый путь артефакта',
  });

const artifactSchema = z.object({
  path: relativePath,
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** MIME-тип для отдачи. Из фиксированного списка: чужой тип не подставляется. */
  contentType: z.enum([
    'application/json',
    'application/octet-stream',
    'application/x-protobuf',
    'image/png',
    // Лицензии шрифтов и спрайтов отдаются наружу вместе с набором: обе
    // требуют, чтобы текст сопровождал распространяемые файлы.
    'text/plain',
  ]),
});

export const basemapManifestSchema = z.object({
  format: z.literal(BASEMAP_MANIFEST_FORMAT),
  /** Ревизия набора: входит в имена файлов и в адрес стиля. */
  revision: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  region: z.string().min(1).max(120),
  /** Границы региона: [запад, юг, восток, север] в градусах. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Дата выгрузки OSM, от которой собрана подложка. */
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** SHA-256 исходного .osm.pbf: по нему сборку можно повторить и сверить. */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Версии инструментов сборки. Пустых значений быть не может. */
  tools: z.record(z.string().min(1), z.string().min(1)),
  /**
   * Контрольные суммы вспомогательных входных наборов.
   *
   * Береговые линии, водные полигоны и Natural Earth влияют на результат так же,
   * как исходный `.osm.pbf`: другая их версия — другие тайлы. Поле необязательно,
   * чтобы наборы, собранные до его появления, оставались пригодными.
   */
  inputs: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  /**
   * Происхождение спрайтов и шрифтов: репозиторий и коммит.
   *
   * Без него нельзя ответить на вопрос «откуда эти иконки и глифы» — а ответ
   * нужен и для лицензий, и для повторяемости сборки. Поле необязательно,
   * чтобы наборы, собранные до его появления, оставались пригодными.
   */
  assetsRevision: z.string().min(1).max(200).optional(),
  attribution: z.string().min(1).max(200),
  /** Файл стиля MapLibre внутри каталога. */
  style: relativePath,
  artifacts: z.array(artifactSchema).min(1),
});

export type BasemapManifest = z.infer<typeof basemapManifestSchema>;
export type BasemapArtifact = z.infer<typeof artifactSchema>;

export type BasemapProblem =
  | 'NOT_CONFIGURED'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_INVALID'
  | 'ARTIFACT_MISSING'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'STYLE_NOT_LISTED'
  /** Файл нашёлся, но лежит вне каталога набора: символическая ссылка наружу. */
  | 'ARTIFACT_OUTSIDE_ROOT';

export interface BasemapReady {
  ok: true;
  root: string;
  manifest: BasemapManifest;
  /** Артефакты по относительному пути: раздаётся только то, что здесь есть. */
  artifacts: Map<string, BasemapArtifact>;
}

export interface BasemapBroken {
  ok: false;
  problem: BasemapProblem;
  /** Какой артефакт не сошёлся. Только путь внутри каталога, без содержимого. */
  artifact?: string;
}

export type BasemapState = BasemapReady | BasemapBroken;

/** SHA-256 файла потоком: артефакт может быть в сотни мегабайт. */
export async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export interface LoadOptions {
  /**
   * Пересчитывать ли контрольные суммы.
   *
   * По умолчанию — да. Отключается только там, где артефакты уже проверены
   * этим же процессом: полный пересчёт гигабайтного архива не должен
   * выполняться на каждый запрос.
   */
  verifyChecksums?: boolean;
}

/**
 * Читает и проверяет набор артефактов.
 *
 * Fail closed на каждом шаге: нет каталога, нет манифеста, манифест не того
 * формата, файл отсутствует, размер или контрольная сумма не совпали — всё это
 * означает «карта не настроена». Подмена одного тайлового архива другим
 * не должна выглядеть как обычная работа.
 */
export async function loadBasemap(
  root: string | undefined,
  options: LoadOptions = {},
): Promise<BasemapState> {
  if (root === undefined || root.trim() === '') {
    return { ok: false, problem: 'NOT_CONFIGURED' };
  }

  const manifestPath = path.join(root, MANIFEST_FILE_NAME);

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return { ok: false, problem: 'MANIFEST_MISSING' };
  }

  let parsed: BasemapManifest;
  try {
    parsed = basemapManifestSchema.parse(JSON.parse(raw));
  } catch {
    // Текст ошибки схемы содержит фактические значения полей и наружу не идёт.
    return { ok: false, problem: 'MANIFEST_INVALID' };
  }

  const artifacts = new Map<string, BasemapArtifact>();
  for (const artifact of parsed.artifacts) {
    artifacts.set(artifact.path, artifact);
  }

  // Стиль обязан быть перечислен наравне с остальными файлами: иначе его
  // подмену никто бы не заметил, а именно он определяет, куда пойдёт браузер.
  if (!artifacts.has(parsed.style)) {
    return { ok: false, problem: 'STYLE_NOT_LISTED' };
  }

  // Корень разрешается один раз: сравнивать нужно то, что система действительно
  // откроет, а не то, что написано в манифесте.
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, problem: 'NOT_CONFIGURED' };
  }

  for (const artifact of parsed.artifacts) {
    const filePath = path.join(rootReal, artifact.path);

    let size: number;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { ok: false, problem: 'ARTIFACT_MISSING', artifact: artifact.path };
      }
      size = info.size;
    } catch {
      return { ok: false, problem: 'ARTIFACT_MISSING', artifact: artifact.path };
    }

    // Посегментной проверки мало: символическая ссылка проходит её целиком,
    // а ведёт наружу. Сверяется фактическое расположение файла.
    let real: string;
    try {
      real = await realpath(filePath);
    } catch {
      return { ok: false, problem: 'ARTIFACT_MISSING', artifact: artifact.path };
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      return { ok: false, problem: 'ARTIFACT_OUTSIDE_ROOT', artifact: artifact.path };
    }

    if (size !== artifact.bytes) {
      return { ok: false, problem: 'SIZE_MISMATCH', artifact: artifact.path };
    }

    if (options.verifyChecksums !== false) {
      const digest = await fileSha256(filePath);
      if (digest !== artifact.sha256) {
        return { ok: false, problem: 'CHECKSUM_MISMATCH', artifact: artifact.path };
      }
    }
  }

  return { ok: true, root: rootReal, manifest: parsed, artifacts };
}

/** Человеческое объяснение отказа. Технических подробностей наружу не уходит. */
export function describeProblem(problem: BasemapProblem): string {
  switch (problem) {
    case 'NOT_CONFIGURED':
      return 'Карта не настроена: каталог с подложкой не задан.';
    case 'MANIFEST_MISSING':
      return 'Карта не настроена: манифест подложки не найден.';
    case 'MANIFEST_INVALID':
      return 'Карта не настроена: манифест подложки не распознан.';
    case 'ARTIFACT_MISSING':
      return 'Карта не настроена: часть файлов подложки отсутствует.';
    case 'SIZE_MISMATCH':
    case 'CHECKSUM_MISMATCH':
      return 'Карта не настроена: файлы подложки не совпадают с манифестом.';
    case 'STYLE_NOT_LISTED':
      return 'Карта не настроена: стиль отсутствует в манифесте.';
    case 'ARTIFACT_OUTSIDE_ROOT':
      return 'Карта не настроена: файл подложки лежит вне её каталога.';
  }
}
