import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import builder from '../../scripts/build_replay_bundle.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const library = createRequire(import.meta.url)('../../dist/node/library.cjs');
const base = JSON.parse(readFileSync(join(root, 'tests/fixtures/simulation-baseline.json')))[0];
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/session-interleaved.json')));
function workspace(t) {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results/replay-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const cli = args => spawnSync(process.execPath, [join(root, 'dist/node/replay.cjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 40 * 1024 * 1024 });
const normalized = overrides => ({ params: base.params, strategy: base.strategy, overrides: { seed: 42, qps: 8, blockSize: 64, simMaxTime: 5, ...overrides } });

test('S09: real builder -> gzip/JSON -> CLI -> exported result agrees with library', async t => {
  const dir = workspace(t), input = join(dir, 'trace.jsonl'), bundlePath = join(dir, 'bundle.json.gz');
  writeFileSync(input, JSON.stringify(fixture) + '\n');
  const report = await builder.buildReplayBundle({ input, output: bundlePath });
  assert.equal(report.stats.requests, 4);
  const { bundle } = await library.loadReplayBundle(bundlePath);
  const config = normalized({ replay: { options: { durationSeconds: 0.2, warmupSeconds: 0.1 } } });
  const configPath = join(dir, 'config.json'), output = join(dir, 'result.json');
  writeFileSync(configPath, JSON.stringify(config));
  const result = cli(['--bundle', bundlePath, '--config', configPath, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const actual = JSON.parse(readFileSync(output));
  const job = library.parseJob({ ...config, overrides: { ...config.overrides, replay: { ...config.overrides.replay, bundle } } });
  const expected = JSON.parse(JSON.stringify(library.executeJob(job)));
  assert.deepEqual(actual, expected);
  assert.equal(actual.completed, 4);
  assert.equal(actual.truncated, false);
  assert.equal(actual.replay.counts.planned, 4);
  const jsonPath = join(dir, 'bundle.json'); writeFileSync(jsonPath, JSON.stringify(bundle));
  const jsonResult = cli(['--bundle', jsonPath, '--config', configPath]);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.deepEqual(JSON.parse(jsonResult.stdout), actual);
  const again = cli(['--bundle', bundlePath, '--config', configPath, '--output', output]);
  assert.notEqual(again.status, 0); assert.match(again.stderr, /EEXIST/);
  assert.deepEqual(JSON.parse(readFileSync(output)), actual);
});

test('S09: parseJob preserves replay for normalized and controls formats and rejects bad options', () => {
  const { bundle } = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/runtime-prefix.json')));
  const replay = { bundle, options: { durationSeconds: 1, warmupSeconds: 0 } };
  const controls = { pBlockSize: '64', overrides: { replay, seed: 42 } };
  const before = JSON.stringify(controls);
  const a = library.parseJob(controls), b = library.parseJob(normalized({ replay }));
  assert.deepEqual(a.overrides.replay, b.overrides.replay);
  assert.equal(a.overrides.seed, 42);
  assert.equal(JSON.stringify(controls), before);
  assert.throws(() => library.parseJob({ ...controls, overrides: { replay: { ...replay, options: { ...replay.options, arrivalModel: 'open' } } } }), /closed/);
  assert.throws(() => library.parseJob({ ...controls, mode: 'other' }), /mode/);
});

test('U5: exported Replay configuration requires a matching bundle and restores workload options immutably', t => {
  const { bundle } = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/runtime-prefix.json')));
  const workload = { source: 'replay', bundleSummary: { digest: createHash('sha256').update(JSON.stringify(bundle)).digest('hex') },
    options: { qps: 7, seed: 9, durationSeconds: 1, warmupSeconds: 0.2, simMaxTime: 2, arrivalModel: 'closed', superblocks: false } };
  const controls = { pBlockSize: '32', workload };
  assert.throws(() => library.parseJob(controls), /reselect.*bundle/);
  const input = { ...controls, overrides: { replay: { bundle } } };
  const before = structuredClone(input);
  const job = library.parseJob(input);
  assert.deepEqual(input, before);
  assert.equal(job.params.blockSize, 32);
  assert.equal(job.overrides.qps, 7);
  assert.equal(job.overrides.seed, 9);
  assert.equal(job.overrides.simMaxTime, 2);
  assert.equal(job.overrides.replay.options.durationSeconds, 1);
  assert.equal(job.overrides.replay.options.warmupSeconds, 0.2);
  assert.equal(library.parseJob({ ...input, overrides: { ...input.overrides, qps: 8 } }).overrides.qps, 8);
  const changed = structuredClone(bundle); changed.sessions[0].req[0].out++;
  assert.throws(() => library.parseJob({ ...input, overrides: { replay: { bundle: changed } } }), /digest does not match/);
  assert.throws(() => library.parseJob({ ...input, workload: { ...workload, options: { ...workload.options, seed: -1 } } }), /workload/);
  assert.throws(() => library.parseJob({ ...input, workload: { ...workload, bundleSummary: { digest: 'bad' } } }), /digest/);
  assert.throws(() => library.parseJob({ ...input, workload: { source: 'unknown' } }), /workload.source/);
  assert.equal(library.parseJob({ pBlockSize: '32' }).overrides.replay, undefined);
  assert.equal(library.parseJob({ pBlockSize: '32', workload: { source: 'synthetic' } }).overrides.replay, undefined);
  const dir = workspace(t), configPath = join(dir, 'config.json'), bundlePath = join(dir, 'bundle.json');
  writeFileSync(configPath, JSON.stringify(controls)); writeFileSync(bundlePath, JSON.stringify(bundle));
  const result = cli(['--bundle', bundlePath, '--config', configPath]);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual, JSON.parse(JSON.stringify(library.executeJob(job))));
  assert.equal(actual.replay.configuration.durationSeconds, 1);
  assert.equal(actual.replay.configuration.warmupSeconds, 0.2);
  writeFileSync(bundlePath, JSON.stringify(changed));
  const mismatch = cli(['--bundle', bundlePath, '--config', configPath]);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /digest does not match/);
});

test('U4.1: normalized and controls jobs validate the effective physical page mapping', () => {
  for (const blockSize of [1, 16, 32, 64, 128, 192]) {
    assert.equal(library.parseJob(normalized({ blockSize })).overrides.blockSize, blockSize);
    assert.equal(library.parseJob({ pBlockSize: String(blockSize) }).params.blockSize, blockSize);
  }
  for (const blockSize of [0, -1, 1.5, 3, 48, 96, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => library.parseJob(normalized({ blockSize })), /blockSize|physical|64/);
    assert.throws(() => library.parseJob({ pBlockSize: String(blockSize) }), /blockSize|physical|64/);
  }
  assert.equal(library.parseJob({ pBlockSize: '48', overrides: { blockSize: 32 } }).overrides.blockSize, 32);
  assert.equal(library.paramsFromControls({ pBlockSize: '1.5' }).blockSize, 1.5);
});

test('U4: effective multi-instance and physical P/D conflicts fail for either workload source', () => {
  const { bundle } = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/runtime-prefix.json')));
  for (const replay of [undefined, { bundle, options: { durationSeconds: 1, warmupSeconds: 0 } }]) {
    const job = normalized({ instances: 2, pdMode: 2, ...(replay ? { replay } : {}) });
    assert.throws(() => library.parseJob(job), /Multiple instances.*P\/D/);
    assert.throws(() => library.parseJob({ ...job, params: { ...job.params, instances: 2 },
      overrides: { ...job.overrides, instances: undefined } }), /instances/);
    const inherited = { ...job, params: { ...job.params, instances: 2, pdMode: 2 }, overrides: { ...job.overrides } };
    delete inherited.overrides.instances; delete inherited.overrides.pdMode;
    assert.throws(() => library.parseJob(inherited), /Multiple instances.*P\/D/);
    assert.doesNotThrow(() => library.parseJob({ ...inherited, overrides: { ...inherited.overrides, pdMode: 0 } }));
  }
});

test('S09: path protection, malformed gzip, byte limits and CLI validation are visible errors', async t => {
  const dir = workspace(t), bundlePath = join(dir, 'bundle.json'), configPath = join(dir, 'config.json');
  const { bundle } = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/runtime-prefix.json')));
  writeFileSync(bundlePath, JSON.stringify(bundle)); writeFileSync(configPath, JSON.stringify(normalized()));
  assert.equal(cli(['--help']).status, 0);
  for (const extra of [['--qps', '0'], ['--seed', '-1'], ['--duration', 'nan'], ['--unknown', '1'], ['--qps', '1', '--qps', '2']]) {
    const result = cli(['--bundle', bundlePath, '--config', configPath, ...extra]); assert.notEqual(result.status, 0);
  }
  const overwrite = cli(['--bundle', bundlePath, '--config', configPath, '--output', bundlePath]);
  assert.notEqual(overwrite.status, 0); assert.match(overwrite.stderr, /distinct/);
  assert.deepEqual(JSON.parse(readFileSync(bundlePath)), bundle);
  const bad = join(dir, 'bad.json.gz'); writeFileSync(bad, 'bad');
  await assert.rejects(library.loadReplayBundle(bad));
  writeFileSync(bad, gzipSync(Buffer.alloc(100000, 32)));
  await assert.rejects(library.loadReplayBundle(bad, { maxDecompressedBytes: 1024 }), /limit/);
  await assert.rejects(library.loadReplayBundle(bundlePath, { maxDecompressedBytes: 10 }), /limit/);
  const output = join(dir, 'invalid-result.json');
  writeFileSync(bundlePath, '{}');
  const invalid = cli(['--bundle', bundlePath, '--config', configPath, '--output', output]);
  assert.notEqual(invalid.status, 0); assert.equal(existsSync(output), false);
});

test('S09: explicit CLI overrides and JS permission guard apply before execution', t => {
  const dir = workspace(t), bundlePath = join(dir, 'bundle.json'), configPath = join(dir, 'config.json');
  const { bundle } = JSON.parse(readFileSync(join(root, 'tests/fixtures/replay/runtime-prefix.json')));
  writeFileSync(bundlePath, JSON.stringify(bundle)); writeFileSync(configPath, JSON.stringify(normalized()));
  const result = cli(['--bundle', bundlePath, '--config', configPath, '--qps', '0.000000001', '--duration', '0.3', '--warmup', '0.1', '--drain', '0.7', '--seed', '9']);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.totalReqs, 0); assert.equal(actual.replay.configuration.seed, 9);
  assert.equal(actual.replay.configuration.durationSeconds, 0.3); assert.equal(actual.replay.configuration.hardCutoff, 1);
  writeFileSync(configPath, JSON.stringify({ ...normalized(), mode: 'js' }));
  const js = cli(['--bundle', bundlePath, '--config', configPath]);
  assert.notEqual(js.status, 0); assert.match(js.stderr, /DSL only/);
  const allowedJs = cli(['--bundle', bundlePath, '--config', configPath, '--allow-js']);
  assert.notEqual(allowedJs.status, 0); assert.match(allowedJs.stderr, /DSL only/);
});

test('S09: shipped real sample executes with the documented B300/Hy4 FP8 preset', async t => {
  const dir = workspace(t), output = join(dir, 'sample-result.json');
  const result = cli(['--bundle', 'data/replay/sample.json', '--config', 'data/replay/sample-config.json', '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(output));
  assert.equal(report.truncated, false);
  assert.ok(report.completed > 0);
  assert.equal(report.completed, report.totalReqs);
  assert.equal(report.replay.counts.launchedSessions, 1);
  assert.equal(report.replay.configuration.execution.paramsB, 770);
  assert.equal(report.replay.configuration.execution.weightDtype, 1);
  assert.equal(report.replay.configuration.execution.dtypeBytes, 1);
  assert.equal(report.replay.configuration.execution.mfu, 0.5);
  assert.equal(report.replay.configuration.execution.gpus, 8);
  assert.ok(report.replay.samples.series.length <= 20000);
});
