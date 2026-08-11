// Qwen3-32B 单卡回归(8/6 校准: TTFT avg=5852ms 保持)
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
// Qwen3-32B × H20 单卡(与 sim_compare.js 同参数)
set('pAttnType', 'gqa'); set('pLayers', 64); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 5120);
set('pParamsB', 32); set('pActB', 32);
set('pGpuCount', 1); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148);
set('pTpSize', 1); set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 16); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
set('pDtype', 2); set('pWeightDtype', 2);
set('pConcurrency', 8); set('pInputLen', 2048); set('pOutputLen', 256);
set('pQps', 4); set('pMfu', 50); set('pLenDist', 'uniform'); set('pSeed', 43);
set('pMaxBatch', 8); set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);
set('pFramework', 'generic'); set('pPrefixCache', 'hash'); set('pPdSep', '0'); set('pTieredKv', '1'); set('pArrivalDist', 'poisson');
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
const p = sim.getParams();
const r = sim.calcAll(p);
console.log('Qwen3-32B calcAll: TTFT:', (r.ttftEst * 1000).toFixed(0), 'ms | TPOT:', (r.tpotEst * 1000).toFixed(2), 'ms');
const names = ['Pure-HBM', 'HBM+DRAM'];
for (const name of names) {
  const s = sim.parseDSL(sim.strategyPresets[name]);
  s.name = name;
  const out = sim.runSimulation(s);
  console.log(name + ': TTFT avg=' + out.avgTtft.toFixed(1) + 'ms | TPOT=' + out.avgTpot.toFixed(2) + 'ms | completed=' + out.completed + '/' + out.totalReqs);
}
console.log('回归参考(8/6): Qwen3-32B Pure-HBM TTFT avg=5852ms, TPOT=43.97ms');
