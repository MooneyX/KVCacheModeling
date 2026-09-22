const { createReadStream } = require('node:fs');
const { open, mkdir, rm } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { createGunzip, createGzip } = require('node:zlib');
const { Readable, Writable } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');

const SOURCE_DEFAULTS = Object.freeze({
  maxSourceBytes: 4 * 1024 ** 3,
  maxLineBytes: 256 * 1024 ** 2,
  maxSourceSessions: 10_000,
  maxSourceRequests: 1_000_000,
  maxSourceBlockReferences: 500_000_000,
});

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}: expected a positive safe integer`);
  return value;
}

function seedValue(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${name}: expected a uint32 seed`);
  return value;
}

function sourceOptions(options = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(SOURCE_DEFAULTS)) result[key] = positiveInteger(options[key] ?? fallback, key);
  return result;
}

function checkLimit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name}: resource limit exceeded (${value} > ${maximum})`);
}

async function* readChunks(file, maximum, state = {}) {
  const source = createReadStream(file);
  const decoded = file.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  const forwardError = error => decoded.destroy(error);
  if (decoded !== source) source.on('error', forwardError);
  const closed = [finished(source, { cleanup: true }).catch(() => {})];
  if (decoded !== source) closed.push(finished(decoded, { cleanup: true }).catch(() => {}));
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of decoded) {
      bytes += chunk.length;
      checkLimit(bytes, maximum, 'decompressed source bytes');
      hash.update(chunk);
      yield chunk;
    }
    state.bytes = bytes;
    state.sha256 = hash.digest('hex');
  } finally {
    source.destroy();
    if (decoded !== source) decoded.destroy();
    await Promise.all(closed);
  }
}

async function readReplayBytes(file, maximum) {
  const chunks = [];
  for await (const chunk of readChunks(file, maximum)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function* readReplayTrace(file, options = {}, state = {}, selectedIndices) {
  const limits = sourceOptions(options);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts = [], size = 0, lineNumber = 0, sourceIndex = 0;
  const parseLine = () => {
    lineNumber++;
    let text;
    try { text = decoder.decode(Buffer.concat(parts, size)); }
    catch { throw new Error(`line ${lineNumber}: invalid UTF-8`); }
    parts = []; size = 0;
    if (!text.trim()) return null;
    const index = sourceIndex++;
    checkLimit(sourceIndex, limits.maxSourceSessions, `line ${lineNumber}: source sessions`);
    if (selectedIndices && !selectedIndices.has(index)) return null;
    let raw;
    try { raw = JSON.parse(text); }
    catch { throw new Error(`line ${lineNumber}: invalid JSON`); }
    return { raw, lineNumber, sourceIndex: index };
  };
  for await (const chunk of readChunks(file, limits.maxSourceBytes, state)) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end;
      const piece = chunk.subarray(offset, stop);
      size += piece.length;
      checkLimit(size, limits.maxLineBytes, `line ${lineNumber + 1}: bytes`);
      parts.push(piece);
      if (end >= 0) {
        const parsed = parseLine();
        if (parsed) yield parsed;
      }
      offset = end < 0 ? chunk.length : end + 1;
    }
  }
  if (size) {
    const parsed = parseLine();
    if (parsed) yield parsed;
  }
  state.lines = lineNumber;
  state.sessions = sourceIndex;
}

const emptyCounts = () => ({ sessions: 0, requests: 0, inputTokens: 0, outputTokens: 0, blockReferences: 0 });
function addCounts(counts, entry) {
  counts.sessions++;
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'blockReferences']) {
    counts[key] += entry[key];
    checkLimit(counts[key], Number.MAX_SAFE_INTEGER, `counts.${key}`);
  }
}

async function scanReplayTrace(input, options = {}) {
  const { flattenReplaySession } = await import('../src/core/replay.js');
  const { mulberry32 } = await import('../src/core/math.js');
  const limits = sourceOptions(options);
  const seed = seedValue(options.seed ?? 1, 'seed');
  const maxSessions = options.maxSessions == null ? null : positiveInteger(options.maxSessions, 'maxSessions');
  const maxSpanSeconds = options.maxSpanSeconds ?? null;
  if (maxSpanSeconds !== null && (typeof maxSpanSeconds !== 'number' || !Number.isFinite(maxSpanSeconds) || maxSpanSeconds < 0)) throw new Error('maxSpanSeconds: expected finite nonnegative seconds');
  const rng = mulberry32(seed);
  const before = emptyCounts(), eligible = emptyCounts(), selected = emptyCounts();
  const entries = [];
  const state = {};
  const thinkTime = { missing: 0, null: 0, zero: 0, positive: 0 };
  for await (const record of readReplayTrace(input, limits, state)) {
    const flat = flattenReplaySession(record.raw, { lineNumber: record.lineNumber, sourceIndex: record.sourceIndex, limits: { maxRequests: limits.maxSourceRequests, maxBlockReferences: limits.maxSourceBlockReferences } });
    const entry = { sourceIndex: record.sourceIndex, lineNumber: record.lineNumber, id: flat.id, requests: flat.requests.length, inputTokens: flat.inputTokens, outputTokens: flat.outputTokens, blockReferences: flat.blockReferences, spanSeconds: flat.spanSeconds, thinkTime: flat.thinkTime };
    addCounts(before, entry);
    checkLimit(before.requests, limits.maxSourceRequests, 'source requests');
    checkLimit(before.blockReferences, limits.maxSourceBlockReferences, 'source block references');
    for (const key of Object.keys(thinkTime)) thinkTime[key] += flat.thinkTime[key];
    const spanTolerance = 8 * Number.EPSILON * Math.max(1, flat.spanSeconds, maxSpanSeconds ?? 0);
    if (maxSpanSeconds !== null && flat.spanSeconds - maxSpanSeconds > spanTolerance) continue;
    addCounts(eligible, entry);
    if (maxSessions === null || entries.length < maxSessions) entries.push(entry);
    else {
      const index = Math.floor(rng() * eligible.sessions);
      if (index < maxSessions) entries[index] = entry;
    }
  }
  if (!entries.length) throw new Error('selection: no sessions remain (empty input or filter result)');
  entries.sort((a, b) => a.sourceIndex - b.sourceIndex);
  entries.forEach(entry => addCounts(selected, entry));
  return { source: { path: resolve(input), ...state }, selection: { maxSpanSeconds, maxSessions, seed, spanDefinition: 'max(t + api_time) - min(t), model requests only' }, counts: { before, eligible, selected }, thinkTime, entries, limits };
}

async function withReplayOutputs(input, paths, action) {
  const resolved = paths.map(path => resolve(path));
  if (new Set([resolve(input), ...resolved]).size !== paths.length + 1) throw new Error('input, output and report paths must be distinct');
  const handles = [];
  let succeeded = false;
  try {
    for (const path of resolved) {
      await mkdir(dirname(path), { recursive: true });
      handles.push(await open(path, 'wx'));
    }
    const result = await action(handles);
    succeeded = true;
    return result;
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
    if (!succeeded) await Promise.all(handles.map((_, i) => rm(resolved[i], { force: true })));
  }
}

async function writeReplayFile(handle, chunks, gzip = false) {
  const sink = new Writable({ write(chunk, encoding, callback) { handle.writeFile(chunk).then(() => callback(), callback); } });
  const streams = [Readable.from(chunks)];
  if (gzip) streams.push(createGzip());
  streams.push(sink);
  await pipeline(streams);
}

async function filterReplayTrace(options) {
  const { input, output } = options;
  if (!input || !output) throw new Error('input and output are required');
  const reportPath = options.report ?? `${output}.report.json`;
  return withReplayOutputs(input, [output, reportPath], async ([outputHandle, reportHandle]) => {
    const scan = await scanReplayTrace(input, options);
    const selected = new Set(scan.entries.map(entry => entry.sourceIndex));
    const state = {};
    const outputHash = createHash('sha256');
    let outputBytes = 0;
    async function* lines() {
      for await (const { raw } of readReplayTrace(input, scan.limits, state, selected)) {
        const line = JSON.stringify(raw) + '\n';
        outputHash.update(line);
        outputBytes += Buffer.byteLength(line);
        checkLimit(outputBytes, scan.limits.maxSourceBytes, 'filtered bytes');
        yield line;
      }
      if (state.sha256 !== scan.source.sha256) throw new Error('source changed between selection and output');
    }
    await writeReplayFile(outputHandle, lines(), output.endsWith('.gz'));
    const report = { reportVersion: 1, source: scan.source, selection: scan.selection, counts: scan.counts, thinkTime: scan.thinkTime, sessions: scan.entries, limits: scan.limits, output: { sha256: outputHash.digest('hex'), bytes: outputBytes }, validation: { rawRecords: true, wholeSessions: true } };
    await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n');
    return report;
  });
}

const FLAG_NAMES = {
  input: 'input', output: 'output', report: 'report', 'max-span-seconds': 'maxSpanSeconds', 'max-sessions': 'maxSessions', seed: 'seed', 'order-seed': 'orderSeed',
  'max-source-bytes': 'maxSourceBytes', 'max-line-bytes': 'maxLineBytes', 'max-source-sessions': 'maxSourceSessions', 'max-source-requests': 'maxSourceRequests', 'max-source-block-references': 'maxSourceBlockReferences',
  'max-decompressed-bytes': 'maxDecompressedBytes', 'max-requests': 'maxRequests', 'max-runs': 'maxRuns', 'max-block-references': 'maxBlockReferences', 'evidence-limit': 'evidenceLimit',
};

function parseReplayArgs(argv, build = false) {
  const options = {};
  const filterOnly = new Set(['input', 'output', 'report', 'max-span-seconds', 'max-sessions', 'seed', ...Object.keys(FLAG_NAMES).filter(flag => flag.startsWith('max-source-') || flag === 'max-line-bytes')]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') { options.help = true; continue; }
    const flag = argv[i].slice(2);
    const key = Object.hasOwn(FLAG_NAMES, flag) ? FLAG_NAMES[flag] : undefined;
    if (!argv[i].startsWith('--') || !key || (!build && !filterOnly.has(flag))) throw new Error(`unknown argument: ${argv[i]}`);
    if (Object.hasOwn(options, key)) throw new Error(`duplicate argument: ${argv[i]}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`missing value for --${flag}`);
    options[key] = ['input', 'output', 'report'].includes(key) ? value : Number(value);
  }
  if (!options.help && (!options.input || !options.output)) throw new Error('--input and --output are required');
  return options;
}

function replayHelp(build = false) {
  return `Usage: node scripts/${build ? 'build_replay_bundle' : 'filter_replay'}.js --input trace.jsonl[.gz] --output ${build ? 'bundle.json[.gz]' : 'filtered.jsonl[.gz]'}\n` +
    'Options: --report PATH --max-span-seconds N --max-sessions N --seed N\n' +
    'Source limits: --max-source-bytes N --max-line-bytes N --max-source-sessions N --max-source-requests N --max-source-block-references N\n' +
    (build ? 'Build options: --order-seed N --evidence-limit N --max-decompressed-bytes N --max-requests N --max-runs N --max-block-references N\n' : '') +
    'Defaults: all sessions; seed=1. Span includes model service time. Output files are never overwritten.\n';
}

module.exports = { SOURCE_DEFAULTS, sourceOptions, seedValue, checkLimit, readReplayBytes, readReplayTrace, scanReplayTrace, withReplayOutputs, writeReplayFile, filterReplayTrace, parseReplayArgs, replayHelp };

if (require.main === module) {
  Promise.resolve().then(async () => {
    const options = parseReplayArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(replayHelp()); return; }
    const report = await filterReplayTrace(options);
    console.log(JSON.stringify({ output: options.output, counts: report.counts, sha256: report.output.sha256 }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
