-- Провайдер геокодирования называется по тому, кто действительно геокодирует.
--
-- Автоматическое геокодирование выполняет собственный Photon, а DaData осталась
-- только подсказками в ручной правке. Пока строки состояния назывались `dadata`,
-- дежурный читал состояние чужого сервиса вместо своего — это не косметика,
-- а неверное показание приборной панели во время отказа.
--
-- Миграция forward-only и не редактирует предыдущие: ограничение singleton
-- пересоздаётся, а не правится на месте.

-- 1. Состояние темпа и остановки провайдера.
--
-- Ограничение снимается до переименования: иначе UPDATE нарушил бы его сам.
ALTER TABLE "GeocodingProviderState"
  DROP CONSTRAINT IF EXISTS "GeocodingProviderState_singleton";

-- Строка переносится, а не создаётся заново: пауза и причина остановки должны
-- пережить выкатку. Их потеря означала бы, что после обновления приложение
-- заново пойдёт в неработающий геокодер.
UPDATE "GeocodingProviderState" SET "id" = 'photon' WHERE "id" = 'dadata';

-- Строка обязана существовать даже там, где её почему-то нет.
INSERT INTO "GeocodingProviderState" ("id", "nextRequestAllowedAt", "updatedAt")
VALUES ('photon', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Посторонних строк остаться не должно: singleton — это ровно одна строка.
DELETE FROM "GeocodingProviderState" WHERE "id" <> 'photon';

ALTER TABLE "GeocodingProviderState"
  ALTER COLUMN "id" SET DEFAULT 'photon';

ALTER TABLE "GeocodingProviderState"
  ADD CONSTRAINT "GeocodingProviderState_singleton" CHECK ("id" = 'photon');

-- 2. Публичное состояние интеграции.
--
-- Прежняя запись переименовывается, чтобы сохранить историю `lastOkAt`
-- и `lastErrorAt`. Если запись `photon` уже есть, прежняя удаляется:
-- две записи об одном геокодере противоречили бы друг другу.
DELETE FROM "IntegrationStatus"
WHERE "provider" = 'dadata'
  AND EXISTS (SELECT 1 FROM "IntegrationStatus" WHERE "provider" = 'photon');

UPDATE "IntegrationStatus" SET "provider" = 'photon' WHERE "provider" = 'dadata';
