-- Этап 3.2: состояние восстановления фоновой синхронизации.
--
-- Поля переживают перезапуск процесса: иначе рестарт обнулял бы backoff,
-- и приложение после сбоя долбило бы внешний API с базовым интервалом.
--
-- Больше ничего не добавляется: остальное состояние прохода живёт в памяти
-- одного прохода и в IntegrationStatus.

ALTER TABLE "IntegrationCursor" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "IntegrationCursor" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IntegrationCursor" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

ALTER TABLE "IntegrationCursor"
  ADD CONSTRAINT "IntegrationCursor_failures_non_negative"
  CHECK ("consecutiveFailures" >= 0);
