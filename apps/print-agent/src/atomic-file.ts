/**
 * Запись файла целиком или никак.
 *
 * ОБЫЧНАЯ ЗАПИСЬ ПОВЕРХ ЗДЕСЬ НЕДОПУСТИМА. Единственная защита от повторной
 * печати — файл с исходами заданий, и он переписывается ровно в тот момент,
 * когда документ уходит драйверу. Отключение питания посреди `writeFile`
 * оставило бы обрезанный JSON: обработчик поднялся бы с пустой памятью и
 * напечатал бы второй бланк к тому же букету.
 *
 * Поэтому: запись во временный файл, `fsync`, затем `rename`. Переименование
 * в пределах тома атомарно и в NTFS, и в файловых системах Linux, на которых
 * идут проверки. `fsync` до переименования обязателен — без него имя может
 * появиться в каталоге раньше, чем содержимое дойдёт до диска.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Права по умолчанию.
 *
 * `0o600` — не перестраховка: рядом лежит журнал заданий с номерами заказов,
 * а на рабочем месте склада у компьютера обычно не один пользователь.
 * В Windows разрешения наследуются от `%LOCALAPPDATA%`, и этот флаг там
 * безвреден.
 */
export const PRIVATE_FILE_MODE = 0o600;

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  mode: number = PRIVATE_FILE_MODE,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  // Имя временного файла случайное: два процесса обработчика (например,
  // ручной запуск поверх запущенного задания планировщика) не должны
  // дописывать друг другу в один и тот же `.tmp`.
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    const handle = await open(temporaryPath, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
