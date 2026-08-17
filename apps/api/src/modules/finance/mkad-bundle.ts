/**
 * Геометрия МКАД поставляется вместе с приложением.
 *
 * Загрузка через интерфейс убрана намеренно: от кольца зависят деньги, и оно
 * не должно меняться по нажатию кнопки. Точная геометрия входит в поставку
 * версионированным системным файлом с зафиксированными источником, датой
 * и лицензией; замена — только новой версией файла через обновление
 * приложения. Прежние версии и снимки расчётов при этом сохраняются: старые
 * начисления обязаны остаться такими, какими были.
 *
 * Загрузка идемпотентна: один и тот же файл не создаёт вторую версию, потому
 * что версии различаются отпечатком геометрии.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../../platform/db.js';
import { parseRing, ringSha256, storeRing, type RingPoint } from './mkad.js';

/** Где лежат системные файлы геометрии. Каталог входит в образ приложения. */
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/mkad');

export interface MkadBundle {
  version: string;
  source: string;
  license: string;
  sourceDate: string;
  derivation: string;
  sha256: string;
  points: RingPoint[];
}

/**
 * Самый свежий файл поставки. `null` — файлов нет вовсе.
 *
 * Имя файла содержит версию, поэтому «самый свежий» определяется по имени,
 * а не по времени файла: у образа время создания одинаковое у всего.
 */
export function readBundle(directory: string = ASSETS): MkadBundle | null {
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  if (files.length === 0) {
    return null;
  }

  const latest = files.sort().at(-1) ?? '';
  const raw = JSON.parse(readFileSync(path.join(directory, latest), 'utf8')) as {
    version: string;
    source: string;
    license: string;
    sourceDate: string;
    derivation: string;
    sha256: string;
    points: [number, number][];
  };

  const points = parseRing(raw.points);
  const sha256 = ringSha256(points);
  if (sha256 !== raw.sha256) {
    // Отпечаток не сходится: файл повреждён или подменён. Молча брать такую
    // геометрию нельзя — по ней считаются деньги.
    throw new Error(`Отпечаток геометрии МКАД не совпадает с файлом ${latest}`);
  }

  return {
    version: raw.version,
    source: raw.source,
    license: raw.license,
    sourceDate: raw.sourceDate,
    derivation: raw.derivation,
    sha256,
    points,
  };
}

/**
 * Установка геометрии из поставки.
 *
 * Вызывается при запуске приложения после миграций. Повторный запуск ничего
 * не меняет: та же геометрия имеет тот же отпечаток и остаётся той же версией.
 */
export async function ensureBundledRing(
  db: Database,
  directory: string = ASSETS,
): Promise<{ installed: boolean; version: string | null }> {
  const bundle = readBundle(directory);
  if (bundle === null) {
    return { installed: false, version: null };
  }

  const existing = await db.mkadRingVersion.findUnique({ where: { sha256: bundle.sha256 } });
  if (existing !== null) {
    return { installed: false, version: bundle.version };
  }

  await storeRing(db, {
    points: bundle.points,
    source: `${bundle.source}. ${bundle.derivation}`,
    license: bundle.license,
    sourceDate: bundle.sourceDate,
  });

  return { installed: true, version: bundle.version };
}
