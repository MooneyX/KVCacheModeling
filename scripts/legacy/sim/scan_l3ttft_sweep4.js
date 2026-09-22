const { createLegacyHarness } = require("../../../dist/node/library.cjs");
// 扫描4: 最终微调 —— dram12/更长输入/均匀到达/maxBatch, 输出 5 点完整曲线

function makeEl(value) { return { value: value !== undefined ? String(value) : "0" }; }
const elements = {};
const readControl = id => elements[id] || (elements[id] = makeEl());

const sim = createLegacyHarness(readControl);
const $ = (id) => readControl(id);
const set = (id, v) => { $(id).value = String(v); };

function base() {
  set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
  set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
  set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 2); set('pDtype', 2);
  set('pGpuCount', 8); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
  set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDramBW', 400);
  set('pSsd', 20); set('pSsdBW', 10);
  set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
  set('pFramework', 'generic'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
  set('pFetchFixedUs', 209); set('pChunkSize', 2048);
  set('pSimMaxTime', 1200); set('pMultiTurn', 0);
  $('pPrefixWarm').checked = true;
}
const strat = sim.parseDSL('ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: dynamic max(32)\nPLACE: tiered');
strat.name = 'Tiered-3L(无预取)';
const BWS = [10, 30, 50, 70, 90];

function runOne(cfg) {
  base();
  for (const k in cfg) set(k, cfg[k]);
  const p0 = sim.getParams();
  const e = sim.estimatePrefillParams(p0);
  set('pPrefillA', e.a.toFixed(3)); set('pPrefillB', e.b.toFixed(7));
  let rows = [];
  for (const bw of BWS) {
    const out = sim.runSimulation(strat, { seed: 42, ssdBW: bw, prefixHit: (cfg.prefixHit || 99) / 100 });
    rows.push({ bw, ttft: out.avgTtft, p50: out.p50Ttft, p99: out.p99Ttft, done: out.completed + '/' + out.totalReqs, trun: out.truncated, q: out.avgQueue, end: out.simEnd });
  }
  const r10 = rows[0], r90 = rows[4];
  const ok = rows.every(r => r.done.split('/')[0] === r.done.split('/')[1] && !r.trun);
  const steps = rows.map((r, i) => i === 0 ? 1 : (rows[i-1].ttft / Math.max(r.ttft, 1)).toFixed(2));
  console.log(`[${cfg.tag}] in${cfg.pInputLen} dram${cfg.pDram} qps${cfg.pQps} arr${cfg.pArrivalDist} mfu${cfg.pMfu} mb${cfg.pMaxBatch} hit${cfg.prefixHit}${ok ? '' : ' !!截断'}`);
  for (const r of rows) console.log(`   bw${String(r.bw).padStart(2)}: TTFT=${r.ttft.toFixed(0).padStart(7)} p50=${r.p50.toFixed(0).padStart(7)} p99=${r.p99.toFixed(0).padStart(8)} ${r.done}${r.trun ? ' T' : ''} q=${r.q.toFixed(1)} end=${r.end.toFixed(0)}`);
  console.log(`   steps10/30/50/70/90: ${steps.join(' ')}  avg10/90=${(r10.ttft / Math.max(r90.ttft, 1)).toFixed(2)}x Δ=${(r10.ttft - r90.ttft).toFixed(0)}ms`);
}

const cfgs = [
  { tag: 'V1', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.5, pMfu: 60, prefixHit: 99, pMaxBatch: 8 },
  { tag: 'V2', pHbm: 24, pDram: 12, pInputLen: 20480, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.5, pMfu: 60, prefixHit: 99, pMaxBatch: 8 },
  { tag: 'V3', pHbm: 24, pDram: 12, pInputLen: 20480, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 60, prefixHit: 99, pMaxBatch: 8 },
  { tag: 'V4', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 60, prefixHit: 99, pMaxBatch: 8, pArrivalDist: 'uniform' },
  { tag: 'V5', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 60, prefixHit: 95, pMaxBatch: 8 },
  { tag: 'V6', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 70, prefixHit: 99, pMaxBatch: 8 },
  { tag: 'V7', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 80, prefixHit: 99, pMaxBatch: 8 },
  { tag: 'V8', pHbm: 24, pDram: 12, pInputLen: 16384, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 60, prefixHit: 99, pMaxBatch: 4 },
  { tag: 'V9', pHbm: 24, pDram: 12, pInputLen: 20480, pOutputLen: 16, pConcurrency: 4, pBlockSize: 256, pQps: 0.4, pMfu: 70, prefixHit: 99, pMaxBatch: 8 },
];
for (const c of cfgs) runOne(c);
