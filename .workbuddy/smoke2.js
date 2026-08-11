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
  pQps:8,pMfu:50,pMaxBatch:8,pBlockSize:16,pPrefixHit:40,pLenDist:'uniform',pMultiTurn:0,pSeed:42};
for (const k in vals) document.getElementById(k).value = vals[k];
for (const k of ["pFramework","pPrefixCache","pPdSep","pTieredKv"]) document.getElementById(k).value={pFramework:"generic",pPrefixCache:"hash",pPdSep:"0",pTieredKv:"1"}[k];
document.getElementById('sDsl').value = strategyPresets['Pure-HBM'];
document.getElementById('sName').value = '';
document.getElementById('sSweepParam').value = 'max_batch_size';
document.getElementById('sSweepMetric').value = 'p99_latency';

async function main(){
  // 1) 绘图函数逐个执行（echarts已桩，只验证不抛异常）
  const draws = ['updateQuickResults','drawTierOverview','drawKvCurve','drawConcurrency',
    'drawBatching','drawPrefixSharing','drawEviction','drawGantt','drawStrategyMetrics'];
  updateQuickResults(); console.log('updateQuickResults OK');
  drawTierOverview(); console.log('drawTierOverview OK');
  drawKvCurve(); console.log('drawKvCurve OK');
  drawConcurrency(); console.log('drawConcurrency OK');
  drawBatching(); console.log('drawBatching OK');
  let t0 = Date.now(); drawEviction(); console.log('drawEviction OK', (Date.now()-t0)+'ms');
  drawGantt(); console.log('drawGantt OK');

  // 2) JS 策略模式
  strategyMode = 'js';
  let jsStrat = { name:'JS-Pure-HBM', dsl: strategyPresetsJS['Pure-HBM'],
    admission:{type:'always'}, eviction:{type:'lru',hbm_evict_threshold:0.95},
    prefetch:{type:'none'}, placement:{type:'hbm_first'}, batching:{type:'continuous',max_batch_size:8} };
  let jr = runSimulation(jsStrat);
  console.log('JS mode:', jr.completed+'/'+jr.totalReqs, 'p50='+jr.p50.toFixed(0), 'hitRate='+jr.hitRate.toFixed(1)+'%');
  strategyMode = 'dsl';

  // 3) DSL 预设全跑一遍
  for (const name of Object.keys(strategyPresets)) {
    let rr = runSimulation(parseDSL(strategyPresets[name]));
    console.log('preset', name+':', rr.completed+'/'+rr.totalReqs,
      'hitRate='+rr.hitRate.toFixed(1)+'%', 'p99='+rr.p99.toFixed(0)+'ms',
      'evict='+rr.evictions, 'prefetch='+rr.prefetches, 'drop='+rr.drops);
  }

  // 4) 交叉分析（异步，28次仿真）
  t0 = Date.now();
  drawCrossAnalysis();
  await new Promise(res => setTimeout(res, 30000));
  console.log('drawCrossAnalysis OK', (Date.now()-t0)/1000+'s (含30s等待上限)');
  console.log('\nALL UI SMOKE TESTS PASSED');
  process.exit(0);
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
