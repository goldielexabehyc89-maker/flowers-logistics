-- CreateEnum
CREATE TYPE "PrintDeliveryState" AS ENUM ('QUEUED', 'CLAIMED', 'SENT_TO_PRINTER', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED');

-- AlterTable
ALTER TABLE "FloristShift" ADD COLUMN     "printPointId" UUID;

-- AlterTable
ALTER TABLE "OrderPrintJob" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryState" "PrintDeliveryState",
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "printPointId" UUID,
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PrintPoint" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "computerName" TEXT,
    "printerName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "agentTokenHash" TEXT,
    "pairingCodeHash" TEXT,
    "pairingExpiresAt" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorText" TEXT,
    "testRequestedAt" TIMESTAMP(3),
    "testRequestedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintPoint_agentTokenHash_key" ON "PrintPoint"("agentTokenHash");

-- CreateIndex
CREATE INDEX "PrintPoint_isActive_name_idx" ON "PrintPoint"("isActive", "name");

-- CreateIndex
CREATE INDEX "OrderPrintJob_printPointId_deliveryState_createdAt_idx" ON "OrderPrintJob"("printPointId", "deliveryState", "createdAt");

-- AddForeignKey
ALTER TABLE "FloristShift" ADD CONSTRAINT "FloristShift_printPointId_fkey" FOREIGN KEY ("printPointId") REFERENCES "PrintPoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderPrintJob" ADD CONSTRAINT "OrderPrintJob_printPointId_fkey" FOREIGN KEY ("printPointId") REFERENCES "PrintPoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintPoint" ADD CONSTRAINT "PrintPoint_testRequestedById_fkey" FOREIGN KEY ("testRequestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintPoint" ADD CONSTRAINT "PrintPoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

