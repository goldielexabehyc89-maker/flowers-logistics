#!/usr/bin/env bash
#
# Сверка набора артефактов с манифестом.
#
# Запускается перед установкой набора на сервер и выкаткой. Fail closed:
# отсутствующий файл, другой размер или другая контрольная сумма — отказ,
# а не предупреждение. Испорченный тайловый архив выглядит как обычный файл
# ровно до того момента, когда карта покажет пустоту.

set -euo pipefail

root="${1:-}"
[ -n "$root" ] || { echo "Использование: verify-manifest.sh <каталог набора>" >&2; exit 2; }
[ -f "${root}/manifest.json" ] || { echo "Манифест не найден в ${root}" >&2; exit 1; }

node -e '
  const { createHash } = require("node:crypto");
  const { createReadStream, readFileSync, statSync } = require("node:fs");
  const path = require("node:path");

  const root = process.argv[1];
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));

  if (manifest.format !== "flowers-logistics/basemap-manifest@1") {
    console.error("Неизвестный формат манифеста");
    process.exit(1);
  }

  const sha256 = (file) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(file).on("data", (chunk) => hash.update(chunk))
        .on("end", () => resolve(hash.digest("hex")))
        .on("error", reject);
    });

  (async () => {
    for (const artifact of manifest.artifacts) {
      const file = path.join(root, artifact.path);
      const size = statSync(file).size;
      if (size !== artifact.bytes) {
        console.error(`Размер не совпал: ${artifact.path}`);
        process.exit(1);
      }
      if ((await sha256(file)) !== artifact.sha256) {
        console.error(`Контрольная сумма не совпала: ${artifact.path}`);
        process.exit(1);
      }
    }
    console.error(`Проверено файлов: ${manifest.artifacts.length}`);
  })();
' "$root"
