// sim_debug.js: 输出仿真的 queue/prefill 分解, 定位 TTFT 高估根因
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.join('\n');
function makeEl(value) {
  return {
    value: value !== undefined ? String(value) : '0',
    textContent: '', innerHTML: '', placeholder: '',
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; } },
    dataset: {},
    appendChild(){}, remove(){},
    querySelectorAll(){ return []; },
    addEventListener(){}, focus(){},
  };
}
const elements = {};
global.document = {
  getElementById(id){ if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
  querySelectorAll(){ return []; },
  createElement(){ return makeEl(); },
  addEventListener(){},
};
global.window = { addEventListener(){}, };
global.echarts = {
  init(){ return { setOption(){}, resize(){}, dispose(){} }; },
  getInstanceByDom(){ return null; },
};
(0, eval)(code + `
globalThis.__sim = { runSimulation, parseDSL, strategyPresets, getParams, calcAll, mulberry32 };
`);
const sim = globalThis.__sim;
const $ = (id) => global.document.getElementById(id);
const set = (id, v) => { $(id).value = String(v); };
const trace = JSON.parse(fs.readFileSync('D:/Documents/KVCacheModeling/trace.json', 'utf8'));
const P = trace.p;
set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168); set('pVocab', 129280);
set('pParamsB', 671); set('pActB', 37); set('pWeightDtype', 1); set('pDtype', 1);
set('pGpuCount', 8); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 1024); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pConcurrency', P.concurrency); set('pInputLen', P.inputLen); set('pOutputLen', P.outputLen);
set('pQps', P.qps); set('pMfu', 30); set('pMaxBatch', 8);
set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', P.prefixHit * 100);
set('pLenDist', P.lenDist); set('pArrivalDist', P.arrivalDist); set('pSeed', P.seed);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
const p = sim.getParams();
const r = sim.calcAll(p);
console.log('availHbm(GB):', (r.availHbm / 1e9).toFixed(1), '| avgLifetimeKv(MB):', (r.avgLifetimeKv / 1e6).toFixed(1), '| aggHbmBW(GB/s):', (r.aggHbmBW / 1e9).toFixed(0), '| computeFlops:', (r.computeFlops / 1e12).toFixed(0), 'T');
const s = sim.parseDSL(sim.strategyPresets['Pure-HBM']);
s.name = 'Pure-HBM';
const out = sim.runSimulation(s);
console.log('simEnd:', out.simEnd.toFixed(2), 's | completed:', out.completed, '/', out.totalReqs, '| truncated:', out.truncated);
console.log('TTFT avg:', out.avgTtft.toFixed(1), 'p50:', out.p50Ttft.toFixed(1), 'p99:', out.p99Ttft.toFixed(1));
console.log('TPOT avg:', out.avgTpot.toFixed(2), '| Lat p50:', out.p50.toFixed(1), '| queue avg:', out.avgQueue.toFixed(2), 's');
console.log('prefillFlops 瓶颈占比:', JSON.stringify(out.bottleneckPct));
console.log('ptBreakdown:', JSON.stringify(out.ptBreakdown));
console.log('\n===== 逐请求 timeline (id | arrive | admit | prefillStart | prefillEnd | complete | TTFT) =====');
if (out.timeline) {
  out.timeline.forEach(t => {
    console.log('Req#' + t.id + ' | arr=' + t.arrive.toFixed(3) + ' | adm=' + (t.admitTime != null ? t.admitTime.toFixed(3) : 'N/A') +
      ' | pfS=' + (t.prefillStart != null ? t.prefillStart.toFixed(3) : 'N/A') +
      ' | pfE=' + (t.prefillEnd != null ? t.prefillEnd.toFixed(3) : 'N/A') +
      ' | cmp=' + (t.completeTime != null ? t.completeTime.toFixed(3) : 'N/A') +
      ' | TTFT=' + ((t.prefillEnd != null ? (t.prefillEnd - t.arrive) * 1000 : 'N/A')));
  });
} else {
  console.log('NO timeline in result');
}
console.log('L3 读带宽需求:', (out.l3BWp99/1e9).toFixed(1), 'GB/s | L2:', (out.l2BWp99/1e9).toFixed(1), 'GB/s');
