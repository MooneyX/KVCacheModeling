// @ts-check
import { mulberry32 } from './math.js';
import { createReplayRequest } from './requests.js';

/** @typedef {import('../contracts/replay').ReplayBundle} ReplayBundle */
/** @typedef {import('../contracts/replay').ReplayLimits} ReplayLimits */
/** @typedef {import('../contracts/replay').ReplayBundleStats} ReplayBundleStats */

/** @type {Readonly<ReplayLimits>} */
export const DEFAULT_REPLAY_LIMITS = Object.freeze({
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxSessions: 10_000,
  maxRequests: 1_000_000,
  maxRuns: 2_000_000,
  maxBlockReferences: 100_000_000,
});

export class ReplayValidationError extends Error {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ReplayValidationError';
    this.path = path;
  }
}

/** @param {string} path @param {string} message @returns {never} */
function invalid(path, message) {
  throw new ReplayValidationError(path, message);
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(path, 'expected a plain JSON object');
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @param {string[]} keys @param {string} path */
function fields(value, keys, path) {
  const object = record(value, path);
  const actual = Reflect.ownKeys(object);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(object, key)) || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    invalid(path, `expected exactly fields: ${keys.join(', ')}`);
  }
  return object;
}

/** @param {unknown} value @param {string} path @param {number} [minimum] @returns {number} */
function integer(value, path, minimum = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(path, `expected a safe integer >= ${minimum}`);
  return value;
}

/** @param {number} a @param {number} b @param {string} path */
function add(a, b, path) {
  return integer(a + b, path);
}

/** @param {unknown} value @param {string} path @returns {any[]} */
function nonempty(value, path) {
  if (!Array.isArray(value) || value.length === 0) invalid(path, 'expected a nonempty array');
  return value;
}

/** @param {Partial<ReplayLimits>} [overrides] @returns {ReplayLimits} */
export function replayLimits(overrides = {}) {
  record(overrides, 'limits');
  const limits = { ...DEFAULT_REPLAY_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(limits, key)) invalid(`limits.${key}`, 'unknown resource limit');
    const name = /** @type {keyof ReplayLimits} */ (key);
    limits[name] = integer(overrides[name], `limits.${key}`, 1);
  }
  return limits;
}

/** @param {number} value @param {number} maximum @param {string} path */
function budget(value, maximum, path) {
  if (value > maximum) invalid(path, `resource limit exceeded (${value} > ${maximum})`);
}

/**
 * Checks RLE intervals without expanding block references. Returns derived data only.
 * @param {unknown} input
 * @param {Partial<ReplayLimits>} [limitOverrides]
 * @returns {ReplayBundleStats}
 */
export function validateReplayBundle(input, limitOverrides = {}) {
  const limits = replayLimits(limitOverrides);
  const bundle = fields(input, ['version', 'blockSize', 'sessions'], 'bundle');
  if (bundle.version !== 1) invalid('bundle.version', 'expected 1');
  if (bundle.blockSize !== 64) invalid('bundle.blockSize', 'expected 64');
  const sessions = nonempty(bundle.sessions, 'bundle.sessions');
  budget(sessions.length, limits.maxSessions, 'bundle.sessions');
  /** @type {ReplayBundleStats} */
  const stats = { sessions: sessions.length, requests: 0, inputTokens: 0, outputTokens: 0, runs: 0, blockReferences: 0, meanRequestsPerSession: 0, anchors: { origin: 0, arrival: 0, completion: 0 } };
  /** @type {{start: number, end: number, owner: number, path: string}[]} */
  const intervals = [];
  for (let s = 0; s < sessions.length; s++) {
    const sessionPath = `bundle.sessions[${s}]`;
    const session = fields(sessions[s], ['req'], sessionPath);
    const requests = nonempty(session.req, `${sessionPath}.req`);
    stats.requests = add(stats.requests, requests.length, `${sessionPath}.req`);
    budget(stats.requests, limits.maxRequests, `${sessionPath}.req`);
    for (let r = 0; r < requests.length; r++) {
      const path = `${sessionPath}.req[${r}]`;
      const request = fields(requests[r], ['in', 'out', 'blockRuns', 'timing'], path);
      const inputTokens = integer(request.in, `${path}.in`, 1);
      const outputTokens = integer(request.out, `${path}.out`);
      const runs = nonempty(request.blockRuns, `${path}.blockRuns`);
      stats.runs = add(stats.runs, runs.length, `${path}.blockRuns`);
      budget(stats.runs, limits.maxRuns, `${path}.blockRuns`);
      let blocks = 0;
      for (let k = 0; k < runs.length; k++) {
        const runPath = `${path}.blockRuns[${k}]`;
        const run = runs[k];
        if (!Array.isArray(run) || run.length !== 2) invalid(runPath, 'expected [start, count]');
        const start = integer(run[0], `${runPath}[0]`);
        const count = integer(run[1], `${runPath}[1]`, 1);
        const end = add(start, count - 1, runPath);
        blocks = add(blocks, count, runPath);
        budget(add(stats.blockReferences, blocks, runPath), limits.maxBlockReferences, runPath);
        intervals.push({ start, end, owner: s, path: runPath });
      }
      if (blocks !== Math.ceil(inputTokens / 64)) invalid(`${path}.blockRuns`, 'expanded block count must equal ceil(in / 64)');
      stats.blockReferences = add(stats.blockReferences, blocks, path);
      stats.inputTokens = add(stats.inputTokens, inputTokens, `${path}.in`);
      stats.outputTokens = add(stats.outputTokens, outputTokens, `${path}.out`);
      const timing = fields(request.timing, ['kind', 'anchorReq', 'offsetMs'], `${path}.timing`);
      integer(timing.offsetMs, `${path}.timing.offsetMs`);
      if (timing.kind === 'origin') {
        if (timing.anchorReq !== null) invalid(`${path}.timing.anchorReq`, 'origin requires null');
      } else if (timing.kind === 'arrival' || timing.kind === 'completion') {
        const anchor = integer(timing.anchorReq, `${path}.timing.anchorReq`);
        if (anchor >= r) invalid(`${path}.timing.anchorReq`, 'must refer to an earlier request in this session');
      } else invalid(`${path}.timing.kind`, 'expected origin, arrival or completion');
      stats.anchors[/** @type {keyof ReplayBundleStats['anchors']} */ (timing.kind)]++;
    }
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  let previous = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const current = intervals[i];
    if (current.start <= previous.end) {
      if (current.owner !== previous.owner) invalid(current.path, `block IDs overlap session ${previous.owner}`);
      if (current.end > previous.end) previous = current;
    } else previous = current;
  }
  stats.meanRequestsPerSession = stats.requests / stats.sessions;
  return stats;
}

/**
 * The transport must decompress gzip with the same byte budget before calling this.
 * @param {string | Uint8Array} input
 * @param {Partial<ReplayLimits>} [limitOverrides]
 * @returns {{bundle: ReplayBundle, stats: ReplayBundleStats}}
 */
export function parseReplayBundle(input, limitOverrides = {}) {
  const limits = replayLimits(limitOverrides);
  let text;
  if (typeof input === 'string') {
    budget(input.length, limits.maxDecompressedBytes, 'bundle.bytes');
    budget(new TextEncoder().encode(input).byteLength, limits.maxDecompressedBytes, 'bundle.bytes');
    text = input;
  } else if (input instanceof Uint8Array) {
    budget(input.byteLength, limits.maxDecompressedBytes, 'bundle.bytes');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch { invalid('bundle.bytes', 'invalid UTF-8'); }
  } else invalid('bundle', 'expected UTF-8 JSON text or bytes');
  let bundle;
  try { bundle = JSON.parse(text); }
  catch { invalid('bundle', 'invalid JSON'); }
  const stats = validateReplayBundle(bundle, limits);
  return { bundle, stats };
}

/**
 * @typedef {Object} FlatReplayRequest
 * @property {number} in
 * @property {number} out
 * @property {number[]} hashIds
 * @property {number} tMs
 * @property {number} apiMs
 * @property {number} endMs
 * @property {number} rawTime
 * @property {number} rawEnd
 * @property {number} topIndex
 * @property {number | null} innerIndex
 * @property {string} path
 * @property {'missing' | 'null' | 'zero' | 'positive'} thinkTimeStatus
 */

/** @param {unknown} value @param {string} path @returns {number} */
function seconds(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(path, 'expected finite nonnegative seconds');
  return value;
}

/** @param {unknown} value @param {string} path */
function identifier(value, path) {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number') return integer(value, path);
  return invalid(path, 'expected a nonempty string or nonnegative safe integer');
}

/** @param {unknown} value @param {string} path */
function modelName(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(path, 'expected a nonempty model name');
  return value;
}

/**
 * Keeps raw hash arrays by reference (read-only); does not copy or mutate the source.
 * @param {unknown} input
 * @param {{lineNumber?: number, sourceIndex?: number, limits?: Partial<ReplayLimits>}} [options]
 */
export function flattenReplaySession(input, options = {}) {
  const limits = replayLimits(options.limits);
  const lineNumber = integer(options.lineNumber ?? 1, 'lineNumber', 1);
  const sourceIndex = integer(options.sourceIndex ?? 0, 'sourceIndex');
  const raw = record(input, `line ${lineNumber}`);
  const id = identifier(raw.id, `line ${lineNumber}.session.id`);
  const path = `line ${lineNumber}, session ${JSON.stringify(id)}`;
  if (raw.block_size !== 64) invalid(`${path}.block_size`, 'expected 64');
  if (raw.hash_id_scope !== 'local') invalid(`${path}.hash_id_scope`, 'expected local');
  if (!Array.isArray(raw.models)) invalid(`${path}.models`, 'expected an array');
  raw.models.forEach((/** @type {unknown} */ model, /** @type {number} */ index) => modelName(model, `${path}.models[${index}]`));
  const top = nonempty(raw.requests, `${path}.requests`);
  /** @type {FlatReplayRequest[]} */
  const requests = [];
  /** @type {{topIndex: number, firstReq: number | null, requests: number[]}[]} */
  const groups = [];
  /** @type {Map<number, typeof groups[number]>} */
  const groupByTop = new Map();
  let blockReferences = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  /** @param {unknown} value @param {number} topIndex @param {number | null} innerIndex */
  const collect = (value, topIndex, innerIndex) => {
    const requestPath = `${path}.requests[${topIndex}]${innerIndex === null ? '' : `.requests[${innerIndex}]`}`;
    const request = record(value, requestPath);
    if (request.type !== 's' && request.type !== 'n') invalid(`${requestPath}.type`, 'expected s or n');
    modelName(request.model, `${requestPath}.model`);
    const t = seconds(request.t, `${requestPath}.t`);
    const api = seconds(request.api_time, `${requestPath}.api_time`);
    const tMs = integer(Math.round(t * 1000), `${requestPath}.t (milliseconds)`);
    const apiMs = integer(Math.round(api * 1000), `${requestPath}.api_time (milliseconds)`);
    const inputLength = integer(request.in, `${requestPath}.in`, 1);
    const outputLength = integer(request.out, `${requestPath}.out`);
    if (!Array.isArray(request.hash_ids) || request.hash_ids.length !== Math.ceil(inputLength / 64)) invalid(`${requestPath}.hash_ids`, 'length must equal ceil(in / 64)');
    budget(requests.length + 1, limits.maxRequests, `${path}.requests`);
    blockReferences = add(blockReferences, request.hash_ids.length, `${path}.hash_ids`);
    budget(blockReferences, limits.maxBlockReferences, `${path}.hash_ids`);
    for (let k = 0; k < request.hash_ids.length; k++) {
      const hashId = request.hash_ids[k];
      if (!Number.isSafeInteger(hashId) || hashId < 0) integer(hashId, `${requestPath}.hash_ids[${k}]`);
    }
    /** @type {FlatReplayRequest['thinkTimeStatus']} */
    let thinkTimeStatus = 'missing';
    if (Object.hasOwn(request, 'think_time')) {
      if (request.think_time === null) thinkTimeStatus = 'null';
      else thinkTimeStatus = seconds(request.think_time, `${requestPath}.think_time`) === 0 ? 'zero' : 'positive';
    }
    inputTokens = add(inputTokens, inputLength, `${path}.inputTokens`);
    outputTokens = add(outputTokens, outputLength, `${path}.outputTokens`);
    requests.push({ in: inputLength, out: outputLength, hashIds: request.hash_ids, tMs, apiMs, endMs: 0, rawTime: t, rawEnd: t + api, topIndex, innerIndex, path: requestPath, thinkTimeStatus });
  };
  for (let i = 0; i < top.length; i++) {
    const value = record(top[i], `${path}.requests[${i}]`);
    if (value.type !== 'subagent') { collect(value, i, null); continue; }
    seconds(value.t, `${path}.requests[${i}].t`);
    identifier(value.agent_id, `${path}.requests[${i}].agent_id`);
    if (!Array.isArray(value.requests)) invalid(`${path}.requests[${i}].requests`, 'expected an array');
    const group = { topIndex: i, firstReq: /** @type {number | null} */ (null), requests: /** @type {number[]} */ ([]) };
    groups.push(group);
    groupByTop.set(i, group);
    for (let j = 0; j < value.requests.length; j++) collect(value.requests[j], i, j);
  }
  if (requests.length === 0) invalid(path, 'empty session: no model requests');
  requests.sort((a, b) => a.rawTime - b.rawTime || a.topIndex - b.topIndex || (a.innerIndex ?? -1) - (b.innerIndex ?? -1));
  const originMs = requests[0].tMs;
  const originSeconds = requests[0].rawTime;
  let lastEnd = originSeconds;
  /** @type {number[]} */
  const mainRequests = [];
  const thinkTime = { missing: 0, null: 0, zero: 0, positive: 0 };
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    request.tMs -= originMs;
    request.endMs = add(request.tMs, request.apiMs, `${request.path}.endMs`);
    lastEnd = Math.max(lastEnd, request.rawEnd);
    thinkTime[request.thinkTimeStatus]++;
    if (request.innerIndex === null) mainRequests.push(i);
    else {
      const group = /** @type {typeof groups[number]} */ (groupByTop.get(request.topIndex));
      group.firstReq ??= i;
      group.requests.push(i);
    }
  }
  return { id, sourceIndex, lineNumber, originMs, spanSeconds: lastEnd - originSeconds, requests, mainRequests, groups, inputTokens, outputTokens, blockReferences, thinkTime };
}

/** @param {[number, number][]} runs @param {number} id */
function appendRun(runs, id) {
  const last = runs[runs.length - 1];
  if (last && id - last[0] === last[1]) last[1] = add(last[1], 1, 'blockRuns.count');
  else runs.push([id, 1]);
}

/** @param {Iterable<number>} ids @returns {[number, number][]} */
export function encodeReplayRuns(ids) {
  /** @type {[number, number][]} */
  const runs = [];
  for (const id of ids) appendRun(runs, integer(id, 'block ID'));
  return runs;
}

/** @param {ReadonlyArray<readonly [number, number]>} runs */
export function* iterateReplayBlocks(runs) {
  for (const [start, count] of runs) {
    integer(start, 'blockRuns.start');
    integer(count, 'blockRuns.count', 1);
    add(start, count - 1, 'blockRuns.end');
    for (let i = 0; i < count; i++) yield start + i;
  }
}

/**
 * Reconstructs the trace arrivals using the compiled edges and original service times.
 * @param {ReturnType<typeof flattenReplaySession>} flat
 * @param {import('../contracts/replay').ReplaySession} session
 */
export function verifyReplayTiming(flat, session) {
  if (session.req.length !== flat.requests.length) invalid('timing', 'request count changed');
  /** @type {number[]} */
  const arrivals = [];
  for (let i = 0; i < session.req.length; i++) {
    const timing = session.req[i].timing;
    integer(timing.offsetMs, `timing[${i}].offsetMs`);
    let base = 0;
    if (timing.kind === 'origin') {
      if (timing.anchorReq !== null) invalid(`timing[${i}]`, 'origin requires null');
    } else {
      if (timing.kind !== 'arrival' && timing.kind !== 'completion') invalid(`timing[${i}]`, 'unknown anchor kind');
      const anchor = integer(timing.anchorReq, `timing[${i}].anchorReq`);
      if (anchor >= i) invalid(`timing[${i}]`, 'anchor must be earlier');
      base = arrivals[anchor] + (timing.kind === 'completion' ? flat.requests[anchor].apiMs : 0);
    }
    const arrival = add(base, timing.offsetMs, `timing[${i}]`);
    if (arrival !== flat.requests[i].tMs) invalid(flat.requests[i].path, 'compiled timing does not recover original arrival');
    arrivals.push(arrival);
  }
  return arrivals;
}

/**
 * @typedef {Object} ReplayTrieNode
 * @property {number} parent
 * @property {number} hashId
 * @property {Map<number, number> | null} children
 * @property {number[] | null} completed
 * @property {number[] | null} best
 */

/**
 * Each completed index is sorted by (endMs, stable index); prefix maxima implement
 * the arrival-time/index tie break. Queries visit deepest path endpoints first.
 * @param {ReturnType<typeof flattenReplaySession>} flat
 * @param {{startBlockId?: number, evidenceLimit?: number, limits?: Partial<ReplayLimits>}} [options]
 */
export function compileReplaySession(flat, options = {}) {
  const startBlockId = integer(options.startBlockId ?? 0, 'startBlockId');
  const evidenceLimit = integer(options.evidenceLimit ?? 32, 'evidenceLimit');
  budget(evidenceLimit, 1000, 'evidenceLimit');
  const limits = replayLimits(options.limits);
  /** @type {ReplayTrieNode[]} */
  const nodes = [{ parent: -1, hashId: -1, children: null, completed: null, best: null }];
  /** @type {number[]} */
  const terminals = [];
  /** @type {import('../contracts/replay').ReplayRequest[]} */
  const req = [];
  let runCount = 0;
  for (const request of flat.requests) {
    let parent = 0;
    /** @type {[number, number][]} */
    const runs = [];
    for (const hashId of request.hashIds) {
      const children = nodes[parent].children ??= new Map();
      let node = children.get(hashId);
      if (node === undefined) {
        node = nodes.length;
        add(startBlockId, node - 1, 'globalBlockId');
        children.set(hashId, node);
        nodes.push({ parent, hashId, children: null, completed: null, best: null });
      }
      appendRun(runs, startBlockId + node - 1);
      parent = node;
    }
    runCount = add(runCount, runs.length, 'compiled.runs');
    budget(runCount, limits.maxRuns, 'compiled.runs');
    terminals.push(parent);
    req.push({ in: request.in, out: request.out, blockRuns: runs, timing: { kind: 'origin', anchorReq: null, offsetMs: request.tMs } });
  }
  for (const i of flat.mainRequests) (nodes[terminals[i]].completed ??= []).push(i);
  for (const node of nodes) {
    if (!node.completed) continue;
    node.completed.sort((a, b) => flat.requests[a].endMs - flat.requests[b].endMs || a - b);
    node.best = [];
    let best = -1;
    for (const index of node.completed) {
      if (best < 0 || flat.requests[index].tMs > flat.requests[best].tMs || (flat.requests[index].tMs === flat.requests[best].tMs && index > best)) best = index;
      node.best.push(best);
    }
  }
  /** @param {number} i */
  const candidate = i => {
    const time = flat.requests[i].tMs;
    for (let n = terminals[i]; n !== 0; n = nodes[n].parent) {
      const node = nodes[n];
      if (!node.completed || !node.best) continue;
      let lo = 0, hi = node.completed.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const index = node.completed[mid];
        const end = flat.requests[index].endMs;
        if (end < time || (end === time && index < i)) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) return node.best[lo - 1];
    }
    return -1;
  };
  const diagnostics = { firstMain: 0, overlapArrival: 0, completion: 0, backtrackedCompletion: 0, fallbackArrival: 0, groupOrigin: 0, groupArrival: 0, innerArrival: 0 };
  let previous = -1;
  for (const i of flat.mainRequests) {
    const request = flat.requests[i];
    if (previous < 0) diagnostics.firstMain++;
    else {
      const prior = flat.requests[previous];
      if (prior.endMs > request.tMs && prior.hashIds[0] === request.hashIds[0]) {
        req[i].timing = { kind: 'arrival', anchorReq: previous, offsetMs: request.tMs - prior.tMs };
        diagnostics.overlapArrival++;
      } else {
        const anchor = candidate(i);
        if (anchor >= 0) {
          req[i].timing = { kind: 'completion', anchorReq: anchor, offsetMs: request.tMs - flat.requests[anchor].endMs };
          diagnostics.completion++;
          if (anchor !== previous) diagnostics.backtrackedCompletion++;
        } else {
          req[i].timing = { kind: 'arrival', anchorReq: previous, offsetMs: request.tMs - prior.tMs };
          diagnostics.fallbackArrival++;
        }
      }
    }
    previous = i;
  }
  for (const group of flat.groups) {
    const first = group.firstReq;
    if (first === null) continue;
    if (first === 0) diagnostics.groupOrigin++;
    else {
      req[first].timing = { kind: 'arrival', anchorReq: first - 1, offsetMs: flat.requests[first].tMs - flat.requests[first - 1].tMs };
      diagnostics.groupArrival++;
    }
    for (const i of group.requests) {
      if (i === first) continue;
      req[i].timing = { kind: 'arrival', anchorReq: first, offsetMs: flat.requests[i].tMs - flat.requests[first].tMs };
      diagnostics.innerArrival++;
    }
  }
  const session = { req };
  verifyReplayTiming(flat, session);
  for (let i = 0; i < req.length; i++) {
    let parent = 0, position = 0;
    for (const id of iterateReplayBlocks(req[i].blockRuns)) {
      const index = id - startBlockId + 1;
      const node = nodes[index];
      if (!node || node.parent !== parent || node.hashId !== flat.requests[i].hashIds[position]) invalid(flat.requests[i].path, 'RLE path identity mismatch');
      parent = index;
      position++;
    }
    if (position !== flat.requests[i].hashIds.length) invalid(flat.requests[i].path, 'RLE path length changed');
  }
  const evidence = req.slice(0, evidenceLimit).map((request, i) => ({ request: i, topIndex: flat.requests[i].topIndex, innerIndex: flat.requests[i].innerIndex, tMs: flat.requests[i].tMs, apiMs: flat.requests[i].apiMs, timing: { ...request.timing } }));
  return { session, nextBlockId: add(startBlockId, nodes.length - 1, 'nextBlockId'), uniqueBlocks: nodes.length - 1, diagnostics, evidence };
}

/**
 * @template {{session: import('../contracts/replay').ReplaySession, sourceIndex: number}} T
 * @param {readonly T[]} entries
 * @param {number} [orderSeed]
 * @returns {T[]}
 */
export function orderReplaySessions(entries, orderSeed = 1) {
  integer(orderSeed, 'orderSeed');
  if (orderSeed > 0xffffffff) invalid('orderSeed', 'expected a uint32 seed');
  if (!entries.length) invalid('sessions', 'cannot order empty sessions');
  const sorted = [...entries].sort((a, b) => a.session.req.length - b.session.req.length || a.sourceIndex - b.sourceIndex);
  const layerCount = Math.min(8, sorted.length);
  /** @type {T[][]} */
  const layers = [];
  const rng = mulberry32(orderSeed);
  for (let k = 0; k < layerCount; k++) {
    const layer = sorted.slice(Math.floor(k * sorted.length / layerCount), Math.floor((k + 1) * sorted.length / layerCount));
    for (let i = layer.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [layer[i], layer[j]] = [layer[j], layer[i]];
    }
    layers.push(layer);
  }
  /** @type {number[]} */
  const visits = [];
  for (let low = 0, high = layerCount - 1; low <= high; low++, high--) {
    visits.push(low);
    if (low !== high) visits.push(high);
  }
  /** @type {T[]} */
  const ordered = [];
  for (let round = 0; ordered.length < entries.length; round++) {
    for (const layer of visits) if (round < layers[layer].length) ordered.push(layers[layer][round]);
  }
  return ordered;
}

/** @type {Readonly<import('../contracts/replay').ReplayRunLimits>} */
export const DEFAULT_REPLAY_RUN_LIMITS = Object.freeze({
  maxSessions: 10_000,
  maxRequests: 20_000,
  maxEvents: 40_000,
  maxBlockReferences: 2_000_000,
  maxWallTimeMs: 30_000,
  maxResultBytes: 32 * 1024 * 1024,
});

/** @param {Partial<typeof DEFAULT_REPLAY_RUN_LIMITS>} [overrides] */
export function replayRunLimits(overrides = {}) {
  record(overrides, 'replay.options.limits');
  const limits = { ...DEFAULT_REPLAY_RUN_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(limits, key)) invalid(`replay.options.limits.${key}`, 'unknown resource limit');
    const name = /** @type {keyof typeof limits} */ (key);
    limits[name] = integer(overrides[name], `replay.options.limits.${key}`, 1);
  }
  return limits;
}

/** @param {unknown} value @param {string} path */
function positiveSeconds(value, path) {
  const result = seconds(value, path);
  if (result === 0) invalid(path, 'expected a positive number');
  return result;
}

/** @param {number} seed */
export function createReplayRandomStreams(seed) {
  integer(seed, 'replay.seed');
  if (seed > 0xffffffff) invalid('replay.seed', 'expected a uint32 seed');
  return { launch: mulberry32((seed ^ 0x6c61756e) >>> 0), route: mulberry32((seed ^ 0x726f7574) >>> 0) };
}

/** @typedef {{time: number, sequence: number, kind: string, data: any}} ReplayEvent */
export class ReplayEventHeap {
  /** @param {number} [limit] */
  constructor(limit = DEFAULT_REPLAY_RUN_LIMITS.maxEvents) {
    this.limit = integer(limit, 'replay.maxEvents', 1);
    /** @type {ReplayEvent[]} */
    this.items = [];
    this.sequence = 0;
  }
  get size() { return this.items.length; }
  peek() { return this.items[0]; }
  /** @param {ReplayEvent} a @param {ReplayEvent} b */
  before(a, b) { return a.time < b.time || (a.time === b.time && a.sequence < b.sequence); }
  /** @param {number} time @param {string} kind @param {any} [data] */
  push(time, kind, data) {
    seconds(time, 'replay.event.time');
    budget(this.size + 1, this.limit, 'replay.events');
    integer(this.sequence + 1, 'replay.event.sequence');
    const event = { time, kind, data, sequence: this.sequence++ };
    let i = this.items.length;
    this.items.push(event);
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!this.before(event, this.items[parent])) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = event;
    return event;
  }
  pop() {
    if (!this.size) return undefined;
    const first = this.items[0];
    const tail = /** @type {ReplayEvent} */ (this.items.pop());
    if (this.size) {
      let i = 0;
      while (2 * i + 1 < this.size) {
        let child = 2 * i + 1;
        if (child + 1 < this.size && this.before(this.items[child + 1], this.items[child])) child++;
        if (!this.before(this.items[child], tail)) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = tail;
    }
    return first;
  }
}

let replayRunSequence = 0;

/**
 * Only one future launch is materialized; consuming a launch never consumes routing randomness.
 * @param {ReplayBundle} bundle
 * @param {{qps: number, durationSeconds: number, seed: number, limits?: Partial<typeof DEFAULT_REPLAY_RUN_LIMITS>}} options
 */
export function createReplayLauncher(bundle, options) {
  const stats = validateReplayBundle(bundle);
  const durationSeconds = positiveSeconds(options.durationSeconds, 'replay.durationSeconds');
  const qps = positiveSeconds(options.qps, 'replay.qps');
  const limits = replayRunLimits(options.limits);
  const random = createReplayRandomStreams(options.seed);
  const lambdaSession = qps / stats.meanRequestsPerSession;
  if (!(lambdaSession > 0) || !Number.isFinite(lambdaSession)) invalid('replay.lambdaSession', 'unrepresentable session rate');
  const runKey = integer(++replayRunSequence, 'replay.runSequence', 1);
  let time = 0;
  let launches = 0;
  let plannedRequests = 0;
  let blockReferences = 0;
  const templateBlocks = bundle.sessions.map(session => session.req.reduce((sum, req) => sum + Math.ceil(req.in / 64), 0));
  /** @type {{time: number, templateIndex: number, launchIndex: number, sessionInstanceKey: string} | null} */
  let next = null;
  function advance() {
    const gap = -Math.log((random.launch() * 0x100000000 + 0.5) / 0x100000000) / lambdaSession;
    const future = time + gap;
    if (future >= durationSeconds) { next = null; return; }
    if (!Number.isFinite(future) || future <= time) invalid('replay.launch.time', 'arrival interval cannot advance the clock');
    time = future;
    const templateIndex = launches % stats.sessions;
    next = { time, templateIndex, launchIndex: launches, sessionInstanceKey: `r${runKey}:t${templateIndex}:n${launches}` };
  }
  advance();
  return {
    stats, limits, lambdaSession, routeRandom: random.route,
    peek: () => next,
    get launches() { return launches; },
    get plannedRequests() { return plannedRequests; },
    get blockReferences() { return blockReferences; },
    take() {
      if (!next) return null;
      const event = next;
      const count = bundle.sessions[event.templateIndex].req.length;
      budget(launches + 1, limits.maxSessions, 'replay.launchedSessions');
      budget(add(plannedRequests, count, 'replay.plannedRequests'), limits.maxRequests, 'replay.plannedRequests');
      budget(add(blockReferences, templateBlocks[event.templateIndex], 'replay.blockReferences'), limits.maxBlockReferences, 'replay.blockReferences');
      launches++;
      plannedRequests += count;
      blockReferences += templateBlocks[event.templateIndex];
      advance();
      return event;
    },
  };
}

/** @param {unknown} input @returns {import('../contracts/replay').ReplayOverride} */
export function validateReplayOverride(input) {
  const value = fields(input, ['bundle', 'options'], 'replay');
  validateReplayBundle(value.bundle);
  budget(JSON.stringify(value.bundle).length, DEFAULT_REPLAY_LIMITS.maxDecompressedBytes, 'replay.bundle.bytes');
  const options = record(value.options, 'replay.options');
  const allowed = ['arrivalModel', 'durationSeconds', 'warmupSeconds', 'superblocks', 'limits'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) invalid(`replay.options.${key}`, 'unknown option');
  if (options.arrivalModel !== undefined && options.arrivalModel !== 'closed') invalid('replay.options.arrivalModel', 'only closed is supported');
  const durationSeconds = positiveSeconds(options.durationSeconds, 'replay.options.durationSeconds');
  const warmupSeconds = seconds(options.warmupSeconds, 'replay.options.warmupSeconds');
  if (warmupSeconds >= durationSeconds) invalid('replay.options.warmupSeconds', 'must be less than durationSeconds');
  if (options.superblocks !== undefined && typeof options.superblocks !== 'boolean') invalid('replay.options.superblocks', 'expected boolean');
  if (options.superblocks === true) invalid('replay.options.superblocks', 'unsupported before logical-block equivalence validation');
  const limits = replayRunLimits(options.limits);
  return { bundle: value.bundle, options: { arrivalModel: 'closed', durationSeconds, warmupSeconds, superblocks: false, limits } };
}

/**
 * Request states: waiting anchor, scheduled, arrived, successful, failed, cancelled.
 * @param {import('../contracts/replay').ReplayOverride} replay
 * @param {{qps: number, seed: number, hooks?: Record<string, Function>}} config
 */
export function createReplayRuntime(replay, config) {
  const { bundle, options } = validateReplayOverride(replay);
  const launcher = createReplayLauncher(bundle, { ...options, qps: config.qps, seed: config.seed });
  const heap = new ReplayEventHeap(launcher.limits.maxEvents);
  const hooks = config.hooks || {};
  const templates = bundle.sessions.map(session => {
    const arrival = session.req.map(() => /** @type {number[]} */ ([]));
    const completion = session.req.map(() => /** @type {number[]} */ ([]));
    /** @type {number[]} */
    const origins = [];
    session.req.forEach((req, i) => {
      if (req.timing.kind === 'origin') origins.push(i);
      else (req.timing.kind === 'arrival' ? arrival : completion)[req.timing.anchorReq].push(i);
    });
    return { arrival, completion, origins, inputTokens: session.req.reduce((n, q) => n + q.in, 0), outputTokens: session.req.reduce((n, q) => n + q.out, 0) };
  });
  /** @type {Map<string, any>} */
  const sessions = new Map();
  const counters = { arrived: 0, successful: 0, failed: 0, cancelled: 0, infeasible: 0, aborted: 0, anchor_unavailable: 0, completedSessions: 0 };
  const startedAt = performance.now();
  function checkWallTime() { budget(performance.now() - startedAt, launcher.limits.maxWallTimeMs, 'replay.wallTimeMs'); }
  function queueLaunch() { const next = launcher.peek(); if (next) heap.push(next.time, 'session-launch', null); }
  queueLaunch();
  /** @param {any} session @param {number} index @param {number} base */
  function release(session, index, base) {
    if (session.states[index] !== 0) return;
    const time = base + bundle.sessions[session.templateIndex].req[index].timing.offsetMs / 1000;
    heap.push(time, 'request-arrival', { key: session.sessionInstanceKey, index });
    session.states[index] = 1;
  }
  /** @param {any} session */
  function settleSession(session) {
    session.remaining--;
    if (session.remaining === 0) {
      counters.completedSessions++;
      sessions.delete(session.sessionInstanceKey);
    }
  }
  /** @param {any} session @param {number[]} roots @param {number} time */
  function cancel(session, roots, time) {
    const stack = roots.slice();
    while (stack.length) {
      const index = /** @type {number} */ (stack.pop());
      if (session.states[index] !== 0) continue;
      session.states[index] = 5;
      counters.cancelled++; counters.anchor_unavailable++;
      hooks.cancel?.({ templateIndex: session.templateIndex, launchIndex: session.launchIndex, requestIndex: index }, time);
      for (const child of templates[session.templateIndex].arrival[index]) stack.push(child);
      for (const child of templates[session.templateIndex].completion[index]) stack.push(child);
      settleSession(session);
    }
  }
  /** @param {any} req @param {number} time @param {string | null} reason */
  function terminal(req, time, reason) {
    const session = sessions.get(req.sessionInstanceKey);
    if (!session || session.states[req.requestIndex] !== 2) return false;
    seconds(time, 'replay.terminal.time');
    if (time < req.arrive) invalid('replay.terminal.time', 'completion precedes client arrival');
    session.states[req.requestIndex] = reason === null ? 3 : 4;
    if (reason === null) {
      counters.successful++;
      hooks.complete?.(req);
      for (const index of templates[session.templateIndex].completion[req.requestIndex]) release(session, index, time);
    } else {
      counters.failed++;
      if (reason === 'infeasible') counters.infeasible++;
      else counters.aborted++;
      hooks.fail?.(req, reason);
      cancel(session, templates[session.templateIndex].completion[req.requestIndex], time);
    }
    settleSession(session);
    return true;
  }
  return {
    launcher, options, heap, sessions, checkWallTime,
    get nextTime() { return heap.peek()?.time ?? Infinity; },
    get done() { return heap.size === 0 && sessions.size === 0; },
    /** @param {number} now @param {(req: any) => void} onArrival */
    drainEvents(now, onArrival) {
      seconds(now, 'replay.now');
      while (heap.size && /** @type {ReplayEvent} */ (heap.peek()).time <= now) {
        checkWallTime();
        const event = /** @type {ReplayEvent} */ (heap.pop());
        if (event.kind === 'session-launch') {
          const launch = launcher.take();
          if (!launch || event.time !== launch.time) invalid('replay.scheduler', 'launch event invariant violated');
          const req = bundle.sessions[launch.templateIndex].req;
          const session = { ...launch, states: new Uint8Array(req.length), remaining: req.length, baseId: launcher.plannedRequests - req.length };
          sessions.set(session.sessionInstanceKey, session);
          const template = templates[session.templateIndex];
          hooks.launch?.({ time: launch.time, templateIndex: launch.templateIndex, launchIndex: launch.launchIndex, requests: req.length, inputTokens: template.inputTokens, outputTokens: template.outputTokens });
          for (const index of template.origins) release(session, index, launch.time);
          queueLaunch();
        } else {
          const session = sessions.get(event.data.key);
          if (!session || session.states[event.data.index] !== 1) invalid('replay.scheduler', 'arrival event invariant violated');
          const index = event.data.index;
          session.states[index] = 2;
          counters.arrived++;
          const request = createReplayRequest(bundle.sessions[session.templateIndex].req[index], session.baseId + index, event.time,
            { sessionInstanceKey: session.sessionInstanceKey, sessionId: session.sessionInstanceKey, routingKey: `replay:t${session.templateIndex}:n${session.launchIndex}`,
              templateIndex: session.templateIndex, launchIndex: session.launchIndex, requestIndex: index });
          hooks.arrive?.(request);
          for (const child of templates[session.templateIndex].arrival[index]) release(session, child, event.time);
          onArrival(request);
        }
      }
    },
    /** @param {any} req @param {number} time */
    complete(req, time) { return terminal(req, time, null); },
    /** @param {any} req @param {string} reason @param {number} time */
    fail(req, reason, time) { return terminal(req, time, reason); },
    counts() {
      let arrivedUnfinished = 0, pendingArrival = 0, waitingAnchor = 0;
      for (const session of sessions.values()) for (const state of session.states) {
        if (state === 0) waitingAnchor++;
        else if (state === 1) pendingArrival++;
        else if (state === 2) arrivedUnfinished++;
      }
      return { ...counters, planned: launcher.plannedRequests, launchedSessions: launcher.launches,
        completeCycles: Math.floor(launcher.launches / bundle.sessions.length), activeSessions: sessions.size,
        arrivedUnfinished, pendingArrival, waitingAnchor, unfinished: arrivedUnfinished + pendingArrival + waitingAnchor };
    },
  };
}
