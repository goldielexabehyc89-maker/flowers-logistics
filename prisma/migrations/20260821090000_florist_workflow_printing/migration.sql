-- Смена флориста, производственный процесс заказа и печать бланка.
--
-- Миграция РАСШИРЯЮЩАЯ: новые типы, новые таблицы и новые колонки со значениями
-- по умолчанию. Ни одна существующая колонка не удаляется, не переименовывается
-- и не меняет тип; чужие таблицы не затрагиваются. Прежняя версия приложения
-- о новых колонках не знает и продолжает работать: все они либо nullable,
-- либо имеют значение по умолчанию.
--
-- Имя зарезервировано за FLORIST. WAREHOUSE владеет `20260821091000_warehouse_flow`
-- и здесь не появляется.

CREATE TYPE "FloristShiftCloseKind" AS ENUM ('SELF', 'ADMIN_FORCED');

CREATE TYPE "OrderFulfillmentProcessState" AS ENUM (
  'NEW',
  'IN_ASSEMBLY',
  'ASSEMBLED',
  'NEEDS_REVIEW'
);

CREATE TYPE "PrintJobState" AS ENUM ('PENDING', 'PRINTED', 'ERROR');

-- СМЕНА ФЛОРИСТА.
--
-- «Не более одной активной смены на пользователя» держит база, а не проверка
-- в коде: два одновременных запроса «начать смену» прошли бы обе проверки
-- и создали две смены. `activeKey` равен идентификатору пользователя, пока
-- смена открыта, и обнуляется при закрытии; уникальный индекс по нему делает
-- вторую активную смену физически невозможной. NULL в PostgreSQL друг с другом
-- не конфликтуют, поэтому закрытых смен у пользователя может быть сколько
-- угодно. Тот же приём уже используется одноразовым кодом активации.
CREATE TABLE "FloristShift" (
  "id"          UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"    TIMESTAMP(3),
  "activeKey"   UUID,
  "closeKind"   "FloristShiftCloseKind",
  "closedById"  UUID,
  "closeReason" TEXT,

  CONSTRAINT "FloristShift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloristShift_activeKey_key" ON "FloristShift" ("activeKey");
CREATE INDEX "FloristShift_userId_startedAt_idx" ON "FloristShift" ("userId", "startedAt");
CREATE INDEX "FloristShift_closedAt_idx" ON "FloristShift" ("closedAt");

ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Ключ активности не выдумывается: он либо равен владельцу смены, либо пуст.
-- Иначе уникальный индекс перестал бы означать «одна активная смена на этого
-- пользователя» и стал бы просто уникальным случайным значением.
ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_active_key_matches_user"
  CHECK ("activeKey" IS NULL OR "activeKey" = "userId");

-- Открытая смена активна, закрытая — нет. Без этого закрытая смена могла бы
-- удерживать ключ и навсегда запретить пользователю новую смену.
ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_active_iff_open"
  CHECK (("closedAt" IS NULL) = ("activeKey" IS NOT NULL));

-- Закрытие всегда именное: кто закрыл и каким способом.
ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_closed_is_complete"
  CHECK (
    "closedAt" IS NULL
    OR ("closeKind" IS NOT NULL AND "closedById" IS NOT NULL)
  );

-- Принудительное завершение требует причины. Это решение владельца, и держать
-- его только в коде мало: причина — единственное, что объясняет флористу,
-- почему его смену закрыли за него.
ALTER TABLE "FloristShift"
  ADD CONSTRAINT "FloristShift_forced_close_has_reason"
  CHECK (
    "closeKind" IS DISTINCT FROM 'ADMIN_FORCED'
    OR ("closeReason" IS NOT NULL AND length(btrim("closeReason")) > 0)
  );

-- ПРОИЗВОДСТВЕННЫЙ ПРОЦЕСС ЗАКАЗА.
--
-- Отдельный счётчик версии, а не общий `version`: общий принадлежит
-- синхронизации и растёт при каждом внешнем изменении заказа. Опирайся захват
-- на него — обычный delta-проход отменял бы действие флориста как «устаревшую
-- версию», хотя ничего конкурирующего не происходило.
ALTER TABLE "DeliveryOrder"
  ADD COLUMN "fulfillmentProcessState"        "OrderFulfillmentProcessState" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "fulfillmentProcessVersion"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fulfillmentAssigneeId"          UUID,
  ADD COLUMN "fulfillmentAssignedAt"          TIMESTAMP(3),
  ADD COLUMN "fulfillmentShiftId"             UUID,
  ADD COLUMN "fulfillmentAssembledAt"         TIMESTAMP(3),
  ADD COLUMN "fulfillmentAssembledById"       UUID,
  ADD COLUMN "fulfillmentAssembledRevisionId" UUID;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillmentAssigneeId_fkey"
  FOREIGN KEY ("fulfillmentAssigneeId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillmentShiftId_fkey"
  FOREIGN KEY ("fulfillmentShiftId") REFERENCES "FloristShift" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillmentAssembledById_fkey"
  FOREIGN KEY ("fulfillmentAssembledById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillmentAssembledRevisionId_fkey"
  FOREIGN KEY ("fulfillmentAssembledRevisionId") REFERENCES "OrderFulfillmentRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Очередь и «Мои заказы» выбирают по производственной области и дню доставки,
-- а раздел администратора — по состоянию процесса.
CREATE INDEX "DeliveryOrder_fulfillmentProcess_idx"
  ON "DeliveryOrder" ("fulfillmentInScope", "deliveryDate", "fulfillmentProcessState");

CREATE INDEX "DeliveryOrder_fulfillmentAssignee_idx"
  ON "DeliveryOrder" ("fulfillmentAssigneeId", "fulfillmentProcessState");

-- ИНВАРИАНТ НАЗНАЧЕНИЯ.
--
-- Состояние и поля назначения — одно целое. «В сборке без исполнителя» и
-- «исполнитель у невзятого заказа» одинаково бессмысленны, но выглядят
-- правдоподобно в выборке, поэтому запрещены базой.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillment_assignment_matches_state"
  CHECK (
    CASE "fulfillmentProcessState"
      WHEN 'NEW' THEN
        "fulfillmentAssigneeId" IS NULL
        AND "fulfillmentAssignedAt" IS NULL
        AND "fulfillmentShiftId" IS NULL
      ELSE
        "fulfillmentAssigneeId" IS NOT NULL
        AND "fulfillmentAssignedAt" IS NOT NULL
    END
  );

-- ИНВАРИАНТ ЗАВЕРШЁННОЙ СБОРКИ.
--
-- Собранный заказ обязан помнить, КЕМ и ПО КАКОЙ ревизии он собран: без ссылки
-- на ревизию нельзя ни построить бланк, ни сравнить последующее изменение,
-- и «Требует проверки» стало бы недоказуемым.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillment_assembled_is_complete"
  CHECK (
    "fulfillmentProcessState" NOT IN ('ASSEMBLED', 'NEEDS_REVIEW')
    OR (
      "fulfillmentAssembledAt" IS NOT NULL
      AND "fulfillmentAssembledById" IS NOT NULL
      AND "fulfillmentAssembledRevisionId" IS NOT NULL
    )
  );

-- Незавершённая сборка следов завершения не оставляет.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillment_unassembled_is_clean"
  CHECK (
    "fulfillmentProcessState" IN ('ASSEMBLED', 'NEEDS_REVIEW')
    OR (
      "fulfillmentAssembledAt" IS NULL
      AND "fulfillmentAssembledById" IS NULL
      AND "fulfillmentAssembledRevisionId" IS NULL
    )
  );

-- НЕИЗМЕНЯЕМЫЙ СНИМОК ПЕЧАТНОГО БЛАНКА.
--
-- PDF собирается из него, а не из живого заказа: иначе повторная печать после
-- изменения заказа выдала бы под тем же номером другой бланк, и к букету
-- оказался бы приложен документ, которого никто не собирал.
CREATE TABLE "OrderPrintForm" (
  "id"              UUID NOT NULL,
  "orderId"         UUID NOT NULL,
  "revisionId"      UUID NOT NULL,
  "templateVersion" INTEGER NOT NULL,
  "snapshot"        JSONB NOT NULL,
  "snapshotHash"    TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderPrintForm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderPrintForm_orderId_createdAt_idx" ON "OrderPrintForm" ("orderId", "createdAt");

ALTER TABLE "OrderPrintForm"
  ADD CONSTRAINT "OrderPrintForm_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPrintForm"
  ADD CONSTRAINT "OrderPrintForm_revisionId_fkey"
  FOREIGN KEY ("revisionId") REFERENCES "OrderFulfillmentRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Неизменяемость держит база, а не только код: `prevent_mutation()` объявлена
-- миграцией `20260804160841_audit_immutability_guards` и уже защищает
-- логистическую ревизию, историю геоданных и производственную ревизию.
CREATE TRIGGER order_print_form_no_update
  BEFORE UPDATE ON "OrderPrintForm"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER order_print_form_no_delete
  BEFORE DELETE ON "OrderPrintForm"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- ЗАДАНИЕ ПЕЧАТИ.
--
-- Повторная печать создаёт НОВОЕ задание по тому же снимку, а не переписывает
-- прежнее: история попыток и есть доказательство того, что бланк печатали.
-- Уникальность пары «заказ + номер попытки» не даёт двум одновременным
-- повторам занять один номер.
CREATE TABLE "OrderPrintJob" (
  "id"            UUID NOT NULL,
  "orderId"       UUID NOT NULL,
  "printFormId"   UUID NOT NULL,
  "state"         "PrintJobState" NOT NULL DEFAULT 'PENDING',
  "attempt"       INTEGER NOT NULL,
  "completedAt"   TIMESTAMP(3),
  "completedById" UUID,
  "lastErrorCode" TEXT,
  "lastErrorAt"   TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrderPrintJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPrintJob_orderId_attempt_key" ON "OrderPrintJob" ("orderId", "attempt");
CREATE INDEX "OrderPrintJob_state_createdAt_idx" ON "OrderPrintJob" ("state", "createdAt");
CREATE INDEX "OrderPrintJob_orderId_createdAt_idx" ON "OrderPrintJob" ("orderId", "createdAt");

ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_printFormId_fkey"
  FOREIGN KEY ("printFormId") REFERENCES "OrderPrintForm" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_attempt_positive" CHECK ("attempt" >= 1);

-- «Напечатано» всегда именное: кто подтвердил и когда. В MVP физической службы
-- печати нет, и подтверждает человек — тем важнее, чтобы отметка не была
-- анонимной.
ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_printed_is_complete"
  CHECK (
    "state" <> 'PRINTED'
    OR ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL)
  );

-- Ошибка обязана быть названа безопасным кодом: пустая ошибка неотличима
-- от отсутствия ошибки.
ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_error_is_named"
  CHECK (
    "state" <> 'ERROR'
    OR ("lastErrorCode" IS NOT NULL AND "lastErrorAt" IS NOT NULL)
  );

-- Попутно снимается расхождение имени индекса, оставшееся от миграции
-- `20260820090000`: PostgreSQL обрезает идентификатор по 63 байтам, и в базе
-- имя получилось короче ожидаемого Prisma. Данные это не затрагивает, но
-- расхождение схемы и базы лучше не переносить дальше.
ALTER INDEX "DeliveryOrder_fulfillmentInScope_fulfillmentCompositionState_id"
  RENAME TO "DeliveryOrder_fulfillmentInScope_fulfillmentCompositionStat_idx";
