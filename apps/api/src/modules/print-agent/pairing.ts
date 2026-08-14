/**
 * Привязка обработчика печати к системе.
 *
 * Администратор выпускает одноразовый код, человек переносит его на компьютер
 * флориста, обработчик меняет код на собственный токен. После обмена код
 * недействителен навсегда.
 *
 * КОД ОДИН НА ВСЮ СИСТЕМУ. Площадка одна (`FUL-010`), поэтому и активный код
 * один: `activeKey` равен постоянному `ACTIVE`, уникальный индекс не даёт
 * появиться второму. У кода активации человека область уже — там `activeKey`
 * равен `userId`, — но приём тот же, и это не совпадение: «не более одной
 * активной записи» выражается индексом, а не проверкой в коде, потому что два
 * одновременных запроса прошли бы обе проверки.
 *
 * Именно единственность активного кода делает возможным хранение Argon2id:
 * такой хеш принципиально неискуем — соль у каждой строки своя, — но искать и
 * не нужно, активная строка заведомо одна, и проверить нужно ровно её.
 */

import type { Role } from '@fl/shared';
import { AppError } from '../../platform/errors.js';
import type { Database } from '../../platform/db.js';
import type { TransactionClient } from '../auth/sessions.js';
import { checkLockout, registerFailure, resetFailures } from '../auth/lockout.js';
import { writeAudit } from '../audit/service.js';
import {
  PAIRING_CODE_TTL_MS,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  hashDeviceToken,
  hashPairingCode,
  isValidPairingCode,
  normalizePairingCode,
  verifyPairingCode,
} from './crypto.js';
import { PRIMARY_SENTINEL, publishDeviceEvent } from './devices.js';

/** Постоянное значение `activeKey`: активный код один на всю систему. */
const ACTIVE_SENTINEL = 'ACTIVE';

/**
 * Advisory-блокировка выпуска и погашения кода.
 *
 * Сериализует «погасить прежний, создать новый»: без неё два одновременных
 * выпуска оба увидели бы отсутствие активного кода и оба попытались бы его
 * создать. Уникальный индекс отклонил бы второй сырой ошибкой — то есть 500
 * вместо понятного результата.
 */
const PAIRING_LOCK = 'print-agent:pairing';

async function lockPairing(tx: TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${PAIRING_LOCK}))`;
}

export interface PairingActor {
  userId: string;
  roles: readonly Role[];
}

export interface RequestContext {
  ip: string;
  userAgent: string | null;
}

export interface IssuedPairingCode {
  /** Открытый код. Показывается администратору ОДИН раз и больше не восстановим. */
  code: string;
  /** Он же в читаемом виде `ABCD-EFGH`. Дефис в значение не входит. */
  display: string;
  expiresAt: string;
}

/**
 * Выпуск кода привязки.
 *
 * Повторный выпуск инвалидирует предыдущий код: администратор, выпустивший
 * новый, обязан быть уверен, что старый листок бумаги больше ничего не даёт.
 *
 * Счётчики перебора сбрасываются здесь намеренно. Они защищают КОНКРЕТНЫЙ
 * секрет: попытки, накопленные против отменённого кода, к новому отношения
 * не имеют. Заодно это единственный честный способ снять блокировку, которую
 * посторонний мог накопить чужими попытками, — не отключая защиту вовсе.
 */
export async function issuePairingCode(
  db: Database,
  config: { PRINT_AGENT_PAIRING_PEPPER: string },
  actor: PairingActor,
  context: RequestContext,
): Promise<IssuedPairingCode> {
  const code = generatePairingCode();
  // Argon2 намеренно медленный: считаем ДО транзакции, чтобы не держать
  // advisory-блокировку всё это время.
  const codeHash = await hashPairingCode(code, config.PRINT_AGENT_PAIRING_PEPPER);
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

  await db.$transaction(async (tx) => {
    await lockPairing(tx);

    await tx.printAgentPairingCode.updateMany({
      where: { activeKey: { not: null } },
      data: { activeKey: null, invalidatedAt: new Date() },
    });

    const created = await tx.printAgentPairingCode.create({
      data: {
        codeHash,
        expiresAt,
        activeKey: ACTIVE_SENTINEL,
        issuedById: actor.userId,
      },
      select: { id: true },
    });

    await resetFailures(tx, [...LOCKOUT_KEYS_GLOBAL]);

    // В аудит уходит срок действия, но НЕ код: журнал не должен быть местом,
    // где код можно прочитать после выдачи.
    await writeAudit(tx, {
      action: 'PRINT_AGENT_PAIRING_CODE_ISSUED',
      entityType: 'PrintAgentPairingCode',
      entityId: created.id,
      actorUserId: actor.userId,
      actorRoles: actor.roles,
      newValue: { expiresAt: expiresAt.toISOString() },
      ip: context.ip,
      userAgent: context.userAgent,
    });
  });

  return { code, display: formatPairingCode(code), expiresAt: expiresAt.toISOString() };
}

/**
 * Ключи ограничения перебора.
 *
 * Считаются отдельно по адресу и по системе. Код один на всю систему, поэтому
 * перебор с сотни адресов по одному коду — реальный сценарий, и защита только
 * по IP его бы не заметила. Общий ключ сбрасывается выпуском нового кода,
 * так что заблокировать привязку навсегда чужими попытками нельзя.
 */
const LOCKOUT_KEYS_GLOBAL = ['print-pair:global'] as const;

function lockoutKeysFor(ip: string): string[] {
  return [...LOCKOUT_KEYS_GLOBAL, `print-pair:ip:${ip}`];
}

export interface PairingRequest {
  code: string;
  /** Имя компьютера, сообщённое обработчиком. */
  deviceName: string;
  os: string | null;
  agentVersion: string | null;
  defaultPrinterName: string | null;
}

export interface PairingResult {
  deviceId: string;
  name: string;
  /** Токен устройства. Выдаётся ОДИН раз и больше не восстановим. */
  token: string;
  isPrimary: boolean;
}

/**
 * Отказ привязки всегда выглядит одинаково.
 *
 * Истёк, погашен, не существовал, набран с ошибкой — снаружи это один и тот же
 * ответ. Различать их означало бы подтверждать угадавшему, что код существует
 * и осталось лишь дождаться срока.
 */
function pairingRejected(reason: string): AppError {
  return new AppError('UNAUTHENTICATED', {
    message: reason,
    publicMessage: 'Код привязки не подошёл. Попросите администратора выпустить новый.',
  });
}

/**
 * Обмен кода на токен устройства.
 *
 * Маршрут открыт без пользовательской авторизации — иначе привязать компьютер
 * было бы нечем, — и поэтому защищён ограничением перебора на уровне базы.
 *
 * ПЕРВОЕ УСТРОЙСТВО СТАНОВИТСЯ ОСНОВНЫМ. Система, где привязан ровно один
 * компьютер и он ничего не печатает, потому что «основной не назначен», —
 * это лишний шаг, о котором никто не догадается. Второе и следующие
 * регистрируются неосновными: основное меняет только ADMIN осознанно.
 */
export async function redeemPairingCode(
  db: Database,
  config: { PRINT_AGENT_PAIRING_PEPPER: string },
  input: PairingRequest,
  context: RequestContext,
): Promise<PairingResult> {
  const keys = lockoutKeysFor(context.ip);

  const lockout = await checkLockout(db, keys);
  if (lockout.locked) {
    throw new AppError('RATE_LIMITED', {
      message: 'pairing attempts locked',
      publicMessage: 'Слишком много попыток. Подождите и попробуйте снова.',
      details: { retryAfterSeconds: lockout.retryAfterSeconds },
    });
  }

  const normalized = normalizePairingCode(input.code);

  // Форма кода проверяется ДО обращения к базе, но неудачей считается так же:
  // иначе по времени ответа было бы видно, дошёл ли ввод до проверки хеша.
  const candidate = isValidPairingCode(normalized)
    ? await db.printAgentPairingCode.findFirst({
        where: { activeKey: ACTIVE_SENTINEL },
        select: { id: true, codeHash: true, expiresAt: true },
      })
    : null;

  const matches =
    candidate !== null &&
    candidate.expiresAt.getTime() > Date.now() &&
    (await verifyPairingCode(candidate.codeHash, normalized, config.PRINT_AGENT_PAIRING_PEPPER));

  if (!matches) {
    await db.$transaction(async (tx) => {
      await registerFailure(tx, keys);
    });
    throw pairingRejected('pairing code rejected');
  }

  const token = generateDeviceToken();
  const tokenHash = hashDeviceToken(token);

  const result = await db.$transaction(async (tx) => {
    await lockPairing(tx);

    // Основное устройство ищется под той же блокировкой: «основных нет»
    // и «создаю основного» обязаны быть одним неделимым решением.
    const existingPrimary = await tx.printAgentDevice.findFirst({
      where: { primaryKey: { not: null } },
      select: { id: true },
    });
    const isPrimary = existingPrimary === null;

    // Устройство создаётся ДО погашения кода, и это не небрежность.
    //
    // Погашенный код обязан указывать на устройство, которое он создал
    // (CHECK базы `PrintAgentPairingCode_consumed_has_device`): «код потрачен,
    // а рабочего места нет» — состояние, из которого нет выхода, потому что
    // выпустить второй код администратор может, а понять, что случилось
    // с первым, — уже нет. Обратный порядок такое состояние создавал бы,
    // пусть и на миг внутри транзакции.
    //
    // Проигравший гонку ничего за собой не оставляет: транзакция откатывается
    // целиком, вместе с этим устройством и его токеном.
    const device = await tx.printAgentDevice.create({
      data: {
        name: input.deviceName,
        state: 'CONNECTED',
        tokenHash,
        primaryKey: isPrimary ? PRIMARY_SENTINEL : null,
        os: input.os,
        agentVersion: input.agentVersion,
        defaultPrinterName: input.defaultPrinterName,
        lastSeenAt: new Date(),
        createdById: null,
        pairedAt: new Date(),
      },
      select: { id: true, name: true },
    });

    // Погашение — условный UPDATE, а не проверка «до».
    //
    // Два одновременных обмена одним кодом прочитали бы одну и ту же активную
    // строку и оба сочли бы код действительным. Здесь выигрывает ровно один:
    // проигравший видит `count === 0`, и вся его транзакция откатывается —
    // ни устройства, ни токена, ни записи в журнале от него не остаётся.
    //
    // Устройство проставляется тем же UPDATE: «погашен» и «кем погашен» —
    // одно решение, а не два.
    const consumed = await tx.printAgentPairingCode.updateMany({
      where: {
        id: candidate.id,
        activeKey: ACTIVE_SENTINEL,
        consumedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { activeKey: null, consumedAt: new Date(), deviceId: device.id },
    });

    if (consumed.count === 0) {
      throw pairingRejected('pairing code already spent');
    }

    await resetFailures(tx, keys);

    // Автор — не человек: код предъявил компьютер. Ни токена, ни кода, ни
    // имени принтера в записи нет.
    await writeAudit(tx, {
      action: 'PRINT_AGENT_DEVICE_PAIRED',
      entityType: 'PrintAgentDevice',
      entityId: device.id,
      actorUserId: null,
      actorRoles: [],
      newValue: { pairingCodeId: candidate.id, isPrimary },
      ip: context.ip,
      userAgent: context.userAgent,
      source: 'worker',
    });
    await publishDeviceEvent(tx, device.id, 'PAIRED');

    return { deviceId: device.id, name: device.name, isPrimary };
  });

  return { ...result, token };
}
