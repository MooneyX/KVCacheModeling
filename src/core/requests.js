/** @typedef {{pathId: string, position: number, tokens: number}} ContentSegment */

function createRequest(id, arrive, inputLen, outputLen, fields = {}) {
  return {
    id, arrive, inputLen, outputLen,
    groupId: null, prefixTokLen: 0, isFounder: false, followUp: false, retainIds: null,
    state: 'wait', tokensGen: 0, admitTime: 0, prefillStart: 0, prefillEnd: 0, decodeStart: 0, completeTime: 0,
    prefixBlkIds: [], ownBlkIds: [], kvHbm: 0, kvDram: 0, kvSsd: 0, prefillTokens: inputLen,
    _outAllocTok: 0, _outSeq: 0, _outMerge: 1, _recomputeTok: 0,
    ...fields,
  };
}

function contentPath(history, identity) {
  return JSON.stringify([history.map(({ pathId, position, tokens }) => [pathId, position, tokens]), identity]);
}

function prefixContent(groupId, tokens) {
  return { pathId: `synthetic:prefix:${groupId}`, position: 0, tokens };
}

function setContent(req, inputContent, outputPath) {
  // Both sources expose a read-only iterable of ContentSegment; Replay keeps RLE lazy.
  req.inputContent = Array.isArray(inputContent)
    ? Object.freeze(inputContent.map(segment => Object.freeze(segment))) : Object.freeze(inputContent);
  req.outputIdentity = Object.freeze({ pathId: outputPath, position: req.inputLen, tokens: req.outputLen });
  return req;
}

function setSyntheticContent(req, history = []) {
  const content = [];
  let position = 0;
  for (const segment of history) {
    const tokens = Math.min(segment.tokens, req.inputLen - position);
    if (tokens <= 0) break;
    content.push({ pathId: segment.pathId, position, tokens });
    position += tokens;
  }
  if (!history.length && req.groupId && req.prefixTokLen > 0) {
    position = Math.min(req.inputLen, req.prefixTokLen);
    content.push(prefixContent(req.groupId, position));
  }
  if (position < req.inputLen) {
    content.push({ pathId: contentPath(content, ['synthetic', req.sessionId, req.id, 'input']),
      position, tokens: req.inputLen - position });
  }
  return setContent(req, content, contentPath(content, ['synthetic', req.sessionId, req.id, 'output']));
}

export function generateRequests(p, overrides, rng, prefixGroupMap) {
  let N = overrides.nreq || Math.min(p.concurrency, 256);
  let requests = [], t = 0, lambda = Math.max(p.qps, 1e-9); // qps 真实生效; 仅防 0/负导致除零(极小值→无请求到达)
  let sigma = 0.6, muL = Math.log(Math.max(p.inputLen,1)) - sigma*sigma/2;
  let muO = Math.log(Math.max(p.outputLen,1)) - sigma*sigma/2;
  function sampleLen(avg, mu){
    if (p.lenDist === 'fixed') return Math.max(64, Math.round(avg)); // 严格固定 = 均值(输入/输出均精确)
    if (p.lenDist === 'lognormal') {
      let u1 = Math.max(rng(), 1e-9), u2 = rng();
      let z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
      return Math.max(64, Math.min(avg*8, Math.round(Math.exp(mu + sigma*z))));
    }
    return Math.max(64, Math.round(avg * (0.5 + rng())));
  }
  for (let i = 0; i < N; i++) {
    // 到达间隔: 泊松(指数分布, 有突发) 或 均匀(固定间隔 1/λ)
    t += p.arrivalDist === 'uniform' ? 1 / lambda : -Math.log(Math.max(rng(), 1e-9)) / lambda;
    let inLen = sampleLen(p.inputLen, muL);
    let outLen = sampleLen(p.outputLen, muO);
    const sessionId = `synthetic:${i}`;
    requests.push(createRequest(i, t, inLen, outLen, { sessionId, routingKey: sessionId }));
  }
  requests.sort((a, b) => a.arrive - b.arrive);

  // 单批 prefill 微基准(2026-08-19): 全部请求 t=0 同时到达(忽略 qps/到达分布),
  // 配合准入/槽位门控跳过 + prefill 完成即结束, 实现"单个 batch 的 prefill 操作"隔离测量。
  // ⚠️ 位置(2026-09-03 修 bug): 原语句在前缀组分配块(prefixHit>0.001)内部, prefixHit=0
  //   时整块被跳过 ⇒ t=0 覆盖失效, 请求仍按泊松散布, "单批"名存实亡(流体时代被槽位全
  //   放开掩盖; 移植到波次路径后暴露 —— 每请求各自成波, 批级同步消失)。移到组分配之前,
  //   对 prefixHit=0/有命中 两种场景统一生效。
  if (p.singleBatch) requests.forEach(rq => { rq.arrive = 0; });

  // 前缀组分配（与旧版相同思想：4组差异化前缀，按命中率目标配比，seeded）
  if (p.prefixHit > 0.001) {
    let totalInput = requests.reduce((s, r) => s + r.inputLen, 0);
    let h = Math.min(p.prefixHit, 1);                 // 命中率 h ∈ (0,1]
    let avgInput = Math.max(p.inputLen, 1);
    let groupDefs = [
      { id: 'pfx_A', ratio: 0.12 }, { id: 'pfx_B', ratio: 0.22 },
      { id: 'pfx_C', ratio: 0.35 }, { id: 'pfx_D', ratio: 0.48 },
    ];
    let sumRatioSq = groupDefs.reduce((s, g) => s + g.ratio * g.ratio, 0);
    // 入组数按满命中(h=1)基准配比(与 h 无关)；单请求覆盖量随 h 缩放:
    // (修复 2026-08-11: 旧版 pTokLen 固定、仅 nTotal 随 h 增长, maxAssign 封顶后命中率不敏感)
    // 修复旧版: nTotal=k×ratio+1 使 ΣnTotal≈3N 膨胀, 被 maxAssign 截断后实际覆盖≈h×0.29
    // (h=99% 实测仅 27.7% 覆盖)。新版水桶分配 ΣnTotal=maxAssign, 无截断。
    // 2026-08-12 v2 语义: prefixHit = 每个请求的"前缀命中比例"(与长度无关的固定比例)——
    // 每个入组请求命中 round(inputLen×h) 的输入(短/长请求一致), 与解析层 prefixSavedPerReq 同口径;
    // 共享前缀长度 = max(成员 inputLen)×h(组内统一), founder 取组内最长请求以保证能建完整前缀。
    let assignments = [];
    if (h > 0.001) {
      let maxAssign = Math.max(4, N);                   // 全请求入组(请求级命中率100%, 前缀缓存全覆盖); 保底4 兼容小N
      let sumRatio = groupDefs.reduce((s, g) => s + g.ratio, 0);
      let quota = groupDefs.map(g => maxAssign * g.ratio / sumRatio);
      let nTotals = quota.map(Math.floor);
      let rem = maxAssign - nTotals.reduce((s, x) => s + x, 0);
      let order = quota.map((q, i) => [i, q - Math.floor(q)]).sort((a, b) => b[1] - a[1]);
      for (let j = 0; j < rem; j++) nTotals[order[j % order.length][0]]++;
      groupDefs.forEach((g, i) => {
        if (nTotals[i] >= 1) assignments.push({ group: g, nTotal: nTotals[i] });  // >=1: 全请求入组(1人组也建组, 预热开时命中自己的前缀)
      });
    }
    let pool = requests.slice();
    for (let i = pool.length - 1; i > 0; i--) { let j = Math.floor(rng() * (i + 1)); let tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    let pi = 0;
    assignments.forEach(a => {
      let grp = [];
      for (let i = 0; i < a.nTotal && pi < pool.length; i++, pi++) {
        let req = pool[pi];
        req.groupId = a.group.id;
        req.prefixTokLen = Math.max(1, Math.round(req.inputLen * h)); // 每请求固定命中比例(与其自身长度无关)
        req.isFounder = false; grp.push(req);
      }
      if (grp.length >= 1) {
        // founder = 组内最长请求: 能 prefill 出完整组前缀(ownTokens = maxInput - P ≥ 0)
        grp.sort((x, y) => y.inputLen - x.inputLen);
        grp[0].isFounder = true;
        let P = Math.max(...grp.map(r0 => r0.prefixTokLen));  // 组前缀 = 最长请求的 h%
        prefixGroupMap[a.group.id] = { prefixTokLen: P, blkIds: [], refcount: 0, activated: false };
      }
    });
    Object.keys(prefixGroupMap).forEach(gid => {
      let grp = requests.filter(r0 => r0.groupId === gid);
      let founder = grp.find(r0 => r0.isFounder);
      let minOther = Math.min(...grp.filter(r0 => !r0.isFounder).map(r0 => r0.arrive));
      if (founder && isFinite(minOther)) founder.arrive = Math.max(0, minOther - 0.001);
    });
    requests.sort((a, b) => a.arrive - b.arrive);

  }
  requests.forEach(req => setSyntheticContent(req));
  return { N, requests };
}

/** @param {import('../contracts/replay').ReplayRequest} template @param {number} id @param {number} arrive @param {any} identity */
export function createReplayRequest(template, id, arrive, identity) {
  const sessionId = identity.sessionId ?? identity.sessionInstanceKey ?? `replay:${id}`;
  const req = createRequest(id, arrive, template.in, template.out,
    { replayTemplate: template, sessionId, routingKey: sessionId, ...identity });
  const runs = template.blockRuns.map(([start, count]) => [start, count]);
  const inputLen = template.in;
  const pathId = blockId => JSON.stringify(['replay', sessionId, 'input', blockId]);
  const content = {
    *[Symbol.iterator]() {
      let position = 0;
      for (const [start, count] of runs) {
        for (let offset = 0; offset < count; offset++) {
          const tokens = Math.min(64, inputLen - position);
          yield Object.freeze({ pathId: pathId(start + offset), position, tokens });
          position += tokens;
        }
      }
    },
  };
  const last = runs.at(-1);
  return setContent(req, content, JSON.stringify(['replay', sessionId, 'output', req.requestIndex ?? id,
    last ? pathId(last[0] + last[1] - 1) : null, inputLen]));
}

/**
 * U1 adapters only: retainedBlocks reads the old cache; onFollowUp transfers old ownership.
 * Neither content identity nor the event drain depends on those physical block handles.
 */
export function createSyntheticRuntime(p, overrides, rng, prefixGroupMap = {}, adapters = {}) {
  const { N, requests: pending } = generateRequests(p, overrides, rng, prefixGroupMap);
  const active = new Set();
  const counters = { arrived: 0, successful: 0, failed: 0, infeasible: 0, aborted: 0,
    launchedSessions: 0, completedSessions: 0, followUps: 0 };
  let initialCache = [];
  if (p.prefixCache === 'radix' && p.prefixWarm && p.prefixHit > 0.001) {
    initialCache = Object.entries(prefixGroupMap).map(([groupId, group]) => {
      const tokens = group.prefixTokLen;
      const l2 = p.prefixWarmL2 > 0.001
        ? Math.min(tokens, Math.max(0, Math.round(tokens * p.prefixWarmL2 / Math.max(p.prefixHit, 1e-9)))) : 0;
      return Object.freeze({ groupId,
        content: Object.freeze([Object.freeze(prefixContent(groupId, tokens))]),
        placements: Object.freeze([
          Object.freeze({ tier: 'dram', position: 0, tokens: l2 }),
          Object.freeze({ tier: 'ssd', position: l2, tokens: tokens - l2 }),
        ]),
      });
    });
  }
  function terminal(req, time, reason) {
    if (!active.has(req)) return false;
    if (!Number.isFinite(time) || time < req.arrive) throw new RangeError('Synthetic terminal time precedes arrival or is not finite');
    active.delete(req);
    let followUp = null;
    if (reason === null) {
      counters.successful++;
      if (!req.followUp && !p.singleBatch && p.multiTurn > 0 && rng() < p.multiTurn) {
        const retainIds = adapters.retainedBlocks?.(req) || [];
        if (retainIds.length > 0) {
          const id = N + counters.followUps++;
          const arrive = time + 1 + rng() * 4;
          const inputLen = Math.round(req.inputLen * (1.1 + 0.3 * rng()));
          const outputLen = Math.max(64, Math.round(req.outputLen * (0.8 + 0.4 * rng())));
          followUp = createRequest(id, arrive, inputLen, outputLen, {
            followUp: true, retainIds, prevTotalTok: req.inputLen, prefillTokens: 0,
            sessionId: req.sessionId, routingKey: req.routingKey,
          });
          const outputTokens = Math.min(req.outputLen, Math.max(0, Math.floor(req.tokensGen)));
          const history = req.inputContent.concat(outputTokens > 0 ? [{ ...req.outputIdentity, tokens: outputTokens }] : []);
          setSyntheticContent(followUp, history);
          pending.push(followUp);
          pending.sort((a, b) => a.arrive - b.arrive);
          adapters.onFollowUp?.(req, followUp);
        }
      }
    } else {
      counters.failed++;
      if (reason === 'infeasible') counters.infeasible++;
      else counters.aborted++;
    }
    if (!followUp) counters.completedSessions++;
    return true;
  }
  return {
    initialCount: N,
    // Snapshots keep the legacy drain estimate without exposing the mutable event queue.
    pendingRequests: () => pending.slice(),
    takeInitialCache() { const description = initialCache; initialCache = []; return description; },
    get nextTime() { return pending[0]?.arrive ?? Infinity; },
    get done() { return pending.length === 0 && active.size === 0; },
    drainEvents(now, onArrival) {
      while (pending.length && pending[0].arrive <= now) {
        const req = pending.shift();
        active.add(req);
        counters.arrived++;
        if (!req.followUp) counters.launchedSessions++;
        onArrival(req);
      }
    },
    complete(req, time) { return terminal(req, time, null); },
    fail(req, reason, time) { return terminal(req, time, reason); },
    counts() {
      return { ...counters, planned: N + counters.followUps, cancelled: 0, anchor_unavailable: 0,
        activeSessions: counters.launchedSessions - counters.completedSessions,
        arrivedUnfinished: active.size, pendingArrival: pending.length, waitingAnchor: 0,
        unfinished: active.size + pending.length };
    },
  };
}
