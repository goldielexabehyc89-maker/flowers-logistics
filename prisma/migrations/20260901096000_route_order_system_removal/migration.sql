-- Безымянное закрытие участия разрешено ровно для одной причины.
--
-- Все остальные виды вывода из маршрута остаются именными: их выполняет
-- логист, и «кто убрал заказ» — обязательная часть истории. Отдельной
-- миграцией, потому что значение перечисления объявлено предыдущей:
-- PostgreSQL не разрешает пользоваться им в той же транзакции.
ALTER TABLE "RouteOrder" DROP CONSTRAINT "RouteOrder_removal_complete";

ALTER TABLE "RouteOrder"
  ADD CONSTRAINT "RouteOrder_removal_complete" CHECK (
    ("removedAt" IS NULL AND "removedById" IS NULL AND "removalReason" IS NULL)
    -- `IS NOT NULL` здесь обязательно, а не для красоты: сравнение с NULL
    -- даёт NULL, а CHECK считает NULL выполненным условием. Без явной
    -- проверки половинчатое удаление (одна дата без причины и автора)
    -- молча проходило бы.
    OR (
      "removedAt" IS NOT NULL
      AND "removalReason" IS NOT NULL
      AND "removalReason" = 'SOURCE_CANCELLATION_WITHDRAWN'
      AND "removedById" IS NULL
    )
    OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL AND "removalReason" IS NOT NULL)
  );
