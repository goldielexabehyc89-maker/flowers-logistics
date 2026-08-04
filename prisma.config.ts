/**
 * Конфигурация Prisma CLI.
 *
 * В Prisma 7 строка подключения больше не хранится в schema.prisma: она задаётся здесь
 * и читается из переменной окружения. В репозиторий строка подключения не попадает.
 *
 * Prisma 7 не загружает .env автоматически — при запуске вне docker compose
 * переменные окружения должны быть заданы явно (см. README).
 */

import { defineConfig } from 'prisma/config';

// Строка подключения добавляется только если она задана. Генерация клиента к базе
// не обращается и должна работать при сборке образа, где DATABASE_URL нет и быть не должно.
// Командам миграций строка нужна: без неё Prisma сама сообщит об отсутствии datasource.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl === undefined || databaseUrl === '' ? {} : { datasource: { url: databaseUrl } }),
});
