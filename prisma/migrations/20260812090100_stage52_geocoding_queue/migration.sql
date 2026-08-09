-- Этап 5.2: очередь геокодирования адресов и виды истории для автоматического разрешения.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Виды записей истории добавлены предыдущей миграцией: PostgreSQL не разрешает
-- использовать новое значение перечисления в той же транзакции, где оно создано.
--
-- Очередь живёт отдельной таблицей, а не темой существующего outbox: обработчик
-- outbox выполняется внутри транзакции, а держать транзакцию открытой во время
-- обращения к внешнему сервису нельзя. Адреса в очереди нет — только ссылка
-- на заказ и поколение адреса.

-- CreateEnum
CREATE TYPE "GeocodeJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- AlterTable
--
-- Поколение адреса. Растёт только при постановке новой версии адреса в очередь,
-- поэтому ответ провайдера, вернувшийся после смены адреса, распознаётся
-- как устаревший и к новому адресу не применяется.
ALTER TABLE "DeliveryOrder" ADD COLUMN "geoGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_geo_generation_non_negative" CHECK ("geoGeneration" >= 0);

-- CreateTable
CREATE TABLE "OrderGeocodeJob" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "geoGeneration" INTEGER NOT NULL,
    "status" "GeocodeJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastErrorCode" TEXT,
    "staleResults" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OrderGeocodeJob_pkey" PRIMARY KEY ("id")
);

-- Одно задание на одно поколение адреса. Дедупликацию держит база, а не код:
-- параллельные транзакции не видят незафиксированных вставок друг друга,
-- поэтому проверка «сначала найти, потом создать» дала бы дубликат.
CREATE UNIQUE INDEX "OrderGeocodeJob_orderId_geoGeneration_key"
  ON "OrderGeocodeJob"("orderId", "geoGeneration");

CREATE INDEX "OrderGeocodeJob_status_nextAttemptAt_idx"
  ON "OrderGeocodeJob"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "OrderGeocodeJob" ADD CONSTRAINT "OrderGeocodeJob_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Счётчики не бывают отрицательными, а поколение задания — нулевым:
-- нулевое поколение означает «адрес ни разу не ставился в очередь».
ALTER TABLE "OrderGeocodeJob"
  ADD CONSTRAINT "OrderGeocodeJob_counters" CHECK (
    "attempts" >= 0
    AND "maxAttempts" BETWEEN 1 AND 20
    AND "attempts" <= "maxAttempts"
    AND "staleResults" >= 0
    AND "geoGeneration" >= 1
  );

-- Аренда полна или отсутствует целиком. Половина аренды не позволила бы
-- отличить работающее задание от брошенного.
ALTER TABLE "OrderGeocodeJob"
  ADD CONSTRAINT "OrderGeocodeJob_lease_complete" CHECK (
    ("lockedAt" IS NULL) = ("lockedBy" IS NULL)
  );

-- Завершённое задание не держит аренду; незавершённое не имеет времени завершения.
ALTER TABLE "OrderGeocodeJob"
  ADD CONSTRAINT "OrderGeocodeJob_finished_shape" CHECK (
    ("status" IN ('DONE', 'FAILED') AND "finishedAt" IS NOT NULL AND "lockedBy" IS NULL)
    OR ("status" IN ('PENDING', 'PROCESSING') AND "finishedAt" IS NULL)
  );

-- Взятое в работу задание обязано иметь арендатора: без этого условия строка
-- в PROCESSING без аренды никогда не вернулась бы в очередь.
ALTER TABLE "OrderGeocodeJob"
  ADD CONSTRAINT "OrderGeocodeJob_processing_leased" CHECK (
    "status" <> 'PROCESSING' OR "lockedBy" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- Формы записей истории для автоматического геокодирования
--
-- История неизменяема, поэтому неверная запись остаётся в ней навсегда как
-- ложное доказательство. Единственная защита — запрет на её создание.
-- ---------------------------------------------------------------------------

-- Автоматические записи автора-человека не имеют и пояснения не несут:
-- пояснение — это ответственность конкретного человека, а здесь его нет.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_automatic_shape" CHECK (
    "kind" NOT IN (
      'GEOCODE_REQUESTED', 'GEOCODE_RESOLVED', 'GEOCODE_LOW_PRECISION', 'GEOCODE_FAILED'
    )
    OR ("actorUserId" IS NULL AND "reason" IS NULL)
  );

-- Постановка в очередь: адрес отправлен, точки ещё нет.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_geocode_requested_shape" CHECK (
    "kind" <> 'GEOCODE_REQUESTED'
    OR (
      "state" = 'PENDING'
      AND "latMicro" IS NULL
      AND "lonMicro" IS NULL
      AND "source" IS NULL
      AND "precision" IS NULL
      AND "reviewReason" IS NULL
    )
  );

-- Успешное разрешение: только точный дом и только от провайдера.
-- Неточный результат точкой не становится ни при каких условиях.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_geocode_resolved_shape" CHECK (
    "kind" <> 'GEOCODE_RESOLVED'
    OR (
      "state" = 'RESOLVED'
      AND "source" = 'DADATA'
      AND "precision" = 'EXACT_HOUSE'
      AND "latMicro" IS NOT NULL
      AND "lonMicro" IS NOT NULL
      AND "reviewReason" IS NULL
    )
  );

-- Недостаточная точность: координаты не сохраняются вовсе.
-- Сохранённая «примерно верная» точка выглядела бы как обычная и увела бы курьера.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_geocode_low_precision_shape" CHECK (
    "kind" <> 'GEOCODE_LOW_PRECISION'
    OR (
      "state" = 'NEEDS_REVIEW'
      AND "reviewReason" = 'LOW_PRECISION'
      AND "latMicro" IS NULL
      AND "lonMicro" IS NULL
      AND "source" IS NULL
      AND "precision" IS NULL
    )
  );

-- Окончательный отказ провайдера после исчерпания повторов.
ALTER TABLE "OrderGeoHistory"
  ADD CONSTRAINT "OrderGeoHistory_geocode_failed_shape" CHECK (
    "kind" <> 'GEOCODE_FAILED'
    OR (
      "state" = 'FAILED'
      AND "reviewReason" = 'PROVIDER_FAILED'
      AND "latMicro" IS NULL
      AND "lonMicro" IS NULL
      AND "source" IS NULL
      AND "precision" IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Состояние интеграции
--
-- Отдельный provider: геокодирование и подложка карты — разные сервисы
-- с разными ключами, и смешивать их состояния значило бы скрывать отказ одного
-- за работоспособностью другого.
-- ---------------------------------------------------------------------------

INSERT INTO "IntegrationStatus" ("provider", "state", "updatedAt")
VALUES ('dadata', 'NOT_CONFIGURED', CURRENT_TIMESTAMP)
ON CONFLICT ("provider") DO NOTHING;
