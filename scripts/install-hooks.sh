#!/usr/bin/env bash
#
# Включает версионируемые git-хуки проекта.
#
# Сам путь к хукам (core.hooksPath) хранится в .git/config и не версионируется,
# поэтому после клонирования репозитория этот скрипт нужно выполнить один раз.
#
# Использование: ./scripts/install-hooks.sh

set -euo pipefail

# Путь проекта содержит пробелы и кириллицу — все пути в кавычках,
# корень репозитория вычисляется от расположения скрипта.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd -- "${REPO_ROOT}"

git config core.hooksPath .githooks
chmod +x .githooks/*

echo "Хуки включены: core.hooksPath = $(git config --local --get core.hooksPath)"
echo
echo "Активные хуки:"
for hook in .githooks/*; do
  [ -f "${hook}" ] && echo "  $(basename -- "${hook}")"
done
echo
echo "pre-push запрещает прямой push в main: работа ведётся только через pull request."
