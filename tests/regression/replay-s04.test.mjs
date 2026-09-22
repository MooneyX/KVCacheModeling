import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import filter from '../../scripts/filter_replay.js';
import builder from '../../scripts/build_replay_bundle.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/replay/session-interleaved.json', import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function workspace(t) {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  const dir = mkdtempSync(join(root, 'test-results/replay-s04-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeTrace(dir, count = 12) {
  const records = Array.from({ length: count }, (_, i) => {
    const record = structuredClone(fixture);
    record.id = `session-${i}`;
    if (i === count - 1) record.requests[0].api_time = 30;
    return record;
  });
  const input = join(dir, 'trace.jsonl');
  writeFileSync(input, '\n' + records.map(r => JSON.stringify(r)).join('\r\n\n'));
  return { input, records };
}
const cli = (script, args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', timeout: 120_000 });

test('S04: streaming selection preserves whole sessions, physical lines and deterministic seeds', async t => {
  const dir = workspace(t);
  const { input, records } = writeTrace(dir);
  const options = { maxSessions: 4, maxSpanSeconds: 1, seed: 7 };
  const scan = await filter.scanReplayTrace(input, options);
  assert.equal(scan.counts.before.sessions, 12);
  assert.equal(scan.counts.before.requests, 48);
  assert.equal(scan.counts.before.inputTokens, 12 * 448);
  assert.equal(scan.counts.before.outputTokens, 12 * 6);
  assert.equal(scan.counts.eligible.sessions, 11);
  assert.equal(scan.counts.selected.sessions, 4);
  assert.equal(scan.source.sha256, sha(readFileSync(input)));
  assert.deepEqual(scan.entries, (await filter.scanReplayTrace(input, options)).entries);
  assert.notDeepEqual(scan.entries, (await filter.scanReplayTrace(input, { ...options, seed: 8 })).entries);
  assert.deepEqual(scan.entries.map(e => e.sourceIndex), [...scan.entries.map(e => e.sourceIndex)].sort((a, b) => a - b));
  assert.ok(scan.entries.every(e => e.lineNumber === 2 + e.sourceIndex * 2));
  const output = join(dir, 'selected.jsonl.gz');
  const result = await filter.filterReplayTrace({ input, output, ...options });
  const bytes = gunzipSync(readFileSync(output));
  const actual = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(actual, scan.entries.map(e => records[e.sourceIndex]));
  assert.equal(result.output.sha256, sha(bytes));
  assert.equal((await filter.scanReplayTrace(output)).counts.selected.sessions, 4);
});

test('S04: standalone builder emits deterministic JSON/gzip and digest-linked bounded reports', async t => {
  const dir = workspace(t);
  const { input } = writeTrace(dir);
  const output = join(dir, 'bundle.json');
  const options = { input, output, maxSessions: 4, maxSpanSeconds: 1, seed: 7, orderSeed: 8, evidenceLimit: 3 };
  const report = await builder.buildReplayBundle(options);
  const json = readFileSync(output);
  const gzipOutput = join(dir, 'compressed.json.gz');
  const gzipReport = await builder.buildReplayBundle({ ...options, output: gzipOutput });
  assert.deepEqual(gunzipSync(readFileSync(gzipOutput)), json);
  assert.equal(report.bundle.sha256, sha(json));
  assert.equal(gzipReport.bundle.sha256, report.bundle.sha256);
  assert.equal(report.bundle.bytes, json.length);
  assert.equal(report.evidence.length, 3);
  assert.equal(report.stats.inputTokens, 4 * 448);
  assert.equal(report.stats.outputTokens, 4 * 6);
  assert.equal(report.stats.requests, 16);
  assert.equal(report.validation.completionDependencies, 'inferred');
  const { bundle } = await builder.loadReplayBundle(output);
  assert.deepEqual((await builder.loadReplayBundle(gzipOutput)).bundle, bundle);
  for (const map of report.mapping) {
    const ids = bundle.sessions[map.templateIndex].req.flatMap(r => r.blockRuns.flatMap(([start, count]) => Array.from({ length: count }, (_, i) => start + i)));
    assert.equal(Math.min(...ids), map.startBlockId);
    assert.equal(new Set(ids).size, map.uniqueBlocks);
  }
  assert.ok(report.evidence.every(e => report.mapping[e.templateIndex].sourceIndex === e.sourceIndex));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'bundle.report.json'))), report);
  const replayed = await builder.buildReplayBundle({ ...options, output: join(dir, 'repeat.json') });
  assert.deepEqual(readFileSync(join(dir, 'repeat.json')), json);
  assert.deepEqual(replayed, report);
});

test('S04: both actual CLI entrypoints work without Node build artifacts', async t => {
  const dir = workspace(t);
  const { input } = writeTrace(dir, 2);
  const filtered = join(dir, 'filtered.jsonl');
  const a = cli('filter_replay.js', ['--input', input, '--output', filtered, '--max-sessions', '1', '--seed', '9']);
  assert.equal(a.status, 0, a.stderr);
  const output = join(dir, 'cli.json.gz');
  const b = cli('build_replay_bundle.js', ['--input', filtered, '--output', output, '--order-seed', '2']);
  assert.equal(b.status, 0, b.stderr);
  assert.equal((await builder.loadReplayBundle(output)).stats.requests, 4);
  assert.equal(cli('build_replay_bundle.js', ['--help']).status, 0);
  const invalid = cli('filter_replay.js', ['--input', input, '--output', filtered, '--seed', 'bad']);
  assert.notEqual(invalid.status, 0);
  assert.throws(() => filter.parseReplayArgs(['--input', input, '--seed']), /missing value/);
  assert.throws(() => filter.parseReplayArgs(['--wat', '1']), /unknown/);
  assert.throws(() => filter.parseReplayArgs(['--input', input, '--input', input]), /duplicate/);
});

test('S04: corrupt inputs and resource limits fail cleanly without overwriting files', async t => {
  const dir = workspace(t);
  const { input } = writeTrace(dir, 2);
  const output = join(dir, 'output.json');
  writeFileSync(output, 'keep');
  await assert.rejects(builder.buildReplayBundle({ input, output }), /EEXIST/);
  assert.equal(readFileSync(output, 'utf8'), 'keep');
  await assert.rejects(builder.buildReplayBundle({ input, output: input }), /distinct/);
  const reserved = join(dir, 'reserved.report.json');
  writeFileSync(reserved, 'keep report');
  const unavailable = join(dir, 'unavailable.json');
  await assert.rejects(builder.buildReplayBundle({ input, output: unavailable, report: reserved }), /EEXIST/);
  assert.equal(existsSync(unavailable), false);
  assert.equal(readFileSync(reserved, 'utf8'), 'keep report');
  for (const [index, options] of [{ maxLineBytes: 16 }, { maxSourceBytes: 16 }, { maxSourceRequests: 7 }, { maxSourceSessions: 1 }, { maxSourceBlockReferences: 10 }, { maxSpanSeconds: 0 }, { maxBlockReferences: 2 }, { maxRuns: 1 }, { maxDecompressedBytes: 16 }].entries()) {
    const target = join(dir, `limited-${index}.json`);
    await assert.rejects(builder.buildReplayBundle({ input, output: target, ...options }), /limit|no sessions/);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(target.replace('.json', '.report.json')), false);
  }
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '\n{"id":"broken","requests":[]}\n');
  await assert.rejects(filter.scanReplayTrace(bad), /line 2, session "broken"/);
  writeFileSync(bad, '\n{');
  await assert.rejects(filter.scanReplayTrace(bad), /line 2: invalid JSON/);
  writeFileSync(bad, Buffer.from([0xff]));
  await assert.rejects(filter.scanReplayTrace(bad), /invalid UTF-8/);
  const zipped = join(dir, 'bomb.json.gz');
  writeFileSync(zipped, gzipSync(Buffer.alloc(1024 * 1024, 32)));
  await assert.rejects(builder.loadReplayBundle(zipped, { maxDecompressedBytes: 1024 }), /resource limit/);
  writeFileSync(zipped, Buffer.from('not gzip'));
  await assert.rejects(builder.loadReplayBundle(zipped));
  await assert.rejects(builder.loadReplayBundle(join(dir, 'missing.json.gz')), /ENOENT/);
});

test('S04: JSONL line budget applies across multiple stream chunks', async t => {
  const dir = workspace(t);
  const source = structuredClone(fixture);
  source.diagnostic = 'x'.repeat(150_000);
  const input = join(dir, 'large.jsonl');
  writeFileSync(input, JSON.stringify(source));
  assert.equal((await filter.scanReplayTrace(input)).counts.before.sessions, 1);
  await assert.rejects(filter.scanReplayTrace(input, { maxLineBytes: 100_000 }), /line 1: bytes/);
});

test('S04: span boundary is inclusive despite floating-point rounding and time-origin shifts', async t => {
  const dir = workspace(t);
  const input = join(dir, 'boundary.jsonl');
  const raw = structuredClone(fixture);
  raw.requests = [raw.requests[0]];
  raw.requests[0].api_time = 0.2;
  for (const time of [0, 0.1, 1]) {
    raw.requests[0].t = time;
    writeFileSync(input, JSON.stringify(raw));
    assert.equal((await filter.scanReplayTrace(input, { maxSpanSeconds: 0.2 })).counts.selected.sessions, 1);
    await assert.rejects(filter.scanReplayTrace(input, { maxSpanSeconds: 0.1999 }), /no sessions/);
  }
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => filter.parseReplayArgs(['--input', input, '--output', 'unused', `--${key}`, '1'], true), /unknown/);
  }
});

test('S04: early consumer return and mid-write failure close streams and clean reserved outputs', async t => {
  const dir = workspace(t);
  const { input } = writeTrace(dir);
  for await (const record of filter.readReplayTrace(input)) {
    assert.equal(record.sourceIndex, 0);
    break;
  }
  const output = join(dir, 'partial.json.gz');
  await assert.rejects(filter.withReplayOutputs(input, [output], async ([handle]) => {
    async function* chunks() { yield 'first'; throw new Error('injected write failure'); }
    await filter.writeReplayFile(handle, chunks(), true);
  }), /injected write failure/);
  assert.equal(existsSync(output), false);
});

test('S04: shipped real sample and report agree on content, statistics and anchor evidence', async () => {
  const file = join(root, 'data/replay/sample.json');
  const bytes = readFileSync(file);
  const report = JSON.parse(readFileSync(join(root, 'data/replay/sample.report.json'), 'utf8'));
  const { bundle, stats } = await builder.loadReplayBundle(file);
  assert.equal(report.bundle.sha256, sha(bytes));
  assert.equal(report.bundle.bytes, bytes.length);
  assert.deepEqual(report.stats, stats);
  assert.equal(stats.sessions, 8);
  assert.ok(report.mapping.every(entry => entry.spanSeconds <= 350));
  for (const item of report.evidence) {
    assert.deepEqual(item.timing, bundle.sessions[item.templateIndex].req[item.request].timing);
    assert.equal(report.mapping[item.templateIndex].sourceIndex, item.sourceIndex);
    const { kind, anchorReq, offsetMs } = item.timing;
    if (kind === 'origin') assert.equal(item.tMs, offsetMs);
    else {
      const anchor = report.evidence.find(e => e.templateIndex === item.templateIndex && e.request === anchorReq);
      assert.ok(anchor);
      assert.equal(item.tMs, anchor.tMs + (kind === 'completion' ? anchor.apiMs : 0) + offsetMs);
    }
  }
});

test('S04: explicit full-trace build conserves the published totals', { skip: !process.env.REPLAY_FULL_TRACE, timeout: 900_000 }, async t => {
  const dir = workspace(t);
  const input = resolve(process.env.REPLAY_FULL_TRACE);
  const report = await builder.buildReplayBundle({ input, output: join(dir, 'full.json.gz'), maxBlockReferences: 400_000_000, maxDecompressedBytes: 128 * 1024 * 1024, maxRuns: 4_000_000 });
  assert.deepEqual({ sessions: report.stats.sessions, requests: report.stats.requests, inputTokens: report.stats.inputTokens, outputTokens: report.stats.outputTokens }, { sessions: 393, requests: 98827, inputTokens: 21635381376, outputTokens: 106474498 });
});
