-- Этап 5.2: новые виды записей в истории геоданных.
--
-- Отдельная миграция намеренно. PostgreSQL разрешает добавить значение
-- перечисления внутри транзакции, но запрещает использовать его до фиксации:
-- CHECK-ограничения, ссылающиеся на эти значения, обязаны применяться
-- следующей миграцией, уже после коммита.

-- AlterEnum
ALTER TYPE "OrderGeoChangeKind" ADD VALUE 'GEOCODE_REQUESTED';
ALTER TYPE "OrderGeoChangeKind" ADD VALUE 'GEOCODE_RESOLVED';
ALTER TYPE "OrderGeoChangeKind" ADD VALUE 'GEOCODE_LOW_PRECISION';
ALTER TYPE "OrderGeoChangeKind" ADD VALUE 'GEOCODE_FAILED';
