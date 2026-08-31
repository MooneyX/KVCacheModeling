// 双参数矩阵: L3命中率(prefix_hit) × L3带宽(ssdBW) → TTFT/TPOT
// 场景: DS-V3 8xH20 受限(HBM12GB/卡, DRAM4GB) + conc16/in16384/out512/qps2 + on_demand预取+hbm_first
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.join('\n');
function makeEl(value) {
  return {
    value: value !== undefined ? String(value) : '0',
    textContent: '', innerHTML: '', placeholder: '',
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, dataset: {},
    appendChild(){}, remove(){}, querySelectorAll(){ return []; }, addEventListener(){}, focus(){},
  };
}
const elements = {};
global.document = {
  getElementById(id){ if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
  querySelectorAll(){ return []; }, createElement(){ return makeEl(); }, addEventListener(){},
};
global.window = { addEventListener(){}, };
global.echarts = { init(){ return { setOption(){}, resize(){}, dispose(){} }; }, getInstanceByDom(){ return null; }, };
(0, eval)(code + `globalThis.__sim = { runSimulation, parseDSL, strategyPresets, getParams, calcAll, mulberry32 };`);
const sim = globalThis.__sim;
const $ = (id) => global.document.getElementById(id);
const set = (id, v) => { $(id).value = String(v); };
set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168); set('pVocab', 129280);
set('pParamsB', 671); set('pActB', 37); set('pWeightDtype', 1); set('pDtype', 1);
set('pGpuCount', 8); set('pHbm', 12); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 4); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pConcurrency', 16); set('pInputLen', 16384); set('pOutputLen', 512);
set('pQps', 2); set('pMfu', 30); set('pMaxBatch', 8);
set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);
set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pPrefillA', 216); set('pPrefillB', 0.0011); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
const dslOD = 'ADMIT: always\nEVICT: lru from hbm when 85% -> dram\nPREFETCH: on_demand from dram when hbm<70%\nBATCH: continuous max(8)\nPLACE: hbm_first';
const strat = sim.parseDSL(dslOD);
strat.name = 'hbm_first+on_demand';
const hits = [0, 20, 40, 60, 80];
const bws  = [1, 2, 5, 10, 20, 40, 80];
const R = {};
console.log('===== DS-V3 · HBM12GB/卡+DRAM4GB · conc16/in16k/out512 · hbm_first+on_demand =====');
console.log('TTFT(ms) | L3带宽(GB/s) →     1      2      5     10     20     40     80');
for (const h of hits) {
  const cells = [];
  for (const bw of bws) {
    const out = sim.runSimulation(strat, { seed: 42, prefixHit: h / 100, ssdBW: bw });
    R[h + '|' + bw] = { ttft: out.avgTtft, p50: out.p50Ttft, p99: out.p99Ttft, tpot: out.avgTpot, l3p99: out.l3BWp99 / 1e9, pf: out.prefetches };
    cells.push(out.avgTtft.toFixed(0).padStart(6));
  }
  console.log('hit=' + String(h).padStart(2) + '% | ' + cells.join(' '));
}
console.log('\nTPOT(ms/tok):');
for (const h of hits) {
  const cells = [];
  for (const bw of bws) cells.push(R[h + '|' + bw].tpot.toFixed(1).padStart(6));
  console.log('hit=' + String(h).padStart(2) + '% | ' + cells.join(' '));
}
console.log('\n关键列: hit=40% 带宽扫描 + 行: ssdBW=10 命中率扫描');
for (const bw of bws) { const r = R['40|' + bw]; console.log('bw=' + String(bw).padStart(2) + ' | TTFT=' + r.ttft.toFixed(0) + ' (p50=' + r.p50.toFixed(0) + ' p99=' + r.p99.toFixed(0) + ') TPOT=' + r.tpot.toFixed(2) + ' l3p99=' + r.l3p99.toFixed(1) + ' pf=' + r.pf); }
console.log('---');
for (const h of hits) { const r = R[h + '|10']; console.log('hit=' + String(h).padStart(2) + '% | TTFT=' + r.ttft.toFixed(0) + ' (p50=' + r.p50.toFixed(0) + ' p99=' + r.p99.toFixed(0) + ') TPOT=' + r.tpot.toFixed(2) + ' l3p99=' + r.l3p99.toFixed(1) + ' pf=' + r.pf); }
