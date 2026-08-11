/**
 * Проверка геоартефактов, устойчивая к обрыву SSH.
 *
 * Эти проверки существуют из-за конкретного случая. Подсчёт SHA-256 набора
 * в 1,1 ГБ шёл внутри одного SSH-соединения; канал оборвался, проверка умерла
 * вместе с ним — и выкатка сообщила «подложка не совпадает с манифестом»,
 * не установив о файлах ничего. Файлы были целы, что подтвердил независимый
 * пересчёт.
 *
 * Отсюда два требования, которые здесь и проверяются:
 *   — проверка выполняется на сервере ровно один раз и переживает обрыв связи;
 *   — обвинение артефактам предъявляется ТОЛЬКО после завершившейся проверки,
 *     которая фактически установила несовпадение.
 *
 * Подменяются ssh и docker; файлы маленькие, каталоги настоящие.
 */

import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON_LIB = path.join(REPO_ROOT, 'deploy/scripts/lib/common.sh');

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';
const GRAPH_SHA = '0f'.repeat(32);

/**
 * Подменённый ssh.
 *
 * Пути в песочнице настоящие, поэтому команда просто выполняется — переписывать
 * их не нужно. Это не мелочь: полезная нагрузка запуска передаётся в base64,
 * и подстановка внутрь неё однажды испортила бы её молча.
 *
 * Отдельно моделируется обрыв: первые POLL_DROPS опросов завершаются кодом 255,
 * как настоящий ssh при разрыве канала.
 */
const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${*: -1}"
printf '%s\\n' "$cmd" >> "$SSH_LOG"

case "$cmd" in
  "d='"*)
    # Это опрос результата. Часть опросов обрывается.
    drops=0
    [ -f "$DROP_COUNTER" ] && drops="$(cat "$DROP_COUNTER")"
    if [ "\${POLL_DROPS:-0}" -gt "$drops" ]; then
      printf '%s\\n' "$((drops + 1))" > "$DROP_COUNTER"
      printf 'ssh: Connection closed by remote host\\n' >&2
      exit 255
    fi
    ;;
esac

eval "$cmd"
`;

/**
 * Подменённый docker.
 *
 * Считает каждый запуск: «проверка выполнилась ровно один раз» — утверждение
 * о фактах, а не о намерениях, и проверяться должно счётчиком.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
sleep "\${DOCKER_SLEEP:-0}"
printf 'проверка выполнена\\n'
exit "\${DOCKER_EXIT:-0}"
`;

/**
 * Тестовый шаг опроса.
 *
 * Боевые значения (`GEO_VERIFY_DELAY=10`, `GEO_VERIFY_ATTEMPTS=120`) живут
 * в `common.sh` и здесь НЕ меняются: они рассчитаны на настоящий сервер,
 * где подсчёт SHA-256 гигабайтного набора занимает минуты.
 *
 * Проверке нужна не длительность паузы, а её наличие: опрос обязан повторяться,
 * переживать обрывы и когда-нибудь сдаваться. Раньше здесь стояла настоящая
 * секунда, и один тест стоил двух-шести секунд реального времени — а вместе
 * с ними приносил зависимость от загруженности машины.
 */
const TEST_POLL_DELAY = 0.02;

/**
 * Запас попыток.
 *
 * Считается не «сколько раз», а «сколько времени»: 800 попыток по 20 мс плюс
 * запуск процесса на каждую дают около двадцати секунд ожидания при типичном
 * времени в десятки миллисекунд. Прежние 40 попыток по секунде давали тот же
 * запас, но платили за него реальным временем каждого прогона.
 */
const TEST_POLL_ATTEMPTS = 800;

/**
 * Модель долгой проверки.
 *
 * Смысл в том, что проверка ПЕРЕЖИВАЕТ запускающее соединение, а не в том,
 * сколько именно она длится. Триста миллисекунд заведомо больше времени
 * возврата запуска и заведомо меньше запаса опроса — этого достаточно,
 * и двух секунд для того же утверждения не нужно.
 */
const LONG_VERIFICATION_SECONDS = 0.3;

/**
 * Полный вывод прогона для сообщения об отказе.
 *
 * Отчёт vitest обрезает длинные значения, и по журналу CI приходилось гадать,
 * какой статус пришёл вместо ожидаемого. Сообщение проверки печатается целиком.
 */
function describeRun(result: RunResult): string {
  const spawn = result.spawnError === null ? '' : `\nзапуск: ${result.spawnError}`;
  return `\nкод: ${result.code}${spawn}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

interface RunResult {
  code: number;
  /** Почему процесс не удалось выполнить. Пусто — выполнен. */
  spawnError: string | null;
  stdout: string;
  stderr: string;
  ssh: string;
  dockerRuns: number;
}

interface SandboxOptions {
  body: string;
  /** Сколько первых опросов оборвать. */
  pollDrops?: number;
  /** Код возврата проверки: 0 успех, 10 несовпадение, 20 внутренняя ошибка. */
  dockerExit?: number;
  /** Задержка проверки в секундах: моделирует долгий подсчёт сумм. */
  dockerSleep?: number;
  attempts?: number;
  delay?: number;
}

/**
 * Заготовка репозитория для песочниц.
 *
 * Раньше каждая песочница создавала свой репозиторий: шесть запусков `git`
 * на проверку, около сотни на файл. Под нагрузкой очередной запуск процесса
 * иногда не удавался, и проверка падала с пустым выводом — то есть сообщала
 * о чём угодно, кроме настоящей причины.
 *
 * Заготовка собирается один раз и копируется: содержимое то же, запусков
 * процессов на два порядка меньше.
 */
let template: { dir: string; version: string } | null = null;

async function repositoryTemplate(): Promise<{ dir: string; version: string }> {
  if (template !== null) {
    return template;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-verify-template-'));
  await mkdir(path.join(dir, 'deploy/scripts'), { recursive: true });
  await writeFile(
    path.join(dir, 'deploy/scripts/verify-geo.mjs'),
    '// проверяющий скрипт\n',
    'utf8',
  );

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args]);
    return stdout.trim();
  };
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Проверка');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'версия');

  template = { dir, version: await git('rev-parse', 'HEAD') };
  return template;
}

async function runInSandbox(options: SandboxOptions): Promise<RunResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'geo-verify-'));
  const binDir = path.join(dir, 'bin');
  const remoteDir = path.join(dir, 'server/flowers-logistics-staging');
  const artifactsDir = path.join(dir, 'server/geo/basemap/20260806');
  const graphDir = path.join(dir, 'server/geo/valhalla/graph');
  const sshLog = path.join(dir, 'ssh.log');
  const dockerLog = path.join(dir, 'docker.log');

  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(remoteDir, 'state'), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(graphDir, { recursive: true });
  await writeFile(sshLog, '', 'utf8');
  await writeFile(dockerLog, '', 'utf8');
  await writeFile(path.join(dir, 'drops'), '0', 'utf8');

  // Маленькие тестовые файлы вместо гигабайтных наборов: проверяется механизм
  // ожидания результата, а не арифметика SHA-256.
  await writeFile(path.join(artifactsDir, 'manifest.json'), '{}\n', 'utf8');
  await writeFile(path.join(graphDir, 'tiles.tar'), 'тайлы\n', 'utf8');

  for (const [name, content] of [
    ['ssh', FAKE_SSH],
    ['docker', FAKE_DOCKER],
  ] as const) {
    const file = path.join(binDir, name);
    await writeFile(file, content, 'utf8');
    await chmod(file, 0o755);
  }

  // Настоящий репозиторий: проверяющий скрипт доставляется из дерева VERSION.
  // Заготовка копируется целиком вместе с .git — история та же, а запускать
  // git заново на каждую песочницу незачем.
  const prepared = await repositoryTemplate();
  await cp(prepared.dir, dir, { recursive: true });
  const version = prepared.version;

  await mkdir(path.join(dir, 'deploy/private'), { recursive: true });
  await writeFile(
    path.join(dir, 'deploy/private/staging.conf'),
    [
      'ENVIRONMENT_MARKER="staging"',
      'SSH_HOST="server.invalid"',
      'SSH_USER="deploy"',
      'SSH_PORT="22"',
      'HOST_FINGERPRINT="server.invalid ssh-ed25519 AAAATEST"',
      `REMOTE_DIR="${remoteDir}"`,
      'APP_DOMAIN="staging.invalid"',
      'APP_HOST_PORT="3001"',
      'IMAGE_REPOSITORY="ghcr.io/example/app"',
      'COMPOSE_PROJECT="fl-staging"',
      'COMPOSE_FILE="docker-compose.deploy.yml"',
      'ENV_FILE="staging.env"',
      'DB_VOLUME="fl-staging-db"',
      `MAP_ARTIFACTS_DIR="${artifactsDir}"`,
      `VALHALLA_GRAPH_DIR="${graphDir}"`,
      `VALHALLA_GRAPH_SHA256="${GRAPH_SHA}"`,
      'VALHALLA_IMAGE="ghcr.io/valhalla/valhalla:3.8.3@sha256:aaaa"',
      '',
    ].join('\n'),
    'utf8',
  );

  const harness = path.join(dir, 'harness.sh');
  await writeFile(
    harness,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `source "${COMMON_LIB}"`,
      `REPO_ROOT="${dir}"`,
      `VERSION="${version}"`,
      'load_environment_config STAGING "$(staging_config_file)"',
      'activate_environment STAGING',
      'prepare_known_hosts',
      options.body,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(harness, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    SSH_LOG: sshLog,
    DOCKER_LOG: dockerLog,
    DROP_COUNTER: path.join(dir, 'drops'),
    POLL_DROPS: String(options.pollDrops ?? 0),
    DOCKER_EXIT: String(options.dockerExit ?? 0),
    DOCKER_SLEEP: String(options.dockerSleep ?? 0),
    GEO_VERIFY_ATTEMPTS: String(options.attempts ?? TEST_POLL_ATTEMPTS),
    GEO_VERIFY_DELAY: String(options.delay ?? TEST_POLL_DELAY),
    VERSION_UNDER_TEST: VALID_SHA,
  };

  let code: number;
  let stdout: string;
  let stderr: string;
  let spawnError: string | null = null;
  try {
    const done = await execFileAsync(harness, [], { cwd: dir, env });
    code = 0;
    stdout = done.stdout;
    stderr = done.stderr;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    code = failure.code ?? 1;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
    // Пустой вывод при отказе означает, что процесс не запустился вовсе.
    // Без этой строки проверка сообщала бы «нет нужного текста» и молчала
    // о том, что текста не было вообще.
    spawnError = stdout === '' && stderr === '' ? (failure.message ?? 'процесс не выполнен') : null;
  }

  const dockerLogText = await readFile(dockerLog, 'utf8');

  return {
    code,
    spawnError,
    stdout,
    stderr,
    ssh: await readFile(sshLog, 'utf8'),
    dockerRuns: dockerLogText.split('\n').filter((line) => line.includes('run ')).length,
  };
}

/**
 * Обе проверки артефактов целиком. Годится только для успешных сценариев:
 * при отказе `fail` завершает выкатку, и до печати итога дело не доходит —
 * это и есть требуемое поведение.
 */
const CHECK_BODY = [
  'upload_verifier',
  'require_geo_artifacts',
  'printf "ИТОГ: успех\\n"',
  'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
].join('\n');

/**
 * Одна проверка без остановки выкатки: возвращает код, а не выходит.
 * Так виден именно статус, включая случаи, когда выкатка обязана остановиться.
 */
const STATUS_BODY = [
  'upload_verifier',
  'run_verifier_with_mount "${MAP_ARTIFACTS_DIR}" basemap "${MAP_ARTIFACTS_DIR}" "" \\',
  '  && printf "ИТОГ: успех\\n" || printf "ИТОГ: отказ\\n"',
  'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
].join('\n');

/** Штатный путь: интересует формулировка отказа, а не статус. */
const MESSAGE_BODY = [
  'upload_verifier',
  'require_geo_artifacts',
  'printf "ДОШЛИ ДО КОНЦА\\n"',
].join('\n');

describe('проверка геоартефактов переживает обрыв SSH', () => {
  // Опрос идёт тестовым шагом в двадцать миллисекунд, а не боевой секундой:
  // проверяется, что он повторяется, переживает обрывы и когда-нибудь сдаётся,
  // а не то, сколько он спит. Запас тайм-аута оставлен прежним намеренно —
  // он покрывает медленную машину, но сам по себе временем прогона не является:
  // типичный сценарий укладывается в десятки миллисекунд.
  vi.setConfig({ testTimeout: 60_000 });

  it('исходное соединение закрывается сразу, а проверка доходит до конца', async () => {
    // Проверка длится дольше, чем живёт запускающее соединение. Раньше это
    // означало её смерть; теперь запуск возвращается сразу, а результат
    // забирается отдельными короткими соединениями.
    const result = await runInSandbox({ body: CHECK_BODY, dockerSleep: LONG_VERIFICATION_SECONDS });

    expect(result.stdout, describeRun(result)).toContain('ИТОГ: успех');
    expect(result.stdout, describeRun(result)).toContain('СТАТУС: OK');

    // Запуск и опрос — разные соединения, и опрос застал проверку идущей.
    const launches = result.ssh.split('\n').filter((line) => line.includes('nohup sh'));
    const polls = result.ssh.split('\n').filter((line) => line.startsWith("d='"));
    expect(launches).toHaveLength(2);
    expect(polls.length).toBeGreaterThan(2);
  });

  it('обрыв опроса не перезапускает проверку', async () => {
    const result = await runInSandbox({ body: CHECK_BODY, pollDrops: 1 });

    expect(result.stdout, describeRun(result)).toContain('ИТОГ: успех');
    // Ровно два запуска docker: подложка и граф. Обрыв опроса не добавил
    // третьего — иначе один и тот же гигабайтный набор считался бы дважды.
    expect(result.dockerRuns).toBe(2);
  });

  it('несколько обрывов подряд тоже не перезапускают проверку', async () => {
    const result = await runInSandbox({ body: CHECK_BODY, pollDrops: 5 });

    expect(result.stdout, describeRun(result)).toContain('ИТОГ: успех');
    expect(result.dockerRuns).toBe(2);
    // Обрывы замечены и названы, а не выданы за отказ артефактов.
    expect(result.stdout).toContain('опрос прерывался');
  });

  it('после восстановления связи успешный результат принимается', async () => {
    const result = await runInSandbox({
      body: CHECK_BODY,
      pollDrops: 3,
      dockerSleep: LONG_VERIFICATION_SECONDS,
    });

    expect(result.code, describeRun(result)).toBe(0);
    expect(result.stdout, describeRun(result)).toContain('СТАТУС: OK');
  });

  it('несовпадение содержимого названо несовпадением', async () => {
    const status = await runInSandbox({ body: STATUS_BODY, dockerExit: 10 });

    expect(status.stdout, describeRun(status)).toContain('ИТОГ: отказ');
    expect(status.stdout, describeRun(status)).toContain('СТАТУС: MISMATCH');

    const message = await runInSandbox({ body: MESSAGE_BODY, dockerExit: 10 });

    expect(message.stderr).toContain('не совпадает с проверенным содержимым');
    // Единственный случай, когда обвинять артефакты можно.
    expect(message.stderr).not.toContain('НЕ признаны');
    // Отказ останавливает выкатку: до следующих шагов дело не доходит.
    expect(message.stdout).not.toContain('ДОШЛИ ДО КОНЦА');
  });

  it('внутренняя ошибка проверки не выдаётся за несовпадение', async () => {
    const status = await runInSandbox({ body: STATUS_BODY, dockerExit: 20 });

    // Сообщение несёт весь вывод: отчёт vitest обрезает длинные строки,
    // и в прошлый раз по журналу CI нельзя было понять, что именно случилось —
    // INTERNAL не пришёл, а какой статус пришёл вместо него, осталось неизвестным.
    expect(status.stdout, describeRun(status)).toContain('СТАТУС: INTERNAL');

    const message = await runInSandbox({ body: MESSAGE_BODY, dockerExit: 20 });

    expect(message.stderr).toContain('не состоялась');
    expect(message.stderr).toContain('Артефакты несовпавшими НЕ признаны');
    expect(message.stderr).not.toContain('не совпадает с проверенным содержимым');
    expect(message.stdout).not.toContain('ДОШЛИ ДО КОНЦА');
  });

  it('ожидание конечно и артефакты при этом не обвиняются', async () => {
    // Задание существует, результата нет и не будет: попытки исчерпываются.
    const result = await runInSandbox({
      body: [
        'VERIFIER_SHA256="скрипт"',
        'job="${REMOTE_DIR}/state/geo-verify/бесконечный"',
        'mkdir -p "${job}"',
        'await_verifier_result "${job}" "бесконечный" || true',
        'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
        'printf "ДЕТАЛЬ: %s\\n" "${GEO_VERIFY_DETAIL}"',
      ].join('\n'),
      attempts: 3,
      delay: 0,
    });

    expect(result.stdout).toContain('СТАТУС: TIMEOUT');
    expect(result.stdout).toContain('результат не получен за отведённое время');

    // Опрошено ровно столько раз, сколько отведено: ожидание конечно.
    const polls = result.ssh.split('\n').filter((line) => line.startsWith("d='"));
    expect(polls).toHaveLength(3);

    // Каталог задания не убран: результата не было, убирать нечего.
    expect(result.ssh).not.toContain('rm -rf ');
  });

  it('после отказа проверки не запускаются ни Valhalla, ни миграции, ни приложение', async () => {
    const result = await runInSandbox({
      body: [
        MESSAGE_BODY,
        'remote "docker compose up -d --no-build valhalla"',
        'remote "docker compose run --rm app npx prisma migrate deploy"',
        'remote "docker compose up -d --no-build app"',
      ].join('\n'),
      dockerExit: 10,
    });

    expect(result.code).not.toBe(0);
    expect(result.ssh).not.toContain('up -d');
    expect(result.ssh).not.toContain('migrate deploy');
  });

  it('результат чужого запуска не принимается', async () => {
    const result = await runInSandbox({
      body: [
        'VERIFIER_SHA256="проверяющий-скрипт"',
        'job="${REMOTE_DIR}/state/geo-verify/мой-запуск"',
        'mkdir -p "${job}"',
        // Результат от прошлой выкатки, оставшийся в каталоге.
        'printf "чужой-запуск проверяющий-скрипт 0\\n" > "${job}/result"',
        'await_verifier_result "${job}" "мой-запуск" || true',
        'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
      ].join('\n'),
      attempts: 2,
    });

    expect(result.stdout).toContain('СТАТУС: FOREIGN');
  });

  it('результат от другой версии проверяющего скрипта не принимается', async () => {
    const result = await runInSandbox({
      body: [
        'VERIFIER_SHA256="новая-версия"',
        'job="${REMOTE_DIR}/state/geo-verify/запуск"',
        'mkdir -p "${job}"',
        'printf "запуск прежняя-версия 0\\n" > "${job}/result"',
        'await_verifier_result "${job}" "запуск" || true',
        'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
      ].join('\n'),
      attempts: 2,
    });

    expect(result.stdout).toContain('СТАТУС: FOREIGN');
  });

  it('недописанный результат не принимается', async () => {
    const result = await runInSandbox({
      body: [
        'VERIFIER_SHA256="скрипт"',
        'job="${REMOTE_DIR}/state/geo-verify/запуск"',
        'mkdir -p "${job}"',
        // Кода возврата ещё нет: строка записана наполовину.
        'printf "запуск скрипт\\n" > "${job}/result"',
        'await_verifier_result "${job}" "запуск" || true',
        'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
      ].join('\n'),
      attempts: 2,
    });

    expect(result.stdout).toContain('СТАТУС: MALFORMED');
  });

  it('исчезнувшее задание не выдаётся за несовпадение', async () => {
    const result = await runInSandbox({
      body: [
        'VERIFIER_SHA256="скрипт"',
        'await_verifier_result "${REMOTE_DIR}/state/geo-verify/нет-такого" "запуск" || true',
        'printf "СТАТУС: %s\\n" "${GEO_VERIFY_STATUS}"',
      ].join('\n'),
      attempts: 2,
    });

    expect(result.stdout).toContain('СТАТУС: LOST');
  });

  it('каталог задания уникален и убирается после получения результата', async () => {
    const result = await runInSandbox({ body: CHECK_BODY });

    const created = result.ssh
      .split('\n')
      .filter((line) => line.includes('geo-verify/'))
      .map((line) => /geo-verify\/([^'"/ ]+)/.exec(line)?.[1])
      .filter((value): value is string => value !== undefined);

    // Две проверки — два разных каталога: общий предсказуемый путь однажды
    // отдал бы результат прошлой выкатки как свой.
    expect(new Set(created).size).toBe(2);
    // Свой каталог убран, чужие не тронуты.
    const removals = result.ssh.split('\n').filter((line) => line.startsWith('rm -rf '));
    expect(removals).toHaveLength(2);
    for (const removal of removals) {
      expect(removal).toContain('geo-verify/');
    }
  });

  it('права каталога и служебных файлов ограничены', async () => {
    const result = await runInSandbox({ body: CHECK_BODY });

    const launch = result.ssh.split('\n').find((line) => line.includes('nohup sh'));
    expect(launch).toBeDefined();
    expect(launch).toContain('chmod 700');
    expect(launch).toContain('chmod 600');
  });

  it('сухой прогон не обращается к серверу', async () => {
    const result = await runInSandbox({
      body: ['DRY_RUN=1', 'require_geo_artifacts', 'printf "ПРОЙДЕНО\\n"'].join('\n'),
    });

    expect(result.stdout).toContain('ПРОЙДЕНО');
    // prepare_known_hosts в песочнице выполняется до тела и ssh не вызывает.
    expect(result.ssh.trim()).toBe('');
    expect(result.dockerRuns).toBe(0);
  });
});
