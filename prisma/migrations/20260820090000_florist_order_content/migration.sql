-- Производственный состав заказа: позиции, компоненты комплектов и неизменяемая
-- история производственного снимка.
--
-- Миграция РАСШИРЯЮЩАЯ. Существующие колонки не удаляются, не переименовываются
-- и не меняют тип; существующие перечисления не пересоздаются; прежние миграции
-- не тронуты. Все новые колонки `DeliveryOrder` либо nullable, либо имеют
-- значение по умолчанию, поэтому:
--
--   * версия приложения `0971c291…`, ничего не знающая об этих колонках,
--     продолжает вставлять и обновлять заказы;
--   * откат приложения на прежнюю версию не портит уже сохранённый состав
--     и не требует новых полей для старой записи заказа.

CREATE TYPE "FulfillmentCompositionState" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TYPE "FulfillmentAssortmentKind" AS ENUM (
  'PRODUCT',
  'SERVICE',
  'BUNDLE',
  'VARIANT',
  'OTHER'
);

CREATE TYPE "OrderFulfillmentRevisionReason" AS ENUM ('INITIAL_IMPORT', 'EXTERNAL_UPDATE');

-- ПРОИЗВОДСТВЕННЫЕ ПОЛЯ ЗАКАЗА.
--
-- `fulfillmentDescription` — стандартный `customerorder.description`, третий
-- независимый источник текста. Логистический `comment` («Комментарий по
-- доставке») не трогается и не подменяется: у них разное содержимое.
--
-- `fulfillmentCompositionState` по умолчанию `PENDING` для ВСЕХ строк, включая
-- существующие. Это не «потеря» состава, а честное «ещё не читали»: состава
-- в базе до этой миграции не было вовсе. Дозагрузку выполняет проход
-- синхронизации независимо от того, менялся ли заказ в МоемСкладе.
ALTER TABLE "DeliveryOrder"
  ADD COLUMN "fulfillmentDescription"         TEXT,
  ADD COLUMN "fulfillmentCardText"            TEXT,
  ADD COLUMN "fulfillmentSnapshotHash"        TEXT,
  ADD COLUMN "fulfillmentCompositionState"    "FulfillmentCompositionState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "fulfillmentCompositionSyncedAt" TIMESTAMP(3),
  ADD COLUMN "fulfillmentCompositionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fulfillmentCompositionFailedAt" TIMESTAMP(3),
  ADD COLUMN "fulfillmentCompositionFailure"  TEXT;

-- Очередь дозагрузки: производственные заказы, состав которых ещё не подтверждён.
CREATE INDEX "DeliveryOrder_fulfillmentInScope_fulfillmentCompositionState_idx"
  ON "DeliveryOrder" ("fulfillmentInScope", "fulfillmentCompositionState");

-- ИНВАРИАНТ СОСТОЯНИЯ СОСТАВА.
--
-- `READY` обязано означать «есть подтверждённый снимок», иначе пустая проекция
-- при `READY` неотличима от подтверждённо пустого заказа. Хеш и время
-- подтверждения существуют ровно в этом состоянии.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_fulfillment_ready_has_snapshot"
  CHECK (
    "fulfillmentCompositionState" <> 'READY'
    OR ("fulfillmentSnapshotHash" IS NOT NULL AND "fulfillmentCompositionSyncedAt" IS NOT NULL)
  );

-- ТЕКУЩАЯ ПРОЕКЦИЯ СОСТАВА.
--
-- Проекция изменяема: новый состав заменяет строки целиком. Запретительных
-- триггеров на удаление здесь нет НАМЕРЕННО — они сделали бы замену состава
-- невозможной. Историю хранит `OrderFulfillmentRevision`, защищённая от UPDATE
-- и DELETE, а сам заказ удалить нельзя (`delivery_order_no_delete` из
-- миграции этапа 3). Поэтому исчезновение строки проекции не уничтожает снимок.
CREATE TABLE "DeliveryOrderPosition" (
  "id"                  UUID NOT NULL,
  "orderId"             UUID NOT NULL,
  -- Уникален В ПРЕДЕЛАХ ЗАКАЗА: глобальной уникальности исследование
  -- не доказывало, объявлять её нельзя.
  "externalPositionId"  UUID NOT NULL,
  -- Воспроизводимый порядок показа и печати. Без него порядок строк определяла
  -- бы база, и состав перетасовывался бы между открытиями карточки.
  "ordinal"             INTEGER NOT NULL,
  "assortmentId"        UUID,
  "assortmentKind"      "FulfillmentAssortmentKind" NOT NULL,
  "assortmentKindRaw"   TEXT,
  "name"                TEXT,
  -- Дробное количество в букете — обычное дело; `float` теряет его молча.
  "quantity"            DECIMAL(20, 6) NOT NULL,
  -- Всегда пусто до подтверждения живого контракта характеристики.
  "characteristicLabel" TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DeliveryOrderPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryOrderPosition_orderId_externalPositionId_key"
  ON "DeliveryOrderPosition" ("orderId", "externalPositionId");

CREATE INDEX "DeliveryOrderPosition_orderId_ordinal_idx"
  ON "DeliveryOrderPosition" ("orderId", "ordinal");

ALTER TABLE "DeliveryOrderPosition"
  ADD CONSTRAINT "DeliveryOrderPosition_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "DeliveryOrderPosition"
  ADD CONSTRAINT "DeliveryOrderPosition_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "DeliveryOrderPosition"
  ADD CONSTRAINT "DeliveryOrderPosition_ordinal_non_negative" CHECK ("ordinal" >= 0);

-- КОМПОНЕНТЫ КОМПЛЕКТА.
--
-- Компоненты принадлежат каталожному бандлу, а не заказу, поэтому их
-- идентичность считается в пределах позиции заказа: один и тот же бандл в двух
-- заказах даёт одинаковые внешние UUID компонентов.
--
-- `ON DELETE CASCADE` здесь уместен именно потому, что это проекция: замена
-- состава удаляет позиции, и осиротевшие компоненты не должны переживать их.
CREATE TABLE "DeliveryOrderPositionComponent" (
  "id"                  UUID NOT NULL,
  "positionId"          UUID NOT NULL,
  "externalComponentId" UUID NOT NULL,
  "ordinal"             INTEGER NOT NULL,
  "assortmentId"        UUID,
  "assortmentKind"      "FulfillmentAssortmentKind" NOT NULL,
  "assortmentKindRaw"   TEXT,
  "name"                TEXT,
  "quantity"            DECIMAL(20, 6) NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeliveryOrderPositionComponent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryOrderPositionComponent_positionId_externalComponent_key"
  ON "DeliveryOrderPositionComponent" ("positionId", "externalComponentId");

CREATE INDEX "DeliveryOrderPositionComponent_positionId_ordinal_idx"
  ON "DeliveryOrderPositionComponent" ("positionId", "ordinal");

ALTER TABLE "DeliveryOrderPositionComponent"
  ADD CONSTRAINT "DeliveryOrderPositionComponent_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "DeliveryOrderPosition" ("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "DeliveryOrderPositionComponent"
  ADD CONSTRAINT "DeliveryOrderPositionComponent_quantity_non_negative" CHECK ("quantity" >= 0);

ALTER TABLE "DeliveryOrderPositionComponent"
  ADD CONSTRAINT "DeliveryOrderPositionComponent_ordinal_non_negative" CHECK ("ordinal" >= 0);

-- НЕИЗМЕНЯЕМАЯ ИСТОРИЯ ПРОИЗВОДСТВЕННОГО СНИМКА.
CREATE TABLE "OrderFulfillmentRevision" (
  "id"              UUID NOT NULL,
  "orderId"         UUID NOT NULL,
  -- Источник и контекст. В хеш снимка НЕ входит: `updated` меняется и от чужих
  -- логистических полей, и участие в хеше давало бы ложные ревизии.
  "externalUpdated" TIMESTAMP(3) NOT NULL,
  "receivedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot"        JSONB NOT NULL,
  "snapshotHash"    TEXT NOT NULL,
  "changedFields"   TEXT[] NOT NULL,
  "reason"          "OrderFulfillmentRevisionReason" NOT NULL,

  CONSTRAINT "OrderFulfillmentRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderFulfillmentRevision_orderId_receivedAt_idx"
  ON "OrderFulfillmentRevision" ("orderId", "receivedAt");

CREATE INDEX "OrderFulfillmentRevision_orderId_snapshotHash_idx"
  ON "OrderFulfillmentRevision" ("orderId", "snapshotHash");

ALTER TABLE "OrderFulfillmentRevision"
  ADD CONSTRAINT "OrderFulfillmentRevision_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Неизменяемость держит база, а не только код: `prevent_mutation()` объявлена
-- миграцией `20260804160841_audit_immutability_guards` и уже используется
-- логистической ревизией и историей геоданных.
CREATE TRIGGER order_fulfillment_revision_no_update
  BEFORE UPDATE ON "OrderFulfillmentRevision"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER order_fulfillment_revision_no_delete
  BEFORE DELETE ON "OrderFulfillmentRevision"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
