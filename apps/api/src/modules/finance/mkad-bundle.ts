/**
 * Геометрия МКАД поставляется вместе с приложением.
 *
 * Загрузка через интерфейс убрана намеренно: от кольца зависят деньги, и оно
 * не должно меняться по нажатию кнопки. Точная геометрия входит в поставку
 * настоящим GeoJSON с зафиксированными источником, снимком, датой и лицензией;
 * замена — только новой версией файла через обновление приложения. Прежние
 * версии и снимки расчётов при этом сохраняются: старые начисления обязаны
 * остаться такими, какими были.
 *
 * Действующая версия определяется ПОСТАВКОЙ, а не последней строкой в базе:
 * отпечаток геометрии из manifest указывает на конкретную версию кольца.
 * Иначе откат приложения на прежнюю версию оставил бы действующей геометрию,
 * которой в этой поставке уже нет.
 *
 * Установка идемпотентна: один и тот же файл не создаёт вторую версию, потому
 * что версии различаются отпечатком геометрии.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../../platform/db.js';
import { writeAudit } from '../audit/service.js';
import { MkadBundleError, parseBundle, type MkadBundle } from './mkad-geojson.js';
import { storeRing, type RingPoint } from './mkad.js';

export type { MkadBundle } from './mkad-geojson.js';
export { MkadBundleError } from './mkad-geojson.js';

/** Где лежат системные файлы геометрии. Каталог входит в образ приложения. */
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/mkad');

/**
 * Чтение поставки.
 *
 * Отсутствие файла — не «геометрия пока не настроена», а негодная поставка:
 * образ собран без обязательной части. Поэтому здесь исключение, а не `null`.
 */
export function readBundle(directory: string = ASSETS): MkadBundle {
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new MkadBundleError(
      `Системная геометрия МКАД негодна: manifest не прочитан (${directory}): ${String(error)}`,
    );
  }

  const name = (manifestRaw as { geometry?: unknown }).geometry;
  if (typeof name !== 'string' || name === '') {
    throw new MkadBundleError('Системная геометрия МКАД негодна: manifest не называет файл.');
  }

  let geojsonRaw: unknown;
  try {
    geojsonRaw = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
  } catch (error) {
    throw new MkadBundleError(
      `Системная геометрия МКАД негодна: файл ${name} не прочитан: ${String(error)}`,
    );
  }

  return parseBundle(manifestRaw, geojsonRaw);
}

/**
 * Поставка читается один раз за жизнь процесса.
 *
 * Файл в образе не меняется, а разбор включает проверку самопересечений:
 * повторять её на каждом расчёте расстояния незачем.
 */
let cached: MkadBundle | null = null;

export function bundle(directory: string = ASSETS): MkadBundle {
  if (cached === null || directory !== ASSETS) {
    const value = readBundle(directory);
    if (directory === ASSETS) {
      cached = value;
    }
    return value;
  }
  return cached;
}

/** Только для проверок: сбрасывает разобранную поставку. */
export function resetBundleCache(): void {
  cached = null;
}

/**
 * Установка геометрии из поставки.
 *
 * Вызывается при запуске приложения после миграций. Повторный запуск ничего
 * не меняет: та же геометрия имеет тот же отпечаток и остаётся той же версией.
 * Новая версия файла добавляет новую неизменяемую строку, а прежние остаются
 * вместе со ссылками прошлых расчётов.
 */
export async function ensureBundledRing(
  db: Database,
  directory: string = ASSETS,
): Promise<{ installed: boolean; version: string; ringVersionId: string }> {
  const value = bundle(directory);

  const existing = await db.mkadRingVersion.findUnique({ where: { sha256: value.sha256 } });
  if (existing !== null) {
    return { installed: false, version: value.version, ringVersionId: existing.id };
  }

  const stored = await storeRing(db, {
    points: value.points,
    source: `${value.snapshotUrl} · отношение OSM ${value.osmRelationId} · ${value.derivation}`,
    license: `${value.license}, ${value.attribution}`,
    sourceDate: value.dataDate,
  });

  /*
   * В аудите — чем именно установлено кольцо, а не само кольцо.
   *
   * Координаты целиком в журнал не попадают: их десятки тысяч, и вопрос
   * «какая геометрия действует» отвечается отпечатком и версией.
   */
  await writeAudit(db, {
    action: 'FINANCE_MKAD_RING_INSTALLED',
    entityType: 'MkadRingVersion',
    entityId: stored.id,
    actorUserId: null,
    actorRoles: [],
    source: 'bootstrap',
    newValue: {
      version: value.version,
      sha256: value.sha256,
      pointCount: value.pointCount,
      lengthMeters: value.lengthMeters,
      osmRelationId: value.osmRelationId,
      dataDate: value.dataDate,
      snapshotUrl: value.snapshotUrl,
      snapshotMd5: value.snapshotMd5,
      license: value.license,
      builder: value.builder,
    },
    ip: null,
    userAgent: null,
  });

  return { installed: true, version: value.version, ringVersionId: stored.id };
}

/**
 * Действующая версия кольца.
 *
 * Не «последняя по времени», а ровно та, что лежит в поставке: версию
 * назначает файл приложения, а не порядок строк в таблице.
 */
export async function activeRing(
  db: Database,
  directory: string = ASSETS,
): Promise<{ id: string; points: RingPoint[]; sha256: string; version: string } | null> {
  const value = bundle(directory);
  const row = await db.mkadRingVersion.findUnique({
    where: { sha256: value.sha256 },
    select: { id: true },
  });
  if (row === null) {
    return null;
  }
  return { id: row.id, points: value.points, sha256: value.sha256, version: value.version };
}
