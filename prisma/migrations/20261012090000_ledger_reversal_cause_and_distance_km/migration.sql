-- Причина отмены и километры начисления — структурными полями.
--
-- ПРИЧИНА ОТМЕНЫ. Снятие финансового результата отменённого заказа внешне
-- неотличимо от обычной правки: и там, и там все начисления попытки погашены.
-- Пока повод приходилось угадывать по состоянию журнала, правка километров
-- НОВОЙ доставки блокировалась отменой, случившейся когда-то раньше по тому же
-- заказу: логист исправлял 12,5 → 0 → 20 км и получал 0 ₽ вместо 800 ₽.
--
-- КИЛОМЕТРЫ НАЧИСЛЕНИЯ. Строка отчёта восстанавливала их делением суммы на
-- ставку. Сумма уже округлена: при ставке 40,01 ₽/км 12,5 км дают 500,12 ₽, а
-- обратная формула возвращает 12,4 км — и отчёт показывал «расчёт уточнён»
-- там, где никто ничего не менял.
--
-- Прежним записям остаётся NULL: причина отмены у них неизвестна, а километры
-- отчёт для таких строк берёт из действующего снимка, как и раньше.
CREATE TYPE "LedgerReversalCause" AS ENUM (
  'ORDER_CANCELLED',
  'RESULT_CANCELLED',
  'DISTANCE_RESTATED',
  'MANUAL'
);

ALTER TABLE "CourierLedgerEntry"
  ADD COLUMN "reversalCause" "LedgerReversalCause",
  ADD COLUMN "distanceKmTenths" INTEGER;

-- Причина бывает только у обратной записи, километры — только у оплаты за МКАД.
ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_reversal_cause_shape" CHECK (
    "reversalCause" IS NULL OR "reversesEntryId" IS NOT NULL
  );

ALTER TABLE "CourierLedgerEntry"
  ADD CONSTRAINT "CourierLedgerEntry_distance_km_shape" CHECK (
    "distanceKmTenths" IS NULL OR ("kind" = 'DISTANCE_FEE' AND "distanceKmTenths" >= 0)
  );
