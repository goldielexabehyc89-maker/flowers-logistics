-- Защита инвариантов этапа 1 на уровне базы данных.
--
-- 1. Аудит неизменяем: запись можно только добавить. UPDATE и DELETE запрещены,
--    иначе журнал перестаёт быть доказательством действий.
-- 2. Сотрудники и курьеры физически не удаляются: недоступность выражается
--    статусом FROZEN. Ошибка в коде или ручной запрос не должны стирать историю.
--
-- Триггеры не отражаются в schema.prisma и не участвуют в diff-е миграций,
-- поэтому они не вызывают дрейфа схемы.

CREATE OR REPLACE FUNCTION prevent_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Таблица % доступна только для добавления записей: операция % запрещена',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION prevent_mutation() IS
  'Блокирует UPDATE/DELETE для append-only таблиц (аудит) и удаление пользователей.';

-- Аудит: только вставка.
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Пользователи: удаление запрещено на уровне БД, изменение разрешено.
CREATE TRIGGER user_no_delete
  BEFORE DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Профиль курьера удаляется только вместе с пользователем, что запрещено выше.
CREATE TRIGGER courier_profile_no_delete
  BEFORE DELETE ON "CourierProfile"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
