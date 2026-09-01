-- Автоматическое распределение заказов флористам.
--
-- Готовность и «закончить после текущего» живут в существующей смене; отдельной
-- сущности смены не заводим. Запрос отказа — отдельная таблица, решение по нему
-- идёт через общую систему уведомлений. Накопление начинается после миграции;
-- существующие назначения не трогаются, режим по умолчанию — ручной (нет записи
-- настройки = MANUAL).

-- 1. Готовность флориста в его смене.
ALTER TABLE "FloristShift"
  ADD COLUMN "dispatchReadyAt" TIMESTAMPTZ(3),
  ADD COLUMN "dispatchFinishAfterCurrent" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "FloristShift_dispatchReadyAt_idx" ON "FloristShift"("dispatchReadyAt");

-- 2. Причина и состояние запроса отказа.
CREATE TYPE "OrderRefusalReason" AS ENUM (
  'INSUFFICIENT_GOODS', 'CANNOT_ASSEMBLE', 'PHYSICALLY_IMPOSSIBLE', 'WRONG_ASSIGNMENT', 'OTHER'
);
CREATE TYPE "OrderRefusalState" AS ENUM ('PENDING', 'REJECTED', 'APPROVED', 'TRANSFERRED');

-- 3. Запрос отказа.
CREATE TABLE "OrderRefusalRequest" (
  "id"          UUID NOT NULL,
  "orderId"     UUID NOT NULL,
  "floristId"   UUID NOT NULL,
  "reason"      "OrderRefusalReason" NOT NULL,
  "comment"     TEXT,
  "state"       "OrderRefusalState" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById" UUID,
  "decidedAt"   TIMESTAMP(3),
  "notificationId" UUID,
  CONSTRAINT "OrderRefusalRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderRefusalRequest_orderId_idx" ON "OrderRefusalRequest"("orderId");
CREATE INDEX "OrderRefusalRequest_floristId_idx" ON "OrderRefusalRequest"("floristId");
CREATE INDEX "OrderRefusalRequest_state_idx" ON "OrderRefusalRequest"("state");
CREATE UNIQUE INDEX "OrderRefusalRequest_notificationId_key" ON "OrderRefusalRequest"("notificationId");
-- Один ОТКРЫТЫЙ запрос на заказ: повтор и гонка не создают дубль.
CREATE UNIQUE INDEX "OrderRefusalRequest_one_pending_per_order"
  ON "OrderRefusalRequest"("orderId") WHERE "state" = 'PENDING';

ALTER TABLE "OrderRefusalRequest"
  ADD CONSTRAINT "OrderRefusalRequest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderRefusalRequest"
  ADD CONSTRAINT "OrderRefusalRequest_floristId_fkey"
  FOREIGN KEY ("floristId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderRefusalRequest"
  ADD CONSTRAINT "OrderRefusalRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderRefusalRequest"
  ADD CONSTRAINT "OrderRefusalRequest_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "OrderChangeNotification"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
