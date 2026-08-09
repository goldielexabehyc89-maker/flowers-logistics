-- Этап 5.2, корректирующий проход: общее состояние провайдера геокодирования.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Три свойства невозможно обеспечить состоянием внутри процесса, потому что
-- экземпляров приложения несколько, а лимит, баланс и ключ у провайдера общие:
--
--   1) минимальный интервал между запросами. Поле «время последнего запроса»
--      в объекте клиента ничего не знает о запросе соседнего процесса, поэтому
--      после передачи замка следующий запрос мог начаться раньше секунды;
--   2) пауза после 429. Она относится ко всему ключу, а не к одному заказу;
--   3) остановка при неверном ключе. Без общей отметки каждый экземпляр
--      продолжал бы выяснять это самостоятельно и тратить обращения.

CREATE TABLE "GeocodingProviderState" (
    -- Singleton: строка ровно одна, и её идентификатор фиксирован.
    "id" TEXT NOT NULL DEFAULT 'dadata',
    -- Время, раньше которого следующий запрос начинать нельзя.
    -- Обслуживает и обычный интервал, и паузу после 429.
    "nextRequestAllowedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Причина полной остановки обращений. Снимается только при запуске
    -- приложения с исправленной конфигурацией.
    "haltedReason" TEXT,
    "haltedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeocodingProviderState_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GeocodingProviderState"
  ADD CONSTRAINT "GeocodingProviderState_singleton" CHECK ("id" = 'dadata');

-- Отметка остановки полна или отсутствует целиком: причина без времени
-- не позволила бы понять, когда обращения прекратились.
ALTER TABLE "GeocodingProviderState"
  ADD CONSTRAINT "GeocodingProviderState_halt_complete" CHECK (
    ("haltedReason" IS NULL) = ("haltedAt" IS NULL)
  );

INSERT INTO "GeocodingProviderState" ("id", "nextRequestAllowedAt", "updatedAt")
VALUES ('dadata', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
