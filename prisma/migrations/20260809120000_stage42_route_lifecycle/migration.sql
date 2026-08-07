-- Этап 4.2: жизненный цикл маршрута и мягкая блокировка редактора.
--
-- Предыдущие миграции не редактируются: правила добавляются только вперёд.
--
-- `DeliveryRoute.state` остаётся текущим состоянием, `RouteStateTransition` —
-- неизменяемой историей. Второго источника истины не появляется: история не
-- дублирует состояние, а объясняет, кто и почему его менял.

-- Отмена маршрута закрывает участия его заказов. Отдельная причина нужна, чтобы
-- в истории было видно разницу между «логист вернул заказ» и «маршрут отменён».
ALTER TYPE "RouteOrderRemovalReason" ADD VALUE IF NOT EXISTS 'ROUTE_CANCELLED' AFTER 'MOVED_TO_ANOTHER_ROUTE';

-- CreateTable
CREATE TABLE "RouteStateTransition" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "fromState" "RouteState" NOT NULL,
    "toState" "RouteState" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "RouteStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouteEditLease" (
    "routeId" UUID NOT NULL,
    "holderUserId" UUID NOT NULL,
    "holderFamilyId" UUID NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RouteEditLease_pkey" PRIMARY KEY ("routeId")
);

-- CreateIndex
CREATE INDEX "RouteStateTransition_routeId_occurredAt_idx" ON "RouteStateTransition"("routeId", "occurredAt");

-- CreateIndex
CREATE INDEX "RouteEditLease_holderUserId_idx" ON "RouteEditLease"("holderUserId");

-- CreateIndex
CREATE INDEX "RouteEditLease_expiresAt_idx" ON "RouteEditLease"("expiresAt");

-- AddForeignKey
ALTER TABLE "RouteStateTransition" ADD CONSTRAINT "RouteStateTransition_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteStateTransition" ADD CONSTRAINT "RouteStateTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteEditLease" ADD CONSTRAINT "RouteEditLease_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RouteEditLease" ADD CONSTRAINT "RouteEditLease_holderUserId_fkey" FOREIGN KEY ("holderUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Инварианты уровня базы
-- ---------------------------------------------------------------------------

-- Разрешены ровно четыре перехода этапа 4. Список проверяется базой, а не только
-- сервером: запись в неизменяемую историю невозможно исправить постфактум,
-- поэтому ошибочный переход не должен туда попасть вовсе.
-- ACTIVE и COMPLETED появятся отдельной миграцией этапа 6 вместе со своими переходами.
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_allowed" CHECK (
    ("fromState" = 'DRAFT' AND "toState" = 'CONFIRMED')
    OR ("fromState" = 'CONFIRMED' AND "toState" = 'DRAFT')
    OR ("fromState" = 'DRAFT' AND "toState" = 'CANCELLED')
    OR ("fromState" = 'CONFIRMED' AND "toState" = 'CANCELLED')
  );

-- Причина обязательна там, где решение нужно объяснить: возврат уже подтверждённого
-- маршрута и отмена. Подтверждение причины не требует — оно и есть согласие.
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_reason_required" CHECK (
    ("toState" = 'CONFIRMED' AND "reason" IS NULL)
    OR ("toState" <> 'CONFIRMED' AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 3 AND 500)
  );

-- Аренда редактора: срок обязан быть позже момента получения, а сердцебиение
-- не может оказаться раньше него.
ALTER TABLE "RouteEditLease"
  ADD CONSTRAINT "RouteEditLease_period_valid" CHECK (
    "expiresAt" > "acquiredAt" AND "heartbeatAt" >= "acquiredAt"
  );

ALTER TABLE "RouteEditLease"
  ADD CONSTRAINT "RouteEditLease_version_positive" CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------
-- Триггеры
--
-- Функция prevent_mutation() создана миграцией 20260804160841_audit_immutability_guards.
-- Триггеры не отражаются в schema.prisma и дрейфа не вызывают.
-- ---------------------------------------------------------------------------

-- История переходов неизменяема: переписанная причина отмены перестала бы быть
-- доказательством, а удалённый переход стёр бы след решения.
CREATE TRIGGER route_state_transition_no_update
  BEFORE UPDATE ON "RouteStateTransition"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER route_state_transition_no_delete
  BEFORE DELETE ON "RouteStateTransition"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Аренда редактора обновляется (heartbeat, перехват, освобождение), но не удаляется:
-- строка одна на маршрут и служит операционным состоянием, а не журналом.
CREATE TRIGGER route_edit_lease_no_delete
  BEFORE DELETE ON "RouteEditLease"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- Маршрут аренды неизменен: подмена routeId переносила бы чужую блокировку.
CREATE OR REPLACE FUNCTION prevent_route_edit_lease_route_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."routeId" IS DISTINCT FROM OLD."routeId" THEN
    RAISE EXCEPTION 'Аренда редактора привязана к маршруту и не переносится'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER route_edit_lease_route_immutable
  BEFORE UPDATE ON "RouteEditLease"
  FOR EACH ROW EXECUTE FUNCTION prevent_route_edit_lease_route_change();
