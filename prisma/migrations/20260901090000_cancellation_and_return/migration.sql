-- Возврат букета от курьера и решение логиста после недоставки.
--
-- Расширяющая forward-only миграция. Прежние данные не переписываются:
-- у существующих заказов признаков отмены нет, задач решения и возвратов
-- тоже — они появляются только новыми событиями.
--
-- Ключевые инварианты закрыты базой, а не кодом: одна активная задача решения
-- и один активный возврат на заказ, одна задача на попытку, неизменяемость
-- переходов возврата.

-- CreateEnum
CREATE TYPE "OrderResolutionDecision" AS ENUM ('CANCELLED', 'REDELIVER');
CREATE TYPE "OrderReturnState" AS ENUM ('WITH_COURIER', 'RETURNING', 'ACCEPTED', 'CANCELLED');

-- AlterEnum: источник размещения пополняется В КОНЕЦ.
ALTER TYPE "PlacementSource" ADD VALUE 'COURIER_RETURN';

-- AlterTable: признаки отмены заказа.
ALTER TABLE "DeliveryOrder"
  ADD COLUMN "cancelledInSource" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancelledInSourceAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByLogistAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByLogistById" UUID;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_cancelledByLogistById_fkey"
  FOREIGN KEY ("cancelledByLogistById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Отмена логистом заполняется целиком: время без автора не отвечает на вопрос «кто».
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_logist_cancel_complete" CHECK (
    ("cancelledByLogistAt" IS NULL AND "cancelledByLogistById" IS NULL)
    OR ("cancelledByLogistAt" IS NOT NULL AND "cancelledByLogistById" IS NOT NULL)
  );

-- Внешняя отмена — тоже пара «признак и время».
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_source_cancel_complete" CHECK (
    ("cancelledInSource" = false AND "cancelledInSourceAt" IS NULL)
    OR ("cancelledInSource" = true AND "cancelledInSourceAt" IS NOT NULL)
  );

-- CreateTable: задача решения логиста.
CREATE TABLE "OrderResolution" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "routeOrderId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "reasonNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "OrderResolutionDecision",
    "decidedAt" TIMESTAMP(3),
    "decidedById" UUID,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "activeKey" UUID,

    CONSTRAINT "OrderResolution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderResolution_attemptId_key" ON "OrderResolution"("attemptId");
CREATE UNIQUE INDEX "OrderResolution_activeKey_key" ON "OrderResolution"("activeKey");
CREATE INDEX "OrderResolution_orderId_idx" ON "OrderResolution"("orderId");
CREATE INDEX "OrderResolution_createdAt_idx" ON "OrderResolution"("createdAt");

-- Активная задача помечается идентификатором своего заказа: так уникальный
-- индекс физически запрещает вторую активную задачу на один заказ.
ALTER TABLE "OrderResolution"
  ADD CONSTRAINT "OrderResolution_activeKey_matches_order" CHECK (
    "activeKey" IS NULL OR "activeKey" = "orderId"
  );

-- Решение заполняется целиком: без автора и времени оно не решение.
ALTER TABLE "OrderResolution"
  ADD CONSTRAINT "OrderResolution_decision_complete" CHECK (
    ("decision" IS NULL AND "decidedAt" IS NULL AND "decidedById" IS NULL)
    OR ("decision" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL)
  );

ALTER TABLE "OrderResolution" ADD CONSTRAINT "OrderResolution_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderResolution" ADD CONSTRAINT "OrderResolution_routeOrderId_fkey"
  FOREIGN KEY ("routeOrderId") REFERENCES "RouteOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderResolution" ADD CONSTRAINT "OrderResolution_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderResolution" ADD CONSTRAINT "OrderResolution_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable: физический возврат от курьера.
CREATE TABLE "OrderReturn" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "routeOrderId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "courierUserId" UUID NOT NULL,
    "state" "OrderReturnState" NOT NULL DEFAULT 'WITH_COURIER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" UUID,
    "placementId" UUID,
    "activeKey" UUID,

    CONSTRAINT "OrderReturn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderReturn_attemptId_key" ON "OrderReturn"("attemptId");
CREATE UNIQUE INDEX "OrderReturn_placementId_key" ON "OrderReturn"("placementId");
CREATE UNIQUE INDEX "OrderReturn_activeKey_key" ON "OrderReturn"("activeKey");
CREATE INDEX "OrderReturn_orderId_idx" ON "OrderReturn"("orderId");
CREATE INDEX "OrderReturn_courierUserId_state_idx" ON "OrderReturn"("courierUserId", "state");

ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_activeKey_matches_order" CHECK (
    "activeKey" IS NULL OR "activeKey" = "orderId"
  );

-- Приёмка — это одновременно время, автор и размещение. Половина приёмки
-- означала бы букет, который склад «как бы взял», но никуда не положил.
ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_accepted_complete" CHECK (
    ("state" <> 'ACCEPTED' AND "acceptedAt" IS NULL AND "acceptedById" IS NULL AND "placementId" IS NULL)
    OR ("state" = 'ACCEPTED' AND "acceptedAt" IS NOT NULL AND "acceptedById" IS NOT NULL AND "placementId" IS NOT NULL)
  );

-- Незакрытый возврат обязан быть активным, закрытый — нет.
ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_activeKey_matches_state" CHECK (
    ("state" IN ('WITH_COURIER', 'RETURNING') AND "activeKey" IS NOT NULL)
    OR ("state" IN ('ACCEPTED', 'CANCELLED') AND "activeKey" IS NULL)
  );

ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_routeOrderId_fkey"
  FOREIGN KEY ("routeOrderId") REFERENCES "RouteOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_courierUserId_fkey"
  FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_acceptedById_fkey"
  FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturn" ADD CONSTRAINT "OrderReturn_placementId_fkey"
  FOREIGN KEY ("placementId") REFERENCES "OrderPlacement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CreateTable: история переходов возврата.
CREATE TABLE "OrderReturnTransition" (
    "id" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "fromState" "OrderReturnState" NOT NULL,
    "toState" "OrderReturnState" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID,
    "reason" TEXT,

    CONSTRAINT "OrderReturnTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderReturnTransition_returnId_occurredAt_idx"
  ON "OrderReturnTransition"("returnId", "occurredAt");

ALTER TABLE "OrderReturnTransition" ADD CONSTRAINT "OrderReturnTransition_returnId_fkey"
  FOREIGN KEY ("returnId") REFERENCES "OrderReturn"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReturnTransition" ADD CONSTRAINT "OrderReturnTransition_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Переходы и задачи не переписываются и не удаляются: это история.
CREATE OR REPLACE FUNCTION prevent_return_history_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'return history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrderReturnTransition_immutable"
  BEFORE UPDATE OR DELETE ON "OrderReturnTransition"
  FOR EACH ROW EXECUTE FUNCTION prevent_return_history_change();

CREATE TRIGGER "OrderReturn_no_delete"
  BEFORE DELETE ON "OrderReturn"
  FOR EACH ROW EXECUTE FUNCTION prevent_return_history_change();

CREATE TRIGGER "OrderResolution_no_delete"
  BEFORE DELETE ON "OrderResolution"
  FOR EACH ROW EXECUTE FUNCTION prevent_return_history_change();
