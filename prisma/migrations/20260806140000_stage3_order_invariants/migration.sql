-- Этап 3.1, корректирующий проход: финансовые инварианты, неизменяемость внешнего
-- идентификатора, необязательный склад и календарная дата доставки.
--
-- Предыдущая миграция не редактируется: правила добавляются только вперёд.

-- Наличные возникают ТОЛЬКО при точном типе оплаты «Наличные/карта на ТТ».
-- Прежняя реализация считала долг курьера для любого типа оплаты, и ошибка
-- в вызывающем коде создала бы несуществующий долг. Теперь это запрещает база.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_money_non_negative"
  CHECK ("sumMinor" >= 0 AND "payedSumMinor" >= 0 AND "cashToCollectMinor" >= 0);

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_cash_requires_cash_payment"
  CHECK (
    ("cashCollectable" AND "cashToCollectMinor" = GREATEST(0::BIGINT, "sumMinor" - "payedSumMinor"))
    OR (NOT "cashCollectable" AND "cashToCollectMinor" = 0)
  );

-- Денежная аномалия существует только там, где вообще есть наличные.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_cash_anomaly_consistent"
  CHECK ("cashAnomaly" = ("cashCollectable" AND "payedSumMinor" > "sumMinor"));

-- Склад может исчезнуть у уже импортированного заказа: заказ обязан сохраниться
-- и выйти из нашей области, а не сломать проход синхронизации.
ALTER TABLE "DeliveryOrder" ALTER COLUMN "storeId" DROP NOT NULL;

-- Плановая дата — календарная дата Москвы. Тип с временем позволял бы часовому
-- поясу перенести доставку на соседний день.
ALTER TABLE "DeliveryOrder" ALTER COLUMN "deliveryDate" TYPE DATE USING "deliveryDate"::DATE;

-- Новая причина «Требует внимания»: значение даты есть, но не разбирается.
ALTER TYPE "OrderAttentionReason" ADD VALUE IF NOT EXISTS 'UNRECOGNIZED_DELIVERY_DATE' AFTER 'MISSING_DELIVERY_DATE';

-- Внешний идентификатор неизменяем. UNIQUE защищает от дубликата, но не мешает
-- переписать ключ идемпотентности у существующей строки: после такой правки
-- импорт создал бы дубликат заказа и потерял историю.
CREATE OR REPLACE FUNCTION prevent_external_id_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."externalId" IS DISTINCT FROM OLD."externalId" THEN
    RAISE EXCEPTION
      'Внешний идентификатор заказа неизменяем: попытка заменить % на %',
      OLD."externalId", NEW."externalId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_order_external_id_immutable
  BEFORE UPDATE ON "DeliveryOrder"
  FOR EACH ROW EXECUTE FUNCTION prevent_external_id_change();
