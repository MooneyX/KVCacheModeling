const { createHash } = require('node:crypto');
const { sourceOptions, seedValue, checkLimit, readReplayBytes, readReplayTrace, scanReplayTrace, withReplayOutputs, writeReplayFile, parseReplayArgs, replayHelp } = require('./filter_replay.js');

async function loadReplayBundle(file, limits = {}) {
  const { parseReplayBundle, replayLimits } = await import('../src/core/replay.js');
  const resolved = replayLimits(limits);
  return parseReplayBundle(await readReplayBytes(file, resolved.maxDecompressedBytes), resolved);
}

async function buildReplayBundle(options) {
  const { input, output } = options;
  if (!input || !output) throw new Error('input and output are required');
  const reportPath = options.report ?? output.replace(/\.json(?:\.gz)?$/, '') + '.report.json';
  const core = await import('../src/core/replay.js');
  const limitOverrides = {};
  for (const key of Object.keys(core.DEFAULT_REPLAY_LIMITS)) {
    if (options[key] !== undefined) limitOverrides[key] = options[key];
  }
  const limits = core.replayLimits(limitOverrides);
  const orderSeed = seedValue(options.orderSeed ?? 1, 'orderSeed');
  const evidenceLimit = options.evidenceLimit ?? 32;
  if (!Number.isSafeInteger(evidenceLimit) || evidenceLimit < 0 || evidenceLimit > 1000) throw new Error('evidenceLimit: expected an integer in [0, 1000]');
  return withReplayOutputs(input, [output, reportPath], async ([outputHandle, reportHandle]) => {
    const scan = await scanReplayTrace(input, options);
    checkLimit(scan.counts.selected.sessions, limits.maxSessions, 'selected sessions');
    checkLimit(scan.counts.selected.requests, limits.maxRequests, 'selected requests');
    checkLimit(scan.counts.selected.blockReferences, limits.maxBlockReferences, 'selected block references');
    const selected = new Map(scan.entries.map(entry => [entry.sourceIndex, entry]));
    const entries = [];
    const evidence = [];
    const diagnostics = {};
    const state = {};
    let nextBlockId = 0, runs = 0;
    for await (const record of readReplayTrace(input, sourceOptions(options), state, new Set(selected.keys()))) {
      const flat = core.flattenReplaySession(record.raw, { lineNumber: record.lineNumber, sourceIndex: record.sourceIndex, limits });
      const startBlockId = nextBlockId;
      const compiled = core.compileReplaySession(flat, { startBlockId, evidenceLimit: Math.max(0, evidenceLimit - evidence.length), limits });
      nextBlockId = compiled.nextBlockId;
      for (const request of compiled.session.req) runs += request.blockRuns.length;
      checkLimit(runs, limits.maxRuns, 'compiled runs');
      for (const [key, value] of Object.entries(compiled.diagnostics)) diagnostics[key] = (diagnostics[key] ?? 0) + value;
      evidence.push(...compiled.evidence.map(item => ({ sourceIndex: record.sourceIndex, ...item })));
      entries.push({ ...selected.get(record.sourceIndex), sourceIndex: record.sourceIndex, startBlockId, uniqueBlocks: compiled.uniqueBlocks, session: compiled.session });
    }
    if (state.sha256 !== scan.source.sha256) throw new Error('source changed between selection and compilation');
    const ordered = core.orderReplaySessions(entries, orderSeed);
    const bundle = { version: 1, blockSize: 64, sessions: ordered.map(entry => entry.session) };
    const stats = core.validateReplayBundle(bundle, limits);
    for (const key of ['sessions', 'requests', 'inputTokens', 'outputTokens', 'blockReferences']) {
      if (stats[key] !== scan.counts.selected[key]) throw new Error(`compilation changed ${key}`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    function* jsonChunks() {
      yield '{"version":1,"blockSize":64,"sessions":[';
      for (let i = 0; i < bundle.sessions.length; i++) {
        if (i) yield ',';
        yield JSON.stringify(bundle.sessions[i]);
      }
      yield ']}\n';
    }
    function* boundedChunks() {
      for (const text of jsonChunks()) {
        bytes += Buffer.byteLength(text);
        checkLimit(bytes, limits.maxDecompressedBytes, 'bundle decompressed bytes');
        hash.update(text);
        yield text;
      }
    }
    await writeReplayFile(outputHandle, boundedChunks(), output.endsWith('.gz'));
    const mapping = ordered.map(({ session, ...entry }, templateIndex) => ({ templateIndex, ...entry }));
    const templateBySource = new Map(mapping.map(entry => [entry.sourceIndex, entry.templateIndex]));
    const report = {
      reportVersion: 1,
      bundle: { sha256: hash.digest('hex'), bytes, version: 1, blockSize: 64, encoding: output.endsWith('.gz') ? 'gzip' : 'json' },
      source: scan.source,
      selection: { ...scan.selection, orderSeed },
      counts: scan.counts,
      stats,
      uniqueBlocks: nextBlockId,
      diagnostics,
      thinkTimeBefore: scan.thinkTime,
      validation: { schema: true, pathIdentities: true, originalTiming: true, countsPreserved: true, crossSessionIsolation: true, completionDependencies: 'inferred' },
      limits: { source: scan.limits, bundle: limits, evidenceLimit },
      mapping,
      evidence: evidence.map(item => ({ templateIndex: templateBySource.get(item.sourceIndex), ...item })),
    };
    await reportHandle.writeFile(JSON.stringify(report, null, 2) + '\n');
    return report;
  });
}

module.exports = { buildReplayBundle, loadReplayBundle };

if (require.main === module) {
  Promise.resolve().then(async () => {
    const options = parseReplayArgs(process.argv.slice(2), true);
    if (options.help) { process.stdout.write(replayHelp(true)); return; }
    const report = await buildReplayBundle(options);
    console.log(JSON.stringify({ output: options.output, stats: report.stats, sha256: report.bundle.sha256 }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
