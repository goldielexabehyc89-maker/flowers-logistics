-- История доступности общей очереди флориста (forward-capture для статистики).
--
-- Только добавление: строка появляется, когда булев признак доступности очереди
-- меняется. Восстановить прошлое нельзя, поэтому накопление идёт вперёд, а
-- граница точности в интерфейсе — минимум occurredAt.
CREATE TABLE "FloristQueueAvailabilityEvent" (
  "id"         UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "available"  BOOLEAN NOT NULL,
  CONSTRAINT "FloristQueueAvailabilityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FloristQueueAvailabilityEvent_occurredAt_idx"
  ON "FloristQueueAvailabilityEvent" ("occurredAt");

-- Неизменяемость: та же защита, что у аудита. Функция prevent_mutation()
-- заведена ранее (миграция audit_immutability_guards).
CREATE TRIGGER florist_queue_availability_no_update
  BEFORE UPDATE ON "FloristQueueAvailabilityEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER florist_queue_availability_no_delete
  BEFORE DELETE ON "FloristQueueAvailabilityEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
