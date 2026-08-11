// 推荐场景复现: H20×8 + Llama-3-70B(预设模型, BF16) → L3 带宽在 10-100GB/s 区间显著影响 TTFT
// 前提: ①引擎"前缀预热"(网页勾选 前缀预热/L3常驻, HiCache 语义) ②策略用 Tiered-3L 无预取变体
//       (eager prefetch 会把 SSD 前缀块提前搬回 HBM → 后期 sharer 免费命中 → 带宽不敏感;
//        无预取 = 块持续驻留 SSD, 全部 sharer 现场拉取 → 敏感; 对应真实 HiCache wait_complete 模式)
// 物理配方: ①Llama-70B BF16 kvPerTok=320KB ②命中99%+预热(sharer 只算 1% 非前缀 prefill)
//          ③in16K(fetch=0.7×16K×320KB≈3.6GB → bw10=0.4s/bw100=0.04s) ④KV下沉SSD ⑤bs64压固定开销
// 用法: node sim_l3ttft_10_100.js
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
// Llama-3-70B 预设 (GQA 80x8x128) + BF16 → kvPerTok=320KB
set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 2); set('pDtype', 2);
set('pGpuCount', 8); set('pHbm', 24); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 16); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pMfu', 30); set('pMaxBatch', 8);
set('pMultiTurn', 0); set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
$('pPrefixWarm').checked = true;
// Tiered-3L 无预取变体(ADMIT/EVICT/BATCH/PLACE 同预置, 仅 PREFETCH: none)
const strat = sim.parseDSL('ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: dynamic max(32)\nPLACE: tiered');
strat.name = 'Tiered-3L(无预取)';
console.log('推荐场景: Llama-3-70B(BF16) · H20×8(TP8) · HBM24GB/卡 · DRAM16GB · conc8/in16384/out256/qps0.5/hit99% · Tiered-3L无预取 · bs64 · 前缀预热✓');
console.log('ssdBW | TTFT(ms)  | x(bw10) | prefixHits | l3BWp99');
for (const bw of [10, 20, 50, 100, 200]) {
  set('pConcurrency', 8); set('pInputLen', 16384); set('pOutputLen', 256);
  set('pPrefixHit', 99); set('pBlockSize', 64); set('pQps', 0.5); set('pSsdBW', bw);
  const out = sim.runSimulation(strat, { seed: 42, ssdBW: bw, prefixHit: 0.99 });
  console.log(String(bw).padStart(5) + ' | ' + out.avgTtft.toFixed(0).padStart(9) + ' | ' + (out.avgTtft / 261087).toFixed(2).padStart(6)
    + ' | ' + out.prefixHits + ' | ' + (out.l3BWp99 / 1e9).toFixed(0));
}
