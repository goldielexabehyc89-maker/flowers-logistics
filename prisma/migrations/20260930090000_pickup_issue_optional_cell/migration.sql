-- Выдача самовывоза без ячейки.
--
-- Расширяющая миграция: два столбца становятся необязательными, ничего не
-- переписывается и не удаляется. Прежние строки (с ячейкой) остаются как есть;
-- новая выдача без ячейки пишет NULL. Уникальный индекс по placementId не
-- меняется: PostgreSQL не считает несколько NULL за совпадение, поэтому выдач
-- без размещения может быть много.
ALTER TABLE "OrderPickupIssue" ALTER COLUMN "placementId" DROP NOT NULL;
ALTER TABLE "OrderPickupIssue" ALTER COLUMN "cellId" DROP NOT NULL;
