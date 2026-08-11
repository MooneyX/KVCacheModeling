// 推荐场景复现: H20×8 + Llama-3-70B, L3 带宽显著影响 TTFT (1→10GB/s 时 2.66×)
// 物理配方: ①GQA大KV(160KB/tok) ②高命中90%(sharer只算非前缀prefill) ③长输入32K(fetch字节大)
//          ④KV下沉SSD(HBM12/卡+DRAM16, 前缀块被挤到SSD) ⑤bs64压209μs/块固定开销 ⑥低并发低qps(时序命中)
// 用法: node sim_l3ttft_sensitive.js
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
set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 1); set('pDtype', 1);
set('pGpuCount', 8); set('pHbm', 12); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 16); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pMfu', 30); set('pMaxBatch', 8);
set('pMultiTurn', 0); set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
const strat = sim.parseDSL(sim.strategyPresets['Tiered-3L']);
strat.name = 'Tiered-3L';
console.log('推荐场景: Llama-3-70B · H20×8(TP8) · HBM12GB/卡 · DRAM16GB · conc4/in32768/out256/qps0.5/hit90% · Tiered-3L · bs64');
console.log('ssdBW | TTFT(ms)  | x(bw1) | TPOT(ms) | prefixHits | l3BWp99');
for (const bw of [1, 2, 5, 10, 20, 50, 100]) {
  set('pConcurrency', 4); set('pInputLen', 32768); set('pOutputLen', 256);
  set('pPrefixHit', 90); set('pBlockSize', 64); set('pQps', 0.5); set('pSsdBW', bw);
  const out = sim.runSimulation(strat, { seed: 42, ssdBW: bw, prefixHit: 0.9 });
  console.log(String(bw).padStart(5) + ' | ' + out.avgTtft.toFixed(0).padStart(9) + ' | ' + (out.avgTtft / 186479).toFixed(2).padStart(5)
    + ' | ' + out.avgTpot.toFixed(1).padStart(9) + ' | ' + out.prefixHits + ' | ' + (out.l3BWp99 / 1e9).toFixed(1));
}
