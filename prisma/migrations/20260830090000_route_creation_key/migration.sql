-- Ключ создания маршрута: повтор одного запроса не создаёт второй черновик.
--
-- Расширяющая forward-only миграция. Колонка необязательная: у всех прежних
-- маршрутов она пуста, и NULL в PostgreSQL уникальности не мешает — каждый
-- существующий черновик остаётся как есть. Пустых черновиков за день может
-- быть сколько угодно: одинаковыми их делает только один и тот же ключ, то
-- есть один и тот же запрос, отправленный дважды.

-- AlterTable
ALTER TABLE "DeliveryRoute" ADD COLUMN     "creationKey" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRoute_creationKey_key" ON "DeliveryRoute"("creationKey");
