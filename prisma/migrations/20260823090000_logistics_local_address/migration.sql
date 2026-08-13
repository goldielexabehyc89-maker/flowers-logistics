-- Локальный адрес логиста, конфликт с источником и неизменяемая история.
--
-- Миграция расширяющая и forward-only. Существующие строки не переписываются:
-- у всех заказов локальный адрес пуст, конфликта нет, история пуста — то есть
-- эффективным адресом остаётся прежний исходный, и поведение до переключения
-- приложения не меняется ни на один заказ.
--
-- Прежний код читает и пишет заказы как раньше: все новые колонки необязательны
-- либо имеют значение по умолчанию, а новое значение перечисления добавлено
-- В КОНЕЦ.

-- 1. Новое значение причины «Требует внимания». Только в конец: порядок
--    объявления — это то, чем PostgreSQL сравнивает значения, и вставка
--    в середину сдвинула бы уже записанные строки.
ALTER TYPE "OrderAttentionReason" ADD VALUE IF NOT EXISTS 'ADDRESS_CONFLICT';

-- 2. Действия над адресом.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderAddressAction') THEN
    CREATE TYPE "OrderAddressAction" AS ENUM (
      'LOCAL_ADDRESS_SET',
      'LOCAL_ADDRESS_CLEARED',
      'SOURCE_CONFLICT_DETECTED',
      'CONFLICT_RESOLVED_KEEP_LOCAL',
      'CONFLICT_RESOLVED_USE_SOURCE'
    );
  END IF;
END
$$;

-- 3. Колонки заказа.
ALTER TABLE "DeliveryOrder"
  ADD COLUMN IF NOT EXISTS "localAddress"              TEXT,
  ADD COLUMN IF NOT EXISTS "localAddressSetAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "localAddressSetById"       UUID,
  ADD COLUMN IF NOT EXISTS "sourceAddressAtLocalEdit"  TEXT,
  ADD COLUMN IF NOT EXISTS "addressConflict"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "addressConflictDetectedAt" TIMESTAMP(3);

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_localAddressSetById_fkey"
  FOREIGN KEY ("localAddressSetById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX IF NOT EXISTS "DeliveryOrder_localAddressSetById_idx"
  ON "DeliveryOrder"("localAddressSetById");

-- Частичный индекс под рабочий список: конфликтных заказов мало, и искать их
-- полным проходом по 1000+ строкам незачем.
CREATE INDEX IF NOT EXISTS "DeliveryOrder_addressConflict_idx"
  ON "DeliveryOrder"("deliveryDate") WHERE "addressConflict";

-- 4. Полнота локальной правки.
--
-- «Адрес есть, автора нет» и «автор есть, адреса нет» — состояния, которых
-- не должно существовать: по ним невозможно ни объяснить правку, ни отменить её.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_local_address_complete" CHECK (
    ("localAddress" IS NULL
      AND "localAddressSetAt" IS NULL
      AND "localAddressSetById" IS NULL
      AND "sourceAddressAtLocalEdit" IS NULL)
    OR
    ("localAddress" IS NOT NULL
      AND "localAddressSetAt" IS NOT NULL
      AND "localAddressSetById" IS NOT NULL)
  );

-- Пустая строка выглядела бы как заданный адрес и попала бы в геокодирование.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_local_address_not_blank" CHECK (
    "localAddress" IS NULL OR length(btrim("localAddress")) > 0
  );

-- 5. Полнота конфликта.
--
-- Конфликт без времени обнаружения не объясним, а конфликт без локальной правки
-- невозможен по определению: расходиться не с чем.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_address_conflict_complete" CHECK (
    ("addressConflict" = false AND "addressConflictDetectedAt" IS NULL)
    OR
    ("addressConflict" = true
      AND "addressConflictDetectedAt" IS NOT NULL
      AND "localAddress" IS NOT NULL)
  );

-- 6. Неизменяемая история.
CREATE TABLE IF NOT EXISTS "OrderAddressHistory" (
  "id"            UUID NOT NULL,
  "orderId"       UUID NOT NULL,
  "action"        "OrderAddressAction" NOT NULL,
  "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "oldAddress"    TEXT,
  "newAddress"    TEXT,
  "sourceAddress" TEXT,
  "actorUserId"   UUID,

  CONSTRAINT "OrderAddressHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OrderAddressHistory"
  ADD CONSTRAINT "OrderAddressHistory_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderAddressHistory"
  ADD CONSTRAINT "OrderAddressHistory_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX IF NOT EXISTS "OrderAddressHistory_orderId_occurredAt_idx"
  ON "OrderAddressHistory"("orderId", "occurredAt");

-- Запись без единого адреса ничего не доказывает: у любого действия есть либо
-- прежнее, либо новое значение, а у обнаружения конфликта — исходное.
ALTER TABLE "OrderAddressHistory"
  ADD CONSTRAINT "OrderAddressHistory_has_value" CHECK (
    "oldAddress" IS NOT NULL OR "newAddress" IS NOT NULL OR "sourceAddress" IS NOT NULL
  );

ALTER TABLE "OrderAddressHistory"
  ADD CONSTRAINT "OrderAddressHistory_values_not_blank" CHECK (
    ("oldAddress" IS NULL OR length(btrim("oldAddress")) > 0)
    AND ("newAddress" IS NULL OR length(btrim("newAddress")) > 0)
    AND ("sourceAddress" IS NULL OR length(btrim("sourceAddress")) > 0)
  );

-- Ручное действие человека обязано иметь автора; системное обнаружение
-- конфликта его не имеет — конфликт находит синхронизация, а не пользователь.
ALTER TABLE "OrderAddressHistory"
  ADD CONSTRAINT "OrderAddressHistory_actor_matches_action" CHECK (
    ("action" = 'SOURCE_CONFLICT_DETECTED' AND "actorUserId" IS NULL)
    OR ("action" <> 'SOURCE_CONFLICT_DETECTED' AND "actorUserId" IS NOT NULL)
  );

-- 7. История неизменяема. Функция prevent_mutation() существует с этапа 1.
CREATE TRIGGER "OrderAddressHistory_no_update"
  BEFORE UPDATE ON "OrderAddressHistory"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER "OrderAddressHistory_no_delete"
  BEFORE DELETE ON "OrderAddressHistory"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

COMMENT ON TABLE "OrderAddressHistory" IS
  'Неизменяемая история локального адреса заказа: значения, действие, автор и время. Персональные данные сюда попадают намеренно и наружу выдаются только ADMIN и LOGISTICIAN.';
