-- Касса логиста: фактические наличные у конкретного человека.
--
-- Расширяющая forward-only миграция. У существующей таблицы появляется одна
-- необязательная колонка связи передачи; данные не переписываются, инварианты
-- не ослабляются. Прошлые операции остаются как есть: касса каждого логиста
-- начинается с нуля, и backfill запрещён решением владельца.

-- CreateEnum
CREATE TYPE "LogistCashKind" AS ENUM ('RECEIVED_FROM_COURIER', 'ISSUED_TO_COURIER', 'TAKEN_FROM_COMPANY', 'HANDED_TO_COMPANY', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "CourierLedgerEntry" ADD COLUMN     "transferId" UUID;

-- CreateTable
CREATE TABLE "LogistCashEntry" (
    "id" UUID NOT NULL,
    "logistUserId" UUID NOT NULL,
    "kind" "LogistCashKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "operationDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID NOT NULL,
    "courierUserId" UUID,
    "transferId" UUID,
    "reason" TEXT,
    "reversesEntryId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogistCashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LogistCashEntry_reversesEntryId_key" ON "LogistCashEntry"("reversesEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "LogistCashEntry_idempotencyKey_key" ON "LogistCashEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LogistCashEntry_logistUserId_operationDate_idx" ON "LogistCashEntry"("logistUserId", "operationDate");

-- CreateIndex
CREATE INDEX "LogistCashEntry_courierUserId_operationDate_idx" ON "LogistCashEntry"("courierUserId", "operationDate");

-- CreateIndex
CREATE INDEX "LogistCashEntry_transferId_idx" ON "LogistCashEntry"("transferId");

-- CreateIndex
CREATE INDEX "LogistCashEntry_occurredAt_idx" ON "LogistCashEntry"("occurredAt");

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_transferId_idx" ON "CourierLedgerEntry"("transferId");

-- AddForeignKey
ALTER TABLE "LogistCashEntry" ADD CONSTRAINT "LogistCashEntry_logistUserId_fkey" FOREIGN KEY ("logistUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LogistCashEntry" ADD CONSTRAINT "LogistCashEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LogistCashEntry" ADD CONSTRAINT "LogistCashEntry_courierUserId_fkey" FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LogistCashEntry" ADD CONSTRAINT "LogistCashEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "LogistCashEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- --------------------------------------------------------------------------
-- Инварианты кассы
-- --------------------------------------------------------------------------

-- Нулевое движение денег не имеет смысла.
ALTER TABLE "LogistCashEntry"
  ADD CONSTRAINT "LogistCashEntry_amount_not_zero"
  CHECK ("amountMinor" <> 0);

-- Знак задан видом: приход в кассу — плюс, расход — минус.
ALTER TABLE "LogistCashEntry"
  ADD CONSTRAINT "LogistCashEntry_sign_matches_kind"
  CHECK (
    "kind" = 'ADJUSTMENT'
    OR ("kind" IN ('RECEIVED_FROM_COURIER', 'TAKEN_FROM_COMPANY') AND "amountMinor" > 0)
    OR ("kind" IN ('ISSUED_TO_COURIER', 'HANDED_TO_COMPANY') AND "amountMinor" < 0)
  );

-- Курьер участвует ровно в передачах с курьером; в расчётах с компанией его нет.
ALTER TABLE "LogistCashEntry"
  ADD CONSTRAINT "LogistCashEntry_courier_matches_kind"
  CHECK (
    ("kind" IN ('RECEIVED_FROM_COURIER', 'ISSUED_TO_COURIER') AND "courierUserId" IS NOT NULL)
    OR ("kind" IN ('TAKEN_FROM_COMPANY', 'HANDED_TO_COMPANY') AND "courierUserId" IS NULL)
    OR "kind" = 'ADJUSTMENT'
  );

-- Обратная операция обязана назвать причину и сослаться на исходную запись.
ALTER TABLE "LogistCashEntry"
  ADD CONSTRAINT "LogistCashEntry_reversal_shape"
  CHECK (
    ("kind" = 'ADJUSTMENT' AND "reversesEntryId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) >= 3)
    OR ("kind" <> 'ADJUSTMENT' AND "reversesEntryId" IS NULL)
  );

-- Запись не может отменять сама себя.
ALTER TABLE "LogistCashEntry"
  ADD CONSTRAINT "LogistCashEntry_reversal_not_self"
  CHECK ("reversesEntryId" IS NULL OR "reversesEntryId" <> "id");

-- Неизменяемость: касса append-only, как и учёт курьера.
CREATE TRIGGER "LogistCashEntry_no_update"
  BEFORE UPDATE ON "LogistCashEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "LogistCashEntry_no_delete"
  BEFORE DELETE ON "LogistCashEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();
