-- Этап 3.3: инвариант ручного локального интервала.
--
-- Поля `manualInterval*` появились в 3.1 как задел и до сих пор не заполнялись.
-- Теперь ими управляет логист, поэтому правило переносится из кода в базу:
-- проверка только на уровне API защищает лишь один путь записи, а миграции,
-- ручное исправление данных и будущий импорт снимка пишут напрямую.
--
-- Половинчатый интервал опаснее пустого: «начало есть, окончания нет» выглядит
-- как заданное время и попадёт в планирование маршрута. Обратный и нулевой
-- интервал невозможно выполнить.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.

ALTER TABLE "DeliveryOrder"
  ADD CONSTRAINT "DeliveryOrder_manual_interval_complete"
  CHECK (
    (
      "manualIntervalStartMinute" IS NULL
      AND "manualIntervalEndMinute" IS NULL
      AND "manualIntervalSetAt" IS NULL
    )
    OR (
      "manualIntervalStartMinute" IS NOT NULL
      AND "manualIntervalEndMinute" IS NOT NULL
      AND "manualIntervalSetAt" IS NOT NULL
      AND "manualIntervalStartMinute" BETWEEN 0 AND 1439
      AND "manualIntervalEndMinute" BETWEEN 0 AND 1439
      AND "manualIntervalEndMinute" > "manualIntervalStartMinute"
    )
  );
