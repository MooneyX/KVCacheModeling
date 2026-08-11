// 修改后 index.html 验证: conc1/conc8/conc32/out64/out1024 vs 实测
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
function setup(conc, inLen, outLen, qps, hit) {
  set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168); set('pVocab', 129280);
  set('pParamsB', 671); set('pActB', 37); set('pWeightDtype', 1); set('pDtype', 1);
  set('pGpuCount', 8); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
  set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 1024); set('pDramBW', 400);
  set('pSsd', 20); set('pSsdBW', 10);
  set('pConcurrency', conc); set('pInputLen', inLen); set('pOutputLen', outLen);
  set('pQps', qps); set('pMfu', 30); set('pMaxBatch', 8);
  set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', hit);
  set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
  set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
  set('pPrefillA', 216); set('pPrefillB', 0.0011); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
}
function run(conc, outLen, label, exp) {
  setup(conc, 2048, outLen, 4, 40);
  const out = sim.runSimulation(sim.parseDSL(sim.strategyPresets['Pure-HBM']));
  console.log(label + ' | sim TTFT=' + out.avgTtft.toFixed(0) + 'ms (实测 ' + exp + ') | TPOT=' + out.avgTpot.toFixed(1) + ' (实测见上) | q=' + out.avgQueue.toFixed(2) + 's | ' + out.completed + '/' + out.totalReqs);
}
console.log('===== 修改后验证 (a=216/b=1.1e-3/pf=0.3/boost-linear) =====');
run(1, 256, 'conc1  ', '367ms');
run(8, 256, 'conc8  ', '478ms');
run(8, 64,  'out64  ', '396ms');
run(8, 1024,'out1024', '396ms');
run(32, 256, 'conc32 ', '4180ms');
