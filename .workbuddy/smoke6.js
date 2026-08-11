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

const vals = {pAttnType:'gqa',pLayers:80,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:8192,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:8,pHbm:96,pHbmBW:4,pTflops:148,
  pTpSize:8,pNvlinkBW:900,pPcieBW:64,pTierQuant:1,pDram:1024,pDramBW:400,pSsd:20,pSsdBW:10,
  pConcurrency:32,pInputLen:4096,pOutputLen:1024,pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,
  pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

console.log('== TP AllReduce 通信开销验证 ==');
let r8 = calcAll(getParams());
console.log('TP=8: passTime='+(r8.passTime*1000).toFixed(2)+'ms, commOverhead='+(r8.commOverhead*1000).toFixed(2)+'ms ('+(r8.commOverhead/r8.passTime*100).toFixed(0)+'%), decode/req='+r8.decodeTpsPerReq.toFixed(0)+' tok/s');

document.getElementById('pTpSize').value = 1;
let r1 = calcAll(getParams());
console.log('TP=1: passTime='+(r1.passTime*1000).toFixed(2)+'ms, commOverhead='+(r1.commOverhead*1000).toFixed(2)+'ms (应为0), decode/req='+r1.decodeTpsPerReq.toFixed(0)+' tok/s');

document.getElementById('pTpSize').value = 4;
let r4 = calcAll(getParams());
console.log('TP=4: commOverhead='+(r4.commOverhead*1000).toFixed(2)+'ms (延迟项与TP=8相同, 带宽项减半)');

// 引擎集成验证
document.getElementById('pTpSize').value = 8;
let a = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:42});
document.getElementById('pTpSize').value = 1;
let b = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:42});
console.log('\n引擎: TP=8 p50='+a.p50.toFixed(0)+'ms vs TP=1 p50='+b.p50.toFixed(0)+'ms (TP=8应更慢: '+(a.p50>b.p50)+')');
console.log('吞吐: TP=8 '+a.throughput.toFixed(0)+' tok/s vs TP=1 '+b.throughput.toFixed(0)+' tok/s');
console.log('DONE');
