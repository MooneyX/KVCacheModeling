const TOKEN_KEYS = ['inputTokens', 'hitL1Tokens', 'hitL2Tokens', 'hitL3Tokens', 'missTokens'];
const BASE_GAUGES = ['activeSessions', 'activeRequests', 'queuedRequests', 'hbmBytes', 'inputPages', 'outputPages'];
const TIER_GAUGES = ['hbmResidentBytes', 'hbmReservedBytes', 'dramBytes', 'dramReservedBytes', 'ssdBytes', 'ssdReservedBytes'];
const emptyTokens = () => Object.fromEntries(TOKEN_KEYS.map(key => [key, 0]));
const ratio = (n, d) => d > 0 ? n / d : null;
function distribution(values) {
  if (!values.length) return { count: 0, mean: null, p50: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)], p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] };
}

export function createReplayMetrics({ durationSeconds: T, warmupSeconds: warmup, hardCutoff, stats, seed, qps, lambdaSession, limits, configuration = {}, finiteCapacity = false }) {
  const GAUGES = finiteCapacity ? [...BASE_GAUGES, ...TIER_GAUGES] : BASE_GAUGES;
  const emptyGauges = () => Object.fromEntries(GAUGES.map(key => [key, 0]));
  const width = Math.max(0.002, hardCutoff / 20_000);
  const windows = Object.fromEntries(['full', 'warmup', 'measurement', 'drain'].map(name => [name, {
    arrivals: 0, completions: 0, failed: 0, cancelled: 0, admitted: 0, successfulArrivals: 0, launches: 0,
    tokens: emptyTokens(), ttft: [], tpot: [], latency: [],
    ...(finiteCapacity ? { retractCount: 0, recomputedTokens: 0 } : {}),
  }]));
  const buckets = new Map();
  const requests = [], launches = [];
  const counts = { planned: 0, arrived: 0, successful: 0, failed: 0, cancelled: 0, admitted: 0, launchedSessions: 0,
    plannedInputTokens: 0, plannedOutputTokens: 0, outputTokens: 0 };
  const admitted = new Set(), arrived = new Set(), terminal = new Set();
  let observedAt = 0, gauges = emptyGauges();
  const integral = emptyGauges(), peak = emptyGauges();
  const eventWindow = time => time < warmup ? 'warmup' : time < T ? 'measurement' : 'drain';
  function eachWindow(time, fn) { fn(windows.full); fn(windows[eventWindow(time)]); }
  function identity(req) { return `${req.launchIndex}:${req.requestIndex}`; }
  function bucket(time) {
    let index = Math.min(19999, Math.floor(time / width));
    if (index < 19999 && (index + 1) * width <= time) index++;
    if (!buckets.has(index)) buckets.set(index, { index, arrivals: 0, completions: 0, duration: 0,
      integral: emptyGauges(), peak: emptyGauges(), last: emptyGauges() });
    return buckets.get(index);
  }
  function observe(time, state) {
    if (time < observedAt || time > hardCutoff + 1e-9) throw new Error('Replay metrics clock invariant violated');
    let cursor = observedAt;
    while (cursor < time) {
      const b = bucket(cursor);
      const end = Math.min(time, (b.index + 1) * width);
      if (end <= cursor) break;
      const dt = end - cursor;
      b.duration += dt;
      for (const key of GAUGES) {
        b.integral[key] += gauges[key] * dt;
        integral[key] += gauges[key] * dt;
        b.peak[key] = Math.max(b.peak[key], gauges[key]);
        peak[key] = Math.max(peak[key], gauges[key]);
        b.last[key] = gauges[key];
      }
      cursor = end;
    }
    observedAt = time;
    gauges = { ...gauges, ...state };
    for (const key of GAUGES) peak[key] = Math.max(peak[key], gauges[key]);
  }
  function summary(req, state, reason) {
    if (requests.length >= 320) return;
    requests.push({ id: req.id, templateIndex: req.templateIndex, launchIndex: req.launchIndex, requestIndex: req.requestIndex,
      inputTokens: req.inputLen, outputTokens: req.outputLen, arrive: req.arrive ?? null,
      admitTime: admitted.has(identity(req)) ? req.admitTime : null,
      prefillEnd: state === 'successful' ? req.prefillEnd : null, completeTime: req.completeTime ?? null, state, ...(reason ? { reason } : {}) });
  }
  function countRequest(req) {
    if (arrived.size >= limits.maxRequests) throw new Error('Replay metrics request resource limit exceeded');
    const key = identity(req);
    if (arrived.has(key)) throw new Error('Replay metrics duplicate client arrival');
    arrived.add(key);
  }
  return {
    launch(event) {
      counts.launchedSessions++; counts.planned += event.requests;
      counts.plannedInputTokens += event.inputTokens; counts.plannedOutputTokens += event.outputTokens;
      eachWindow(event.time, w => w.launches++);
      if (launches.length < 320) launches.push({ ...event });
    },
    arrive(req) {
      countRequest(req);
      counts.arrived++;
      eachWindow(req.arrive, w => w.arrivals++);
      bucket(req.arrive).arrivals++;
    },
    admit(req, hit) {
      const key = identity(req);
      if (admitted.has(key)) return;
      if (!arrived.has(key)) throw new Error('Replay metrics admission before arrival');
      if (hit.inputTokens !== req.inputLen || TOKEN_KEYS.some(k => !Number.isSafeInteger(hit[k]) || hit[k] < 0)
        || hit.hitL1Tokens + hit.hitL2Tokens + hit.hitL3Tokens + hit.missTokens !== hit.inputTokens) throw new Error('Replay token conservation invariant violated');
      admitted.add(key); counts.admitted++;
      eachWindow(req.arrive, w => { w.admitted++; for (const key of TOKEN_KEYS) w.tokens[key] += hit[key]; });
    },
    complete(req) {
      const key = identity(req);
      if (terminal.has(key)) return;
      if (!admitted.has(key)) throw new Error('Replay metrics completion before admission');
      terminal.add(key); counts.successful++; counts.outputTokens += req.outputLen;
      eachWindow(req.completeTime, w => w.completions++);
      bucket(req.completeTime).completions++;
      eachWindow(req.arrive, w => {
        w.successfulArrivals++;
        w.ttft.push(((req.firstTokenTime ?? req.prefillEnd) - req.arrive) * 1000);
        if (req.outputLen > 0) w.tpot.push((req.completeTime - req.decodeStart) / req.outputLen * 1000);
        w.latency.push((req.completeTime - req.arrive) * 1000);
      });
      summary(req, 'successful');
    },
    fail(req, reason) {
      const key = identity(req);
      if (terminal.has(key)) return;
      terminal.add(key); counts.failed++;
      eachWindow(req.arrive, w => w.failed++);
      summary(req, 'failed', reason);
    },
    cancel(req, time) {
      const key = identity(req);
      if (terminal.has(key)) return;
      terminal.add(key); counts.cancelled++;
      eachWindow(time, w => w.cancelled++);
      summary({ ...req, completeTime: time }, 'cancelled', 'anchor_unavailable');
    },
    retract(req, time) {
      if (!finiteCapacity || terminal.has(identity(req))) return;
      if (!admitted.has(identity(req))) throw new Error('Replay metrics retraction before admission');
      if (!Number.isFinite(time) || time < 0 || time > hardCutoff + 1e-9) throw new Error('Replay metrics retraction time invariant violated');
      eachWindow(time, w => w.retractCount++);
    },
    recompute(req, tokens, time) {
      if (!finiteCapacity || terminal.has(identity(req))) return;
      if (!admitted.has(identity(req))) throw new Error('Replay metrics recomputation before admission');
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Replay metrics recomputed token invariant violated');
      if (!Number.isFinite(time) || time < 0 || time > hardCutoff + 1e-9) throw new Error('Replay metrics recomputation time invariant violated');
      eachWindow(time, w => w.recomputedTokens += tokens);
    },
    observe,
    finish(end, runtime) {
      observe(end, gauges);
      const ranges = { full: [0, end], warmup: [0, Math.min(warmup, end)], measurement: [Math.min(warmup, end), Math.min(T, end)], drain: [Math.min(T, end), end] };
      const reportWindows = {};
      for (const [name, w] of Object.entries(windows)) {
        const [start, stop] = ranges[name], durationSeconds = Math.max(0, stop - start);
        const { ttft, tpot, latency, tokens, ...numbers } = w;
        reportWindows[name] = { start, end: stop, durationSeconds, ...numbers,
          arrivalQps: ratio(w.arrivals, durationSeconds), completionQps: ratio(w.completions, durationSeconds),
          unfinishedArrivals: w.arrivals - w.successfulArrivals - w.failed,
          failureFraction: ratio(w.failed, w.arrivals), unfinishedFraction: ratio(w.arrivals - w.successfulArrivals - w.failed, w.arrivals),
          unadmitted: w.arrivals - w.admitted,
          cache: { ...tokens, hitRate: ratio(tokens.hitL1Tokens + tokens.hitL2Tokens + tokens.hitL3Tokens, tokens.inputTokens),
            ...(finiteCapacity ? { recomputedTokens: w.recomputedTokens } : {}) },
          latency: { unit: 'ms', ttft: distribution(ttft), tpot: distribution(tpot), endToEnd: distribution(latency) } };
      }
      const series = [...buckets.values()].sort((a, b) => a.index - b.index).map(b => {
        const start = b.index * width, stop = Math.min(end, (b.index + 1) * width);
        return { start, end: stop, arrivals: b.arrivals, completions: b.completions,
          arrivalQps: ratio(b.arrivals, stop - start), completionQps: ratio(b.completions, stop - start),
          mean: Object.fromEntries(GAUGES.map(key => [key, ratio(b.integral[key], b.duration)])), peak: b.peak, last: b.last };
      });
      return { configuration: { ...configuration, seed, arrivalModel: 'closed', outputIdentity: 'unmapped', superblocks: false,
          durationSeconds: T, warmupSeconds: warmup, hardCutoff, targetQps: qps, lambdaSession },
        source: { ...stats }, counts: { ...counts, ...runtime }, windows: reportWindows,
        cache: reportWindows.measurement.cache,
        samples: { series, requests, launches, bucketWidth: width, maxBuckets: 20000, coverage: [0, end],
          requestCoverage: { total: counts.successful + counts.failed + counts.cancelled, sampled: requests.length, complete: counts.successful + counts.failed + counts.cancelled <= 320 },
          launchCoverage: { total: counts.launchedSessions, sampled: launches.length, complete: counts.launchedSessions <= 320 },
          timeWeightedMean: Object.fromEntries(GAUGES.map(key => [key, ratio(integral[key], end)])), peak },
        state: { truncated: runtime.truncated, terminationReason: runtime.terminationReason, retractCount: finiteCapacity ? windows.full.retractCount : 0,
          ...(finiteCapacity ? { recomputedTokens: windows.full.recomputedTokens } : {}),
          infeasible: runtime.infeasible, aborted: runtime.aborted, anchor_unavailable: runtime.anchor_unavailable,
          limits: { ...limits }, stability: 'not_evaluated', idealCache: 'not_evaluated', mainWindow: 'measurement',
          latencyInterpretation: 'observed_window', completionDependencies: 'inferred',
          supportedScope: finiteCapacity ? 'single-instance/64-token/finite-capacity-tiered-four-configurations' : 'single-instance/64-token/HBM-capacity-sufficient' } };
    },
  };
}
