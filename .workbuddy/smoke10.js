// ---- DOM stubs ----
const elements = {};
function makeEl(id){ return { id, value:undefined, textContent:'', innerHTML:'', style:{},
  classList:{toggle(){},add(){},remove(){},contains(){return false}},
  querySelectorAll(){return []}, appendChild(){}, addEventListener(){}, disabled:false }; }
global.document = {
  getElementById: id => elements[id] || (elements[id]=makeEl(id)),
  querySelectorAll: () => [], addEventListener: () => {}, createElement: () => makeEl('x'),
};
global.window = { addEventListener: () => {} };
global.echarts = { init:()=>({setOption(){},resize(){},dispose(){}}), getInstanceByDom:()=>null,
  graphic:{LinearGradient:function(){}} };

const fs = require('fs');
eval(fs.readFileSync('.workbuddy/kvcheck.js','utf8'));

// 用户场景: H20×2, DRAM=16GB, 并发128, 输入8192
const vals = {pAttnType:'gqa',pLayers:80,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:8192,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:2,pHbm:96,pHbmBW:4,pTflops:148,
  pTpSize:2,pNvlinkBW:900,pPcieBW:64,pTierQuant:1,pDram:16,pDramBW:400,pSsd:20,pSsdBW:10,
  pConcurrency:128,pInputLen:8192,pOutputLen:1024,pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,
  pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];
document.getElementById('sDsl').value = strategyPresets['Pure-HBM'];
document.getElementById('sName').value = '';

let r = calcAll(getParams());
console.log('availHbm:', (r.availHbm/1e9).toFixed(1)+'GB', 'perReqKv:', (r.perRequestKv/1e9).toFixed(2)+'GB',
  'prefill:', (getParams().inputLen/r.prefillTps).toFixed(1)+'s/req');

let res = runSimulation(parseDSL(strategyPresets['Pure-HBM']));
console.log('completed:', res.completed, '/', res.totalReqs);
console.log('incomplete rows:', res.incomplete.length);
let states = {};
res.incomplete.forEach(q => states[q.state] = (states[q.state]||0)+1);
console.log('未完成状态分布:', JSON.stringify(states));
console.log('simEnd:', res.simEnd.toFixed(0)+'s');
console.log('甘特图总行数 =', res.timeline.length + res.incomplete.length);
// drawGantt 不崩溃
drawGantt();
console.log('drawGantt OK');
