-- Работа курьера: результат доставки и автоматическое завершение маршрута.
--
-- Миграция расширяющая и forward-only. Значение `COMPLETED` добавляется
-- в КОНЕЦ перечисления: PostgreSQL хранит порядок объявления, и вставка
-- в середину сдвинула бы существующие значения, а прежний клиент Prisma
-- перестал бы читать уже записанные строки.
--
-- Прежний код продолжает работать против этой схемы: ни одна существующая
-- колонка не изменена и не удалена, все новые таблицы независимы, а `COMPLETED`
-- не появляется в данных до первого фактического результата курьера.

-- Новое состояние маршрута. Отдельной транзакцией: PostgreSQL до 12 не давал
-- использовать значение в той же транзакции, где оно добавлено, и держать этот
-- порядок дешевле, чем однажды на этом споткнуться.
ALTER TYPE "RouteState" ADD VALUE IF NOT EXISTS 'COMPLETED';

-- Итог доставки. Третьего значения нет намеренно: «в пути» и «принял маршрут»
-- продукт не вводит.
CREATE TYPE "DeliveryOutcome" AS ENUM ('DELIVERED', 'NOT_DELIVERED');

-- Кто и на каком основании отменил окончательный результат.
CREATE TYPE "DeliveryAttemptCancelKind" AS ENUM ('COURIER_SELF', 'MANAGER_CORRECTION');

-- --- Справочник причин недоставки -------------------------------------------
CREATE TABLE "DeliveryFailureReason" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "requiresComment" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "changedById" UUID,

  CONSTRAINT "DeliveryFailureReason_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryFailureReason_code_key" ON "DeliveryFailureReason"("code");
CREATE INDEX "DeliveryFailureReason_isActive_ordinal_idx" ON "DeliveryFailureReason"("isActive", "ordinal");

ALTER TABLE "DeliveryFailureReason"
  ADD CONSTRAINT "DeliveryFailureReason_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Название непустое: пустая строка в списке причин выглядела бы как сбой
-- интерфейса, а попала бы снимком в неизменяемую историю.
ALTER TABLE "DeliveryFailureReason"
  ADD CONSTRAINT "DeliveryFailureReason_name_not_blank" CHECK (btrim("name") <> '');

ALTER TABLE "DeliveryFailureReason"
  ADD CONSTRAINT "DeliveryFailureReason_version_positive" CHECK ("version" >= 1);

-- Начальный справочник из продуктового контракта (`PROJECT_CONTEXT.md` §8).
-- Коды неизменяемы, названия редактируемы.
INSERT INTO "DeliveryFailureReason" ("id", "code", "name", "ordinal", "requiresComment", "updatedAt")
VALUES
  (gen_random_uuid(), 'NO_ANSWER',        'Нет ответа',            1, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'RECIPIENT_ABSENT', 'Получатель отсутствует', 2, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'REFUSED',          'Отказ',                 3, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'WRONG_ADDRESS',    'Неверный адрес',        4, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'NO_ACCESS',        'Нет доступа',           5, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'PAYMENT_PROBLEM',  'Проблема оплаты',       6, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'DAMAGE',           'Повреждение',           7, false, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'OTHER',            'Другое',                8, true,  CURRENT_TIMESTAMP);

-- --- Неизменяемая попытка доставки ------------------------------------------
CREATE TABLE "DeliveryAttempt" (
  "id" UUID NOT NULL,
  "routeOrderId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "routeId" UUID NOT NULL,
  "outcome" "DeliveryOutcome" NOT NULL,
  "reasonId" UUID,
  "reasonNameSnapshot" TEXT,
  "comment" TEXT,
  "courierUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activeKey" UUID,

  CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- ГЛАВНЫЙ ИНВАРИАНТ: у одного участия не может быть двух действующих правд.
--
-- Гонка двух устройств курьера, повтор потерянного HTTP-ответа и двойное
-- нажатие упираются в этот индекс, а не в проверку в коде: проверка «нет ли
-- уже результата» всегда оставляет окно между чтением и записью.
CREATE UNIQUE INDEX "DeliveryAttempt_activeKey_key" ON "DeliveryAttempt"("activeKey");

CREATE INDEX "DeliveryAttempt_routeId_occurredAt_idx" ON "DeliveryAttempt"("routeId", "occurredAt");
CREATE INDEX "DeliveryAttempt_courierUserId_occurredAt_idx" ON "DeliveryAttempt"("courierUserId", "occurredAt");
CREATE INDEX "DeliveryAttempt_orderId_idx" ON "DeliveryAttempt"("orderId");

ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_routeOrderId_fkey"
  FOREIGN KEY ("routeOrderId") REFERENCES "RouteOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "DeliveryOrder"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_routeId_fkey"
  FOREIGN KEY ("routeId") REFERENCES "DeliveryRoute"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_reasonId_fkey"
  FOREIGN KEY ("reasonId") REFERENCES "DeliveryFailureReason"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_courierUserId_fkey"
  FOREIGN KEY ("courierUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Ключ действующей попытки — это и есть участие. Любое другое значение
-- означало бы, что уникальность считается не по тому, по чему обещано.
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_activeKey_matches_participation"
  CHECK ("activeKey" IS NULL OR "activeKey" = "routeOrderId");

-- «Доставлен» причины не имеет; «Не доставлен» — имеет всегда, вместе
-- со снимком названия. Полуфабрикат из одного поля базой не принимается.
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_reason_matches_outcome"
  CHECK (
    ("outcome" = 'DELIVERED' AND "reasonId" IS NULL AND "reasonNameSnapshot" IS NULL)
    OR ("outcome" = 'NOT_DELIVERED' AND "reasonId" IS NOT NULL AND btrim("reasonNameSnapshot") <> '')
  );

-- Пустой комментарий — это отсутствие комментария, а не значение.
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_comment_not_blank"
  CHECK ("comment" IS NULL OR btrim("comment") <> '');

-- --- Отмена результата: связанная операция ----------------------------------
CREATE TABLE "DeliveryAttemptCancellation" (
  "id" UUID NOT NULL,
  "attemptId" UUID NOT NULL,
  "kind" "DeliveryAttemptCancelKind" NOT NULL,
  "reason" TEXT,
  "actorUserId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeliveryAttemptCancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryAttemptCancellation_attemptId_key"
  ON "DeliveryAttemptCancellation"("attemptId");
CREATE INDEX "DeliveryAttemptCancellation_actorUserId_occurredAt_idx"
  ON "DeliveryAttemptCancellation"("actorUserId", "occurredAt");

ALTER TABLE "DeliveryAttemptCancellation"
  ADD CONSTRAINT "DeliveryAttemptCancellation_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "DeliveryAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DeliveryAttemptCancellation"
  ADD CONSTRAINT "DeliveryAttemptCancellation_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Исправление логистом и администратором обязано нести причину; отмена
-- курьером в пятиминутном окне — нет.
ALTER TABLE "DeliveryAttemptCancellation"
  ADD CONSTRAINT "DeliveryAttemptCancellation_manager_reason_required"
  CHECK ("kind" <> 'MANAGER_CORRECTION' OR btrim(COALESCE("reason", '')) <> '');

-- --- Неизменяемость истории --------------------------------------------------
--
-- Обещание «попытка неизменяема» должно держать база, а не комментарий.
-- Единственное разрешённое изменение — снятие технического ключа `activeKey`
-- при отмене: содержимое результата при этом остаётся прежним.
CREATE OR REPLACE FUNCTION prevent_delivery_attempt_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."routeOrderId" IS DISTINCT FROM OLD."routeOrderId"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."routeId" IS DISTINCT FROM OLD."routeId"
     OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
     OR NEW."reasonId" IS DISTINCT FROM OLD."reasonId"
     OR NEW."reasonNameSnapshot" IS DISTINCT FROM OLD."reasonNameSnapshot"
     OR NEW."comment" IS DISTINCT FROM OLD."comment"
     OR NEW."courierUserId" IS DISTINCT FROM OLD."courierUserId"
     OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" THEN
    RAISE EXCEPTION
      'Результат доставки неизменяем: исправление оформляется отменой и новой попыткой'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."activeKey" IS NULL AND NEW."activeKey" IS NOT NULL THEN
    RAISE EXCEPTION
      'Отменённая попытка не может стать действующей снова'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION prevent_delivery_attempt_change() IS
  'Содержимое попытки доставки неизменяемо; снимать разрешено только activeKey.';

CREATE TRIGGER "DeliveryAttempt_content_immutable"
  BEFORE UPDATE ON "DeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION prevent_delivery_attempt_change();

-- Удалять историю нельзя ни попытками, ни отменами: это операционная правда.
CREATE TRIGGER "DeliveryAttempt_no_delete"
  BEFORE DELETE ON "DeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER "DeliveryAttemptCancellation_no_delete"
  BEFORE DELETE ON "DeliveryAttemptCancellation"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

CREATE TRIGGER "DeliveryAttemptCancellation_no_update"
  BEFORE UPDATE ON "DeliveryAttemptCancellation"
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();

-- --- Жизненный цикл маршрута -------------------------------------------------
--
-- Появились два перехода: завершение по последнему результату и возврат
-- в работу, если результат отменили. Оба наступают от ФАКТА, а не от решения
-- человека, поэтому причина у них пустая: объяснение отмены живёт в связанной
-- записи `DeliveryAttemptCancellation`, и дублировать его здесь значило бы
-- завести второй источник правды.
ALTER TABLE "RouteStateTransition" DROP CONSTRAINT "RouteStateTransition_allowed";
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_allowed" CHECK (
    ("fromState"::text = 'DRAFT' AND "toState"::text = 'CONFIRMED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'DRAFT')
    OR ("fromState"::text = 'DRAFT' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'CANCELLED')
    OR ("fromState"::text = 'CONFIRMED' AND "toState"::text = 'ACTIVE')
    OR ("fromState"::text = 'ACTIVE' AND "toState"::text = 'COMPLETED')
    OR ("fromState"::text = 'COMPLETED' AND "toState"::text = 'ACTIVE')
  );

ALTER TABLE "RouteStateTransition" DROP CONSTRAINT "RouteStateTransition_reason_required";
ALTER TABLE "RouteStateTransition"
  ADD CONSTRAINT "RouteStateTransition_reason_required" CHECK (
    ("toState"::text IN ('CONFIRMED', 'ACTIVE', 'COMPLETED') AND "reason" IS NULL)
    OR (
      "toState"::text NOT IN ('CONFIRMED', 'ACTIVE', 'COMPLETED')
      AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 3 AND 500
    )
  );
