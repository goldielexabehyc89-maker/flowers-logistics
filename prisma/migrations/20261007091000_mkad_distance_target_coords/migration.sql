-- Координаты заказа, для которых считалось расстояние за МКАД.
-- Нужны автоматическому расчёту: отличают «снимок для текущих координат уже
-- есть» (no-op) от «координаты изменились» (новая версия). Прежние и ручные
-- строки остаются с NULL — их автоматика не перетирает.
-- AlterTable
ALTER TABLE "RouteOrderDistance" ADD COLUMN     "targetLatMicro" INTEGER,
ADD COLUMN     "targetLonMicro" INTEGER;
