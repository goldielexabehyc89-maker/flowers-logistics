-- Этап 5.1, корректирующий проход: усиление инвариантов истории геоданных.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
-- Прежние ограничения 20260810120000 описывали форму записи неполно и допускали
-- сочетания, которые история не должна уметь выражать. Они заменяются строгими.
--
-- История геоданных неизменяема, поэтому неверная запись в ней не правится
-- и не удаляется — она навсегда остаётся ложным доказательством того, где
-- находился заказ. Единственная защита от такой записи — запрет на её создание.

-- ---------------------------------------------------------------------------
-- Ручная установка точки
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderGeoHistory" DROP CONSTRAINT "OrderGeoHistory_manual_complete";

-- Ручная запись описывает ровно одно событие: человек показал дом на карте.
-- Значит, состояние только RESOLVED, источник только MANUAL, точность только
-- EXACT_HOUSE, обе координаты на месте, автор известен, причина написана.
-- Причина проверки здесь бессмысленна: проверку только что и выполнил человек.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_manual_complete" CHECK (
    "kind" <> 'MANUAL_SET'
    OR (
      "state" = 'RESOLVED'
      AND "source" = 'MANUAL'
      AND "precision" = 'EXACT_HOUSE'
      AND "latMicro" IS NOT NULL
      AND "lonMicro" IS NOT NULL
      AND "actorUserId" IS NOT NULL
      AND "reason" IS NOT NULL
      AND char_length("reason") BETWEEN 3 AND 500
      AND "reviewReason" IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Обесценивание точки после смены адреса
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderGeoHistory" DROP CONSTRAINT "OrderGeoHistory_invalidation_shape";

-- Инвалидация не приносит новой точки: ни координат, ни источника, ни точности.
-- Зато она обязана сохранить прежнюю точку целиком — ради неё запись и делается.
-- Половина прежней пары доказательством не является.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_invalidation_shape" CHECK (
    "kind" <> 'INVALIDATED_ADDRESS_CHANGED'
    OR (
      "state" = 'NEEDS_REVIEW'
      AND "reviewReason" = 'ADDRESS_CHANGED'
      AND "latMicro" IS NULL
      AND "lonMicro" IS NULL
      AND "source" IS NULL
      AND "precision" IS NULL
      AND "previousLatMicro" IS NOT NULL
      AND "previousLonMicro" IS NOT NULL
    )
  );
