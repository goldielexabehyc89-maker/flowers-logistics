-- Этап 5.4: склады, планирование маршрутов и автоматические черновики.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Миграция РАСШИРЯЮЩАЯ. Ни одна существующая колонка не переименована, не сужена
-- и не стала обязательной: `startDepotId` и `endDepotId` у ручных маршрутов
-- добавляются пустыми. Миграция не может создать склад — его создаёт человек,
-- — а ручная маршрутизация обязана работать всё время до этого момента.
-- Обязательность складов требуется только там, где она осмысленна: у маршрута,
-- созданного планированием (CHECK "DeliveryRoute_plan_depots").

-- CreateEnum
CREATE TYPE "RoutePlanRunState" AS ENUM (
  'QUEUED', 'COMPUTING', 'PREVIEW', 'APPLIED', 'FAILED', 'EXPIRED'
);

-- CreateTable
CREATE TABLE "Depot" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "latMicro" INTEGER NOT NULL,
    "lonMicro" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Depot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePlanRun" (
    "id" UUID NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "state" "RoutePlanRunState" NOT NULL DEFAULT 'QUEUED',
    "activeDateKey" DATE,
    "requestedById" UUID NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoutePlanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePlanVehicleSlot" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "courierUserId" UUID,
    "vehicleType" "VehicleType" NOT NULL,
    "capacityOrders" INTEGER NOT NULL,
    "shiftStartMinute" INTEGER NOT NULL,
    "shiftEndMinute" INTEGER NOT NULL,
    "startDepotId" UUID NOT NULL,
    "endDepotId" UUID NOT NULL,

    CONSTRAINT "RoutePlanVehicleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePlanInputSnapshot" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePlanInputSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutePlanResultSnapshot" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "graphSha256" TEXT NOT NULL,
    "matrixKeys" JSONB NOT NULL,
    "solverVersion" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutePlanResultSnapshot_pkey" PRIMARY KEY ("id")
);

-- AlterTable: только добавление необязательных колонок.
ALTER TABLE "DeliveryRoute" ADD COLUMN "startDepotId" UUID;
ALTER TABLE "DeliveryRoute" ADD COLUMN "endDepotId" UUID;
ALTER TABLE "DeliveryRoute" ADD COLUMN "planRunId" UUID;
ALTER TABLE "DeliveryRoute" ADD COLUMN "planVehicleSlotId" UUID;

-- CreateIndex
-- Не более одного склада по умолчанию: NULL в PostgreSQL уникальности не нарушают.
CREATE UNIQUE INDEX "Depot_defaultKey_key" ON "Depot"("defaultKey");
CREATE INDEX "Depot_isActive_idx" ON "Depot"("isActive");

-- Не более одного НЕЗАВЕРШЁННОГО запуска на день. Два одновременных расчёта
-- одного дня становятся физически невозможны, а не «маловероятны»: ключ
-- удерживается, пока запуск в QUEUED, COMPUTING или PREVIEW.
CREATE UNIQUE INDEX "RoutePlanRun_activeDateKey_key" ON "RoutePlanRun"("activeDateKey");
CREATE INDEX "RoutePlanRun_deliveryDate_state_idx" ON "RoutePlanRun"("deliveryDate", "state");
CREATE INDEX "RoutePlanRun_state_lockedUntil_idx" ON "RoutePlanRun"("state", "lockedUntil");

-- Один курьер — не больше одного слота в запуске. Слоты без курьера
-- не конфликтуют между собой: их ключ равен NULL.
CREATE UNIQUE INDEX "RoutePlanVehicleSlot_runId_courierUserId_key"
  ON "RoutePlanVehicleSlot"("runId", "courierUserId");
CREATE UNIQUE INDEX "RoutePlanVehicleSlot_runId_slotIndex_key"
  ON "RoutePlanVehicleSlot"("runId", "slotIndex");

CREATE UNIQUE INDEX "RoutePlanInputSnapshot_runId_key" ON "RoutePlanInputSnapshot"("runId");
CREATE UNIQUE INDEX "RoutePlanResultSnapshot_runId_key" ON "RoutePlanResultSnapshot"("runId");

-- Один слот не может породить два маршрута. Без этого повторное применение
-- одного запуска создало бы вторую копию плана.
CREATE UNIQUE INDEX "DeliveryRoute_planVehicleSlotId_key"
  ON "DeliveryRoute"("planVehicleSlotId");
CREATE INDEX "DeliveryRoute_planRunId_idx" ON "DeliveryRoute"("planRunId");

-- AddForeignKey
ALTER TABLE "Depot" ADD CONSTRAINT "Depot_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutePlanRun" ADD CONSTRAINT "RoutePlanRun_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RoutePlanRun" ADD CONSTRAINT "RoutePlanRun_appliedById_fkey"
  FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutePlanVehicleSlot" ADD CONSTRAINT "RoutePlanVehicleSlot_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RoutePlanRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RoutePlanVehicleSlot" ADD CONSTRAINT "RoutePlanVehicleSlot_courierUserId_fkey"
  FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RoutePlanVehicleSlot" ADD CONSTRAINT "RoutePlanVehicleSlot_startDepotId_fkey"
  FOREIGN KEY ("startDepotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RoutePlanVehicleSlot" ADD CONSTRAINT "RoutePlanVehicleSlot_endDepotId_fkey"
  FOREIGN KEY ("endDepotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutePlanInputSnapshot" ADD CONSTRAINT "RoutePlanInputSnapshot_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RoutePlanRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RoutePlanResultSnapshot" ADD CONSTRAINT "RoutePlanResultSnapshot_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "RoutePlanRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_startDepotId_fkey"
  FOREIGN KEY ("startDepotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_endDepotId_fkey"
  FOREIGN KEY ("endDepotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_planRunId_fkey"
  FOREIGN KEY ("planRunId") REFERENCES "RoutePlanRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryRoute" ADD CONSTRAINT "DeliveryRoute_planVehicleSlotId_fkey"
  FOREIGN KEY ("planVehicleSlotId") REFERENCES "RoutePlanVehicleSlot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Инварианты склада
--
-- Держатся базой, а не только кодом: смена склада по умолчанию — операция,
-- которую однажды выполнят скриптом, из консоли или будущим модулем.
-- ---------------------------------------------------------------------------

-- Единственное осмысленное значение признака. Произвольная строка означала бы,
-- что «складов по умолчанию» может быть столько, сколько выдумано значений.
ALTER TABLE "Depot"
  ADD CONSTRAINT "Depot_default_key_shape" CHECK (
    "defaultKey" IS NULL OR "defaultKey" = 'default'
  );

-- Склад по умолчанию обязан быть активен. Состояние «выключен, но по умолчанию»
-- физически невозможно: планирование иначе молча опиралось бы на выведенную
-- из работы точку отсчёта.
ALTER TABLE "Depot"
  ADD CONSTRAINT "Depot_default_active" CHECK (
    "defaultKey" IS NULL OR "isActive"
  );

ALTER TABLE "Depot"
  ADD CONSTRAINT "Depot_latitude_range" CHECK ("latMicro" BETWEEN -90000000 AND 90000000);
ALTER TABLE "Depot"
  ADD CONSTRAINT "Depot_longitude_range" CHECK ("lonMicro" BETWEEN -180000000 AND 180000000);

ALTER TABLE "Depot"
  ADD CONSTRAINT "Depot_shape" CHECK (
    "version" >= 1
    AND char_length("name") BETWEEN 1 AND 200
    AND char_length("address") BETWEEN 1 AND 500
  );

-- ---------------------------------------------------------------------------
-- Инварианты запуска планирования
-- ---------------------------------------------------------------------------

-- Ключ активности либо равен дате запуска, либо отсутствует: любое другое
-- значение позволило бы обойти запрет двух одновременных расчётов одного дня.
ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_active_key_value" CHECK (
    "activeDateKey" IS NULL OR "activeDateKey" = "deliveryDate"
  );

-- Ключ удерживается РОВНО в незавершённых состояниях. Иначе завершённый запуск
-- либо навсегда блокировал бы день, либо незавершённый перестал бы его защищать.
ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_active_key_states" CHECK (
    ("state" IN ('QUEUED', 'COMPUTING', 'PREVIEW')) = ("activeDateKey" IS NOT NULL)
  );

ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_lease_complete" CHECK (
    ("lockedUntil" IS NULL) = ("lockedBy" IS NULL)
  );

-- Расчёт без аренды невозможен: некому было бы его продолжить и не с чем
-- сравнить владельца при записи результата.
ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_computing_has_lease" CHECK (
    "state" <> 'COMPUTING' OR "lockedUntil" IS NOT NULL
  );

-- Применение всегда имеет автора и время, а неудача — безопасный код причины.
ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_applied_complete" CHECK (
    ("state" = 'APPLIED') = ("appliedAt" IS NOT NULL)
    AND ("appliedAt" IS NULL) = ("appliedById" IS NULL)
  );

ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_failed_has_code" CHECK (
    "state" <> 'FAILED' OR "failureCode" IS NOT NULL
  );

-- Восстановлений после падения процесса не больше трёх. Ограничение базы, а не
-- только кода: бесконечно перезапускаемый расчёт занимал бы день навсегда.
ALTER TABLE "RoutePlanRun"
  ADD CONSTRAINT "RoutePlanRun_shape" CHECK (
    "version" >= 1 AND "recoveryAttempts" BETWEEN 0 AND 3
  );

-- Слот: вместимость в заказах и осмысленная смена внутри суток.
ALTER TABLE "RoutePlanVehicleSlot"
  ADD CONSTRAINT "RoutePlanVehicleSlot_shape" CHECK (
    "slotIndex" >= 1
    AND "capacityOrders" >= 1
    AND "shiftStartMinute" >= 0
    AND "shiftEndMinute" <= 1440
    AND "shiftEndMinute" > "shiftStartMinute"
  );

-- Автоматический маршрут обязан иметь оба склада: без точки отсчёта план
-- невоспроизводим. Ручной маршрут ограничением не затронут.
ALTER TABLE "DeliveryRoute"
  ADD CONSTRAINT "DeliveryRoute_plan_depots" CHECK (
    "planRunId" IS NULL
    OR ("startDepotId" IS NOT NULL AND "endDepotId" IS NOT NULL)
  );

-- Происхождение маршрута полно или отсутствует целиком: маршрут, знающий запуск
-- и не знающий слот, нельзя было бы сопоставить с планом.
ALTER TABLE "DeliveryRoute"
  ADD CONSTRAINT "DeliveryRoute_plan_origin" CHECK (
    ("planRunId" IS NULL) = ("planVehicleSlotId" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Триггеры
--
-- Функция prevent_mutation() создана миграцией 20260804160841_audit_immutability_guards.
-- ---------------------------------------------------------------------------

-- Склады не удаляются никогда: на них ссылаются маршруты и снимки планирования.
CREATE TRIGGER depot_no_delete
  BEFORE DELETE ON "Depot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_plan_run_no_delete
  BEFORE DELETE ON "RoutePlanRun"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Слоты неизменяемы после постановки запуска: перехват брошенной аренды обязан
-- продолжить расчёт с теми же условиями, с которыми запуск был поставлен.
CREATE TRIGGER route_plan_vehicle_slot_no_update
  BEFORE UPDATE ON "RoutePlanVehicleSlot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_plan_vehicle_slot_no_delete
  BEFORE DELETE ON "RoutePlanVehicleSlot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Снимок входа неизменяем: он и есть определение того, что именно считалось.
CREATE TRIGGER route_plan_input_snapshot_no_update
  BEFORE UPDATE ON "RoutePlanInputSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_plan_input_snapshot_no_delete
  BEFORE DELETE ON "RoutePlanInputSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Снимок результата неизменяем: переписанный план перестал бы объяснять,
-- почему курьер поехал именно так.
CREATE TRIGGER route_plan_result_snapshot_no_update
  BEFORE UPDATE ON "RoutePlanResultSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_plan_result_snapshot_no_delete
  BEFORE DELETE ON "RoutePlanResultSnapshot"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
