-- Уведомления логистов об изменениях заказа и решения о пересборке.
--
-- Три таблицы: бизнес-уведомление (неизменяемое, append-only), персональная
-- отметка прочтения (одна на пользователя) и глобальное идемпотентное решение
-- о пересборке (одно на уведомление). Накопление начинается после миграции —
-- пересчёта старых заказов и backfill'а уведомлений нет.

-- 1. Бизнес-уведомление.
CREATE TABLE "OrderChangeNotification" (
  "id"         UUID NOT NULL,
  "orderId"    UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"     TEXT NOT NULL,
  "categories" TEXT[],
  "kind"       TEXT NOT NULL,
  "payload"    JSONB NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChangeNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderChangeNotification_orderId_idx" ON "OrderChangeNotification"("orderId");
CREATE INDEX "OrderChangeNotification_occurredAt_idx" ON "OrderChangeNotification"("occurredAt");
ALTER TABLE "OrderChangeNotification"
  ADD CONSTRAINT "OrderChangeNotification_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 2. Персональная отметка прочтения.
CREATE TABLE "OrderChangeNotificationRead" (
  "id"             UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "readAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChangeNotificationRead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderChangeNotificationRead_notificationId_userId_key"
  ON "OrderChangeNotificationRead"("notificationId", "userId");
CREATE INDEX "OrderChangeNotificationRead_userId_idx" ON "OrderChangeNotificationRead"("userId");
ALTER TABLE "OrderChangeNotificationRead"
  ADD CONSTRAINT "OrderChangeNotificationRead_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "OrderChangeNotification"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "OrderChangeNotificationRead"
  ADD CONSTRAINT "OrderChangeNotificationRead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 3. Глобальное идемпотентное решение о пересборке.
CREATE TABLE "OrderReassemblyDecision" (
  "id"                UUID NOT NULL,
  "notificationId"    UUID NOT NULL,
  "orderId"           UUID NOT NULL,
  "decidedById"       UUID NOT NULL,
  "assignedFloristId" UUID NOT NULL,
  "assemblyRound"     INTEGER NOT NULL,
  "decidedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderReassemblyDecision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderReassemblyDecision_notificationId_key"
  ON "OrderReassemblyDecision"("notificationId");
CREATE INDEX "OrderReassemblyDecision_orderId_idx" ON "OrderReassemblyDecision"("orderId");
ALTER TABLE "OrderReassemblyDecision"
  ADD CONSTRAINT "OrderReassemblyDecision_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "OrderChangeNotification"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "OrderReassemblyDecision"
  ADD CONSTRAINT "OrderReassemblyDecision_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReassemblyDecision"
  ADD CONSTRAINT "OrderReassemblyDecision_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderReassemblyDecision"
  ADD CONSTRAINT "OrderReassemblyDecision_assignedFloristId_fkey"
  FOREIGN KEY ("assignedFloristId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Append-only: бизнес-события и решения не переписываются и не удаляются.
-- Функция prevent_mutation() определена ранней миграцией аудита.
CREATE TRIGGER "OrderChangeNotification_no_change"
  BEFORE UPDATE OR DELETE ON "OrderChangeNotification"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER "OrderChangeNotificationRead_no_change"
  BEFORE UPDATE OR DELETE ON "OrderChangeNotificationRead"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER "OrderReassemblyDecision_no_change"
  BEFORE UPDATE OR DELETE ON "OrderReassemblyDecision"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
