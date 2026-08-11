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

// 16K 长输入场景：prefill 受限，前缀复用的 TTFT 收益应非常显著
const vals = {pAttnType:'gqa',pLayers:80,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:8192,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:8,pHbm:96,pHbmBW:4,pTflops:148,pPcieBW:64,
  pTierQuant:1,pDram:1024,pDramBW:400,pSsd:20,pSsdBW:10,pConcurrency:32,pInputLen:16384,pOutputLen:1024,
  pQps:4,pMfu:50,pMaxBatch:8,pBlockSize:16,pPrefixHit:0,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

console.log('== 16K输入 × 前缀命中率扫描 (Pure-HBM, seed=42) ==');
console.log('hit%\tavgTtft(ms)\tp50(ms)\tp99(ms)\tavgQueue(s)\tthroughput(tok/s)');
for (const hit of [0,10,20,30,40,50,60,70,80,90]) {
  let r = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:42, prefixHit: hit/100});
  console.log(hit+'%\t'+r.avgTtft.toFixed(0)+'\t'+r.p50.toFixed(0)+'\t'+r.p99.toFixed(0)+'\t'
    +r.avgQueue.toFixed(1)+'\t'+r.throughput.toFixed(0));
}

// 验证 sensitivity 的 overrides 机制（prefixHit override 不改变全局 pPrefixHit）
document.getElementById('pPrefixHit').value = 0;
let a = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:42, prefixHit: 0.5});
console.log('\noverride 机制: 全局0% + override 50% → prefixHits='+a.prefixHits+' (应>0)');
console.log('DONE');
