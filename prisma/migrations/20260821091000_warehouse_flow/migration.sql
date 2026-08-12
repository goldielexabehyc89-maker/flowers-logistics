-- Этап 6.5: фактическое движение заказов по складу.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Миграция РАСШИРЯЮЩАЯ. Существующие таблицы не изменены, кроме двух
-- ограничений жизненного цикла маршрута, которые ДОПОЛНЕНЫ новым переходом:
-- ни одна прежде допустимая запись не становится недопустимой.
--
-- Границы: складское движение не зависит ни от одного состояния FLORIST.
-- Вход — физический QR: однозначный заказ и активная ячейка.

-- Новое состояние маршрута: физическая передача курьеру и есть начало маршрута.
--
-- Значение добавляется В КОНЕЦ перечисления: PostgreSQL хранит порядок
-- объявления, и вставка в середину сдвинула бы существующие значения.
-- `COMPLETED` здесь НЕ добавляется — он появится вместе с работой курьера.
ALTER TYPE "RouteState" ADD VALUE IF NOT EXISTS 'ACTIVE';

-- CreateEnum
CREATE TYPE "PlacementReleaseReason" AS ENUM (
  'MOVED_TO_ROUTE_CELL', 'MOVED_TO_STORAGE', 'ISSUED_TO_COURIER', 'WITHDRAWN'
);
CREATE TYPE "PlacementSource" AS ENUM ('RECEIVED', 'MOVED');
CREATE TYPE "IssueSessionState" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- Составной ключ ячейки: он нужен внешнему ключу привязки маршрута,
-- который обязан гарантировать тип ROUTE средствами базы.
CREATE UNIQUE INDEX "StorageCell_id_kind_key" ON "StorageCell"("id", "kind");

-- CreateTable
CREATE TABLE "RouteIssueSession" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "courierUserId" UUID NOT NULL,
    "state" "IssueSessionState" NOT NULL DEFAULT 'OPEN',
    "openKey" UUID,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" UUID NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RouteIssueSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderPlacement" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "cellId" UUID NOT NULL,
    "fromCellId" UUID,
    "source" "PlacementSource" NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedById" UUID NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,
    "releaseReason" "PlacementReleaseReason",
    "movedToCellId" UUID,
    "issueSessionId" UUID,
    "requiresRelocation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrderPlacement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RouteCellBinding" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "cellId" UUID NOT NULL,
    "cellKind" "StorageCellKind" NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boundById" UUID NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedById" UUID,

    CONSTRAINT "RouteCellBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RouteIssueSession_openKey_key" ON "RouteIssueSession"("openKey");
CREATE INDEX "RouteIssueSession_routeId_state_idx" ON "RouteIssueSession"("routeId", "state");
CREATE INDEX "OrderPlacement_orderId_placedAt_idx" ON "OrderPlacement"("orderId", "placedAt");
CREATE INDEX "OrderPlacement_cellId_idx" ON "OrderPlacement"("cellId");
CREATE INDEX "OrderPlacement_issueSessionId_idx" ON "OrderPlacement"("issueSessionId");
CREATE INDEX "RouteCellBinding_routeId_idx" ON "RouteCellBinding"("routeId");
CREATE INDEX "RouteCellBinding_cellId_idx" ON "RouteCellBinding"("cellId");

-- AddForeignKey
ALTER TABLE "RouteIssueSession" ADD CONSTRAINT "RouteIssueSession_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueSession" ADD CONSTRAINT "RouteIssueSession_courierUserId_fkey" FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueSession" ADD CONSTRAINT "RouteIssueSession_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueSession" ADD CONSTRAINT "RouteIssueSession_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "StorageCell"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_fromCellId_fkey" FOREIGN KEY ("fromCellId") REFERENCES "StorageCell"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_movedToCellId_fkey" FOREIGN KEY ("movedToCellId") REFERENCES "StorageCell"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_placedById_fkey" FOREIGN KEY ("placedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "OrderPlacement" ADD CONSTRAINT "OrderPlacement_issueSessionId_fkey" FOREIGN KEY ("issueSessionId") REFERENCES "RouteIssueSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RouteCellBinding" ADD CONSTRAINT "RouteCellBinding_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteCellBinding" ADD CONSTRAINT "RouteCellBinding_boundById_fkey" FOREIGN KEY ("boundById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteCellBinding" ADD CONSTRAINT "RouteCellBinding_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Составной внешний ключ: маршрутной ячейкой может быть ТОЛЬКО ячейка типа ROUTE.
--
-- Обычный внешний ключ этого выразить не умеет, а проверка в коде обходится
-- одним запросом. Тип продублирован колонкой и закреплён CHECK, поэтому
-- «ячейка хранения назначена маршрутным листом» физически невозможна.
ALTER TABLE "RouteCellBinding"
  ADD CONSTRAINT "RouteCellBinding_cell_fkey"
  FOREIGN KEY ("cellId", "cellKind") REFERENCES "StorageCell"("id", "kind")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RouteCellBinding"
  ADD CONSTRAINT "RouteCellBinding_kind_is_route" CHECK ("cellKind" = 'ROUTE');

-- У заказа не более ОДНОГО текущего местоположения.
--
-- Это же и защита от двух одновременных сканирований: второй кладовщик получает
-- отказ базы, а не «последний выиграл». Проверка «сначала посмотреть, потом
-- вставить» такую гонку не ловит — параллельные транзакции не видят
-- незафиксированных вставок друг друга.
CREATE UNIQUE INDEX "OrderPlacement_active_order_unique"
  ON "OrderPlacement"("orderId") WHERE "releasedAt" IS NULL;

-- Одна активная маршрутная ячейка на маршрут и один маршрут на ячейку.
CREATE UNIQUE INDEX "RouteCellBinding_active_route_unique"
  ON "RouteCellBinding"("routeId") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "RouteCellBinding_active_cell_unique"
  ON "RouteCellBinding"("cellId") WHERE "releasedAt" IS NULL;

-- Полнота освобождения: три поля заполняются вместе.
--
-- Половинчатое значение выглядело бы как достоверный след: «известно когда,
-- неизвестно кем и почему». Такая запись не доказывает ничего.
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_release_complete" CHECK (
    ("releasedAt" IS NULL AND "releasedById" IS NULL AND "releaseReason" IS NULL)
    OR ("releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releaseReason" IS NOT NULL)
  );

-- Целевая ячейка обязательна ровно при перемещении и запрещена в остальных случаях.
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_move_target" CHECK (
    (
      "releaseReason" IN ('MOVED_TO_ROUTE_CELL', 'MOVED_TO_STORAGE')
      AND "movedToCellId" IS NOT NULL
    )
    OR (
      ("releaseReason" IS NULL OR "releaseReason" IN ('ISSUED_TO_COURIER', 'WITHDRAWN'))
      AND "movedToCellId" IS NULL
    )
  );

-- Сессия выдачи обязательна ровно при выдаче курьеру.
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_issue_session" CHECK (
    ("releaseReason" = 'ISSUED_TO_COURIER' AND "issueSessionId" IS NOT NULL)
    OR ("releaseReason" IS DISTINCT FROM 'ISSUED_TO_COURIER' AND "issueSessionId" IS NULL)
  );

-- Источник и происхождение согласованы: первая приёмка приходит ниоткуда,
-- перемещение обязано назвать прежнюю ячейку.
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_source_origin" CHECK (
    ("source" = 'RECEIVED' AND "fromCellId" IS NULL)
    OR ("source" = 'MOVED' AND "fromCellId" IS NOT NULL)
  );

-- Заказ не может быть перемещён «сам в себя»: это скрыло бы отсутствие движения.
ALTER TABLE "OrderPlacement"
  ADD CONSTRAINT "OrderPlacement_distinct_cells" CHECK (
    "fromCellId" IS NULL OR "fromCellId" <> "cellId"
  );

-- История движений неизменяема.
--
-- Разрешено ровно одно изменение уже существующей строки: закрыть активное
-- размещение и пометить его требующим перемещения. Всё остальное — включая
-- молчаливую подмену `cellId` — запрещено: перемещение обязано быть видимым
-- действием с автором и временем, а не правкой строки.
CREATE OR REPLACE FUNCTION order_placement_history_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Закрытое размещение изменять нельзя: создайте новое';
  END IF;

  IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."cellId" IS DISTINCT FROM OLD."cellId"
     OR NEW."fromCellId" IS DISTINCT FROM OLD."fromCellId"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."placedAt" IS DISTINCT FROM OLD."placedAt"
     OR NEW."placedById" IS DISTINCT FROM OLD."placedById" THEN
    RAISE EXCEPTION 'Размещение переписывать нельзя: перемещение оформляется новой записью';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_placement_history_guard
  BEFORE UPDATE ON "OrderPlacement"
  FOR EACH ROW EXECUTE FUNCTION order_placement_history_guard();

CREATE OR REPLACE FUNCTION order_placement_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'История перемещений не удаляется';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_placement_no_delete
  BEFORE DELETE ON "OrderPlacement"
  FOR EACH ROW EXECUTE FUNCTION order_placement_no_delete();

CREATE TRIGGER route_cell_binding_no_delete
  BEFORE DELETE ON "RouteCellBinding"
  FOR EACH ROW EXECUTE FUNCTION order_placement_no_delete();

-- Отмена сессии выдачи обязана называть причину; завершение — нет.
ALTER TABLE "RouteIssueSession"
  ADD CONSTRAINT "RouteIssueSession_cancel_complete" CHECK (
    ("state" <> 'CANCELLED' AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
    OR (
      "state" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL
      AND "cancelReason" IS NOT NULL AND char_length("cancelReason") BETWEEN 3 AND 500
    )
  );

-- Открытая сессия удерживает ключ маршрута; завершённая и отменённая — нет.
ALTER TABLE "RouteIssueSession"
  ADD CONSTRAINT "RouteIssueSession_open_key" CHECK (
    ("state" = 'OPEN' AND "openKey" = "routeId")
    OR ("state" <> 'OPEN' AND "openKey" IS NULL)
  );

ALTER TABLE "RouteIssueSession"
  ADD CONSTRAINT "RouteIssueSession_completed_at" CHECK (
    ("state" = 'COMPLETED' AND "completedAt" IS NOT NULL)
    OR ("state" <> 'COMPLETED' AND "completedAt" IS NULL)
  );

-- Жизненный цикл маршрута ДОПОЛНЯЕТСЯ переходом в `ACTIVE`.
--
-- Сравнение ведётся через приведение к тексту: `ALTER TYPE ... ADD VALUE`
-- и использование нового значения перечисления в одной транзакции PostgreSQL
-- запрещает, а миграции выполняются транзакцией.
--
-- Ни один прежде допустимый переход не удалён: ограничение только расширено.
ALTER TABLE "RouteStateTransition" DROP CONSTRAINT "RouteStateTransition_allowed";
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_allowed" CHECK (
    ("fromState"::text = 'DRAFT' AND "toState"::text = 'CONFIRMED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'DRAFT')
    OR ("fromState"::text = 'DRAFT' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'ACTIVE')
  );

-- Причина по-прежнему обязательна там, где решение нужно объяснить.
-- Перевод в `ACTIVE` объяснять нечем: он наступает от факта выдачи последнего
-- заказа, а не от решения человека.
ALTER TABLE "RouteStateTransition" DROP CONSTRAINT "RouteStateTransition_reason_required";
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_reason_required" CHECK (
    ("toState"::text IN ('CONFIRMED', 'ACTIVE') AND "reason" IS NULL)
    OR (
      "toState"::text NOT IN ('CONFIRMED', 'ACTIVE')
      AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 3 AND 500
    )
  );
