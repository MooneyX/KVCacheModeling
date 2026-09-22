import { join } from 'node:path';
import { serverConfig } from './config';
import { createTaskServer } from './http';

const config = serverConfig();
const app = createTaskServer(config, join(__dirname, 'runner.cjs'));
app.server.listen(config.port, config.host, () => {
  console.log(`Simulation server listening on http://${config.host}:${config.port}`);
  process.send?.({ type: 'ready' });
});
app.server.on('error', error => { console.error(error); void stop(1); });
let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  try { await app.close(); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop(); });
if (process.connected) {
  process.on('message', message => { if ((message as { type?: string })?.type === 'shutdown') void stop(); });
  process.on('disconnect', () => { void stop(); });
}
