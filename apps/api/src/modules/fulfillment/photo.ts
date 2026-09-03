/**
 * Серверный read-only проxy фотографии номенклатуры.
 *
 * ПОЧЕМУ ВООБЩЕ ПРОКСИ. Фото не хранится в нашей базе (решение владельца
 * `FUL-002` п.8–9): оно загружается при каждом открытии карточки. Отдать
 * браузеру прямую ссылку нельзя — она требует токена МоегоСклада, а токен
 * не покидает сервер ни при каких условиях (`FUL-002` §2.7.2).
 *
 * ЧТО ЗДЕСЬ НЕ СОХРАНЯЕТСЯ НИКОГДА: байты изображения, адрес источника, токен
 * и заголовки внешнего ответа. Ни в базу, ни в журнал, ни в кэш браузера
 * (`Cache-Control: no-store`). Ответ не раскрывает upstream: клиент видит наш
 * путь и тип изображения, и ничего больше.
 *
 * FAIL CLOSED В ТРЁХ МЕСТАХ.
 *
 *  1. Сущность. Проксируется только та номенклатура, которая ФАКТИЧЕСКИ входит
 *     в состав заказа производственной области и видима флористу. Иначе раздел
 *     флориста превратился бы в универсальный загрузчик чужих файлов по UUID.
 *  2. Тип. Разрешён короткий список изображений; всё остальное отвергается
 *     до передачи клиенту.
 *  3. Размер. Проверяется и по заголовку, и по фактически прочитанным байтам.
 *
 * ЛЮБОЙ ОТКАЗ — ЭТО «ФОТО ОТСУТСТВУЕТ». Недоступное фото не должно ломать
 * карточку: заказ собирают по составу, а не по картинке. Поэтому наружу
 * уходит один и тот же нейтральный 404 без технических подробностей —
 * и потому же он не рассказывает, существует ли такая номенклатура вообще.
 */

import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import { MOYSKLAD_IDS } from '../integrations/moysklad/config.js';
import type { PhotoFetcher } from './photo-fetcher.js';
import { isVisibleToFlorist } from './visibility.js';
import type { FulfillmentAssortmentKind } from './composition.js';

/** Разрешённые типы. Ни SVG, ни PDF: SVG исполняет скрипты в браузере. */
export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Предел размера: фотография товара, а не архив. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface PhotoResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface PhotoDeps {
  db: Database;
  /**
   * Отдельный ограниченный контур фотографий. `null` — интеграция не настроена:
   * сетевого обращения не будет. НЕ основной клиент МоегоСклада: фотографии его
   * очередь (2/1/30), импорт и статусы не занимают.
   */
  photos: PhotoFetcher | null;
}

/** Нейтральный отказ. Один и тот же для всех причин — он же и есть политика. */
function absent(): AppError {
  return new AppError('NOT_FOUND', {
    message: 'photo is not available',
    publicMessage: 'Фото отсутствует.',
  });
}

/**
 * Разрешена ли номенклатура к проксированию.
 *
 * Разрешение даёт не список настроек, а факт: такая позиция или компонент
 * состоит в заказе производственной области и видима флористу. Скрытая
 * сервисная позиция доступа к файлам не даёт.
 */
export async function isPhotoAllowed(db: Database, assortmentId: string): Promise<boolean> {
  const position = await db.deliveryOrderPosition.findFirst({
    where: { assortmentId, order: { fulfillmentInScope: true } },
    select: { assortmentId: true, assortmentKind: true },
  });

  if (
    position !== null &&
    isVisibleToFlorist(
      {
        assortmentId: position.assortmentId,
        assortmentKind: position.assortmentKind as FulfillmentAssortmentKind,
      },
      MOYSKLAD_IDS,
    )
  ) {
    return true;
  }

  // Компонент бандла — тоже часть состава, который видит флорист.
  const component = await db.deliveryOrderPositionComponent.findFirst({
    where: { assortmentId, position: { order: { fulfillmentInScope: true } } },
    select: { id: true },
  });

  return component !== null;
}

/**
 * Тип сущности для запроса изображений.
 *
 * Собирается из НАШЕГО перечисления, а не из ответа внешнего сервиса и тем
 * более не из запроса клиента: произвольная строка здесь означала бы
 * произвольный путь в чужом API.
 */
function entityKindOf(kind: string): 'product' | 'bundle' | 'variant' | null {
  if (kind === 'PRODUCT') return 'product';
  if (kind === 'BUNDLE') return 'bundle';
  if (kind === 'VARIANT') return 'variant';
  return null;
}

/**
 * Фотография номенклатуры.
 *
 * Возвращает `null`, если фотографии нет: это штатное состояние карточки,
 * а не отказ. Любая техническая неудача превращается в тот же `null` —
 * подробности внешнего сервиса клиенту не принадлежат.
 */
export async function readAssortmentPhoto(
  deps: PhotoDeps,
  assortmentId: string,
): Promise<PhotoResult | null> {
  if (deps.photos === null) {
    return null;
  }

  const kinds = await assortmentKindsOf(deps.db, assortmentId);
  const entities = kinds
    .map((kind) => entityKindOf(kind))
    .filter((entity): entity is 'product' | 'bundle' | 'variant' => entity !== null);
  if (entities.length === 0) {
    return null;
  }

  // Обращение в upstream идёт через ограниченный контур с предохранителем: при
  // недоступности МоегоСклада запрос быстро завершается «нет фото», карточку не
  // блокирует и очередь импорта не занимает.
  const photo = await deps.photos.getPhoto(entities, assortmentId);
  return photo === null ? null : { bytes: photo.bytes, contentType: photo.contentType };
}

/** Какими типами номенклатуры эта позиция встречается в составе. */
async function assortmentKindsOf(db: Database, assortmentId: string): Promise<string[]> {
  const [positions, components] = await Promise.all([
    db.deliveryOrderPosition.findMany({
      where: { assortmentId, order: { fulfillmentInScope: true } },
      select: { assortmentKind: true },
      distinct: ['assortmentKind'],
    }),
    db.deliveryOrderPositionComponent.findMany({
      where: { assortmentId, position: { order: { fulfillmentInScope: true } } },
      select: { assortmentKind: true },
      distinct: ['assortmentKind'],
    }),
  ]);

  return [...new Set([...positions, ...components].map((row) => row.assortmentKind as string))];
}

/** Ответ маршрута: либо изображение, либо нейтральное «фото отсутствует». */
export async function requirePhoto(deps: PhotoDeps, assortmentId: string): Promise<PhotoResult> {
  if (!(await isPhotoAllowed(deps.db, assortmentId))) {
    throw absent();
  }
  const photo = await readAssortmentPhoto(deps, assortmentId);
  if (photo === null) {
    throw absent();
  }
  return photo;
}
