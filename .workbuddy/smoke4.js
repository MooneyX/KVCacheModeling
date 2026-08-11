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
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:8,pHbm:96,pHbmBW:4,pTflops:148,pPcieBW:64,
  pTierQuant:1,pDram:1024,pDramBW:400,pSsd:20,pSsdBW:10,pConcurrency:32,pInputLen:4096,pOutputLen:1024,
  pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,pPrefixHit:0,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

console.log('== 前缀命中率影响验证 ==\n');
for (const hit of [0, 40, 80]) {
  document.getElementById('pPrefixHit').value = hit;
  let p = getParams(), r = calcAll(p);
  let res = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:42});
  console.log('prefixHit='+hit+'%:');
  console.log('  存储需求 totalKvDemand:', (r.totalKvDemand/1e9).toFixed(1)+'GB',
    ' 前缀节省/req:', (r.prefixSavedPerReq/1e6).toFixed(0)+'MB',
    ' HBM容纳:', r.maxHbmRequests+'个');
  console.log('  仿真: prefixHits='+res.prefixHits,
    'avgTtft='+res.avgTtft.toFixed(0)+'ms',
    'p50='+res.p50.toFixed(0)+'ms',
    'p99='+res.p99.toFixed(0)+'ms',
    'avgQueue='+res.avgQueue.toFixed(1)+'s');
}

// 压力场景下命中率对延迟的影响（Tiered-3L, 64K输入）
console.log('\n== 内存压力场景 (64K输入, Tiered-3L) ==');
document.getElementById('pInputLen').value = 65536;
document.getElementById('pOutputLen').value = 512;
document.getElementById('pConcurrency').value = 64;
document.getElementById('pMaxBatch').value = 64;
document.getElementById('pQps').value = 4;
for (const hit of [0, 60]) {
  document.getElementById('pPrefixHit').value = hit;
  let res = runSimulation(parseDSL(strategyPresets['Tiered-3L']), {seed:42, nreq:60});
  console.log('prefixHit='+hit+'%: evictions='+res.evictions,
    'hitRate='+res.hitRate.toFixed(1)+'%',
    'memUtilPeak='+res.memUtilPeak.toFixed(0)+'%',
    'avgTtft='+res.avgTtft.toFixed(0)+'ms',
    'completed='+res.completed+'/'+res.totalReqs);
}
console.log('\nDONE');
