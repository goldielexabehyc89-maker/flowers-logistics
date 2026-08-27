-- Контрольная точка незавершённого прохода синхронизации.
--
-- Миграция ТОЛЬКО расширяющая: четыре колонки, допускающие NULL, без значений
-- по умолчанию и без UPDATE. Пустая контрольная точка означает «незавершённого
-- прохода нет» — ровно то состояние, в котором находятся все существующие
-- строки, поэтому ни одна из них не меняется.
--
-- Отдельная таблица не заводится: это состояние ТОГО ЖЕ курсора интеграции,
-- и разнеси мы их по двум таблицам, две строки однажды разошлись бы.

ALTER TABLE "IntegrationCursor"
  ADD COLUMN "passKind"        TEXT,
  ADD COLUMN "passOffset"      INTEGER,
  ADD COLUMN "passFingerprint" TEXT,
  ADD COLUMN "passStartedAt"   TIMESTAMP(3);

-- Смысл имеет только неотрицательное смещение: отрицательное означало бы
-- «продолжить раньше начала» и молча перечитало бы всю выборку.
ALTER TABLE "IntegrationCursor"
  ADD CONSTRAINT "IntegrationCursor_pass_offset_non_negative"
  CHECK ("passOffset" IS NULL OR "passOffset" >= 0);

-- Контрольная точка либо полна, либо отсутствует. Половинчатая запись
-- (вид без смещения, смещение без отпечатка) не даёт продолжить проход,
-- но выглядит как возможность продолжить — и однажды ею воспользуются.
ALTER TABLE "IntegrationCursor"
  ADD CONSTRAINT "IntegrationCursor_pass_checkpoint_complete"
  CHECK (
    ("passKind" IS NULL AND "passOffset" IS NULL AND "passFingerprint" IS NULL AND "passStartedAt" IS NULL)
    OR
    ("passKind" IS NOT NULL AND "passOffset" IS NOT NULL AND "passFingerprint" IS NOT NULL AND "passStartedAt" IS NOT NULL)
  );
