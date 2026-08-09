-- Этап 5.3: кэш матриц времени и расстояния.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Перечисления создаются в этой же миграции и здесь же используются: запрет
-- PostgreSQL касается только ДОБАВЛЕНИЯ значений в уже существующий тип.

-- CreateEnum
CREATE TYPE "TrafficMode" AS ENUM ('NONE', 'STATIC');

-- CreateEnum
CREATE TYPE "MatrixCacheStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "RouteMatrixCache" (
    "id" UUID NOT NULL,
    "keyHash" TEXT NOT NULL,
    "graphRevision" TEXT NOT NULL,
    "profile" "VehicleType" NOT NULL,
    "trafficMode" "TrafficMode" NOT NULL,
    "pointCount" INTEGER NOT NULL,
    "status" "MatrixCacheStatus" NOT NULL DEFAULT 'PENDING',
    "durationsSec" JSONB,
    "distancesM" JSONB,
    "computedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RouteMatrixCache_pkey" PRIMARY KEY ("id")
);

-- Ключ уникален: именно он делает возможным single-flight через
-- INSERT … ON CONFLICT DO NOTHING. Проверка «сначала найти, потом создать»
-- при гонке дала бы два одновременных расчёта одного и того же ключа.
CREATE UNIQUE INDEX "RouteMatrixCache_keyHash_key" ON "RouteMatrixCache"("keyHash");

CREATE INDEX "RouteMatrixCache_expiresAt_idx" ON "RouteMatrixCache"("expiresAt");
CREATE INDEX "RouteMatrixCache_status_lockedAt_idx" ON "RouteMatrixCache"("status", "lockedAt");

-- Ключ — это ровно шестьдесят четыре шестнадцатеричных символа SHA-256.
-- Произвольная строка означала бы, что ключ собран не канонической функцией.
ALTER TABLE "RouteMatrixCache"
  ADD CONSTRAINT "RouteMatrixCache_key_shape" CHECK ("keyHash" ~ '^[0-9a-f]{64}$');

-- Матрица меньше чем на двух точках бессмысленна, а ревизия графа обязательна:
-- расчёт по другому графу — другой ответ.
ALTER TABLE "RouteMatrixCache"
  ADD CONSTRAINT "RouteMatrixCache_shape" CHECK (
    "pointCount" >= 2
    AND "attempts" >= 0
    AND char_length("graphRevision") BETWEEN 1 AND 200
  );

-- Готовый результат полон: обе матрицы, время расчёта и срок годности.
-- Незавершённый результат не содержит матриц вовсе — иначе частично
-- записанный расчёт однажды был бы выдан за готовый.
ALTER TABLE "RouteMatrixCache"
  ADD CONSTRAINT "RouteMatrixCache_ready_complete" CHECK (
    (
      "status" = 'READY'
      AND "durationsSec" IS NOT NULL
      AND "distancesM" IS NOT NULL
      AND "computedAt" IS NOT NULL
      AND "expiresAt" IS NOT NULL
    )
    OR (
      "status" <> 'READY'
      AND "durationsSec" IS NULL
      AND "distancesM" IS NULL
      AND "computedAt" IS NULL
    )
  );

-- Аренда полна или отсутствует целиком.
ALTER TABLE "RouteMatrixCache"
  ADD CONSTRAINT "RouteMatrixCache_lease_complete" CHECK (
    ("lockedAt" IS NULL) = ("lockedBy" IS NULL)
  );
