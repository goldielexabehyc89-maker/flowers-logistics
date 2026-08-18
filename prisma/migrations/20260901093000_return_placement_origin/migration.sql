-- Возврат от курьера — такое же первичное появление товара в ячейке, как приёмка.
--
-- Ограничение писалось, когда источников было ровно два: «приняли» и
-- «переместили». Возврат недоставленного букета не приходит ни из какой
-- ячейки — он приходит из машины курьера, поэтому `fromCellId` у него пуст,
-- как у приёмки. Отдельной миграцией, потому что значение перечисления
-- добавлено предыдущей: PostgreSQL не разрешает пользоваться новым значением
-- в той же транзакции, где оно объявлено.
ALTER TABLE "OrderPlacement" DROP CONSTRAINT "OrderPlacement_source_origin";

ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_source_origin" CHECK (
    ("source" IN ('RECEIVED', 'COURIER_RETURN') AND "fromCellId" IS NULL)
    OR ("source" = 'MOVED' AND "fromCellId" IS NOT NULL)
  );
