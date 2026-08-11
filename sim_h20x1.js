// 复现: H20×1 + conc64/in8192/out16, 为什么 l3BWp99=0?
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

// 公共: H20 单卡 + 用户负载
function setup(model) {
  set('pGpuCount', 1); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 1);
  set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
  set('pDram', 1024); set('pDramBW', 400);   // 网页默认 DRAM 1024GB
  set('pSsd', 20); set('pSsdBW', 10);        // 网页默认 SSD 20TB
  set('pConcurrency', 64); set('pInputLen', 8192); set('pOutputLen', 16);
  set('pQps', 8); set('pMfu', 50); set('pMaxBatch', 8);
  set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);
  set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
  set('pFramework', 'generic'); set('pPrefixCache', 'hash'); set('pPdSep', '0'); set('pTieredKv', '1');
  set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
  if (model === 'qwen32') {
    set('pAttnType', 'gqa'); set('pLayers', 64); set('pKvHeads', 8); set('pHeadDim', 128);
    set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 5120);
    set('pParamsB', 32); set('pActB', 32); set('pWeightDtype', 2); set('pDtype', 2);
  } else { // dsv3
    set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168); set('pVocab', 129280);
    set('pParamsB', 671); set('pActB', 37); set('pWeightDtype', 1); set('pDtype', 1);
    set('pPrefillA', 216); set('pPrefillB', 0.0011);
  }
}
function analyze(model, stratName, dsl) {
  setup(model);
  const p = sim.getParams();
  const r = sim.calcAll(p);
  const strat = dsl ? sim.parseDSL(dsl) : sim.parseDSL(sim.strategyPresets[stratName]);
  strat.name = stratName;
  const out = sim.runSimulation(strat, { seed: 42 });
  console.log('--- ' + model + ' × ' + stratName + ' ---');
  console.log('  HBM总=' + (p.hbm*p.gpus) + 'GB 权重=' + (r.modelWeightGB).toFixed(0) + 'GB 可用KV=' + (r.availHbm/1e9).toFixed(1) + 'GB'
    + ' DRAM=' + (r.dramTotal/1e9).toFixed(0) + 'GB SSD=' + (r.ssdTotal/1e9).toFixed(0) + 'GB');
  console.log('  kvPerTok=' + (r.kvPerToken/1e3).toFixed(0) + 'KB | 总KV需求=' + (r.totalKvDemand/1e9).toFixed(1) + 'GB'
    + ' | 解析分布: HBM=' + (Math.min(r.totalKvDemand, r.availHbm)/1e9).toFixed(1) + 'GB'
    + ' 溢出=' + (Math.max(0, r.totalKvDemand - r.availHbm)/1e9).toFixed(1) + 'GB');
  console.log('  l2Peak=' + out.l2PeakGB.toFixed(1) + 'GB l3Peak=' + out.l3PeakGB.toFixed(1) + 'GB'
    + ' | l2BWp99=' + (out.l2BWp99/1e9).toFixed(1) + 'GB/s l3BWp99=' + (out.l3BWp99/1e9).toFixed(1) + 'GB/s'
    + ' | ev=' + out.evictions + ' trGB=' + (out.transferGB||0).toFixed(1)
    + ' | TTFT=' + out.avgTtft.toFixed(0) + 'ms TPOT=' + out.avgTpot.toFixed(2) + 'ms | ' + out.completed + '/' + out.totalReqs);
}
// 默认网页策略? 先看 preset 名称
console.log('presets:', Object.keys(sim.strategyPresets).join(', '));
console.log('\n===== H20×1 · conc64 · in8192 · out16 =====');
analyze('qwen32', 'Tiered-3L');
analyze('qwen32', 'Pure-HBM');
analyze('dsv3', 'Tiered-3L');

console.log('\n===== 反证: 缩小 DRAM 后 L3 是否参与 (Qwen32 Tiered-3L) =====');
for (const dram of [1024, 64, 32, 16, 8]) {
  setup('qwen32');
  set('pDram', dram);
  const p = sim.getParams();
  const r = sim.calcAll(p);
  const out = sim.runSimulation(sim.parseDSL(sim.strategyPresets['Tiered-3L']), { seed: 42 });
  console.log('  DRAM=' + String(dram).padStart(4) + 'GB | 溢出=' + (Math.max(0, r.totalKvDemand - r.availHbm)/1e9).toFixed(0) + 'GB'
    + ' | l2Peak=' + out.l2PeakGB.toFixed(1) + 'GB l3Peak=' + out.l3PeakGB.toFixed(1) + 'GB'
    + ' | l2BWp99=' + (out.l2BWp99/1e9).toFixed(1) + ' l3BWp99=' + (out.l3BWp99/1e9).toFixed(1) + 'GB/s'
    + ' | ev=' + out.evictions + ' trGB=' + (out.transferGB||0).toFixed(1));
}
