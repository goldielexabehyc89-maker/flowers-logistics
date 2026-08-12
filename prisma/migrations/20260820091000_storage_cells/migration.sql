-- Этап 6.4: справочник складских ячеек.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- Миграция ЧИСТО ДОБАВЛЯЮЩАЯ: новый тип и новая таблица. Ни одна существующая
-- таблица, колонка, ограничение или триггер не изменены, поэтому предыдущая
-- версия приложения продолжает стартовать и работать поверх этой схемы —
-- она просто не знает о новой таблице.
--
-- Границы решения владельца `FUL-004`: складская ячейка не расширяет
-- логистический `Depot`. Координат, вместимости и связи с маршрутом здесь нет.

-- CreateEnum
CREATE TYPE "StorageCellKind" AS ENUM ('STORAGE', 'ROUTE');

-- CreateTable
CREATE TABLE "StorageCell" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "normalizedCode" TEXT NOT NULL,
    "kind" "StorageCellKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID NOT NULL,
    "changedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageCell_pkey" PRIMARY KEY ("id")
);

-- Уникальность именно НОРМАЛИЗОВАННОГО кода.
--
-- Скан `a-01` не должен выбрать другую ячейку `A-01`: для человека и для сканера
-- это одна и та же полка. Уникальность на исходном написании допустила бы две
-- строки, различимые только регистром, и сканер честно не смог бы выбрать.
CREATE UNIQUE INDEX "StorageCell_normalizedCode_key" ON "StorageCell"("normalizedCode");

-- Рабочая выборка: активные ячейки нужного типа.
CREATE INDEX "StorageCell_isActive_kind_idx" ON "StorageCell"("isActive", "kind");

-- AddForeignKey
--
-- ON DELETE RESTRICT: пользователь не удаляется каскадом. Удаление пользователя
-- в системе запрещено вовсе, но внешний ключ обязан защищать сам себя.
ALTER TABLE "StorageCell" ADD CONSTRAINT "StorageCell_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StorageCell" ADD CONSTRAINT "StorageCell_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Форма кода: непустой после обрезки, разумной длины, без управляющих символов.
--
-- Проверяется и исходное написание, и нормализованное: правило, оставленное
-- только приложению, обходится одним INSERT из консоли, и на складе появилась бы
-- ячейка с пустым или непечатаемым кодом, которую нельзя ни назвать, ни найти.
ALTER TABLE "StorageCell"
  ADD CONSTRAINT "StorageCell_code_shape" CHECK (
    btrim("code") = "code"
    AND char_length("code") BETWEEN 1 AND 48
    AND "code" !~ '[[:cntrl:]]'
  );

-- Нормализованный код обязан БЫТЬ нормализованным.
--
-- Без этой проверки строка могла бы хранить в `normalizedCode` произвольное
-- значение — например, в нижнем регистре, — и уникальный индекс перестал бы
-- означать «одна полка = одна запись»: рядом легально встали бы `A-01` и `a-01`.
-- Приведение регистра выполняет приложение (NFKC + верхний регистр); база
-- проверяет результат теми средствами, которые у неё есть.
ALTER TABLE "StorageCell"
  ADD CONSTRAINT "StorageCell_normalized_shape" CHECK (
    "normalizedCode" = btrim("normalizedCode")
    AND "normalizedCode" = upper("normalizedCode")
    AND char_length("normalizedCode") BETWEEN 1 AND 48
    AND "normalizedCode" !~ '[[:cntrl:]]'
  );

-- Версия оптимистической блокировки не бывает нулевой или убывающей ниже единицы.
ALTER TABLE "StorageCell"
  ADD CONSTRAINT "StorageCell_version_positive" CHECK ("version" >= 1);

-- Код неизменяем после создания.
--
-- Этикетка уже напечатана и наклеена на полку. Переименование кода означало бы,
-- что физическая этикетка молча указывает на другую ячейку, и заказ уехал бы
-- не туда без единого следа. Ошибочный код исправляется деактивацией старой
-- ячейки и созданием новой.
CREATE OR REPLACE FUNCTION storage_cell_code_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."normalizedCode" IS DISTINCT FROM OLD."normalizedCode" THEN
    RAISE EXCEPTION 'Код складской ячейки изменять нельзя: деактивируйте её и создайте новую';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_cell_code_immutable
  BEFORE UPDATE ON "StorageCell"
  FOR EACH ROW EXECUTE FUNCTION storage_cell_code_immutable();

-- Ячейка физически не удаляется.
--
-- На неё будет ссылаться неизменяемая история перемещений заказов; удаление
-- оставило бы историю без места. Недоступность выражается признаком `isActive`.
CREATE OR REPLACE FUNCTION storage_cell_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Складские ячейки не удаляются: используйте деактивацию';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_cell_no_delete
  BEFORE DELETE ON "StorageCell"
  FOR EACH ROW EXECUTE FUNCTION storage_cell_no_delete();
