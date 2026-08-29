-- Локальная отмена самовывоза: исключение заказа из очереди самовывоза.
--
-- Расширяющая миграция: новая таблица, ничего существующего не трогает и ни
-- одной строки не переписывает. НЕ меняет статус заказа, НЕ связана с
-- синхронизацией состояния в МойСклад. Предыдущий клиент Prisma о таблице не
-- знает и её не выбирает — откат на прежний код безопасен.
CREATE TABLE "OrderPickupCancellation" (
  "id"            UUID PRIMARY KEY,
  "orderId"       UUID NOT NULL,
  "cancelledAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledById" UUID NOT NULL,
  CONSTRAINT "OrderPickupCancellation_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "OrderPickupCancellation_cancelledById_fkey"
    FOREIGN KEY ("cancelledById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Одна локальная отмена на заказ: терминальный исход самовывоза ровно один.
CREATE UNIQUE INDEX "OrderPickupCancellation_orderId_key"
  ON "OrderPickupCancellation"("orderId");

CREATE INDEX "OrderPickupCancellation_cancelledAt_idx"
  ON "OrderPickupCancellation"("cancelledAt");
