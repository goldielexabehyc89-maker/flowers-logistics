-- Самовывоз: выдача заказа покупателю (этап 6.7).
--
-- Срез добавляет ровно одно новое событие складского домена — «Выдан
-- покупателю» — и ничего не меняет в уже работающих доставке, комплектовании
-- и выдаче курьеру. Маршрут, маршрутная ячейка и сессия выдачи самовывозу
-- не нужны: заказ лежит в обычной ячейке хранения и уходит из неё к человеку,
-- который пришёл сам (`FUL-003` п.8).
--
-- Границы: ни одного поля производственного контура FLORIST здесь нет.
-- Признак «самовывоз» живёт в уже существующем `deliveryMethodId` заказа
-- и опознаётся точным UUID значения справочника, а не названием.

-- Новая причина освобождения. Значение добавляется В КОНЕЦ перечисления:
-- PostgreSQL хранит порядок объявления, и вставка в середину сдвинула бы уже
-- записанные значения.
ALTER TYPE "PlacementReleaseReason" ADD VALUE IF NOT EXISTS 'ISSUED_TO_CUSTOMER';

-- Неизменяемый факт выдачи покупателю.
CREATE TABLE "OrderPickupIssue" (
  "id"          UUID NOT NULL,
  "orderId"     UUID NOT NULL,
  "placementId" UUID NOT NULL,
  "cellId"      UUID NOT NULL,
  "issuedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedById"  UUID NOT NULL,

  CONSTRAINT "OrderPickupIssue_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OrderPickupIssue"
  ADD CONSTRAINT "OrderPickupIssue_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPickupIssue"
  ADD CONSTRAINT "OrderPickupIssue_placementId_fkey" FOREIGN KEY ("placementId")
  REFERENCES "OrderPlacement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPickupIssue"
  ADD CONSTRAINT "OrderPickupIssue_cellId_fkey" FOREIGN KEY ("cellId")
  REFERENCES "StorageCell"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPickupIssue"
  ADD CONSTRAINT "OrderPickupIssue_issuedById_fkey" FOREIGN KEY ("issuedById")
  REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Один заказ выдаётся ОДИН раз, и одно размещение закрывается одной выдачей.
--
-- Это и есть защита от двойного клика и повтора потерянного ответа: второй
-- запрос проигрывает уникальному индексу базы, а не проверке «сначала
-- посмотреть, потом вставить» — параллельные транзакции не видят
-- незафиксированных вставок друг друга.
CREATE UNIQUE INDEX "OrderPickupIssue_orderId_key" ON "OrderPickupIssue"("orderId");
CREATE UNIQUE INDEX "OrderPickupIssue_placementId_key" ON "OrderPickupIssue"("placementId");
CREATE INDEX "OrderPickupIssue_issuedAt_idx" ON "OrderPickupIssue"("issuedAt");

-- Факт выдачи не редактируется и не удаляется.
--
-- Спор «когда именно отдали коробку» решается этой строкой, поэтому правка
-- задним числом запрещена базой, а не дисциплиной вызовов.
CREATE OR REPLACE FUNCTION order_pickup_issue_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Факт выдачи покупателю неизменяем';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_pickup_issue_no_update
  BEFORE UPDATE ON "OrderPickupIssue"
  FOR EACH ROW EXECUTE FUNCTION order_pickup_issue_immutable();

CREATE TRIGGER order_pickup_issue_no_delete
  BEFORE DELETE ON "OrderPickupIssue"
  FOR EACH ROW EXECUTE FUNCTION order_pickup_issue_immutable();

-- Целевая ячейка запрещена и при выдаче покупателю: заказ уходит со склада
-- к человеку, а не переезжает на другую полку.
--
-- Сравнение через `::text` обязательно: значение перечисления, добавленное
-- в этой же транзакции, PostgreSQL использовать в выражении ещё не разрешает.
ALTER TABLE "OrderPlacement" DROP CONSTRAINT "OrderPlacement_move_target";
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_move_target" CHECK (
    (
      "releaseReason"::text IN ('MOVED_TO_ROUTE_CELL', 'MOVED_TO_STORAGE')
      AND "movedToCellId" IS NOT NULL
    )
    OR (
      (
        "releaseReason" IS NULL
        OR "releaseReason"::text IN ('ISSUED_TO_COURIER', 'WITHDRAWN', 'ISSUED_TO_CUSTOMER')
      )
      AND "movedToCellId" IS NULL
    )
  );
