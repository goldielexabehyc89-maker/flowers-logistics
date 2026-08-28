-- Порядок и защита от регресса при передаче состояния заказа в МойСклад.
--
-- Расширяющая миграция: новая таблица, ничего существующего не трогает и
-- ни одной строки не переписывает. Предыдущий клиент Prisma о таблице не знает
-- и её не выбирает, поэтому откат на прежний код безопасен.
CREATE TABLE "OrderMoyskladState" (
  "orderId"     UUID PRIMARY KEY,
  "enqueuedSeq" INTEGER NOT NULL DEFAULT 0,
  "appliedSeq"  INTEGER NOT NULL DEFAULT 0,
  "lastStateId" UUID,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderMoyskladState_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
