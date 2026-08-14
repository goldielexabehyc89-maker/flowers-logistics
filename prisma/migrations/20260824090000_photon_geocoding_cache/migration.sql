-- Собственный Photon как автоматический геокодер и кэш по нормализованному адресу.
--
-- Миграция расширяющая и forward-only. Существующие строки не переписываются:
-- кэш начинается пустым, а уже разрешённые точки сохраняют свой прежний
-- источник. Прежний код продолжает читать и писать заказы как раньше —
-- новое значение перечисления добавлено В КОНЕЦ, новая таблица ему не нужна.

-- 1. Новый источник точки. Только в конец: порядок объявления — это то, чем
--    PostgreSQL сравнивает значения, и вставка в середину сдвинула бы уже
--    записанные строки.
ALTER TYPE "OrderGeoSource" ADD VALUE IF NOT EXISTS 'PHOTON';

-- 2. Чем закончился поиск адреса.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'GeocodeOutcome') THEN
    CREATE TYPE "GeocodeOutcome" AS ENUM ('HOUSE', 'AMBIGUOUS', 'NOT_FOUND');
  END IF;
END
$$;

-- 3. Кэш.
--
-- Первичный ключ — сам нормализованный адрес: второй записи для одного адреса
-- существовать не должно, и это гарантирует база, а не аккуратность кода.
CREATE TABLE IF NOT EXISTS "GeocodeCacheEntry" (
  "normalizedAddress" TEXT NOT NULL,
  "outcome"           "GeocodeOutcome" NOT NULL,
  "latMicro"          INTEGER,
  "lonMicro"          INTEGER,
  "source"            "OrderGeoSource" NOT NULL,
  "hits"              INTEGER NOT NULL DEFAULT 0,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GeocodeCacheEntry_pkey" PRIMARY KEY ("normalizedAddress")
);

CREATE INDEX IF NOT EXISTS "GeocodeCacheEntry_outcome_idx"
  ON "GeocodeCacheEntry"("outcome");

-- Пустой ключ кэшировать нельзя: пустой адрес не ищут.
ALTER TABLE "GeocodeCacheEntry"
  ADD CONSTRAINT "GeocodeCacheEntry_key_not_blank" CHECK (
    length(btrim("normalizedAddress")) > 0
  );

-- Координаты существуют ТОЛЬКО у точного дома и всегда парой.
--
-- Это то же правило, что и у самого заказа: неоднозначная привязка не должна
-- выглядеть как пригодная точка, иначе курьер уедет «примерно туда».
ALTER TABLE "GeocodeCacheEntry"
  ADD CONSTRAINT "GeocodeCacheEntry_point_matches_outcome" CHECK (
    ("outcome" = 'HOUSE' AND "latMicro" IS NOT NULL AND "lonMicro" IS NOT NULL)
    OR ("outcome" <> 'HOUSE' AND "latMicro" IS NULL AND "lonMicro" IS NULL)
  );

-- Координата вне планеты — это ошибка данных, а не редкий случай.
ALTER TABLE "GeocodeCacheEntry"
  ADD CONSTRAINT "GeocodeCacheEntry_point_in_range" CHECK (
    ("latMicro" IS NULL OR ("latMicro" BETWEEN -90000000 AND 90000000))
    AND ("lonMicro" IS NULL OR ("lonMicro" BETWEEN -180000000 AND 180000000))
  );

ALTER TABLE "GeocodeCacheEntry"
  ADD CONSTRAINT "GeocodeCacheEntry_hits_not_negative" CHECK ("hits" >= 0);

COMMENT ON TABLE "GeocodeCacheEntry" IS
  'Кэш геокодирования по нормализованному адресу. Не история: строка заменяется целиком при повторном поиске.';
