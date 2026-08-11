// 复现用户场景: H20×1 DRAM16G Llama-3-70B conc64 in8192 out16
// 验证: 为何 SSD 带宽峰值为 0 — 对比 Pure-HBM(默认) vs Tiered-3L(有 dram->ssd 淘汰)
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
  querySelectorAll(){ return []; }, querySelector(){ return null; }, createElement(){ return makeEl(); }, addEventListener(){},
};
global.window = { addEventListener(){}, };
global.echarts = { init(){ return { setOption(){}, resize(){}, dispose(){} }; }, getInstanceByDom(){ return null; }, };
(0, eval)(code + `globalThis.__sim = { runSimulation, parseDSL, strategyPresets, getParams, calcAll, mulberry32 };`);
const sim = globalThis.__sim;
const $ = (id) => global.document.getElementById(id);
const set = (id, v) => { $(id).value = String(v); };

// Llama-3-70B × H20 单卡
set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128); set('pHidden', 8192); set('pVocab', 128256);
set('pParamsB', 70); set('pActB', 70); set('pWeightDtype', 2); set('pDtype', 2); // BF16
set('pGpuCount', 1); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 1);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 16); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pConcurrency', 64); set('pInputLen', 8192); set('pOutputLen', 16);
set('pQps', 4); set('pMfu', 30); set('pMaxBatch', 8);
set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);
set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
set('pSimMaxTime', 600); // 加大窗口避免截断

// 先看解析估算(权重/HBM可用/KV需求)
const p = sim.getParams();
const r = sim.calcAll(p);
console.log('== 解析估算 ==');
console.log('weightBytes=', (r.weightBytes/1e9).toFixed(1), 'GB | kvPerTok=', (r.kvPerToken/1024).toFixed(1), 'KB | perRequestKv=', (r.perRequestKv/1e9).toFixed(2), 'GB');
console.log('availHbm 相关: hbm=', p.hbm, 'GB/卡 ×', p.gpus, '卡 | dram=', p.dram, 'GB | ssd=', p.ssd, 'GB');

// 两种策略对比
const names = ['Pure-HBM', 'Tiered-3L', 'HBM+DRAM'];
for (const name of names) {
  const strat = sim.parseDSL(sim.strategyPresets[name]);
  strat.name = name;
  const t0 = Date.now();
  try {
    const out = sim.runSimulation(strat);
    console.log('[' + name + '] TTFT=' + out.avgTtft.toFixed(0) + 'ms TPOT=' + out.avgTpot.toFixed(2) + 'ms'
      + ' | l2Peak=' + out.l2PeakGB.toFixed(1) + 'GB l3Peak=' + out.l3PeakGB.toFixed(1) + 'GB'
      + ' | l2BWp99=' + (out.l2BWp99/1e9).toFixed(2) + ' l3BWp99=' + (out.l3BWp99/1e9).toFixed(2) + ' l3BWPeak=' + (out.l3BWPeak/1e9).toFixed(2) + 'GB/s'
      + ' | ev=' + out.evictions + ' pf=' + out.prefetches + ' | ' + out.completed + '/' + out.totalReqs
      + ' | simEnd=' + out.simEnd.toFixed(1) + 's | ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
  } catch(e) { console.log('[' + name + '] ERROR: ' + e.message); }
}
