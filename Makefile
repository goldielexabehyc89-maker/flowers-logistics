# Команды выкатки.
#
# Универсальной команды вида `deploy ENV=...` не существует намеренно: staging
# и production имеют разные команды, конфигурации и цели, и каждая отказывается
# работать с чужим окружением.
#
#   make deploy-staging    VERSION=<полный-40-символьный-sha>
#   make deploy-staging    VERSION=<полный-40-символьный-sha> DRY_RUN=1
#   make deploy-production VERSION=<полный-40-символьный-sha>
#   make deploy-production VERSION=<полный-40-символьный-sha> DRY_RUN=1
#
# `--dry-run` как аргумент make не используется: его перехватывает сам make.
# Переключатель передаётся переменной DRY_RUN=1.

SHELL := /usr/bin/env bash

VERSION ?=
DRY_RUN ?=

DRY_RUN_FLAG := $(if $(DRY_RUN),--dry-run,)

.PHONY: deploy-staging deploy-production help

help:
	@echo "make deploy-staging    VERSION=<sha> [DRY_RUN=1]"
	@echo "make deploy-production VERSION=<sha> [DRY_RUN=1]"

deploy-staging:
	@./deploy/scripts/deploy-staging.sh --version "$(VERSION)" $(DRY_RUN_FLAG)

deploy-production:
	@./deploy/scripts/deploy-production.sh --version "$(VERSION)" $(DRY_RUN_FLAG)
