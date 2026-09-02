-- Ранг применённой стадии MoySklad-статуса: более поздняя стадия (доставка,
-- финал) не откатывается более ранней (сборка) даже при большем seq. Старые
-- строки получают 0 и доопределяются по последнему UUID в коде — без backfill.
ALTER TABLE "OrderMoyskladState" ADD COLUMN "appliedRank" INTEGER NOT NULL DEFAULT 0;

-- Отметка эскалации задачи логиста (>30 мин без реакции). Ставится ровно один
-- раз условной записью; повтор прохода/перезапуск дубликата не создают.
ALTER TABLE "OrderResolution" ADD COLUMN "escalatedAt" TIMESTAMP(3);
