-- Разделение ставки «За заказ» на пешую и автомобильную.
--
-- Forward-only, без пересчёта начислений. Обе новые ставки заполняются старым
-- единым значением: пока администратор не задаст разные, любой маршрут
-- получает ту же ставку, что и раньше, и уже подтверждённые снимки не меняются.

-- 1. CourierTariffVersion: две ставки «За заказ» вместо одной.
ALTER TABLE "CourierTariffVersion"
  ADD COLUMN "perOrderWalkMinor" BIGINT,
  ADD COLUMN "perOrderCarMinor" BIGINT;

UPDATE "CourierTariffVersion"
  SET "perOrderWalkMinor" = "perOrderMinor",
      "perOrderCarMinor" = "perOrderMinor";

ALTER TABLE "CourierTariffVersion"
  ALTER COLUMN "perOrderWalkMinor" SET NOT NULL,
  ALTER COLUMN "perOrderCarMinor" SET NOT NULL;

-- Старую ставку и её долю в CHECK убираем, вводим CHECK на обе новые.
ALTER TABLE "CourierTariffVersion"
  DROP CONSTRAINT "CourierTariffVersion_rates_non_negative";

ALTER TABLE "CourierTariffVersion"
  DROP COLUMN "perOrderMinor";

ALTER TABLE "CourierTariffVersion"
  ADD CONSTRAINT "CourierTariffVersion_rates_non_negative"
  CHECK ("perOrderWalkMinor" >= 0 AND "perOrderCarMinor" >= 0 AND "perKmMinor" >= 0);

-- 2. RouteTariffSnapshot: фиксируем тип транспорта. Замороженные ставки снимков
--    не трогаем — vehicleType это чистая справка из связанного маршрута.
ALTER TABLE "RouteTariffSnapshot"
  ADD COLUMN "vehicleType" "VehicleType";

UPDATE "RouteTariffSnapshot" s
  SET "vehicleType" = r."vehicleType"
  FROM "DeliveryRoute" r
  WHERE r."id" = s."routeId";

ALTER TABLE "RouteTariffSnapshot"
  ALTER COLUMN "vehicleType" SET NOT NULL;
