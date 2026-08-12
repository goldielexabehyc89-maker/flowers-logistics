#!/usr/bin/env node
/**
 * Бюджет матрицы в конфигурации дорожного графа.
 *
 * `valhalla_build_config` выдаёт обоим нужным профилям 2500 пар — это матрица
 * 50×50. Приложение считает день из 60 точек, то есть 3600 маршрутов, и первый
 * настоящий пилот получил `400 Exceeded max locations: 2500` ещё до расчёта.
 *
 * Поправить число в `/srv/.../valhalla.json` руками означало бы починить ровно
 * один каталог: следующая сборка вернула бы 2500, и никто бы не заметил.
 * Поэтому чинит pipeline, и делает это здесь.
 *
 * Скрипт живёт отдельным файлом, а не строкой внутри команды сборки, по одной
 * причине: строку внутри `docker run` нельзя проверить тестом, а сорок минут
 * сборки графа — слишком дорогая цена за опечатку в пределах.
 *
 *   node tools/geo/set-graph-limits.mjs --config <valhalla.json> --pairs 3600
 *   node tools/geo/set-graph-limits.mjs --config <valhalla.json> --pairs 3600 --verify
 *
 * Первый вызов правит файл, второй — перечитывает его отдельным процессом.
 * Проверять переменную, которую только что записал сам, бессмысленно:
 * доказательством служит то, что фактически лежит на диске и что прочитает
 * маршрутизатор.
 */

import { readFile, writeFile } from 'node:fs/promises';

/** Профили, которыми пользуется приложение. Только они и меняются. */
const PROFILES = ['auto', 'pedestrian'];

function parseArgs(argv) {
  const args = { verify: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--verify') {
      args.verify = true;
    } else if (key?.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function usage() {
  console.error(
    'Использование: set-graph-limits.mjs --config <valhalla.json> --pairs <число> [--verify]',
  );
  process.exit(2);
}

const args = parseArgs(process.argv);
const required = Number.parseInt(args.pairs ?? '', 10);
if (args.config === undefined || !Number.isInteger(required) || required < 1) usage();

let config;
try {
  config = JSON.parse(await readFile(args.config, 'utf8'));
} catch {
  // Содержимое файла наружу не выводится: в конфигурации графа встречаются
  // серверные пути, и место им не в журнале сборки.
  console.error(`ОТКАЗ: конфигурация ${args.config} не читается или не разбирается`);
  process.exit(1);
}

const limits = config?.service_limits;
if (limits === undefined || limits === null || typeof limits !== 'object') {
  console.error('ОТКАЗ: конфигурация не содержит service_limits');
  process.exit(1);
}

if (args.verify) {
  for (const profile of PROFILES) {
    const actual = limits[profile]?.max_matrix_location_pairs;
    if (!Number.isInteger(actual) || actual < required) {
      console.error(
        `ОТКАЗ: бюджет профиля ${profile} равен ${String(actual)}, а нужно не меньше ${required}`,
      );
      process.exit(1);
    }
  }
  console.error(`бюджет подтверждён по файлу: оба профиля >= ${required}`);
  process.exit(0);
}

for (const profile of PROFILES) {
  const profileLimits = limits[profile];
  if (profileLimits === undefined || profileLimits === null || typeof profileLimits !== 'object') {
    console.error(`ОТКАЗ: в конфигурации нет профиля ${profile}`);
    process.exit(1);
  }

  const current = profileLimits.max_matrix_location_pairs;
  if (!Number.isInteger(current) || current < required) {
    // Меняется ровно одно поле. Остальные distance/location/security limits
    // остаются такими, какими их задал `valhalla_build_config`: ослаблять их
    // без измеренного основания значило бы открыть маршрутизатор на запросы,
    // которых продукт не делает.
    profileLimits.max_matrix_location_pairs = required;
    console.error(`бюджет ${profile}: ${String(current)} -> ${required}`);
  } else {
    console.error(`бюджет ${profile}: ${current} уже достаточен`);
  }
}

await writeFile(args.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
