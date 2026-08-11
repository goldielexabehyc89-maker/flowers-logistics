-- Этап 6.1: внутренняя готовность заказа к отгрузке.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Миграция РАСШИРЯЮЩАЯ. Ни одна существующая колонка не переименована, не сужена
-- и не стала обязательной. Все ранее импортированные заказы получают значение
-- по умолчанию `NOT_READY` без следа человека — и это верно: их готовность
-- никто ещё не подтверждал.
--
-- Границы решения владельца `WH-001`: готовность — внутреннее состояние нашего
-- приложения. Она не выводится из внешнего статуса МоегоСклада, наружу не пишется,
-- на маршруты, `Depot` и планирование не влияет. Товарного учёта здесь нет.

-- CreateEnum
CREATE TYPE "OrderShipmentReadiness" AS ENUM ('NOT_READY', 'READY');

-- AlterTable
ALTER TABLE "DeliveryOrder" ADD COLUMN     "shipmentReadiness" "OrderShipmentReadiness" NOT NULL DEFAULT 'NOT_READY',
ADD COLUMN     "shipmentReadinessSetAt" TIMESTAMP(3),
ADD COLUMN     "shipmentReadinessSetById" UUID;

-- CreateIndex
CREATE INDEX "DeliveryOrder_inScope_deliveryDate_shipmentReadiness_idx" ON "DeliveryOrder"("inScope", "deliveryDate", "shipmentReadiness");

-- AddForeignKey
--
-- ON DELETE RESTRICT: пользователь не удаляется каскадом. Удаление пользователя
-- в системе запрещено вовсе (триггер `user_no_delete`), но внешний ключ обязан
-- защищать сам себя: правило, которое держится только соседним триггером,
-- исчезает вместе с ним.
ALTER TABLE "DeliveryOrder" ADD CONSTRAINT "DeliveryOrder_shipmentReadinessSetById_fkey" FOREIGN KEY ("shipmentReadinessSetById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Автор и время последнего изменения существуют ТОЛЬКО ВМЕСТЕ.
--
-- Половинчатое значение выглядело бы как достоверный след: «известно когда,
-- неизвестно кем» или наоборот. Такая запись не доказывает ничего, а выглядит
-- доказательством.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_shipment_readiness_actor" CHECK (
    ("shipmentReadinessSetAt" IS NULL AND "shipmentReadinessSetById" IS NULL)
    OR ("shipmentReadinessSetAt" IS NOT NULL AND "shipmentReadinessSetById" IS NOT NULL)
  );

-- `READY` невозможно получить без следа человека.
--
-- Готовность меняет только человек (решение `WH-001`). Правило, оставленное
-- на дисциплину кода, обходится одним `UPDATE` из консоли, и заказ оказался бы
-- готовым к отгрузке без единого следа о том, кто это решил. Обратное
-- направление не ограничивается: `NOT_READY` — состояние по умолчанию,
-- и новый заказ обязан существовать без автора и времени.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_shipment_readiness_manual" CHECK (
    "shipmentReadiness" = 'NOT_READY' OR "shipmentReadinessSetAt" IS NOT NULL
  );
