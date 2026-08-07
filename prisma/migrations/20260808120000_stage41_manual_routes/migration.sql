-- Этап 4.1: ручные маршруты-черновики, участие заказов с историей и конфликты.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Главное решение схемы: внутреннее состояние заказа НЕ хранится отдельной колонкой.
-- Единственный источник истины — активное участие в маршруте (RouteOrder с пустым
-- removedAt) и состояние самого маршрута. Отдельное поле было бы вторым источником
-- истины, который база согласовать не может: она физически не должна допускать
-- «активное участие есть, а заказ считается нераспределённым».

-- CreateEnum
CREATE TYPE "RouteState" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RouteOrderRemovalReason" AS ENUM ('RETURNED_TO_UNASSIGNED', 'MOVED_TO_ANOTHER_ROUTE');

-- CreateEnum
CREATE TYPE "RouteOrderConflictKind" AS ENUM ('DELIVERY_DATE_CHANGED', 'SCOPE_LOST', 'SOURCE_MISSING', 'SOURCE_ARCHIVED');

-- CreateTable
CREATE TABLE "DeliveryRoute" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "state" "RouteState" NOT NULL DEFAULT 'DRAFT',
    "vehicleType" "VehicleType" NOT NULL,
    "courierUserId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteOrder" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "addedById" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedById" UUID,
    "removedAt" TIMESTAMP(3),
    "removalReason" "RouteOrderRemovalReason",
    "movedToRouteId" UUID,

    CONSTRAINT "RouteOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteOrderConflict" (
    "id" UUID NOT NULL,
    "routeOrderId" UUID NOT NULL,
    "kind" "RouteOrderConflictKind" NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteOrderConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteNumberCounter" (
    "deliveryDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteNumberCounter_pkey" PRIMARY KEY ("deliveryDate")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryRoute_number_key" ON "DeliveryRoute"("number");

-- CreateIndex
CREATE INDEX "DeliveryRoute_deliveryDate_state_idx" ON "DeliveryRoute"("deliveryDate", "state");

-- CreateIndex
CREATE INDEX "DeliveryRoute_courierUserId_idx" ON "DeliveryRoute"("courierUserId");

-- CreateIndex
CREATE INDEX "RouteOrder_routeId_position_idx" ON "RouteOrder"("routeId", "position");

-- CreateIndex
CREATE INDEX "RouteOrder_orderId_idx" ON "RouteOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RouteOrderConflict_routeOrderId_kind_key" ON "RouteOrderConflict"("routeOrderId", "kind");

-- CreateIndex
CREATE INDEX "RouteOrderConflict_routeOrderId_idx" ON "RouteOrderConflict"("routeOrderId");

-- AddForeignKey
ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_courierUserId_fkey" FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrder" ADD CONSTRAINT "RouteOrder_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrder" ADD CONSTRAINT "RouteOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrder" ADD CONSTRAINT "RouteOrder_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrder" ADD CONSTRAINT "RouteOrder_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrder" ADD CONSTRAINT "RouteOrder_movedToRouteId_fkey" FOREIGN KEY ("movedToRouteId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteOrderConflict" ADD CONSTRAINT "RouteOrderConflict_routeOrderId_fkey" FOREIGN KEY ("routeOrderId") REFERENCES "RouteOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Инварианты уровня базы
-- ---------------------------------------------------------------------------

-- Главный инвариант распределения: заказ не может одновременно состоять более чем
-- в одном активном составе. Индекс глобальный, поэтому он же запрещает и повторное
-- вхождение заказа в один и тот же маршрут — отдельное ограничение было бы дублем.
CREATE UNIQUE INDEX "RouteOrder_active_order_unique"
  ON "RouteOrder"("orderId")
  WHERE "removedAt" IS NULL;

-- Позиции активных участий внутри маршрута уникальны: иначе порядок доставки
-- был бы неоднозначным, а он превращается в реальный порядок объезда.
CREATE UNIQUE INDEX "RouteOrder_active_position_unique"
  ON "RouteOrder"("routeId", "position")
  WHERE "removedAt" IS NULL;

-- Позиция начинается с единицы. Верхняя граница не задаётся: перестановка порядка
-- временно сдвигает позиции на большое смещение, потому что частичный уникальный
-- индекс проверяется построчно и «поменять местами» одним запросом невозможно.
ALTER TABLE "RouteOrder"
  ADD CONSTRAINT "RouteOrder_position_positive" CHECK ("position" >= 1);

-- Удаление фиксируется целиком: половинчатое состояние выглядело бы как активное
-- участие без автора и времени либо как удалённое без причины.
ALTER TABLE "RouteOrder"
  ADD CONSTRAINT "RouteOrder_removal_complete" CHECK (
    ("removedAt" IS NULL AND "removedById" IS NULL AND "removalReason" IS NULL)
    OR ("removedAt" IS NOT NULL AND "removedById" IS NOT NULL AND "removalReason" IS NOT NULL)
  );

-- Целевой маршрут обязателен ровно при перемещении и запрещён при возврате.
ALTER TABLE "RouteOrder"
  ADD CONSTRAINT "RouteOrder_moved_target_consistent" CHECK (
    ("removalReason" = 'MOVED_TO_ANOTHER_ROUTE' AND "movedToRouteId" IS NOT NULL)
    OR ("removalReason" IS DISTINCT FROM 'MOVED_TO_ANOTHER_ROUTE' AND "movedToRouteId" IS NULL)
  );

-- Перемещение «в самого себя» — не перемещение, а потерянная история.
ALTER TABLE "RouteOrder"
  ADD CONSTRAINT "RouteOrder_moved_target_differs" CHECK (
    "movedToRouteId" IS NULL OR "movedToRouteId" <> "routeId"
  );

-- Версия оптимистической блокировки не может уйти в минус ни у маршрута, ни у заказа.
ALTER TABLE "DeliveryRoute"
  ADD CONSTRAINT "DeliveryRoute_version_non_negative" CHECK ("version" >= 0);

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_version_non_negative" CHECK ("version" >= 0);

ALTER TABLE "RouteNumberCounter"
  ADD CONSTRAINT "RouteNumberCounter_last_number_non_negative" CHECK ("lastNumber" >= 0);

-- ---------------------------------------------------------------------------
-- Триггеры
--
-- Функция prevent_mutation() создана миграцией 20260804160841_audit_immutability_guards
-- и переиспользуется здесь. Триггеры не отражаются в schema.prisma и дрейфа не вызывают.
-- ---------------------------------------------------------------------------

-- Маршрут, участие, конфликт и счётчик физически не удаляются.
CREATE TRIGGER delivery_route_no_delete
  BEFORE DELETE ON "DeliveryRoute"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_order_no_delete
  BEFORE DELETE ON "RouteOrder"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_order_conflict_no_delete
  BEFORE DELETE ON "RouteOrderConflict"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_order_conflict_no_update
  BEFORE UPDATE ON "RouteOrderConflict"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_number_counter_no_delete
  BEFORE DELETE ON "RouteNumberCounter"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Дата маршрута неизменна. Правка даты у существующего маршрута незаметно нарушила бы
-- правило «в одном маршруте только заказы одной даты»: состав остался бы прежним,
-- а дата стала другой. Неверный день исправляется другим черновиком.
CREATE OR REPLACE FUNCTION prevent_route_delivery_date_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."deliveryDate" IS DISTINCT FROM OLD."deliveryDate" THEN
    RAISE EXCEPTION
      'Дата маршрута неизменна: перенос выполняется созданием другого черновика'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_route_delivery_date_immutable
  BEFORE UPDATE ON "DeliveryRoute"
  FOR EACH ROW EXECUTE FUNCTION prevent_route_delivery_date_change();

-- История участия защищена от переписывания.
--
-- Запрета DELETE недостаточно: строку можно было бы «переиспользовать» — сменить
-- маршрут или заказ, оживить удалённое участие или задним числом изменить причину
-- и автора удаления. Тогда история распределения перестала бы быть доказательством.
CREATE OR REPLACE FUNCTION prevent_route_order_history_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."routeId" IS DISTINCT FROM OLD."routeId"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."addedById" IS DISTINCT FROM OLD."addedById"
     OR NEW."addedAt" IS DISTINCT FROM OLD."addedAt" THEN
    RAISE EXCEPTION
      'Участие заказа в маршруте неизменяемо в части маршрута, заказа и автора добавления'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."removedAt" IS NOT NULL THEN
    IF NEW."removedAt" IS NULL THEN
      RAISE EXCEPTION
        'Удалённое участие не возвращается в активное: повторное добавление создаёт новую запись'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."removedAt" IS DISTINCT FROM OLD."removedAt"
       OR NEW."removedById" IS DISTINCT FROM OLD."removedById"
       OR NEW."removalReason" IS DISTINCT FROM OLD."removalReason"
       OR NEW."movedToRouteId" IS DISTINCT FROM OLD."movedToRouteId"
       OR NEW."position" IS DISTINCT FROM OLD."position" THEN
      RAISE EXCEPTION
        'Зафиксированное удаление участия не изменяется'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER route_order_history_guard
  BEFORE UPDATE ON "RouteOrder"
  FOR EACH ROW EXECUTE FUNCTION prevent_route_order_history_rewrite();
