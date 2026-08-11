// Harness: 直接执行 index.html 内的仿真引擎,输出 DeepSeek-V3 × H20x8 基准参数下的仿真指标
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');

// 提取所有内联 <script> 块(不含 src 外部引用)
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (scripts.length === 0) { console.error('NO_SCRIPT_FOUND'); process.exit(1); }
const code = scripts.join('\n');

// ---- DOM 桩 ----
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

// 间接 eval: 脚本内 let/const 在同一 eval 作用域内可见
(0, eval)(code + `
globalThis.__sim = { runSimulation, parseDSL, strategyPresets, strategyPresetsJS,
  getParams, calcAll, mulberry32, autoNameStrategy, hwPresets, models };
`);

const sim = globalThis.__sim;
const $ = (id) => global.document.getElementById(id);

// ---- 设置 DeepSeek-V3 × H20x8 基准参数(与网页默认一致,模型切换为 DeepSeek-V3)----
const set = (id, v) => { $(id).value = String(v); };
set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168);
set('pParamsB', 671); set('pActB', 37);
set('pGpuCount', 8); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148);
set('pTpSize', 8); set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 1024); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
set('pDtype', 2); set('pWeightDtype', 1); // KV BF16(2B) 与真实一致; 权重 FP8(1B) = 实际 DeepSeek-V3 部署
set('pConcurrency', 32); set('pInputLen', 4096); set('pOutputLen', 1024);
set('pQps', 8); set('pMfu', 50); set('pLenDist', 'uniform'); set('pSeed', 42);
set('pMaxBatch', 8); set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', 40);

// ---- overhead 修正说明: 模型权重 FP8 671GB, 总HBM 768GB, 10%overhead=76.8GB 过于保守 ----
// 实际部署: 每卡 96GB, 权重 84GB/卡, CUDA上下文+激活工作区 ≈ 5-8GB/卡, 可用 KV ≈ 84GB/卡(见下方 static 输出)

// ---- 静态估算(calcAll)----
const p = sim.getParams();
const r = sim.calcAll(p);
console.log('===== calcAll 静态估算 =====');
console.log('KV/Token:', (r.kvPerToken/1024).toFixed(1), 'KB');
console.log('模型权重:', (r.modelWeightGB).toFixed(0), 'GB');
console.log('HBM可用(KV):', (r.availHbm/1e9).toFixed(1), 'GB');
console.log('HBM可容纳请求:', r.maxHbmRequests);
console.log('Prefill TPS:', (r.prefillTps).toFixed(0));
console.log('TTFT估算(单请求):', (r.ttftEst*1000).toFixed(1), 'ms');
console.log('TPOT估算:', (r.tpotEst*1000).toFixed(2), 'ms/tok');
console.log('单请求KV(含碎片):', (r.perRequestKv/1e6).toFixed(2), 'MB');

// ---- 仿真(runSimulation):遍历所有 DSL 预设策略 ----
console.log('\n===== runSimulation 仿真(DeepSeek-V3, H20x8, conc=32, in=4096, out=1024, prefixHit=40%) =====');
console.log('策略'.padEnd(24), 'TTFT_avg'.padStart(10), 'TTFT_p50'.padStart(10), 'TTFT_p99'.padStart(10),
  'TPOT_avg'.padStart(10), 'Lat_p99'.padStart(10), 'HBM命中%'.padStart(9), '吞吐tok/s'.padStart(11),
  '预取'.padStart(6), '淘汰'.padStart(6), '完成/总数');
const presetNames = Object.keys(sim.strategyPresets);
for (const name of presetNames) {
  const s = sim.parseDSL(sim.strategyPresets[name]);
  s.name = name;
  const out = sim.runSimulation(s);
  console.log(out.name.slice(0,24).padEnd(24),
    out.avgTtft.toFixed(1).padStart(10), out.p50Ttft.toFixed(1).padStart(10), out.p99Ttft.toFixed(1).padStart(10),
    out.avgTpot.toFixed(2).padStart(10), out.p99.toFixed(1).padStart(10),
    out.hitRate.toFixed(1).padStart(9), out.throughput.toFixed(0).padStart(11),
    String(out.prefetches).padStart(6), String(out.evictions).padStart(6),
    out.completed + '/' + out.totalReqs);
}

// ---- 前缀命中率敏感性: prefixHit 0/20/40/60/80% ----
console.log('\n===== prefixHit 敏感性(Pure-HBM + HBM+DRAM + 默认DSL) =====');
const sensNames = ['Pure-HBM', 'HBM+DRAM'];
const sensName = presetNames[0] || 'Default';
for (const ph of [0, 20, 40, 60, 80]) {
  set('pPrefixHit', ph);
  const row = [];
  for (const nm of sensNames) {
    const s = sim.parseDSL(sim.strategyPresets[nm]);
    s.name = nm;
    const out = sim.runSimulation(s);
    row.push(nm + ': TTFT_avg=' + out.avgTtft.toFixed(1) + 'ms p50=' + out.p50Ttft.toFixed(1) + 'ms p99=' + out.p99Ttft.toFixed(1) + 'ms hit=' + out.hitRate.toFixed(1) + '%');
  }
  console.log('prefixHit=' + ph + '% | ' + row.join(' | '));
}
