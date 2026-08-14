-- Локальный обработчик автоматической печати (`FUL-010`).
--
-- Миграция расширяет СУЩЕСТВУЮЩУЮ очередь печати и добавляет машинный контур
-- обработчика. Второй очереди, второго снимка бланка и второго генератора PDF
-- здесь нет намеренно: `OrderPrintForm`, `OrderPrintJob` и `PrintJobState`
-- остаются единственными.
--
-- Значения `PrintJobState` только ДОБАВЛЯЮТСЯ. Ни одно старое значение не
-- переименовано и не удалено: строки, созданные до появления обработчика,
-- обязаны читаться прежним смыслом. `PENDING` и есть «в очереди» — отдельного
-- `QUEUED` нет, иначе каждый запрос был бы обязан вечно перечислять оба
-- значения, и первый же забытый список тихо потерял бы часть заданий.

-- CreateEnum
CREATE TYPE "PrintDocumentKind" AS ENUM ('ORDER_FORM', 'TEST_PAGE');

-- CreateEnum
CREATE TYPE "PrintAgentDeviceState" AS ENUM ('CONNECTED', 'DISCONNECTED', 'REVOKED');

-- AlterEnum
--
-- PostgreSQL 16 допускает несколько ADD VALUE в одной транзакции; использовать
-- новое значение в ней же нельзя, и эта миграция его не использует.
ALTER TYPE "PrintJobState" ADD VALUE 'CLAIMED';
ALTER TYPE "PrintJobState" ADD VALUE 'PRINTING';
ALTER TYPE "PrintJobState" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "PrintJobState" ADD VALUE 'CANCELLED';

-- AlterTable
--
-- `orderId`, `printFormId` и `attempt` становятся NULL-допустимыми ТОЛЬКО ради
-- тестовой страницы: у неё нет ни заказа, ни бланка. Ослабления инварианта не
-- происходит — обязательность переносится в CHECK ниже и начинает зависеть от
-- вида документа. Существующие строки остаются заполненными.
ALTER TABLE "OrderPrintJob" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" UUID,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "deviceId" UUID,
ADD COLUMN     "documentKind" "PrintDocumentKind" NOT NULL DEFAULT 'ORDER_FORM',
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastErrorMessage" TEXT,
ADD COLUMN     "printingAt" TIMESTAMP(3),
ALTER COLUMN "orderId" DROP NOT NULL,
ALTER COLUMN "printFormId" DROP NOT NULL,
ALTER COLUMN "attempt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PrintAgentDevice" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "state" "PrintAgentDeviceState" NOT NULL DEFAULT 'CONNECTED',
    "tokenHash" TEXT NOT NULL,
    "primaryKey" TEXT,
    "os" TEXT,
    "agentVersion" TEXT,
    "defaultPrinterName" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSucceededJobId" UUID,
    "lastSucceededAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintAgentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintAgentPairingCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "deviceId" UUID,
    "activeKey" TEXT,
    "issuedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintAgentPairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintAgentDevice_tokenHash_key" ON "PrintAgentDevice"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PrintAgentDevice_primaryKey_key" ON "PrintAgentDevice"("primaryKey");

-- CreateIndex
CREATE INDEX "PrintAgentDevice_state_lastSeenAt_idx" ON "PrintAgentDevice"("state", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrintAgentPairingCode_activeKey_key" ON "PrintAgentPairingCode"("activeKey");

-- CreateIndex
CREATE INDEX "PrintAgentPairingCode_expiresAt_idx" ON "PrintAgentPairingCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPrintJob_idempotencyKey_key" ON "OrderPrintJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderPrintJob_deviceId_state_idx" ON "OrderPrintJob"("deviceId", "state");

-- AddForeignKey
ALTER TABLE "OrderPrintJob" ADD CONSTRAINT "OrderPrintJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PrintAgentDevice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderPrintJob" ADD CONSTRAINT "OrderPrintJob_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintAgentDevice" ADD CONSTRAINT "PrintAgentDevice_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintAgentDevice" ADD CONSTRAINT "PrintAgentDevice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintAgentPairingCode" ADD CONSTRAINT "PrintAgentPairingCode_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PrintAgentDevice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintAgentPairingCode" ADD CONSTRAINT "PrintAgentPairingCode_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Инварианты, которых Prisma не выражает.
--
-- Prisma не моделирует CHECK-ограничения, поэтому дрейфа схемы они не вызывают.
-- Каждое из них закрывает случай, который проверкой в коде закрыть нельзя:
-- два одновременных запроса прошли бы обе проверки и оба записали бы результат.

-- Ровно один основной обработчик на всю систему.
--
-- Уникальный индекс по nullable-колонке уже запрещает две строки с одинаковым
-- значением. CHECK добавляет то, чего индекс не знает: значение может быть
-- только 'PRIMARY'. Без него ошибка в коде или ручной INSERT записали бы туда
-- два разных значения, оба прошли бы уникальность, и основных обработчиков
-- стало бы двое — то есть два бланка на один букет.
ALTER TABLE "PrintAgentDevice"
  ADD CONSTRAINT "PrintAgentDevice_primaryKey_is_sentinel"
  CHECK ("primaryKey" IS NULL OR "primaryKey" = 'PRIMARY');

-- Отозванное устройство не может быть основным.
--
-- Иначе отзыв компьютера оставил бы систему с основным обработчиком, который
-- заведомо не может печатать, и очередь встала бы молча.
ALTER TABLE "PrintAgentDevice"
  ADD CONSTRAINT "PrintAgentDevice_revoked_is_not_primary"
  CHECK ("primaryKey" IS NULL OR "state" <> 'REVOKED');

-- Отзыв и его время неразделимы.
ALTER TABLE "PrintAgentDevice"
  ADD CONSTRAINT "PrintAgentDevice_revoked_has_timestamp"
  CHECK (("state" = 'REVOKED') = ("revokedAt" IS NOT NULL));

-- Не более одного активного кода привязки во всей системе.
--
-- Область здесь шире, чем у `ActivationCode`: там `activeKey` равен `userId`
-- («один активный код на человека»), здесь площадка одна и код общий, поэтому
-- значение постоянно. Именно это и позволяет искать код по Argon2id-хешу,
-- который принципиально неискуем: активная строка заведомо одна.
ALTER TABLE "PrintAgentPairingCode"
  ADD CONSTRAINT "PrintAgentPairingCode_activeKey_is_sentinel"
  CHECK ("activeKey" IS NULL OR "activeKey" = 'ACTIVE');

-- Погашенный или инвалидированный код активным не остаётся.
ALTER TABLE "PrintAgentPairingCode"
  ADD CONSTRAINT "PrintAgentPairingCode_spent_is_not_active"
  CHECK ("activeKey" IS NULL OR ("consumedAt" IS NULL AND "invalidatedAt" IS NULL));

-- Погашенный код обязан указывать на устройство, которое он создал.
ALTER TABLE "PrintAgentPairingCode"
  ADD CONSTRAINT "PrintAgentPairingCode_consumed_has_device"
  CHECK ("consumedAt" IS NULL OR "deviceId" IS NOT NULL);

-- Вид документа определяет обязательные поля задания.
--
-- Бланк без заказа и без снимка — это документ без содержимого; тестовая
-- страница с заказом — бланк, выданный за проверку принтера. Ни то, ни другое
-- не должно существовать, и решает это база, а не вызывающий код.
ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_document_kind_shape"
  CHECK (
    ("documentKind" = 'ORDER_FORM'
      AND "orderId" IS NOT NULL
      AND "printFormId" IS NOT NULL
      AND "attempt" IS NOT NULL)
    OR
    ("documentKind" = 'TEST_PAGE'
      AND "orderId" IS NULL
      AND "printFormId" IS NULL
      AND "attempt" IS NULL)
  );

-- Задание, взятое обработчиком, обязано называть обработчика.
--
-- Без этого `CLAIMED` без устройства выглядел бы как взятое задание, которое
-- некому вернуть в очередь: ни повторить, ни отменить его автоматика не смогла бы.
ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_claimed_has_device"
  CHECK ("state" NOT IN ('CLAIMED', 'PRINTING') OR "deviceId" IS NOT NULL);

-- «Напечатано» по-прежнему именное, но подтвердить может и машина.
--
-- Прежнее правило (`20260821090000`) требовало `completedById`, и его
-- собственный комментарий объяснял почему: «в MVP физической службы печати
-- нет, и подтверждает человек». Служба появилась, и требование человека стало
-- бы означать, что успешную машинную печать записать нельзя вовсе.
--
-- Смысл правила при этом сохраняется полностью: отметка не может быть
-- анонимной. Изменилось только то, что автором признаётся ещё и устройство —
-- ровно одно из двух, и по этому же полю ручная отметка остаётся отличима
-- от машинной.
ALTER TABLE "OrderPrintJob"
  DROP CONSTRAINT "OrderPrintJob_printed_is_complete";

ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_printed_is_complete"
  CHECK (
    "state" <> 'PRINTED'
    OR (
      "completedAt" IS NOT NULL
      AND ("completedById" IS NOT NULL OR "deviceId" IS NOT NULL)
    )
  );

-- Разбор тоже обязан быть назван безопасным кодом.
--
-- Тот же довод, что у `OrderPrintJob_error_is_named`: `NEEDS_REVIEW` без
-- причины — это «разберись сам», отправленное человеку, который как раз
-- и не знает, что случилось.
ALTER TABLE "OrderPrintJob"
  ADD CONSTRAINT "OrderPrintJob_review_is_named"
  CHECK (
    "state" <> 'NEEDS_REVIEW'
    OR ("lastErrorCode" IS NOT NULL AND "lastErrorAt" IS NOT NULL)
  );
