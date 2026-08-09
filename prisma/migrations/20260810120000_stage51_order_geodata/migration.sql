-- Этап 5.1: геоданные заказа и их неизменяемая история.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Координаты хранятся целыми микроградусами, а не числами с плавающей точкой:
-- от координаты зависят порядок объезда и расстояние, а двоичная дробь округляется
-- незаметно и накапливает ошибку. Микроградус — около 11 сантиметров.

-- CreateEnum
CREATE TYPE "OrderGeoState" AS ENUM ('UNRESOLVED', 'PENDING', 'RESOLVED', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderGeoSource" AS ENUM ('DADATA', 'MANUAL', 'SYNTHETIC');

-- CreateEnum
CREATE TYPE "OrderGeoPrecision" AS ENUM ('EXACT_HOUSE', 'NEARBY_HOUSE', 'STREET', 'LOCALITY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OrderGeoReviewReason" AS ENUM ('ADDRESS_CHANGED', 'LOW_PRECISION', 'PROVIDER_FAILED', 'MANUAL_CHECK');

-- CreateEnum
CREATE TYPE "OrderGeoChangeKind" AS ENUM ('MANUAL_SET', 'INVALIDATED_ADDRESS_CHANGED');

-- AlterTable
ALTER TABLE "DeliveryOrder"
  ADD COLUMN "geoState" "OrderGeoState" NOT NULL DEFAULT 'UNRESOLVED',
  ADD COLUMN "geoSource" "OrderGeoSource",
  ADD COLUMN "geoPrecision" "OrderGeoPrecision",
  ADD COLUMN "geoLatMicro" INTEGER,
  ADD COLUMN "geoLonMicro" INTEGER,
  ADD COLUMN "geoResolvedAt" TIMESTAMP(3),
  ADD COLUMN "geoReviewReason" "OrderGeoReviewReason";

-- CreateTable
CREATE TABLE "OrderGeoHistory" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderGeoChangeKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "OrderGeoState" NOT NULL,
    "source" "OrderGeoSource",
    "precision" "OrderGeoPrecision",
    "latMicro" INTEGER,
    "lonMicro" INTEGER,
    "previousLatMicro" INTEGER,
    "previousLonMicro" INTEGER,
    "reviewReason" "OrderGeoReviewReason",
    "reason" TEXT,
    "actorUserId" UUID,

    CONSTRAINT "OrderGeoHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderGeoHistory_orderId_occurredAt_idx" ON "OrderGeoHistory"("orderId", "occurredAt");

-- Планирование и карта спрашивают «какие заказы дня уже пригодны»: без индекса
-- это перебор всей таблицы заказов.
CREATE INDEX "DeliveryOrder_geoState_deliveryDate_idx" ON "DeliveryOrder"("geoState", "deliveryDate");

-- AddForeignKey
ALTER TABLE "OrderGeoHistory" ADD CONSTRAINT "OrderGeoHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGeoHistory" ADD CONSTRAINT "OrderGeoHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Инварианты уровня базы
-- ---------------------------------------------------------------------------

-- Координаты в пределах планеты. Микроградусы: 90° = 90 000 000.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_geo_range" CHECK (
    ("geoLatMicro" IS NULL OR "geoLatMicro" BETWEEN -90000000 AND 90000000)
    AND ("geoLonMicro" IS NULL OR "geoLonMicro" BETWEEN -180000000 AND 180000000)
  );

-- Половина координаты — это не координата. Широта без долготы указывает
-- в никуда, но выглядит как заполненное поле.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_geo_pair_complete" CHECK (
    ("geoLatMicro" IS NULL AND "geoLonMicro" IS NULL)
    OR ("geoLatMicro" IS NOT NULL AND "geoLonMicro" IS NOT NULL)
  );

-- Точка существует ТОЛЬКО в состоянии RESOLVED и всегда вместе с источником,
-- точностью и временем разрешения.
--
-- Это и есть гарантия для будущего автоматического планирования: оно берёт
-- заказы по geoState = 'RESOLVED', и непригодная точка не может туда попасть.
-- Обратное тоже верно: RESOLVED без координат невозможен.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_geo_resolved_complete" CHECK (
    (
      "geoState" = 'RESOLVED'
      AND "geoLatMicro" IS NOT NULL
      AND "geoSource" IS NOT NULL
      AND "geoPrecision" IS NOT NULL
      AND "geoResolvedAt" IS NOT NULL
    )
    OR (
      "geoState" <> 'RESOLVED'
      AND "geoLatMicro" IS NULL
      AND "geoSource" IS NULL
      AND "geoPrecision" IS NULL
      AND "geoResolvedAt" IS NULL
    )
  );

-- Причина проверки осмысленна только там, где проверка нужна.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_geo_review_reason" CHECK (
    ("geoReviewReason" IS NULL AND "geoState" NOT IN ('NEEDS_REVIEW', 'FAILED'))
    OR ("geoReviewReason" IS NOT NULL AND "geoState" IN ('NEEDS_REVIEW', 'FAILED'))
  );

-- История: та же арифметика координат и та же полнота пары.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_range" CHECK (
    ("latMicro" IS NULL OR "latMicro" BETWEEN -90000000 AND 90000000)
    AND ("lonMicro" IS NULL OR "lonMicro" BETWEEN -180000000 AND 180000000)
    AND ("previousLatMicro" IS NULL OR "previousLatMicro" BETWEEN -90000000 AND 90000000)
    AND ("previousLonMicro" IS NULL OR "previousLonMicro" BETWEEN -180000000 AND 180000000)
  );

ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_pair_complete" CHECK (
    (("latMicro" IS NULL) = ("lonMicro" IS NULL))
    AND (("previousLatMicro" IS NULL) = ("previousLonMicro" IS NULL))
  );

-- Ручная установка обязана иметь автора, координаты и объяснение: точка,
-- поставленная человеком без причины, неотличима от случайного клика.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_manual_complete" CHECK (
    "kind" <> 'MANUAL_SET'
    OR (
      "latMicro" IS NOT NULL
      AND "source" = 'MANUAL'
      AND "actorUserId" IS NOT NULL
      AND "reason" IS NOT NULL
      AND char_length("reason") BETWEEN 3 AND 500
    )
  );

-- Инвалидация не приносит новой точки и всегда объясняет причину.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_invalidation_shape" CHECK (
    "kind" <> 'INVALIDATED_ADDRESS_CHANGED'
    OR ("latMicro" IS NULL AND "state" = 'NEEDS_REVIEW' AND "reviewReason" = 'ADDRESS_CHANGED')
  );

-- ---------------------------------------------------------------------------
-- Триггеры
--
-- Функция prevent_mutation() создана миграцией 20260804160841_audit_immutability_guards.
-- ---------------------------------------------------------------------------

-- История геоданных неизменяема: переписанная точка перестала бы быть
-- доказательством того, где заказ находился до правки адреса.
CREATE TRIGGER order_geo_history_no_update
  BEFORE UPDATE ON "OrderGeoHistory"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER order_geo_history_no_delete
  BEFORE DELETE ON "OrderGeoHistory"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
