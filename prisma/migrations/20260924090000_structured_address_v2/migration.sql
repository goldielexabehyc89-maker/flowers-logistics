-- Структурированный адрес: новый контракт рядом со старым.
--
-- Миграция ТОЛЬКО расширяющая. Ни одной существующей строки она не трогает:
-- новые колонки допускают NULL, значения по умолчанию не задаются, UPDATE
-- не выполняется. Старый заказ после неё остаётся ровно тем, чем был, —
-- перевод существующих заказов на новый контракт был бы массовым изменением,
-- а его в этом пакете нет.

ALTER TABLE "DeliveryOrder"
  ADD COLUMN "structuredAddress"      TEXT,
  ADD COLUMN "addressDetails"         TEXT,
  ADD COLUMN "addressContractVersion" INTEGER;

-- Единицу не записывает никто: прежний контракт — это NULL. Неизвестную
-- версию база не принимает, поэтому «молчаливого отката к legacy» при опечатке
-- быть не может — будет явный отказ.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_address_contract_version"
  CHECK ("addressContractVersion" IS NULL OR "addressContractVersion" = 2);

-- История структурированного адреса.
--
-- Отдельная таблица, а не новое значение перечисления `OrderAddressAction`:
-- строка с незнакомым значением перечисления ломает чтение истории предыдущим
-- клиентом Prisma, то есть откат. О новой таблице прежний клиент не знает
-- и в неё не заглядывает.
CREATE TABLE "OrderStructuredAddressEvent" (
  "id"          UUID         NOT NULL,
  "orderId"     UUID         NOT NULL,
  "kind"        TEXT         NOT NULL,
  "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "oldValue"    TEXT,
  "newValue"    TEXT,
  "actorUserId" UUID,

  CONSTRAINT "OrderStructuredAddressEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderStructuredAddressEvent_kind" CHECK ("kind" IN ('ADDRESS', 'DETAILS'))
);

CREATE INDEX "OrderStructuredAddressEvent_orderId_occurredAt_idx"
  ON "OrderStructuredAddressEvent" ("orderId", "occurredAt");

ALTER TABLE "OrderStructuredAddressEvent"
  ADD CONSTRAINT "OrderStructuredAddressEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderStructuredAddressEvent"
  ADD CONSTRAINT "OrderStructuredAddressEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Только вставка: история не переписывается задним числом. Функция
-- `prevent_mutation()` уже существует и охраняет аудит и заказы.
CREATE TRIGGER order_structured_address_event_no_update
  BEFORE UPDATE ON "OrderStructuredAddressEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER order_structured_address_event_no_delete
  BEFORE DELETE ON "OrderStructuredAddressEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
