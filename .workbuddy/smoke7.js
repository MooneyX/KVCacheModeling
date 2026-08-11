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

let r = runSimulation(parseDSL(strategyPresets['Pure-HBM']));
let tl = r.timeline.slice(0,16);
console.log('id\tarrive\tqueue\twaitC\tprefill\tdecode\tcomplete\t(queue时长)');
for (const t of tl) {
  console.log(t.id+'\t'+t.arrive.toFixed(2)+'\t'+t.admitTime.toFixed(2)+'\t'+t.prefillStart.toFixed(2)+'\t'
    +t.prefillEnd.toFixed(2)+'\t·\t'+t.completeTime.toFixed(2)+'\t('+(t.admitTime-t.arrive).toFixed(2)+'s)');
}
// decode 并行度检查：任意时刻同时在 decode 的请求数
let overlaps = 0;
for (let i = 0; i < tl.length; i++) for (let j = i+1; j < tl.length; j++) {
  let a = tl[i], b = tl[j];
  if (a.prefillEnd < b.completeTime && b.prefillEnd < a.completeTime) overlaps++;
}
console.log('\ndecode区间有重叠的请求对数:', overlaps, '(>0 说明 decode 确实并行)');
console.log('timeline总数:', r.timeline.length, 'completed:', r.completed);
