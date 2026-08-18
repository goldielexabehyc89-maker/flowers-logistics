-- Судьба исходящей отметки об отмене отделена от самого решения логиста.
--
-- Решение действует у нас сразу и ни от какой сети не зависит. Отправка
-- наружу — отдельная операция со своей судьбой: она может быть запрещена
-- настройкой контура, может не дойти и может потребовать повторов. Слитые
-- в одно поле, эти два факта заставили бы интерфейс говорить «отменён
-- в МоемСкладе» там, где наружу не ушло ничего.
CREATE TYPE "SourceCancelState" AS ENUM ('NOT_REQUESTED', 'QUEUED', 'BLOCKED', 'SENT', 'FAILED');

ALTER TABLE "DeliveryOrder"
  ADD COLUMN "sourceCancelState" "SourceCancelState" NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN "sourceCancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "sourceCancelSentAt" TIMESTAMP(3),
  ADD COLUMN "sourceCancelError" TEXT;

-- Отправленная отметка обязана иметь время отправки, а запрошенная — время
-- запроса: состояние без своей отметки времени нечитаемо в разборе.
ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_source_cancel_outbox_complete" CHECK (
    ("sourceCancelState" = 'NOT_REQUESTED' AND "sourceCancelRequestedAt" IS NULL AND "sourceCancelSentAt" IS NULL)
    OR ("sourceCancelState" IN ('QUEUED', 'BLOCKED', 'FAILED') AND "sourceCancelRequestedAt" IS NOT NULL AND "sourceCancelSentAt" IS NULL)
    OR ("sourceCancelState" = 'SENT' AND "sourceCancelRequestedAt" IS NOT NULL AND "sourceCancelSentAt" IS NOT NULL)
  );
