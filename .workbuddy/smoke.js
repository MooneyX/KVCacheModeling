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
const src = fs.readFileSync('.workbuddy/kvcheck.js','utf8');
eval(src);

// ---- 设置参数元素值 ----
const vals = {pAttnType:'gqa',pLayers:80,pKvHeads:8,pHeadDim:128,pKvLora:512,pRopeDim:64,pHidden:8192,
  pDtype:1,pWeightDtype:2,pParamsB:0,pActB:0,pGpuCount:8,pHbm:96,pHbmBW:4,pTflops:148,pPcieBW:64,
  pTierQuant:1,pDram:1024,pDramBW:400,pSsd:20,pSsdBW:10,pConcurrency:32,pInputLen:4096,pOutputLen:1024,
  pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

// ---- Test 1: calcAll GQA 70B ----
let p = getParams(), r = calcAll(p);
console.log('== calcAll (Llama-3-70B, H20x8) ==');
console.log('kvPerToken:', r.kvPerToken, '(expect 163840)');
console.log('totalParams(B):', (r.totalParams/1e9).toFixed(1), '(expect ~70)');
console.log('weightBytes(GB):', (r.modelWeightBytes/1e9).toFixed(0), '(expect ~141)');
console.log('availHbm(GB):', (r.availHbm/1e9).toFixed(0), '(expect ~550)');
console.log('prefillTps:', r.prefillTps.toFixed(0), '(expect ~4000)');
console.log('decodeTpsPerReq:', r.decodeTpsPerReq.toFixed(0), 'passTime(ms):', (r.passTime*1000).toFixed(2));
console.log('fragPct:', r.fragPct.toFixed(2), 'littleConcurrency:', r.littleConcurrency.toFixed(0));

// ---- Test 2: MLA KV ----
document.getElementById('pAttnType').value='mla';
document.getElementById('pParamsB').value=671; document.getElementById('pActB').value=37;
let r2 = calcAll(getParams());
console.log('\n== MLA (DeepSeek-V3) ==');
console.log('kvPerToken:', r2.kvPerToken, '(expect 35136 = 61*576*1)');
console.log('weightBytes(GB):', (r2.modelWeightBytes/1e9).toFixed(0), '(expect 1342, availHbm->0):', (r2.availHbm/1e9).toFixed(0));

// ---- Test 3: runSimulation DSL ----
document.getElementById('pAttnType').value='gqa';
document.getElementById('pParamsB').value=0; document.getElementById('pActB').value=0;
let strat = parseDSL(strategyPresets['Pure-HBM']);
let t0=Date.now();
let res = runSimulation(strat);
console.log('\n== runSimulation (Pure-HBM) ==', 'elapsed:', (Date.now()-t0)+'ms');
console.log('completed:', res.completed+'/'+res.totalReqs);
console.log('hitRate:', res.hitRate.toFixed(1)+'%', '(must be <100 and >0)');
console.log('p50:', res.p50.toFixed(0), 'p99:', res.p99.toFixed(0), '(p99>=p50:', res.p99>=res.p50, ')');
console.log('throughput:', res.throughput.toFixed(0), 'tok/s');
console.log('memUtilPeak:', res.memUtilPeak.toFixed(1)+'%', 'avg:', res.memUtilAvg.toFixed(1)+'%');
console.log('avgQueue:', res.avgQueue.toFixed(2)+'s', 'avgTtft:', res.avgTtft.toFixed(0)+'ms');
console.log('prefixHits:', res.prefixHits, 'groups:', res.prefixGroups, 'savedMB:', res.prefixSavedMB.toFixed(0));
console.log('evictions:', res.evictions, 'prefetches:', res.prefetches, 'drops:', res.drops);
console.log('timeline entries:', res.timeline.length);

// ---- Test 4: Tiered-3L + multiTurn + lognormal ----
document.getElementById('pMultiTurn').value=30;
document.getElementById('pLenDist').value='lognormal';
let res2 = runSimulation(parseDSL(strategyPresets['Tiered-3L']));
console.log('\n== runSimulation (Tiered-3L, multiTurn=30, lognormal) ==');
console.log('completed:', res2.completed+'/'+res2.totalReqs, 'hitRate:', res2.hitRate.toFixed(1)+'%');
console.log('sessionHits:', res2.sessionHits, 'transferGB:', res2.transferGB.toFixed(1));
console.log('p50:', res2.p50.toFixed(0), 'p99:', res2.p99.toFixed(0), 'fairnessCV:', res2.fairnessCV.toFixed(0));

// ---- Test 5: 种子可复现性 ----
let a = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:7});
let b = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:7});
console.log('\n== 种子可复现 ==', 'same p50:', a.p50===b.p50, 'same completed:', a.completed===b.completed);
let c = runSimulation(parseDSL(strategyPresets['Pure-HBM']), {seed:8});
console.log('different seed differs:', a.p50!==c.p50 || a.completed!==c.completed);
