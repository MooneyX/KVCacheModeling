// 仿真对齐对比: 与实测完全相同参数(conc=8, in=2048, out=256, qps=4, prefixHit=40%, seed=42, maxBatch=8, uniform)
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.join('\n');
function makeEl(value) {
  return {
    value: value !== undefined ? String(value) : '0',
    textContent: '', innerHTML: '', placeholder: '',
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; } },
    dataset: {},
    appendChild(){}, remove(){},
    querySelectorAll(){ return []; },
    addEventListener(){}, focus(){},
  };
}
const elements = {};
global.document = {
  getElementById(id){ if (!elements[id]) elements[id] = makeEl(); return elements[id]; },
  querySelectorAll(){ return []; },
  createElement(){ return makeEl(); },
  addEventListener(){},
};
global.window = { addEventListener(){}, };
global.echarts = {
  init(){ return { setOption(){}, resize(){}, dispose(){} }; },
  getInstanceByDom(){ return null; },
};
(0, eval)(code + `
globalThis.__sim = { runSimulation, parseDSL, strategyPresets, getParams, calcAll, mulberry32 };
`);
const sim = globalThis.__sim;
const $ = (id) => global.document.getElementById(id);
const set = (id, v) => { $(id).value = String(v); };

// Qwen3-32B × H20 单卡(与实测同)
set('pAttnType', 'gqa'); set('pLayers', 64); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 5120);
set('pParamsB', 32); set('pActB', 32);
set('pGpuCount', 1); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148);
set('pTpSize', 1); set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 16); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
set('pDtype', 2); set('pWeightDtype', 2);
set('pConcurrency', 8); set('pInputLen', 2048); set('pOutputLen', 256);
set('pQps', 4); set('pMfu', 50); set('pLenDist', 'uniform'); set('pSeed', 43);
set('pMaxBatch', 8); set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);
set('pFramework', 'generic'); set('pPrefixCache', 'hash'); set('pPdSep', '0'); set('pTieredKv', '1'); set('pArrivalDist', 'poisson');

const p = sim.getParams();
const r = sim.calcAll(p);
console.log('===== calcAll 静态估算 =====');
console.log('TTFT估算:', (r.ttftEst*1000).toFixed(1), 'ms | TPOT:', (r.tpotEst*1000).toFixed(2), 'ms | KV/Token:', (r.kvPerToken/1024).toFixed(0), 'KB');

console.log('\n===== 仿真 runSimulation(与实测同参数) =====');
const names = ['Pure-HBM', 'HBM+DRAM'];
for (const name of names) {
  const s = sim.parseDSL(sim.strategyPresets[name]);
  s.name = name;
  const out = sim.runSimulation(s);
  const avgLat = out.latencies.length ? out.latencies.reduce((a, b) => a + b, 0) / out.latencies.length : 0;
  console.log(name + ':');
  console.log('  TTFT avg=' + out.avgTtft.toFixed(1) + 'ms p50=' + out.p50Ttft.toFixed(1) + 'ms p99=' + out.p99Ttft.toFixed(1) + 'ms');
  console.log('  TPOT avg=' + out.avgTpot.toFixed(2) + 'ms | Lat avg=' + avgLat.toFixed(1) + 'ms | hitRate=' + out.hitRate.toFixed(1) + '%');
  console.log('  throughput=' + out.throughput.toFixed(1) + ' tok/s | completed=' + out.completed + '/' + out.totalReqs + ' | simEnd=' + out.simEnd.toFixed(1) + 's');
}

// 实测数据点(同 trace 同参数, seed=43 正式轮, 缓存清空)
console.log('\n===== 实测(同 trace, seed=43 正式轮) =====');
console.log('TTFT avg=4863.5ms p50=5476.6ms p99=7705.4ms');
console.log('TPOT avg=46.55ms | Lat avg=17903.4ms | completed=16/16 | throughput=4498/26.84=167.6 tok/s');
