-- Импорт выплат курьерам из Excel-выписки ПланФакта.
--
-- Выплата по банковской выписке ложится в журнал курьера тем же видом, что и
-- выдача наличных логистом (`CASH_ISSUED_TO_COURIER`): для расчёта с курьером
-- это одно и то же — деньги, которые он получил. Но кассы логиста у неё нет:
-- никакой `LogistCashEntry` не создаётся, и ничьи наличные не двигаются.
-- Источник записи называется ссылкой на импорт, а не текстом в пояснении.
--
-- Строка импорта появляется ТОЛЬКО при подтверждении: загрузка и предпросмотр
-- ничего не пишут. Персональных данных в ней нет — ни имён контрагентов, ни
-- телефонов: только идентификаторы курьеров и записей журнала.

-- CreateTable
CREATE TABLE "CourierPayoutImport" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'PLANFACT',
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "postedCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "postedTotalMinor" BIGINT NOT NULL,
    "rows" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourierPayoutImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierPayoutImport_idempotencyKey_key" ON "CourierPayoutImport"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CourierPayoutImport_fileSha256_idx" ON "CourierPayoutImport"("fileSha256");

-- CreateIndex
CREATE INDEX "CourierPayoutImport_createdAt_idx" ON "CourierPayoutImport"("createdAt");

-- AddForeignKey
ALTER TABLE "CourierPayoutImport" ADD CONSTRAINT "CourierPayoutImport_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable
ALTER TABLE "CourierLedgerEntry" ADD COLUMN "payoutImportId" UUID;

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_payoutImportId_idx" ON "CourierLedgerEntry"("payoutImportId");

-- AddForeignKey
ALTER TABLE "CourierLedgerEntry" ADD CONSTRAINT "CourierLedgerEntry_payoutImportId_fkey" FOREIGN KEY ("payoutImportId") REFERENCES "CourierPayoutImport"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Ссылка на импорт бывает только у выдачи денег курьеру: обратная запись
-- ссылается на отменяемую через "reversesEntryId", а не на импорт.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_payout_import_shape" CHECK (
    "payoutImportId" IS NULL OR "kind" = 'CASH_ISSUED_TO_COURIER'
  );
