-- Ограничения целостности для колонок, реализующих частичную уникальность.
--
-- `ActivationCode.activeKey` и `SystemSetting.currentKey` дают правило «не более одной
-- активной записи» через уникальный индекс по nullable-колонке. Само по себе это работает,
-- только пока приложение записывает туда правильное значение: ошибка в коде или ручной
-- INSERT с произвольным значением обошли бы ограничение и создали второй активный код
-- активации или вторую текущую версию настройки.
--
-- CHECK-ограничения закрывают эту возможность на уровне базы. Prisma не моделирует
-- CHECK-ограничения, поэтому дрейфа схемы они не вызывают.

ALTER TABLE "ActivationCode"
  ADD CONSTRAINT "ActivationCode_activeKey_matches_userId"
  CHECK ("activeKey" IS NULL OR "activeKey" = "userId");

ALTER TABLE "SystemSetting"
  ADD CONSTRAINT "SystemSetting_currentKey_matches_key"
  CHECK ("currentKey" IS NULL OR "currentKey" = "key");
