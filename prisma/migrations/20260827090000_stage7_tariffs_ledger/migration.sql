-- Этап 7: тарифы курьера, финансовый учёт и снимки, на которых он стоит.
--
-- Расширяющая forward-only миграция. Существующие таблицы не переписываются,
-- индексы не удаляются, данные не переносятся: старые доставки остаются без
-- начислений намеренно — тарифного снимка у них никогда не было, и придумывать
-- ставку задним числом запрещено решением владельца.

-- CreateEnum
CREATE TYPE "CourierTariffKind" AS ENUM ('REGULAR', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "BeyondMkadSource" AS ENUM ('COMPUTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CourierLedgerKind" AS ENUM ('CASH_RECEIVED', 'DELIVERY_FEE', 'DISTANCE_FEE', 'ATTEMPT_FEE', 'CASH_HANDED_TO_LOGIST', 'CASH_ISSUED_TO_COURIER', 'EXPENSE_PARKING', 'EXPENSE_TOLL', 'EXPENSE_TRANSIT', 'EXPENSE_REPAIR', 'EXPENSE_LOADING', 'EXPENSE_OTHER', 'BONUS', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "CourierTariffVersion" (
    "id" UUID NOT NULL,
    "kind" "CourierTariffKind" NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "perOrderMinor" BIGINT NOT NULL,
    "perKmMinor" BIGINT NOT NULL,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierTariffVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteTariffSnapshot" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "tariffVersionId" UUID NOT NULL,
    "perOrderMinor" BIGINT NOT NULL,
    "perKmMinor" BIGINT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteTariffSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MkadRingVersion" (
    "id" UUID NOT NULL,
    "points" JSONB NOT NULL,
    "pointCount" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MkadRingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteOrderDistance" (
    "id" UUID NOT NULL,
    "routeOrderId" UUID NOT NULL,
    "ringVersionId" UUID NOT NULL,
    "graphSha256" TEXT,
    "meters" INTEGER NOT NULL,
    "roundedKmTenths" INTEGER NOT NULL,
    "insideMkad" BOOLEAN NOT NULL,
    "source" "BeyondMkadSource" NOT NULL,
    "actorUserId" UUID,
    "reason" TEXT,
    "activeKey" UUID,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteOrderDistance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryMoneyFact" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "courierUserId" UUID NOT NULL,
    "cashCollectable" BOOLEAN NOT NULL,
    "cashToCollectMinor" BIGINT NOT NULL,
    "paymentTypeId" UUID,
    "paymentTypeName" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryMoneyFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierLedgerEntry" (
    "id" UUID NOT NULL,
    "courierUserId" UUID NOT NULL,
    "kind" "CourierLedgerKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "operationDate" DATE NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID NOT NULL,
    "reason" TEXT,
    "comment" TEXT,
    "routeId" UUID,
    "orderId" UUID,
    "attemptId" UUID,
    "reversesEntryId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierTariffVersion_kind_effectiveFrom_idx" ON "CourierTariffVersion"("kind", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CourierTariffVersion_createdAt_idx" ON "CourierTariffVersion"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RouteTariffSnapshot_routeId_key" ON "RouteTariffSnapshot"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "MkadRingVersion_sha256_key" ON "MkadRingVersion"("sha256");

-- CreateIndex
CREATE INDEX "MkadRingVersion_createdAt_idx" ON "MkadRingVersion"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RouteOrderDistance_activeKey_key" ON "RouteOrderDistance"("activeKey");

-- CreateIndex
CREATE INDEX "RouteOrderDistance_routeOrderId_capturedAt_idx" ON "RouteOrderDistance"("routeOrderId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryMoneyFact_attemptId_key" ON "DeliveryMoneyFact"("attemptId");

-- CreateIndex
CREATE INDEX "DeliveryMoneyFact_courierUserId_capturedAt_idx" ON "DeliveryMoneyFact"("courierUserId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeliveryMoneyFact_routeId_idx" ON "DeliveryMoneyFact"("routeId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierLedgerEntry_reversesEntryId_key" ON "CourierLedgerEntry"("reversesEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierLedgerEntry_idempotencyKey_key" ON "CourierLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_courierUserId_operationDate_idx" ON "CourierLedgerEntry"("courierUserId", "operationDate");

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_routeId_idx" ON "CourierLedgerEntry"("routeId");

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_orderId_idx" ON "CourierLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "CourierLedgerEntry_occurredAt_idx" ON "CourierLedgerEntry"("occurredAt");

-- AddForeignKey
ALTER TABLE "CourierTariffVersion" ADD CONSTRAINT "CourierTariffVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteTariffSnapshot" ADD CONSTRAINT "RouteTariffSnapshot_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteTariffSnapshot" ADD CONSTRAINT "RouteTariffSnapshot_tariffVersionId_fkey" FOREIGN KEY ("tariffVersionId") REFERENCES "CourierTariffVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrderDistance" ADD CONSTRAINT "RouteOrderDistance_routeOrderId_fkey" FOREIGN KEY ("routeOrderId") REFERENCES "RouteOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrderDistance" ADD CONSTRAINT "RouteOrderDistance_ringVersionId_fkey" FOREIGN KEY ("ringVersionId") REFERENCES "MkadRingVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrderDistance" ADD CONSTRAINT "RouteOrderDistance_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryMoneyFact" ADD CONSTRAINT "DeliveryMoneyFact_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CourierLedgerEntry" ADD CONSTRAINT "CourierLedgerEntry_courierUserId_fkey" FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CourierLedgerEntry" ADD CONSTRAINT "CourierLedgerEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CourierLedgerEntry" ADD CONSTRAINT "CourierLedgerEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "CourierLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- --------------------------------------------------------------------------
-- Инварианты денег и неизменяемость
-- --------------------------------------------------------------------------

-- Деньги — целые минорные единицы, ставки неотрицательны.
ALTER TABLE "CourierTariffVersion"
  ADD CONSTRAINT "CourierTariffVersion_rates_non_negative"
  CHECK ("perOrderMinor" >= 0 AND "perKmMinor" >= 0);

-- Период тарифа не может закончиться раньше, чем начался.
ALTER TABLE "CourierTariffVersion"
  ADD CONSTRAINT "CourierTariffVersion_period_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

-- Праздничная версия обязана иметь обе границы: бессрочный праздник означал бы
-- молчаливую подмену обычного тарифа навсегда.
ALTER TABLE "CourierTariffVersion"
  ADD CONSTRAINT "CourierTariffVersion_holiday_bounded"
  CHECK ("kind" <> 'HOLIDAY' OR "effectiveTo" IS NOT NULL);

ALTER TABLE "RouteTariffSnapshot"
  ADD CONSTRAINT "RouteTariffSnapshot_rates_non_negative"
  CHECK ("perOrderMinor" >= 0 AND "perKmMinor" >= 0);

-- Расстояние за МКАД неотрицательно, а десятые доли километра согласованы
-- с метрами: две величины одного факта не имеют права разойтись.
ALTER TABLE "RouteOrderDistance"
  ADD CONSTRAINT "RouteOrderDistance_meters_non_negative"
  CHECK ("meters" >= 0 AND "roundedKmTenths" >= 0);

ALTER TABLE "RouteOrderDistance"
  ADD CONSTRAINT "RouteOrderDistance_rounding_matches"
  CHECK ("roundedKmTenths" = round("meters"::numeric / 100));

-- Точка внутри МКАД не может иметь ненулевого расстояния за МКАД.
ALTER TABLE "RouteOrderDistance"
  ADD CONSTRAINT "RouteOrderDistance_inside_is_zero"
  CHECK (NOT "insideMkad" OR "meters" = 0);

-- Ручная правка обязана назвать автора и причину, расчёт — не имеет их вовсе.
ALTER TABLE "RouteOrderDistance"
  ADD CONSTRAINT "RouteOrderDistance_manual_needs_reason"
  CHECK (
    ("source" = 'MANUAL' AND "actorUserId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) >= 3)
    OR ("source" = 'COMPUTED' AND "actorUserId" IS NULL AND "reason" IS NULL)
  );

-- Сумма к получению неотрицательна: переплата не уходит в минус.
ALTER TABLE "DeliveryMoneyFact"
  ADD CONSTRAINT "DeliveryMoneyFact_cash_non_negative"
  CHECK ("cashToCollectMinor" >= 0);

-- Наличных не бывает без признака наличной оплаты.
ALTER TABLE "DeliveryMoneyFact"
  ADD CONSTRAINT "DeliveryMoneyFact_cash_requires_flag"
  CHECK ("cashCollectable" OR "cashToCollectMinor" = 0);

-- Нулевая денежная операция не имеет смысла и только засоряет учёт.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_amount_not_zero"
  CHECK ("amountMinor" <> 0);

-- Обратная корректировка обязана назвать причину и ссылаться на исходную
-- запись; обычная запись обратной ссылки не имеет.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_reversal_shape"
  CHECK (
    ("kind" = 'ADJUSTMENT' AND "reversesEntryId" IS NOT NULL AND length(btrim(coalesce("reason", ''))) >= 3)
    OR ("kind" <> 'ADJUSTMENT' AND "reversesEntryId" IS NULL)
  );

-- Запись не может отменять сама себя.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_reversal_not_self"
  CHECK ("reversesEntryId" IS NULL OR "reversesEntryId" <> "id");

-- Знак задан видом операции: плюс увеличивает долг курьера компании.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_sign_matches_kind"
  CHECK (
    "kind" = 'ADJUSTMENT'
    OR ("kind" IN ('CASH_RECEIVED', 'CASH_ISSUED_TO_COURIER') AND "amountMinor" > 0)
    OR ("kind" NOT IN ('CASH_RECEIVED', 'CASH_ISSUED_TO_COURIER') AND "amountMinor" < 0)
  );

-- Неизменяемость финансовых записей и снимков: правка и удаление запрещены
-- на уровне базы, а не только в коде.
CREATE OR REPLACE FUNCTION prevent_ledger_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Финансовая запись неизменяема: ошибка исправляется обратной операцией с причиной'
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION prevent_ledger_change() IS
  'Учёт денег append-only: UPDATE и DELETE запрещены полностью.';

CREATE TRIGGER "CourierLedgerEntry_no_update"
  BEFORE UPDATE ON "CourierLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "CourierLedgerEntry_no_delete"
  BEFORE DELETE ON "CourierLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "CourierTariffVersion_no_update"
  BEFORE UPDATE ON "CourierTariffVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "CourierTariffVersion_no_delete"
  BEFORE DELETE ON "CourierTariffVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "RouteTariffSnapshot_no_update"
  BEFORE UPDATE ON "RouteTariffSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "RouteTariffSnapshot_no_delete"
  BEFORE DELETE ON "RouteTariffSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "DeliveryMoneyFact_no_update"
  BEFORE UPDATE ON "DeliveryMoneyFact"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "DeliveryMoneyFact_no_delete"
  BEFORE DELETE ON "DeliveryMoneyFact"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "MkadRingVersion_no_update"
  BEFORE UPDATE ON "MkadRingVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

CREATE TRIGGER "MkadRingVersion_no_delete"
  BEFORE DELETE ON "MkadRingVersion"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();

-- У расстояния разрешено снимать только признак действующей строки: сам расчёт
-- и ручная правка остаются в истории навсегда.
CREATE OR REPLACE FUNCTION prevent_route_order_distance_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."routeOrderId" IS DISTINCT FROM OLD."routeOrderId"
     OR NEW."ringVersionId" IS DISTINCT FROM OLD."ringVersionId"
     OR NEW."graphSha256" IS DISTINCT FROM OLD."graphSha256"
     OR NEW."meters" IS DISTINCT FROM OLD."meters"
     OR NEW."roundedKmTenths" IS DISTINCT FROM OLD."roundedKmTenths"
     OR NEW."insideMkad" IS DISTINCT FROM OLD."insideMkad"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."capturedAt" IS DISTINCT FROM OLD."capturedAt" THEN
    RAISE EXCEPTION
      'Расстояние за МКАД неизменяемо: правка оформляется новой строкой с причиной'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."activeKey" IS NULL AND NEW."activeKey" IS NOT NULL THEN
    RAISE EXCEPTION 'Снятую строку расстояния нельзя вернуть в действующие'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION prevent_route_order_distance_change() IS
  'Расстояние за МКАД append-only; снимать разрешено только activeKey.';

CREATE TRIGGER "RouteOrderDistance_content_immutable"
  BEFORE UPDATE ON "RouteOrderDistance"
  FOR EACH ROW EXECUTE FUNCTION prevent_route_order_distance_change();

CREATE TRIGGER "RouteOrderDistance_no_delete"
  BEFORE DELETE ON "RouteOrderDistance"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_change();
