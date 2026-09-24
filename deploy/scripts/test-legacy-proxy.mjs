// Isolated TLS/proxy regression. No production endpoints, printers or ACME.
// CADDY_BIN and OPENSSL_BIN must point to trusted installed/pinned binaries.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const caddyBin = process.env.CADDY_BIN || 'caddy';
const opensslBin = process.env.OPENSSL_BIN || 'openssl';
const folder = await mkdtemp(path.join(os.tmpdir(), 'flowers-legacy-proxy-'));
const template = await readFile(new URL('../proxy/app.erpget.ru.caddy', import.meta.url), 'utf8');
const cert = path.join(folder, 'fixture.crt');
const key = path.join(folder, 'fixture.key');
let caddy;
let logs = '';
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
});

function command(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  command(opensslBin, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=app.erpget.ru',
    '-addext',
    'subjectAltName=DNS:app.erpget.ru,DNS:erpget.ru,DNS:staging.erpget.ru',
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const port = await freePort();
  const upstreamPort = upstream.address().port;
  const bootstrapFolder = path.join(folder, 'bootstrap');
  await mkdir(bootstrapFolder);
  await writeFile(
    path.join(bootstrapFolder, 'certificate.pem'),
    `${await readFile(cert, 'utf8')}\n${await readFile(key, 'utf8')}`,
    { mode: 0o600 },
  );
  const bootstrap = await readFile(
    new URL('../proxy/app.erpget-bootstrap.conf', import.meta.url),
    'utf8',
  );
  const bootstrapConfig = path.join(folder, 'bootstrap.conf');
  await writeFile(
    bootstrapConfig,
    bootstrap.replace('/var/lib/caddy/app.erpget-bootstrap', bootstrapFolder),
  );
  const productionConfig = path.join(folder, 'production.Caddyfile');
  await writeFile(
    productionConfig,
    template.replace('/etc/caddy/app.erpget-bootstrap/*.conf', bootstrapConfig),
  );
  const adapted = JSON.parse(
    command(caddyBin, ['adapt', '--config', productionConfig, '--adapter', 'caddyfile']),
  );
  assert.deepEqual(adapted.apps.tls.certificates.automate, ['app.erpget.ru']);
  assert.deepEqual(adapted.apps.tls.certificates.load_folders, [bootstrapFolder]);
  assert.ok(
    adapted.apps.tls.automation.policies.some(
      (policy) => policy.subjects.includes('app.erpget.ru') && policy.key_type === 'rsa2048',
    ),
  );
  await writeFile(
    productionConfig,
    template.replace('/etc/caddy/app.erpget-bootstrap/*.conf', `${folder}/absent-*.conf`),
  );
  const automatedOnly = JSON.parse(
    command(caddyBin, ['adapt', '--config', productionConfig, '--adapter', 'caddyfile']),
  );
  assert.deepEqual(automatedOnly.apps.tls.certificates.automate, ['app.erpget.ru']);
  assert.equal(automatedOnly.apps.tls.certificates.load_folders, undefined);
  // Keep the fixture entirely offline. Explicit automation was asserted above;
  // this running server uses only the fixture certificate from the same loader.
  const site = template
    .replace('app.erpget.ru {', `https://app.erpget.ru:${port} {`)
    .replace('tls force_automate {', 'tls {')
    .replace('/etc/caddy/app.erpget-bootstrap/*.conf', bootstrapConfig)
    .replace('127.0.0.1:3002', `127.0.0.1:${upstreamPort}`);
  const controls = ['erpget.ru', 'staging.erpget.ru']
    .map((host) => `https://${host}:${port} {\n tls ${cert} ${key}\n respond "control"\n}`)
    .join('\n');
  const config = path.join(folder, 'Caddyfile');
  await writeFile(
    config,
    `{
 admin off
 auto_https off
 servers {
  trusted_proxies static 127.0.0.1
 }
}
${site}
${controls}
`,
  );
  command(caddyBin, ['validate', '--config', config, '--adapter', 'caddyfile']);
  caddy = spawn(caddyBin, ['run', '--config', config, '--adapter', 'caddyfile'], {
    env: { ...process.env, XDG_DATA_HOME: folder, XDG_CONFIG_HOME: folder },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  caddy.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  caddy.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  caddy.on('error', (error) => {
    logs += error.message;
  });
  const ca = await readFile(cert);
  const request = (hostname, options = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port,
          servername: hostname,
          ca,
          rejectUnauthorized: true,
          method: 'POST',
          path: '/api/print-agent/poll',
          headers: {
            host: hostname,
            authorization: 'Bearer fixture-only',
            'x-forwarded-for': '203.0.113.99',
          },
          ...options,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.setTimeout(3000, () => req.destroy(new Error('TLS request timeout')));
      req.on('error', reject);
      req.end();
    });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await request('app.erpget.ru');
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, `Caddy did not start: ${logs}`);
  let checks = 2;
  for (const cipher of ['ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA']) {
    const legacy = {
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      ciphers: cipher,
      ecdhCurve: 'prime256v1',
      ALPNProtocols: ['http/1.1'],
    };
    const result = await request('app.erpget.ru', legacy);
    assert.equal(result.status, 200);
    const echo = JSON.parse(result.body);
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/api/print-agent/poll');
    assert.equal(echo.headers.host, 'app.erpget.ru');
    assert.equal(echo.headers.authorization, 'Bearer fixture-only');
    assert.equal(echo.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(echo.headers['x-forwarded-proto'], 'https');
    checks++;
    for (const host of ['erpget.ru', 'staging.erpget.ru']) {
      await assert.rejects(request(host, legacy), /handshake|alert|EPROTO/i);
      checks++;
    }
  }
  for (const host of ['app.erpget.ru', 'erpget.ru', 'staging.erpget.ru']) {
    for (const version of ['TLSv1.2', 'TLSv1.3']) {
      const result = await request(host, {
        minVersion: version,
        maxVersion: version,
        ciphers: 'ECDHE-RSA-AES128-GCM-SHA256',
      });
      assert.equal(result.status, 200);
      checks++;
    }
  }
  await assert.rejects(
    request('app.erpget.ru', {
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.1',
      ciphers: 'DEFAULT:@SECLEVEL=0',
    }),
    /protocol|alert|EPROTO/i,
  );
  checks++;
  console.log(
    `PASS: ${checks} TLS/proxy checks; CBC isolated to app; HTTPS trust and XFF verified.`,
  );
} finally {
  if (caddy && caddy.exitCode === null) {
    const ended = once(caddy, 'exit');
    caddy.kill('SIGTERM');
    await ended;
  }
  await new Promise((resolve) => upstream.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
