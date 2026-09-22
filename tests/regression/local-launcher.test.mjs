import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseOptions, localEnvironment, ensureFreePort, acquireLock, findNpmCli } from '../../scripts/local.mjs';

test('local launcher defaults, development flags and invalid ports', () => {
  assert.deepEqual(parseOptions([]), { dev: false, port: 8787, webPort: 5173, open: true, install: true, help: undefined });
  const dev = parseOptions(['--dev', '--port', '9100', '--web-port', '9101', '--skip-install', '--no-open']);
  assert.equal(dev.dev, true); assert.equal(dev.install, false); assert.equal(dev.open, false);
  for (const args of [['--port', '0'], ['--port', '65536'], ['--port', 'nan'], ['--dev', '--port', '5173'], ['--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
  assert.ok(existsSync(findNpmCli()));
});

test('local environment stays loopback and uses stable isolated task data', () => {
  const options = parseOptions(['--dev', '--port', '9100', '--web-port', '9101']);
  const env = localEnvironment(options, resolve('.runtime/local'));
  assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PORT, '9100');
  assert.equal(env.PUBLIC_ORIGIN, 'http://127.0.0.1:9101'); assert.equal(env.COOKIE_SECURE, 'false');
  assert.equal(env.SIM_DATA_DIR, resolve('.runtime/local/tasks'));
});

test('occupied ports are rejected without stopping the existing service', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { await assert.rejects(ensureFreePort(port), /No existing process was stopped/); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
  await ensureFreePort(port);
});

test('launcher lock rejects another active owner and never removes an invalid record', () => {
  const dir = mkdtempSync(resolve('local-lock-test-'));
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /already running/);
    release(); assert.equal(existsSync(join(dir, 'launcher.json')), false);
    writeFileSync(join(dir, 'launcher.json'), 'invalid');
    assert.throws(() => acquireLock(dir), /incomplete launcher lock/);
    assert.equal(existsSync(join(dir, 'launcher.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
