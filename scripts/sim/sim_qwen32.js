// 对比仿真: Qwen3-32B 单卡(H20) 参数, 与 .114.88 GPU6 实际测量对比
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

// ---- Qwen3-32B × H20 单卡(与 .114.88 GPU6 实测一致) ----
set('pAttnType', 'gqa'); set('pLayers', 64); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 5120);
set('pParamsB', 32); set('pActB', 32);
set('pGpuCount', 1); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148);
set('pTpSize', 1); set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 16); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
set('pDtype', 2); set('pWeightDtype', 2); // BF16 KV + BF16 权重(与模型 config torch_dtype=bfloat16 一致)
set('pConcurrency', 1); set('pInputLen', 4096); set('pOutputLen', 64);
set('pQps', 1); set('pMfu', 50); set('pLenDist', 'uniform'); set('pSeed', 42);
set('pMaxBatch', 1); set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 0);

const p = sim.getParams();
const r = sim.calcAll(p);
console.log('===== calcAll 静态估算(Qwen3-32B × H20x1, BF16) =====');
console.log('KV/Token:', (r.kvPerToken/1024).toFixed(1), 'KB');
console.log('模型权重:', (r.modelWeightGB).toFixed(1), 'GB');
console.log('HBM可用(KV):', (r.availHbm/1e9).toFixed(1), 'GB');
console.log('Prefill TPS:', (r.prefillTps).toFixed(0));
console.log('TTFT估算(单请求@4096):', (r.ttftEst*1000).toFixed(1), 'ms');
console.log('TPOT估算:', (r.tpotEst*1000).toFixed(2), 'ms/tok');
console.log('单请求KV(含碎片):', (r.perRequestKv/1e6).toFixed(2), 'MB');
console.log('computeFlops:', (r.computeFlops/1e12).toFixed(1), 'TFLOPS(含MFU)');

// ---- 不同输入长度下仿真 TTFT(无前缀缓存, 单请求) ----
console.log('\n===== 单请求仿真 TTFT vs 实际 =====');
console.log('InputLen | sim_ttft_ms | actual_ttft_ms(冷启动) | actual_ttft_ms(前缀命中)');
for (const inLen of [1024, 2048, 4096, 8192]) {
  set('pInputLen', inLen);
  const out = sim.runSimulation(sim.parseDSL(sim.strategyPresets['Pure-HBM']), { nreq: 1, seed: 42 });
  console.log(String(inLen).padEnd(9), '|', out.avgTtft.toFixed(1).padStart(11), '|',
    ({1024:426, 2048:410, 4096:792, 8192:1637}[inLen]).toFixed(0).padStart(20), '|',
    ({1024:31, 2048:34, 4096:34, 8192:38}[inLen]).toFixed(0).padStart(22));
}

// ---- 仿真 TPOT vs 实际(4096 in) ----
set('pInputLen', 4096);
const p2 = sim.getParams();
const r2 = sim.calcAll(p2);
console.log('\n===== TPOT 对比(4096 in) =====');
console.log('sim TPOT:', (r2.tpotEst*1000).toFixed(2), 'ms/tok | actual TPOT: 22.3-22.7 ms/tok');

// ---- 输出长度解耦验证(仿真引擎修复后应恒定) ----
console.log('\n===== 仿真引擎 TTFT vs outputLen(单请求, 4096 in) =====');
for (const outLen of [64, 128, 256, 1024]) {
  set('pOutputLen', outLen);
  const out = sim.runSimulation(sim.parseDSL(sim.strategyPresets['Pure-HBM']), { nreq: 1, seed: 42 });
  console.log('outLen=' + String(outLen).padEnd(5), 'TTFT_avg=' + out.avgTtft.toFixed(1) + 'ms');
}
