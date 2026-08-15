-- Адрес склада выбирается из подсказок, а координаты приходят вместе с ним.
--
-- Расширяющая миграция: прежние значения не переписываются и не удаляются.
-- Ни одному складу координаты не назначаются догадкой.

-- 1. Точка становится необязательной: «не определена» — настоящее состояние.
ALTER TABLE "Depot" ALTER COLUMN "latMicro" DROP NOT NULL;
ALTER TABLE "Depot" ALTER COLUMN "lonMicro" DROP NOT NULL;

-- 2. Подтверждение точки источником. Прежние склады заполнялись руками,
--    и подтверждения у них нет — это факт, а не предположение.
ALTER TABLE "Depot" ADD COLUMN "pointConfirmedAt" TIMESTAMP(3);

COMMENT ON COLUMN "Depot"."pointConfirmedAt" IS
  'Когда точка подтверждена выбором подсказки адреса. NULL — адрес вводили руками.';

-- 3. Склад по умолчанию обязан иметь подтверждённую точку.
--
--    Прежний склад по умолчанию подтверждения не имеет, поэтому сначала
--    снимается признак умолчания: расчёт на его координаты и так не работал,
--    а состояние «основной, но без пригодной точки» не должно существовать.
--    Сам склад остаётся со своим адресом и координатами — человек выберет
--    адрес из подсказок заново и вернёт склад в работу.
UPDATE "Depot"
SET "defaultKey" = NULL
WHERE "defaultKey" IS NOT NULL AND "pointConfirmedAt" IS NULL;

ALTER TABLE "Depot" ADD CONSTRAINT "Depot_default_has_point" CHECK (
  "defaultKey" IS NULL
  OR ("latMicro" IS NOT NULL AND "lonMicro" IS NOT NULL AND "pointConfirmedAt" IS NOT NULL)
);
