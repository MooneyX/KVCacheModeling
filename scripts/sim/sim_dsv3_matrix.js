// DS-V3 × 8×H20 仿真精度矩阵: 多参数组合的仿真预期值(供实测对比)
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.join('\n');
function makeEl(value) {
  return { value: value !== undefined ? String(value) : '0', textContent: '', innerHTML: '', placeholder: '',
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } }, dataset: {},
    appendChild(){}, remove(){}, querySelectorAll(){ return []; }, addEventListener(){}, focus(){}, };
}
function runCase(params, label) {
  const elements = {};
  global.document = {
    getElementById(id){ if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
    querySelectorAll(){ return []; }, createElement(){ return makeEl(); }, addEventListener(){},
  };
  global.window = { addEventListener(){}, };
  global.echarts = { init(){ return { setOption(){}, resize(){}, dispose(){} }; }, getInstanceByDom(){ return null; }, };
  const set = (id, v) => { global.document.getElementById(id).value = String(v); };
  // DS-V3 基础参数
  set('pAttnType','mla'); set('pLayers',61); set('pKvLora',512); set('pRopeDim',64); set('pHidden',7168); set('pVocab',129280);
  set('pParamsB',671); set('pActB',37); set('pWeightDtype',1); set('pDtype',1);
  set('pGpuCount',8); set('pHbm',96); set('pHbmBW',4); set('pTflops',148); set('pTpSize',8);
  set('pNvlinkBW',900); set('pPcieBW',64); set('pTierQuant',1); set('pDram',1024); set('pDramBW',400);
  set('pSsd',20); set('pSsdBW',10);
  set('pConcurrency', params.conc); set('pInputLen', params.inLen); set('pOutputLen', params.outLen);
  set('pQps', params.qps); set('pMfu', params.mfu||30); set('pMaxBatch', params.maxBatch || 16);
  set('pBlockSize',16); set('pMultiTurn', params.multiTurn || 0); set('pPrefixHit', params.hit);
  set('pLenDist', params.lenDist || 'fixed'); set('pArrivalDist', params.arrival || 'uniform'); set('pSeed', params.seed || 42);
  set('pFramework', params.fw || 'generic'); set('pPrefixCache', params.pc || 'hash'); set('pPdSep', params.pdSep || '0'); set('pTieredKv', params.tiered || '1');
  // 2026-08-10 实测校准: DS-V3 prefillA=216μs/tok(2048tok=444ms 反推), b=kvPerTok/aggHbmBW=1.1e-3
  set('pPrefillA', 216); set('pPrefillB', 0.0011); set('pFetchFixedUs', 209); set('pChunkSize', 2048);
  (0, eval)(code + '\nglobalThis.__s={runSimulation,parseDSL,strategyPresets,calcAll,getParams};');
  const s = globalThis.__s;
  const r = s.calcAll(s.getParams());
  const out = s.runSimulation(s.parseDSL(s.strategyPresets['Pure-HBM']), {});
  console.log(label
    + ' | TTFT=' + out.avgTtft.toFixed(0) + 'ms p50=' + out.p50Ttft.toFixed(0)
    + ' | TPOT=' + out.avgTpot.toFixed(1) + 'ms'
    + ' | Lat=' + out.p50.toFixed(0) + 'ms'
    + ' | tput=' + out.throughput.toFixed(1) + 'tok/s'
    + ' | 完成=' + out.completed + '/' + out.totalReqs
    + ' | queue=' + out.avgQueue.toFixed(1) + 's'
    + ' | 静态TPOT=' + (r.tpotEst*1000).toFixed(1) + 'ms');
}
const F = {conc:8, inLen:2048, outLen:256, qps:4, hit:40};
console.log('=== DS-V3 × 8×H20 仿真矩阵 (N=min(2×conc,256)) ===');
runCase({...F}, 'base      conc8 in2048 out256 qps4 hit40 uniform');
runCase({...F, conc:1}, 'conc1');
runCase({...F, conc:32}, 'conc32');
runCase({...F, inLen:512}, 'in512');
runCase({...F, inLen:8192}, 'in8192');
runCase({...F, outLen:64}, 'out64');
runCase({...F, outLen:1024}, 'out1024');
runCase({...F, qps:0.5}, 'qps0.5(无排队)');
runCase({...F, qps:16}, 'qps16(深排队)');
runCase({...F, hit:0}, 'hit0');
runCase({...F, hit:80}, 'hit80');
runCase({...F, arrival:'poisson'}, 'arrival-poisson');
runCase({...F, fw:'sglang', pc:'radix', pdSep:'1', tiered:'1'}, 'fw-sglang(radix+PD)');
runCase({...F, fw:'sglang', pc:'radix', pdSep:'0', tiered:'1'}, 'fw-sglang混合批(耦合)');
runCase({...F, fw:'vllm', pc:'hash', pdSep:'0', tiered:'0'}, 'fw-vllm(无分层)');
