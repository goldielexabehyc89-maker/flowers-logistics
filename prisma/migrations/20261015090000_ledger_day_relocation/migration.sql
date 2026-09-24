-- Перенос дня учёта: связанная пара обратных записей одной категории.
--
-- Отмена заказа в МоемСкладе снимает системные начисления В ИСХОДНЫХ ДНЯХ их
-- учёта (решение владельца, 24.09.2026): день доставки показывает по заказу
-- нули, день обработки отмены отдельного минуса не получает.
--
-- Начисление к этому моменту может быть уже погашено сторно ДРУГОГО дня:
-- километры пересчитали назавтра. Тогда пара «начисление — сторно» разнесена
-- по двум дням: день доставки несёт плюс, день правки — минус. Второе сторно
-- у одной записи запрещено уникальностью "reversesEntryId", а несвязанная
-- корректировка попала бы в отчёте в «прочие корректировки» и потеряла
-- километры.
--
-- Поэтому учёт такого начисления ПЕРЕНОСИТСЯ в день его сторно связанной
-- парой: запись OUT в дне начисления (сумма противоположна), запись IN в дне
-- сторно (сумма равна начислению). Сумма пары — ноль, общий баланс не меняется;
-- категория и километры читаются из переносимой записи. Старые записи не
-- переписываются, сторно остаётся единственным.
CREATE TYPE "LedgerRelocationSide" AS ENUM ('OUT', 'IN');

ALTER TABLE "CourierLedgerEntry"
  ADD COLUMN "relocatesEntryId" UUID,
  ADD COLUMN "relocationSide" "LedgerRelocationSide";

-- У переносимой записи не больше одной пары: сторона не повторяется.
CREATE UNIQUE INDEX "CourierLedgerEntry_relocatesEntryId_relocationSide_key"
  ON "CourierLedgerEntry"("relocatesEntryId", "relocationSide");

ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_relocatesEntryId_fkey"
  FOREIGN KEY ("relocatesEntryId") REFERENCES "CourierLedgerEntry"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Перенос — всегда обратная запись без ссылки сторно; ссылка и сторона идут вместе.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_relocation_shape" CHECK (
    ("relocatesEntryId" IS NULL AND "relocationSide" IS NULL)
    OR (
      "relocatesEntryId" IS NOT NULL
      AND "relocationSide" IS NOT NULL
      AND "kind" = 'ADJUSTMENT'
      AND "reversesEntryId" IS NULL
    )
  );

-- Запись не может переносить сама себя.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_relocation_not_self"
  CHECK ("relocatesEntryId" IS NULL OR "relocatesEntryId" <> "id");

-- Форма обратной записи: прежнее правило требовало у каждой ссылку на сторно.
-- Теперь обратная запись ссылается РОВНО на одно — на отменяемую запись
-- (сторно) или на переносимую (перенос дня учёта); причина обязательна как и
-- раньше. У обычной записи ни той, ни другой ссылки нет.
ALTER TABLE "CourierLedgerEntry"
  DROP CONSTRAINT "CourierLedgerEntry_reversal_shape";

ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_reversal_shape"
  CHECK (
    (
      "kind" = 'ADJUSTMENT'
      AND (("reversesEntryId" IS NOT NULL) <> ("relocatesEntryId" IS NOT NULL))
      AND length(btrim(coalesce("reason", ''))) >= 3
    )
    OR ("kind" <> 'ADJUSTMENT' AND "reversesEntryId" IS NULL AND "relocatesEntryId" IS NULL)
  );
