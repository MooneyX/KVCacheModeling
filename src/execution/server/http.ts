import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync, realpathSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { TaskQueue } from './queue';
import { HttpError, validateSubmission } from './input';
import type { ServerConfig } from './config';

async function body(req: IncomingMessage, limit: number): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createTaskServer(config: ServerConfig, runnerPath: string) {
  mkdirSync(config.dataDir, { recursive: true });
  const webRoot = existsSync(config.webDir) ? realpathSync(config.webDir) : resolve(config.webDir);
  const dataRoot = realpathSync(config.dataDir);
  if (dataRoot === webRoot || dataRoot.startsWith(webRoot + sep) || webRoot.startsWith(dataRoot + sep)) {
    throw new Error('Task data and public web directories must be separate.');
  }
  const secretPath = join(config.dataDir, 'session-secret');
  if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const secret = readFileSync(secretPath, 'utf8') + config.token;
  const queue = new TaskQueue(config, runnerPath);
  const attempts = new Map<string, { count: number; until: number }>();
  function signature(payload: string) { return createHmac('sha256', secret).update(payload).digest('hex'); }
  function owner(req: IncomingMessage) {
    const value = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('sim_session='))?.slice(12);
    if (!value) throw new HttpError(401, 'Connect to the simulation service first.');
    const [id, expires, sig] = value.split('.');
    if (!/^[a-f0-9-]{36}$/.test(id || '') || !sig || !equal(sig, signature(`${id}.${expires}`)) || Number(expires) < Date.now()) {
      throw new HttpError(401, 'Session expired; reconnect to the service.');
    }
    return id;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const expectedOrigin = config.publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new HttpError(403, 'Cross-origin requests are disabled.');
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are disabled.');
        if (req.method === 'GET' && url.pathname === '/api/health') {
          json(res, 200, { execution: 'server', engineVersion: queue.engineVersion, authRequired: !!config.token, concurrency: config.concurrency, maxJobs: config.maxJobs });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/session') {
          const address = req.socket.remoteAddress || 'unknown';
          for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
          const attempt = attempts.get(address) || { count: 0, until: Date.now() + 60_000 };
          if (attempt.count >= 10 || attempts.size >= 1000) throw new HttpError(429, 'Too many connection attempts. Try again later.');
          const input = await body(req, 4096) as { token?: string };
          if (config.token && (typeof input?.token !== 'string' || !equal(input.token, config.token))) {
            attempt.count++; attempts.set(address, attempt);
            throw new HttpError(401, 'Invalid access key.');
          }
          let id: string;
          try { id = owner(req); } catch { id = randomUUID(); }
          const payload = `${id}.${Date.now() + 7 * 24 * 60 * 60_000}`;
          res.setHeader('Set-Cookie', `sim_session=${payload}.${signature(payload)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=604800${config.secureCookie ? '; Secure' : ''}`);
          json(res, 200, { connected: true });
          return;
        }
        const user = owner(req);
        if (url.pathname === '/api/tasks') {
          if (req.method === 'GET') { json(res, 200, queue.list(user)); return; }
          if (req.method === 'POST') {
            const task = queue.submit(user, validateSubmission(await body(req, config.bodyBytes), config));
            json(res, 202, task); return;
          }
        }
        const match = /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(points|cancel|download))?$/.exec(url.pathname);
        if (match) {
          const [, id, action] = match;
          if (req.method === 'GET' && !action) { json(res, 200, queue.get(id, user)); return; }
          if (req.method === 'GET' && action === 'points') {
            json(res, 200, queue.points(id, user, Number(url.searchParams.get('after') || 0))); return;
          }
          if (req.method === 'POST' && action === 'cancel') { json(res, 200, queue.cancel(id, user)); return; }
          if (req.method === 'DELETE' && !action) { queue.remove(id, user); json(res, 200, { deleted: true }); return; }
          if (req.method === 'GET' && action === 'download') {
            const release = queue.acquireDownload(id, user);
            res.once('close', release);
            res.once('finish', release);
            const task = queue.get(id, user);
            const input = queue.input(id, user);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="simulation-${id}.json"`, 'Cache-Control': 'no-store' });
            res.write('{"task":' + JSON.stringify(task) + ',"input":' + JSON.stringify(input) + ',"points":[');
            for (let i = 0; i < task.completed; i++) {
              if (res.destroyed) return;
              const point = queue.points(id, user, i, 1).points[0];
              if (!res.write((i ? ',' : '') + JSON.stringify(point))) {
                await new Promise<void>(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
              }
            }
            res.end(']}'); return;
          }
        }
        throw new HttpError(404, 'API route not found.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Invalid URL.'); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.'))) throw new HttpError(404, 'Not found.');
      const file = resolve(config.webDir, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(resolve(config.webDir) + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'Not found.');
      if (!realpathSync(file).startsWith(webRoot + sep)) throw new HttpError(404, 'Not found.');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof HttpError)) console.error(error);
      json(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Internal server error.' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.setTimeout(120_000);
  return { server, queue, async close() {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const deadline = setTimeout(() => server.closeAllConnections(), 5000);
    try { await queue.close(); server.closeIdleConnections(); await closed; }
    finally { clearTimeout(deadline); }
  } };
}
