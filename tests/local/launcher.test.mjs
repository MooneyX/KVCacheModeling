import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, startLocal } from '../../scripts/local.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'))[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('local deployment and Vite development both run server tasks and release ports', { timeout: 120_000 }, async () => {
  const port = await freePort();
  let webPort = await freePort();
  while (webPort === port) webPort = await freePort();
  for (const dev of [false, true]) {
    let app, taskId;
    try {
      app = await startLocal(parseOptions(['--skip-install', '--no-open', '--port', String(port), '--web-port', String(webPort), ...(dev ? ['--dev'] : [])]));
      const health = await (await fetch(app.url + '/api/health')).json();
      assert.equal(health.execution, 'server');
      const page = await (await fetch(app.url)).text();
      assert.ok(page.includes('serverTasks'));
      if (dev) assert.ok(page.includes('/@vite/client'), 'development page must provide HMR');
      const login = await fetch(app.url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url }, body: '{}' });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const created = await fetch(app.url + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: app.url },
        body: JSON.stringify({ kind: 'simulation', jobs: [fixture], requestId: crypto.randomUUID(), label: 'Local launcher smoke test' }) });
      assert.equal(created.status, 202);
      taskId = (await created.json()).id;
      let task;
      for (let count = 0; count < 100; count++) {
        task = await (await fetch(app.url + '/api/tasks/' + taskId, { headers: { Cookie: cookie } })).json();
        if (task.status === 'completed' || task.status === 'failed') break;
        await delay(100);
      }
      assert.equal(task.status, 'completed', task.error);
      const download = await (await fetch(app.url + '/api/tasks/' + taskId + '/download', { headers: { Cookie: cookie } })).json();
      assert.equal(download.points[0].result.avgTtft, fixture.summary.avgTtft);
      assert.ok(existsSync(resolve('.runtime/local/tasks', taskId, 'meta.json')));
    } finally {
      if (app) { await app.stop(); rmSync(app.logfile, { force: true }); }
      if (taskId) rmSync(resolve('.runtime/local/tasks', taskId), { recursive: true, force: true });
    }
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }));
    if (dev) await assert.rejects(fetch(`http://127.0.0.1:${webPort}`, { signal: AbortSignal.timeout(1500) }));
    assert.equal(existsSync(resolve('.runtime/local/launcher.json')), false);
  }
});

test('server child reports readiness and shuts down on parent disconnect', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const dir = resolve('.runtime/local-ipc-test');
  const child = fork(resolve('dist/node/server.cjs'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SIM_DATA_DIR: dir, SIM_ACCESS_TOKEN: '', PUBLIC_ORIGIN: '' } });
  child.stderr.resume();
  try {
    const message = await once(child, 'message');
    assert.equal(message[0].type, 'ready');
    const exited = once(child, 'exit');
    child.disconnect();
    const [code] = await exited;
    assert.equal(code, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
