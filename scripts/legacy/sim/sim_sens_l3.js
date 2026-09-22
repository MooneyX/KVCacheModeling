// ============================================================
// L3 带宽 × 前缀命中率 → 平均TTFT 敏感性分析 harness v2
// 数据来源：index.html 内嵌仿真引擎（原样提取，未改动任何公式）
// 与网页行为一致：模型无 calib 时自动 applyEstimatedParams() 推导 a/b/τ_pf
// 用法: node sim_sens_l3.js probe|sweep [hitList] [bwList] [seed]
// ============================================================

const { createLegacyHarness } = require('../../../dist/node/library.cjs');

// ---------- 参数配置（对应网页各输入框的值） ----------
const CFG = {
  model: 'Qwen3-30B-A3B',        // 预置模型名（从 models 字典）
  hw: 'h20x8',               // 预置硬件
  concurrency: 16,
  inputLen: 8192,
  outputLen: 128,
  qps: 8,
  maxBatch: 1,
  blockSize: 16,
  prefixHitPct: 50,
  ssdBW: 10,
  chunkSize: 2048,
  seed: 42,
  lenDist: 'uniform',
  arrivalDist: 'poisson',
  framework: 'sglang',
  prefixCache: 'radix',
  pdSep: 1,
  tieredKv: 1,
  multiTurn: 0,
  mfu: 50,
  simMaxTime: 1200,
};

// ---------- 预置模型/硬件字典（与 index.html 一致） ----------
const MODELS = {
  'Llama-3-70B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-72B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:151936, paramsB:0, actB:0},
  'Llama-3-8B':    {attn:'gqa', layers:32, kvHeads:8, headDim:128, hidden:4096, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-7B':    {attn:'gqa', layers:28, kvHeads:4, headDim:128, hidden:3584, vocab:151936, paramsB:0, actB:0},
  'Qwen3-32B':     {attn:'gqa', layers:64, kvHeads:8, headDim:128, hidden:5120, vocab:151936, paramsB:32, actB:32},
  'Qwen3-30B-A3B': {attn:'gqa', layers:48, kvHeads:4, headDim:128, hidden:2048, vocab:151936, paramsB:30.5, actB:3.3},
  'DeepSeek-V2-Lite': {attn:'mla', layers:27, kvLora:512, ropeDim:64, hidden:2048, vocab:128256, paramsB:15.7, actB:2.4},
  'DeepSeek-V3':   {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:128256, paramsB:671, actB:37,
    calibA: 216, calibB: 0.0011},
  'Custom':        {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128000, paramsB:0, actB:0}
};
const HW = {
  'h20x8':  {hbm:96, hbmBW:4,   tflops:148, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:10, gpus:8},
  'h100x8': {hbm:80, hbmBW:3.35,tflops:989, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:14, gpus:8},
  'a100x8': {hbm:80, hbmBW:2,   tflops:312, tp:8, nvlink:600,  pcie:32,  dram:512,  dramBW:300, ssd:10, ssdBW:7,  gpus:8},
  'b200x8': {hbm:192,hbmBW:8,   tflops:2250,tp:8, nvlink:1800, pcie:128, dram:2048, dramBW:500, ssd:40, ssdBW:14, gpus:8}
};

// ---------- mock DOM ----------
function buildDocValues() {
  const mm = MODELS[CFG.model], hw = HW[CFG.hw];
  const v = {
    pAttnType: { value: mm.attn },
    pLayers: { value: String(mm.layers) },
    pKvHeads: { value: String(mm.kvHeads || 8) },
    pHeadDim: { value: String(mm.headDim || 128) },
    pKvLora: { value: String(mm.kvLora || 512) },
    pRopeDim: { value: String(mm.ropeDim || 64) },
    pHidden: { value: String(mm.hidden) },
    pVocab: { value: String(mm.vocab || 128000) },
    pDtype: { value: '1' },
    pWeightDtype: { value: '1' },
    pParamsB: { value: String(mm.paramsB || 0) },
    pActB: { value: String(mm.actB || 0) },
    pGpuCount: { value: String(hw.gpus) },
    pHbm: { value: String(hw.hbm) },
    pHbmBW: { value: String(hw.hbmBW) },
    pTflops: { value: String(hw.tflops) },
    pTpSize: { value: String(hw.tp) },
    pNvlinkBW: { value: String(hw.nvlink) },
    pPcieBW: { value: String(hw.pcie) },
    pTierQuant: { value: '1' },
    pDram: { value: String(hw.dram) },
    pDramBW: { value: String(hw.dramBW) },
    pSsd: { value: String(hw.ssd) },
    pSsdBW: { value: String(CFG.ssdBW) },
    pConcurrency: { value: String(CFG.concurrency) },
    pInputLen: { value: String(CFG.inputLen) },
    pOutputLen: { value: String(CFG.outputLen) },
    pQps: { value: String(CFG.qps) },
    pMfu: { value: String(CFG.mfu) },
    pMaxBatch: { value: String(CFG.maxBatch) },
    pBlockSize: { value: String(CFG.blockSize) },
    pSimMaxTime: { value: String(CFG.simMaxTime) },
    pPrefixHit: { value: String(CFG.prefixHitPct) },
    pPrefixWarm: { checked: true },
    pPrefillA: { value: String(CFG.prefillA || 79.5) },
    pPrefillB: { value: String(CFG.prefillB || 0.00533) },
    pFetchFixedUs: { value: String(CFG.fetchFixedUs || 209) },
    pChunkSize: { value: String(CFG.chunkSize) },
    pSeed: { value: String(CFG.seed) },
    pLenDist: { value: CFG.lenDist },
    pArrivalDist: { value: CFG.arrivalDist },
    pFramework: { value: CFG.framework },
    pPrefixCache: { value: CFG.prefixCache },
    pPdSep: { value: String(CFG.pdSep) },
    pTieredKv: { value: String(CFG.tieredKv) },
    pMultiTurn: { value: String(CFG.multiTurn) },
  };
  return v;
}
const docValues = buildDocValues();
const fakeEl = { value: '0', checked: false };

const { getParams, estimatePrefillParams, runSimulation, parseDSL, calcAll } = createLegacyHarness(id => docValues[id] || fakeEl);

// ---------- 与网页一致：模型无 calibA/B → applyEstimatedParams() 推导 ----------
// （init()/applyModel() 对 Qwen3-32B 等无校准模型会自动执行）
function autoEstimateParams() {
  if (MODELS[CFG.model].calibA != null && MODELS[CFG.model].calibB != null) {
    docValues.pPrefillA.value = String(MODELS[CFG.model].calibA);
    docValues.pPrefillB.value = String(MODELS[CFG.model].calibB);
  } else {
    let e = estimatePrefillParams(getParams());
    docValues.pPrefillA.value = e.a.toFixed(2);
    docValues.pPrefillB.value = e.b.toFixed(6);
    docValues.pFetchFixedUs.value = e.tauPf.toFixed(0);
  }
}
autoEstimateParams();
const EST = {
  a: parseFloat(docValues.pPrefillA.value),
  b: parseFloat(docValues.pPrefillB.value),
  tauPf: parseFloat(docValues.pFetchFixedUs.value),
};

// ---------- 封装 ----------
// 策略：默认 DSL 模板（Pure-HBM 预设）但 BATCH 改为 max(1) —— 串行 prefill，
// L3 拉取(fetch)的墙钟等待不被并行算力共享稀释，带宽差异在 TTFT 中直接可见
function baseStrategy() {
  return {
    name: 'Pure-HBM-max1', dsl: 'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(1)\nPLACE: hbm_first',
    admission: { type: 'always' },
    eviction: { type: 'lru', hbm_evict_threshold: 0.9 },
    prefetch: { type: 'none' },
    placement: { type: 'hbm_first' },
    batching: { type: 'continuous', max_batch_size: 1 }
  };
}

function runOne(prefixHitPct, ssdBW, seed) {
  docValues.pPrefixHit.value = String(prefixHitPct);
  docValues.pSsdBW.value = String(ssdBW);
  let s = baseStrategy();
  let r = runSimulation(s, { seed: seed != null ? seed : CFG.seed, prefixHit: prefixHitPct / 100, ssdBW: ssdBW });
  return r;
}

// ============================ main ============================
const mode = process.argv[2] || 'probe';
console.error('EST a/b/tauPf = ' + EST.a + ' / ' + EST.b + ' / ' + EST.tauPf);

if (mode === 'probe') {
  const hit = Number(process.argv[3] || CFG.prefixHitPct);
  const bw = Number(process.argv[4] || CFG.ssdBW);
  const t0 = Date.now();
  const r = runOne(hit, bw, CFG.seed);
  const dt = (Date.now() - t0) / 1000;
  const perReq = (r.timeline || []).map(t => ({
    id: t.id, arrive: +t.arrive.toFixed(3), admit: +(t.admitTime || 0).toFixed(3),
    pstart: +(t.prefillStart || 0).toFixed(3), pend: +(t.prefillEnd || 0).toFixed(3),
    ttft: +(((t.prefillEnd || 0) - t.arrive) * 1000).toFixed(1)
  }));
  console.log(JSON.stringify({
    model: CFG.model, hw: CFG.hw, conc: CFG.concurrency, inLen: CFG.inputLen, outLen: CFG.outputLen,
    hitPct: hit, ssdBW: bw, est: EST,
    ttft: +r.avgTtft.toFixed(1), ttft_p50: +r.p50Ttft.toFixed(1), ttft_p99: +r.p99Ttft.toFixed(1),
    tpot: +r.avgTpot.toFixed(2), throughput: +r.throughput.toFixed(1),
    hitRate: +r.hitRate.toFixed(1), completed: r.completed, totalReqs: r.totalReqs,
    truncated: r.truncated, simEnd: +r.simEnd.toFixed(1), drainEst: +r.drainEst.toFixed(0),
    prefixGroups: r.prefixGroups, prefixHits: r.prefixHits,
    l3ReadBW: +(r.l3ReadBW / 1e9).toFixed(2), pt: r.ptBreakdown,
    wallSec: +dt.toFixed(2), perReq: perReq
  }, null, 1));
} else if (mode === 'sweep') {
  const sweepHit = (process.argv[3] || '0,20,40,60,80,100').split(',').map(Number);
  const bwVals = (process.argv[4] || '10,90,20').split(',').map(Number);
  const seed = Number(process.argv[5] || CFG.seed);
  console.error('sweep: hit=' + sweepHit.join(',') + ' bw=' + bwVals.join(',') + ' seed=' + seed);
  const out = { cfg: CFG, est: EST, model: CFG.model, hw: CFG.hw, sweepHit: sweepHit, bwVals: bwVals, seed: seed, grid: {} };
  const t0 = Date.now();
  for (const bw of bwVals) {
    out.grid['bw' + bw] = [];
    for (const h of sweepHit) {
      const r = runOne(h, bw, seed);
      out.grid['bw' + bw].push({
        hit: h, bw: bw,
        ttft: +r.avgTtft.toFixed(1), ttft_p50: +r.p50Ttft.toFixed(1), ttft_p99: +r.p99Ttft.toFixed(1),
        tpot: +r.avgTpot.toFixed(2), throughput: +r.throughput.toFixed(1),
        hit_rate: +r.hitRate.toFixed(1), mem_util: +r.memUtilPeak.toFixed(1), p99: +r.p99.toFixed(1),
        completed: r.completed, totalReqs: r.totalReqs, truncated: r.truncated,
        simEnd: +r.simEnd.toFixed(1), l3BWp99: +(r.l3BWp99 / 1e9).toFixed(1)
      });
      console.error('  done: bw=' + bw + ' hit=' + h + ' ttft=' + r.avgTtft.toFixed(0) + 'ms ' +
        'completed=' + r.completed + '/' + r.totalReqs + (r.truncated ? ' TRUNC' : '') + ' wall=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
  }
  console.log(JSON.stringify(out, null, 1));
}
