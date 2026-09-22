import { spawn, fork } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    dev: { type: 'boolean', default: false },
    port: { type: 'string', default: '8787' },
    'web-port': { type: 'string', default: '5173' },
    'no-open': { type: 'boolean', default: false },
    'skip-install': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  const port = name => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`--${name} must be an integer in [1, 65535].`);
    return value;
  };
  const options = { dev: values.dev, port: port('port'), webPort: port('web-port'), open: !values['no-open'], install: !values['skip-install'], help: values.help };
  if (options.dev && options.port === options.webPort) throw new Error('API and development web ports must differ.');
  return options;
}

export function ensureFreePort(port) {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', error => reject(new Error(`127.0.0.1:${port} is unavailable (${error.code}). No existing process was stopped. Close its owner or select another port.`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve));
  });
}

export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'launcher.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try { descriptor = openSync(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new Error(`An incomplete launcher lock exists at ${path}. Check other launch windows before removing it.`); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error(`Invalid launcher lock: ${path}`);
      try { process.kill(owner.pid, 0); }
      catch (probeError) {
        if (probeError.code !== 'ESRCH') throw new Error(`Cannot verify launcher PID ${owner.pid}; refusing to replace its lock.`);
        unlinkSync(path);
        continue;
      }
      throw new Error(`A local launcher is already running (PID ${owner.pid}). Stop it with Q or Ctrl+C before rebuilding.`);
    }
    try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() })); }
    finally { closeSync(descriptor); }
    return () => {
      try { if (JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Unable to release launcher lock:', error.message); }
    };
  }
  throw new Error('Another launcher acquired the lock. Try again after it stops.');
}

export function findNpmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const npm = candidates.find(path => path && existsSync(path));
  if (!npm) throw new Error('npm was not found next to Node.js. Install the full Node.js distribution including npm.');
  return npm;
}

export function localEnvironment(options, runtime) {
  const url = `http://127.0.0.1:${options.dev ? options.webPort : options.port}`;
  return { ...process.env, HOST: '127.0.0.1', PORT: String(options.port), PUBLIC_ORIGIN: url, COOKIE_SECURE: 'false',
    SIM_DATA_DIR: join(runtime, 'tasks'), SIM_WEB_DIR: join(root, 'dist/web'), NODE_ENV: 'production',
    PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '') };
}

async function runNpm(npm, args, env, log) {
  log(`> npm ${args.join(' ')}\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npm, ...args], { cwd: root, env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', data => log(data)); child.stderr.on('data', data => log(data, true));
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} failed (exit ${code}).`)));
  });
}

async function openBrowser(url, log) {
  try {
    const child = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', error => log(`Browser did not open: ${error.message}. Open ${url} manually.\n`, true));
    child.unref();
  } catch (error) { log(`Browser did not open: ${error.message}\n`, true); }
}

export async function startLocal(options) {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 22 || (minor === 22 && patch < 2)) throw new Error('Node.js >=22.22.2 <23 is required.');
  const npm = findNpmCli();
  const runtime = join(root, '.runtime/local');
  const release = acquireLock(runtime);
  const logfile = join(runtime, `startup-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = (text, error = false) => {
    (error ? process.stderr : process.stdout).write(text);
    appendFileSync(logfile, text);
  };
  const env = localEnvironment(options, runtime);
  let backend, vite, stopped = false, closed = false, closing;
  const stop = () => closing ||= (async () => {
    stopped = true;
    if (vite) await vite.close();
    if (backend && !closed) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          log('Server shutdown is taking longer than expected; forcing this launcher-owned server to stop.\n', true);
          backend.kill();
        }, 12_000);
        backend.once('close', () => { clearTimeout(timer); resolve(); });
        if (backend.connected) backend.send({ type: 'shutdown' }, error => { if (error) backend.kill(); });
        else backend.kill();
      });
    }
    release();
  })();
  try {
    await ensureFreePort(options.port);
    if (options.dev) await ensureFreePort(options.webPort);
    log(`Local ${options.dev ? 'development' : 'deployment'} | Node ${process.version}\nLogs: ${logfile}\n`);
    if (options.install) await runNpm(npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], env, log);
    else if (!existsSync(join(root, 'node_modules/vite/package.json'))) throw new Error('Dependencies are missing; rerun without --skip-install.');
    await runNpm(npm, ['run', 'build'], env, log);
    backend = fork(join(root, 'dist/node/server.cjs'), [], { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    backend.stdout.on('data', data => log(data)); backend.stderr.on('data', data => log(data, true));
    backend.once('close', () => { closed = true; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Server readiness timed out after 30 seconds.')); }, 30_000);
      const cleanup = () => { clearTimeout(timeout); backend.off('message', message); backend.off('error', error); backend.off('close', exit); };
      const message = data => { if (data?.type === 'ready') { cleanup(); resolve(); } };
      const error = value => { cleanup(); reject(value); };
      const exit = code => { cleanup(); reject(new Error(`Server exited before readiness (${code}).`)); };
      backend.on('message', message); backend.once('error', error); backend.once('close', exit);
    });
    backend.on('error', error => log(`Server error: ${error.message}\n`, true));
    if (options.dev) {
      const { createServer } = await import('vite');
      vite = await createServer({ root, server: { host: '127.0.0.1', port: options.webPort, strictPort: true, open: false,
        proxy: { '/api': { target: `http://127.0.0.1:${options.port}` } } } });
      await vite.listen();
    }
    const url = env.PUBLIC_ORIGIN;
    const healthResponse = await fetch(url + '/api/health', { signal: AbortSignal.timeout(5000) });
    const health = await healthResponse.json();
    if (!healthResponse.ok || health.execution !== 'server') throw new Error('Server health check failed.');
    const page = await fetch(url + '/', { signal: AbortSignal.timeout(5000) });
    if (!page.ok || !(await page.text()).includes('id="serverTasks"')) throw new Error('Web page health check failed.');
    log(`\nREADY ${url}\nAPI: http://127.0.0.1:${options.port}/api/health\nTask data: ${env.SIM_DATA_DIR}\n`);
    log(health.authRequired ? 'Use your configured SIM_ACCESS_TOKEN in the page to connect.\n' : 'Local-only access; no access key required.\n');
    log(options.dev ? 'Frontend changes use Vite hot reload. Backend/core changes: stop and rerun to rebuild.\n' : 'Source changes: stop and rerun to rebuild.\n');
    log('Keep this window open. Q + Enter or Ctrl+C stops the local service; active tasks will be interrupted, saved results retained.\n');
    if (options.open) await openBrowser(url, log);
    return { url, logfile, stop, isAlive: () => !closed && !stopped };
  } catch (error) {
    log(`Startup failed: ${error.message}\n`, true);
    await stop();
    throw error;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: deploy-local.cmd [--dev] [--port 8787] [--web-port 5173] [--skip-install] [--no-open]\nDefault: npm ci, build, local server, health checks, open browser.\n--dev: frontend hot reload via Vite; simulation stays in local server processes.\n--skip-install: reuse installed dependencies (build still runs).\nOnly one launcher per workspace; occupied ports are never taken over.\nQ + Enter or Ctrl+C: stop owned services and retain task data.');
    return;
  }
  const app = await startLocal(options);
  let exiting = false;
  const input = createInterface({ input: process.stdin });
  const finish = async (failed = false) => {
    if (exiting) return;
    exiting = true; input.close(); clearInterval(monitor);
    await app.stop();
    if (process.connected) process.disconnect();
    process.exitCode = failed ? 1 : 0;
  };
  const monitor = setInterval(() => { if (!app.isAlive()) void finish(true); }, 1000);
  input.on('line', line => { if (['q', 'quit', 'exit'].includes(line.trim().toLowerCase())) void finish(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void finish(); });
  if (process.connected) {
    process.on('message', message => { if (message?.type === 'shutdown') void finish(); });
    process.on('disconnect', () => { void finish(); });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
