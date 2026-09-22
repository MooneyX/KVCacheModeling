import { createReadStream } from 'node:fs';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_REPLAY_LIMITS, replayRunLimits } from '../../core/replay.js';
import { parseJob, loadReplayBundle } from '../../adapters/node/input';
import { executeJob } from './index';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function numberFlag(value: string, name: string, positive = false, integer = false) {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || (positive ? number <= 0 : number < 0) || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`--${name} must be a finite ${positive ? 'positive' : 'nonnegative'} ${integer ? 'safe integer' : 'number'}.`);
  }
  return number;
}

async function distinctPaths(paths: string[]) {
  const names = new Set<string>(), identities = new Set<string>();
  for (const [index, path] of paths.entries()) {
    const absolute = resolve(path);
    let canonical: string, identity: string | undefined;
    try {
      canonical = await realpath(absolute);
      const info = await stat(absolute, { bigint: true });
      if (info.ino !== 0n) identity = `${info.dev}:${info.ino}`;
    } catch (error) {
      if (index !== 2 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonical = resolve(await realpath(dirname(absolute)), basename(absolute));
    }
    const name = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (names.has(name) || (identity !== undefined && identities.has(identity))) throw new Error('Bundle, config and output paths must be distinct.');
    names.add(name);
    if (identity !== undefined) identities.add(identity);
  }
}

async function readConfig(path: string) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > DEFAULT_REPLAY_LIMITS.maxDecompressedBytes) throw new Error('Config JSON exceeds byte limit.');
    chunks.push(buffer);
  }
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))), 'Config');
}

async function main() {
  const { values, tokens } = parseArgs({ tokens: true, options: {
    bundle: { type: 'string', short: 'b' }, config: { type: 'string', short: 'c' }, output: { type: 'string', short: 'o' },
    qps: { type: 'string' }, duration: { type: 'string' }, warmup: { type: 'string' }, drain: { type: 'string' }, seed: { type: 'string' },
    'allow-js': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const seen = new Set<string>();
  for (const token of tokens) if (token.kind === 'option') {
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (values.help) {
    process.stdout.write('Usage: npm run replay -- --bundle bundle.json[.gz] --config params.json [--output result.json]\nOptions: --qps N --duration SECONDS --warmup SECONDS --drain SECONDS --seed N --allow-js --help\nConfig: exported control-ID JSON or normalized {params,strategy,overrides,mode}.\nFlags override config. Defaults: duration=5, warmup=0; QPS, drain (simMaxTime), and seed use config.\nClosed-loop Replay currently supports single-instance, 64-token pages, no superblocks, sufficient HBM capacity.\nWithout --output, JSON is written to stdout. Existing output files are never overwritten.\nRun limits: overrides.replay.options.limits. --allow-js requires trusted code; Replay JS cache hooks are not yet supported.\n');
    return;
  }
  if (!values.bundle || !values.config) throw new Error('--bundle and --config are required. Use --help for usage.');
  await distinctPaths([values.bundle, values.config, ...(values.output ? [values.output] : [])]);
  const config = await readConfig(values.config);
  const overrides = config.overrides === undefined ? {} : { ...object(config.overrides, 'overrides') };
  const replay = overrides.replay === undefined ? {} : object(overrides.replay, 'overrides.replay');
  const configuredOptions = replay.options === undefined ? {} : object(replay.options, 'overrides.replay.options');
  const options = { durationSeconds: 5, warmupSeconds: 0, ...configuredOptions };
  if (values.qps !== undefined) overrides.qps = numberFlag(values.qps, 'qps', true);
  if (values.seed !== undefined) overrides.seed = numberFlag(values.seed, 'seed', false, true);
  if (values.drain !== undefined) overrides.simMaxTime = numberFlag(values.drain, 'drain');
  if (values.duration !== undefined) options.durationSeconds = numberFlag(values.duration, 'duration', true);
  if (values.warmup !== undefined) options.warmupSeconds = numberFlag(values.warmup, 'warmup');
  const { bundle } = await loadReplayBundle(values.bundle);
  const job = parseJob({ ...config, overrides: { ...overrides, replay: { ...replay, bundle, options } } });
  if (job.mode === 'js' && !values['allow-js']) throw new Error('JavaScript strategies require --allow-js and must be trusted; this process is not a sandbox.');
  const result = executeJob(job);
  const json = JSON.stringify(result, null, 2) + '\n';
  const limits = replayRunLimits(job.overrides?.replay?.options.limits);
  if (Buffer.byteLength(json, 'utf8') > limits.maxResultBytes) throw new Error(`Replay result exceeds maxResultBytes ${limits.maxResultBytes}.`);
  if (values.output) await writeFile(values.output, json, { flag: 'wx' });
  else process.stdout.write(json);
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
