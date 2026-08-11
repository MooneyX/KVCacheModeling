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

// 内存压力场景：64K输入 × 大batch → 驻留KV超过HBM可用容量
const vals = {pAttnType:'gqa',pLayers:80,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:8192,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:8,pHbm:96,pHbmBW:4,pTflops:148,pPcieBW:64,
  pTierQuant:1,pDram:1024,pDramBW:400,pSsd:20,pSsdBW:10,pConcurrency:64,pInputLen:65536,pOutputLen:512,
  pQps:4,pMfu:50,pMaxBatch:64,pBlockSize:16,pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

let r = calcAll(getParams());
console.log('perRequestKv:', (r.perRequestKv/1e9).toFixed(1)+'GB', 'maxHbmRequests:', r.maxHbmRequests);

for (const name of ['Pure-HBM','Tiered-3L','Aggressive']) {
  let t0=Date.now();
  let res = runSimulation(parseDSL(strategyPresets[name]));
  console.log('\n['+name+']', 'elapsed:', (Date.now()-t0)+'ms');
  console.log('  completed:', res.completed+'/'+res.totalReqs,
    'hitRate:', res.hitRate.toFixed(1)+'%',
    'memUtilPeak:', res.memUtilPeak.toFixed(0)+'%');
  console.log('  evictions:', res.evictions, '(active:', res.activeEvictions+')',
    'prefetches:', res.prefetches, 'drops:', res.drops,
    'transferGB:', res.transferGB.toFixed(1));
  console.log('  prefixHits:', res.prefixHits, 'savedMB:', res.prefixSavedMB.toFixed(0),
    'p50:', res.p50.toFixed(0), 'p99:', res.p99.toFixed(0));
}
console.log('\nPRESSURE TEST DONE');
