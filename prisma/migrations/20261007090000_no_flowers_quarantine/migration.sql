-- AlterTable
ALTER TABLE "DeliveryOrder" ADD COLUMN     "dispatchRequeuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderNoFlowersQuarantine" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "floristId" UUID NOT NULL,
    "assemblyRound" INTEGER NOT NULL,
    "reason" "OrderRefusalReason" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "returnedById" UUID,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "activeKey" UUID,
    "notificationId" UUID,
    CONSTRAINT "OrderNoFlowersQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderNoFlowersQuarantine_activeKey_key" ON "OrderNoFlowersQuarantine"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderNoFlowersQuarantine_notificationId_key" ON "OrderNoFlowersQuarantine"("notificationId");

-- CreateIndex
CREATE INDEX "OrderNoFlowersQuarantine_orderId_idx" ON "OrderNoFlowersQuarantine"("orderId");

-- CreateIndex
CREATE INDEX "OrderNoFlowersQuarantine_activeKey_idx" ON "OrderNoFlowersQuarantine"("activeKey");

-- AddForeignKey
ALTER TABLE "OrderNoFlowersQuarantine" ADD CONSTRAINT "OrderNoFlowersQuarantine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderNoFlowersQuarantine" ADD CONSTRAINT "OrderNoFlowersQuarantine_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderNoFlowersQuarantine" ADD CONSTRAINT "OrderNoFlowersQuarantine_returnedById_fkey" FOREIGN KEY ("returnedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderNoFlowersQuarantine" ADD CONSTRAINT "OrderNoFlowersQuarantine_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "OrderChangeNotification"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
