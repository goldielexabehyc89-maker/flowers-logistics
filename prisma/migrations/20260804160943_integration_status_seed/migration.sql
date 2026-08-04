-- Плейсхолдеры состояния интеграций для индикатора в интерфейсе.
--
-- На этапе 1 реальных подключений нет: обе записи находятся в состоянии NOT_CONFIGURED,
-- поэтому интерфейс честно показывает «Интеграция не настроена», а не выдуманный успех.
-- Токены и ключи в эту таблицу не попадают никогда — только состояние и очищенные детали.

INSERT INTO "IntegrationStatus" ("provider", "state", "pendingOperations", "updatedAt")
VALUES
  ('moysklad', 'NOT_CONFIGURED', 0, NOW()),
  ('maps', 'NOT_CONFIGURED', 0, NOW())
ON CONFLICT ("provider") DO NOTHING;
