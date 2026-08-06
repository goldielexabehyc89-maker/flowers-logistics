-- Этап 3.1: заказы доставки из МоегоСклада, неизменяемая история версий и курсор синхронизации.
--
-- Деньги хранятся целыми копейками в BIGINT: единица подтверждена сверкой с карточкой заказа.
-- Тип с плавающей точкой не используется — от этих значений зависит долг курьера.
--
-- Инварианты, защищённые базой, добавляются отдельным блоком в конце файла:
--  * заказ физически не удаляется — только исключается из активного планирования;
--  * ревизия заказа неизменяема: UPDATE и DELETE запрещены.

-- CreateEnum
CREATE TYPE "DeliveryIntervalKind" AS ENUM ('MISSING', 'RANGE', 'EXACT', 'UNRECOGNIZED');

-- CreateEnum
CREATE TYPE "OrderAttentionReason" AS ENUM ('MISSING_DELIVERY_DATE', 'MISSING_INTERVAL', 'UNRECOGNIZED_INTERVAL', 'MISSING_ADDRESS', 'MISSING_RECIPIENT', 'CASH_OVERPAYMENT');

-- CreateEnum
CREATE TYPE "OrderScopeExitReason" AS ENUM ('STORE_CHANGED', 'DELIVERY_METHOD_CHANGED', 'SOURCE_ARCHIVED', 'SOURCE_MISSING');

-- CreateEnum
CREATE TYPE "OrderRevisionReason" AS ENUM ('INITIAL_IMPORT', 'EXTERNAL_UPDATE', 'SCOPE_ENTERED', 'SCOPE_EXITED', 'SOURCE_MISSING');

-- CreateTable
CREATE TABLE "DeliveryOrder" (
    "id" UUID NOT NULL,
    "externalId" UUID NOT NULL,
    "externalName" TEXT NOT NULL,
    "externalUpdated" TIMESTAMP(3) NOT NULL,
    "externalMoment" TIMESTAMP(3),
    "externalStateId" UUID,
    "externalStateName" TEXT,
    "externalStateType" TEXT,
    "storeId" UUID NOT NULL,
    "deliveryMethodId" UUID,
    "deliveryDate" TIMESTAMP(3),
    "deliveryDateRaw" TEXT,
    "intervalRaw" TEXT,
    "intervalKind" "DeliveryIntervalKind" NOT NULL DEFAULT 'MISSING',
    "intervalStartMinute" INTEGER,
    "intervalEndMinute" INTEGER,
    "manualIntervalStartMinute" INTEGER,
    "manualIntervalEndMinute" INTEGER,
    "manualIntervalSetAt" TIMESTAMP(3),
    "address" TEXT,
    "recipient" TEXT,
    "comment" TEXT,
    "paymentTypeId" UUID,
    "paymentTypeName" TEXT,
    "sumMinor" BIGINT NOT NULL DEFAULT 0,
    "payedSumMinor" BIGINT NOT NULL DEFAULT 0,
    "cashCollectable" BOOLEAN NOT NULL DEFAULT false,
    "cashToCollectMinor" BIGINT NOT NULL DEFAULT 0,
    "cashAnomaly" BOOLEAN NOT NULL DEFAULT false,
    "inScope" BOOLEAN NOT NULL DEFAULT true,
    "scopeExitReason" "OrderScopeExitReason",
    "scopeExitedAt" TIMESTAMP(3),
    "sourceArchived" BOOLEAN NOT NULL DEFAULT false,
    "sourceMissing" BOOLEAN NOT NULL DEFAULT false,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionReasons" "OrderAttentionReason"[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryOrderRevision" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "externalUpdated" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "changedFields" TEXT[],
    "reason" "OrderRevisionReason" NOT NULL,

    CONSTRAINT "DeliveryOrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCursor" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "updatedCursor" TIMESTAMP(3),
    "initialLoadCompleted" BOOLEAN NOT NULL DEFAULT false,
    "initialLoadCompletedAt" TIMESTAMP(3),
    "lastReconciliationAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryOrder_externalId_key" ON "DeliveryOrder"("externalId");

-- CreateIndex
CREATE INDEX "DeliveryOrder_inScope_deliveryDate_idx" ON "DeliveryOrder"("inScope", "deliveryDate");

-- CreateIndex
CREATE INDEX "DeliveryOrder_needsAttention_idx" ON "DeliveryOrder"("needsAttention");

-- CreateIndex
CREATE INDEX "DeliveryOrder_externalUpdated_idx" ON "DeliveryOrder"("externalUpdated");

-- CreateIndex
CREATE INDEX "DeliveryOrder_storeId_deliveryMethodId_idx" ON "DeliveryOrder"("storeId", "deliveryMethodId");

-- CreateIndex
CREATE INDEX "DeliveryOrderRevision_orderId_receivedAt_idx" ON "DeliveryOrderRevision"("orderId", "receivedAt");

-- CreateIndex
CREATE INDEX "DeliveryOrderRevision_orderId_externalUpdated_idx" ON "DeliveryOrderRevision"("orderId", "externalUpdated");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCursor_provider_key" ON "IntegrationCursor"("provider");

-- AddForeignKey
ALTER TABLE "DeliveryOrderRevision" ADD CONSTRAINT "DeliveryOrderRevision_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Инварианты уровня базы.
--
-- Функция prevent_mutation() создана миграцией 20260804160841_audit_immutability_guards
-- и переиспользуется здесь: сообщение об ошибке уже содержит имя таблицы и операцию.
--
-- Триггеры не отражаются в schema.prisma и не участвуют в diff-е миграций,
-- поэтому дрейфа схемы не вызывают.

-- Заказ физически не удаляется: он может выйти из нашей области и быть исключён
-- из активного планирования, но история заказа сохраняется всегда.
CREATE TRIGGER delivery_order_no_delete
  BEFORE DELETE ON "DeliveryOrder"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Ревизия неизменяема: в ней лежат значения полей заказа, и переписанная история
-- перестала бы быть доказательством того, что и когда пришло из МоегоСклада.
CREATE TRIGGER delivery_order_revision_no_update
  BEFORE UPDATE ON "DeliveryOrderRevision"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER delivery_order_revision_no_delete
  BEFORE DELETE ON "DeliveryOrderRevision"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
