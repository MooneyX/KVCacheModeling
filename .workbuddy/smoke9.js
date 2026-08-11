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
  pConcurrency:128,pInputLen:4096,pOutputLen:1024,pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,
  pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];

let r = runSimulation(parseDSL(strategyPresets['Pure-HBM']));
console.log('concurrency=128 → N=100 请求');
console.log('completed:', r.completed, '/', r.totalReqs);
console.log('timeline rows:', r.timeline.length);
// 检查阶段完整性
let bad = r.timeline.filter(t => !(t.admitTime >= t.arrive && t.prefillStart >= t.admitTime
  && t.prefillEnd > t.prefillStart && t.completeTime > t.prefillEnd));
console.log('阶段时间异常的条目:', bad.length);
if (bad.length) console.log(bad.slice(0,3));
// 零长度阶段统计
let zeroQueue = r.timeline.filter(t => t.admitTime - t.arrive < 0.01).length;
let zeroWait = r.timeline.filter(t => t.prefillStart - t.admitTime < 0.01).length;
console.log('queue≈0 的行:', zeroQueue, '· wait≈0 的行:', zeroWait);
let decDur = r.timeline.map(t => t.completeTime - t.prefillEnd);
console.log('decode时长 min/max:', Math.min(...decDur).toFixed(2), '/', Math.max(...decDur).toFixed(2));
