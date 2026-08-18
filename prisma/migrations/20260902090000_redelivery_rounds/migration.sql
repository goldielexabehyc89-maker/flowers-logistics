-- Повторная доставка без второго заказа.
--
-- Заказ МоегоСклада остаётся один: тот же внутренний идентификатор, тот же
-- внешний UUID, тот же номер и вся прежняя история. Различать попытки сборки
-- нужно всё равно — иначе прежняя печать и прежний букет в ячейке молча
-- сделали бы новую сборку «уже готовой». Для этого у заказа появляется КРУГ
-- сборки, и его же несут размещение и печатная форма.
ALTER TABLE "DeliveryOrder" ADD COLUMN "assemblyRound" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OrderPlacement" ADD COLUMN "assemblyRound" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OrderPrintForm" ADD COLUMN "assemblyRound" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_assembly_round_positive" CHECK ("assemblyRound" >= 1);
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_assembly_round_positive" CHECK ("assemblyRound" >= 1);
ALTER TABLE "OrderPrintForm"
  ADD CONSTRAINT "OrderPrintForm_assembly_round_positive" CHECK ("assemblyRound" >= 1);

-- Карточка возврата получает собственный отображаемый номер.
--
-- Дублировать заказ ради подтверждения возврата нельзя: он утащил бы за собой
-- связь с МоимСкладом. Возврат — отдельная внутренняя сущность со своим
-- номером «номер-otm», а при повторном возврате того же заказа — «-otm-2».
ALTER TABLE "OrderReturn" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "OrderReturn" ADD COLUMN "displayNumber" TEXT;

-- Прежним строкам номер проставляется здесь же: колонка обязана стать
-- обязательной, а строки без номера нечитаемы для курьера. Это не backfill
-- бизнес-данных, а достройка только что добавленной колонки.
UPDATE "OrderReturn" AS r
SET "displayNumber" = o."externalName" || '-otm'
FROM "DeliveryOrder" AS o
WHERE o."id" = r."orderId" AND r."displayNumber" IS NULL;

ALTER TABLE "OrderReturn" ALTER COLUMN "displayNumber" SET NOT NULL;
ALTER TABLE "OrderReturn"
  ADD CONSTRAINT "OrderReturn_sequence_positive" CHECK ("sequence" >= 1);

CREATE UNIQUE INDEX "OrderReturn_orderId_sequence_key" ON "OrderReturn" ("orderId", "sequence");
CREATE UNIQUE INDEX "OrderReturn_displayNumber_key" ON "OrderReturn" ("displayNumber");

-- Одно активное участие в маршруте на заказ.
--
-- Правило было договорённостью кода, а становится инвариантом базы: два
-- активных участия означают, что один и тот же букет обещан двум курьерам.
CREATE UNIQUE INDEX "RouteOrder_one_active_per_order"
  ON "RouteOrder" ("orderId") WHERE "removedAt" IS NULL;

-- Причина изъятия размещения — из списка, а не свободным текстом.
--
-- Свободный комментарий не отвечает на единственный важный вопрос: букет
-- поехал на пересборку или списан. По тексту это потом не сосчитать.
CREATE TYPE "PlacementWithdrawReason" AS ENUM ('REASSEMBLY', 'WRITE_OFF');

ALTER TABLE "OrderPlacement" ADD COLUMN "withdrawReason" "PlacementWithdrawReason";

ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_withdraw_reason_matches_release" CHECK (
    "withdrawReason" IS NULL OR "releaseReason" = 'WITHDRAWN'
  );

-- Два варианта повторной доставки различаются решением, а не догадкой.
ALTER TYPE "OrderResolutionDecision" ADD VALUE 'REDELIVER_SAME_BOUQUET';
ALTER TYPE "OrderResolutionDecision" ADD VALUE 'REDELIVER_REASSEMBLE';
