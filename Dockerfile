# Production-образ: один Node-процесс обслуживает API и собранный web-клиент.
# Версия Node зафиксирована и совпадает с .nvmrc, engines, dev-образом и CI.

# ---------- Этап 1: зависимости для сборки ----------
FROM node:24.19.0-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund

# ---------- Этап 2: сборка ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json prisma.config.ts ./
COPY prisma prisma
COPY packages packages
COPY apps apps
RUN npx prisma generate \
  && npm run build -w @fl/shared \
  && npm run build -w @fl/web \
  && npm run build -w @fl/api

# ---------- Этап 3: production-зависимости ----------
# CLI Prisma входит в обычные зависимости, а не в dev: миграции применяются
# из этого же образа командой `npx prisma migrate deploy`. Будь он dev-зависимостью,
# npx попытался бы скачать пакет во время выкатки — то есть выкатка зависела бы
# от доступности реестра npm и ставила бы неизвестно какую версию.
FROM deps AS prod-deps
WORKDIR /app
RUN npm ci --omit=dev --no-audit --no-fund \
  && grep -qE '"version"[[:space:]]*:[[:space:]]*"7\.9\.1"' node_modules/prisma/package.json

# ---------- Этап 4: рантайм ----------
FROM node:24.19.0-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Moscow \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/prisma prisma
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
# Системные файлы приложения: геометрия МКАД поставляется вместе с образом,
# иначе расстояние за МКАД не с чего считать.
COPY --from=build /app/apps/api/assets apps/api/assets
COPY --from=build /app/apps/web/dist apps/web/dist

# Процесс работает от непривилегированного пользователя.
USER node

EXPOSE 3000

# Проба совпадает с readiness приложения: контейнер считается здоровым,
# только когда база действительно отвечает.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
