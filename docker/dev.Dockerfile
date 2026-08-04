# Образ для локальной разработки и запуска команд проекта.
# Версия Node зафиксирована и совпадает с .nvmrc, engines, CI и production-образом.
FROM node:24.19.0-bookworm-slim

# openssl нужен Prisma schema engine; ca-certificates — для доступа к registry и БД по TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV TZ=Europe/Moscow
WORKDIR /workspace
