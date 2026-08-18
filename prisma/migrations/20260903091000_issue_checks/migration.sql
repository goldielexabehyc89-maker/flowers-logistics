-- Проверенные заказы выдачи: минимальное дополнение к существующей сессии.
--
-- Почему нельзя обойтись самой `RouteIssueSession`. Сессия — одна строка
-- на маршрут, множества заказов она не хранит. Единственная связь заказа
-- с сессией сегодня — `OrderPlacement."issueSessionId"`, и она означает
-- ровно «выдан»: `OrderPlacement_issue_session` требует, чтобы поле было
-- заполнено ТОЛЬКО вместе с `releaseReason = 'ISSUED_TO_COURIER'`.
-- Пометить им ещё не выданную коробку база не даёт, и это правильное
-- правило: «проверен» и «выдан» — разные факты, и путать их нельзя.
--
-- Хранить список в поле самой сессии (массивом или JSON) тоже нельзя:
-- тогда уникальность отметки на заказ, внешние ключи и защита от гонки
-- двух кладовщиков превратились бы в договорённость кода. Здесь они
-- нужны именно от базы.
--
-- Поэтому — дочерняя таблица отметок. Сессия остаётся прежней: у неё
-- по-прежнему один курьер, один открытый ключ и своя версия.
CREATE TABLE "RouteIssueCheck" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedById" UUID NOT NULL,
    -- Сброс не стирает отметку, а закрывает её: «внесено 3 из 3, потом
    -- сбросили» обязано остаться видимым, иначе разбор спора о том, что
    -- именно грузили, начинается с пустого места.
    "clearedAt" TIMESTAMP(3),
    "clearedById" UUID,

    CONSTRAINT "RouteIssueCheck_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RouteIssueCheck" ADD CONSTRAINT "RouteIssueCheck_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "RouteIssueSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueCheck" ADD CONSTRAINT "RouteIssueCheck_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueCheck" ADD CONSTRAINT "RouteIssueCheck_checkedById_fkey"
  FOREIGN KEY ("checkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "RouteIssueCheck" ADD CONSTRAINT "RouteIssueCheck_clearedById_fkey"
  FOREIGN KEY ("clearedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "RouteIssueCheck_sessionId_idx" ON "RouteIssueCheck" ("sessionId");
CREATE INDEX "RouteIssueCheck_orderId_idx" ON "RouteIssueCheck" ("orderId");

-- Одна действующая отметка на заказ внутри сессии.
--
-- Это и есть защита от второго счёта: два кладовщика могут отсканировать
-- одну коробку одновременно, и «сначала проверить, потом вставить» такую
-- гонку не ловит — параллельные транзакции не видят чужих незафиксированных
-- вставок.
CREATE UNIQUE INDEX "RouteIssueCheck_active_unique"
  ON "RouteIssueCheck" ("sessionId", "orderId") WHERE "clearedAt" IS NULL;

-- Закрытие отметки всегда именное: «известно когда, неизвестно кем»
-- не доказывает ничего.
ALTER TABLE "RouteIssueCheck"
  ADD CONSTRAINT "RouteIssueCheck_cleared_complete" CHECK (
    ("clearedAt" IS NULL AND "clearedById" IS NULL)
    OR ("clearedAt" IS NOT NULL AND "clearedById" IS NOT NULL)
  );

-- Отметки не удаляются и не переписываются задним числом: сброс закрывает
-- их, а повторная проверка создаёт новые.
CREATE OR REPLACE FUNCTION route_issue_check_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'История проверки выдачи не удаляется';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RouteIssueCheck_no_delete"
  BEFORE DELETE ON "RouteIssueCheck"
  FOR EACH ROW EXECUTE FUNCTION route_issue_check_no_delete();
