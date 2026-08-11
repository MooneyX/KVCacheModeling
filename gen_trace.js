// gen_trace.js: 从 index.html 提取请求生成逻辑(泊松到达 + uniform/log-normal 长度 + 4组前缀分配),
// 输出与仿真 runSimulation 内部完全一致的请求 trace(JSON),供实测脚本复刻。
const fs = require('fs');
const html = fs.readFileSync('D:/Documents/KVCacheModeling/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = scripts.join('\n');

// ---- DOM 桩(与 sim_harness 一致)----
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

// ---- 提取请求生成代码块: "// ---------- 请求生成 ----------" 到 "// ---------- JS 策略编译 ----------" ----
const startMark = '  // ---------- 请求生成 ----------';
const endMark = '  // ---------- JS 策略编译 ----------';
const si = code.indexOf(startMark);
const ei = code.indexOf(endMark);
if (si < 0 || ei < 0 || ei <= si) { console.error('MARKER_NOT_FOUND', si, ei); process.exit(1); }
const genBlock = code.slice(si, ei);

// ---- 参数(从命令行读取, 默认与网页一致)----
const argv = process.argv.slice(2);
const setP = (id, v) => { elements[id] = makeEl(); elements[id].value = String(v); };
const MODEL = process.env.MODEL || 'qwen32';
if (MODEL === 'dsv3') {
  // DeepSeek-V3 × H20×8 (与 sim_dsv3_matrix.js / sim_harness.js 一致)
  setP('pAttnType', 'mla'); setP('pLayers', 61); setP('pKvLora', 512); setP('pRopeDim', 64); setP('pHidden', 7168);
  setP('pVocab', 129280); setP('pParamsB', 671); setP('pActB', 37);
  setP('pGpuCount', 8); setP('pHbm', 96); setP('pHbmBW', 4); setP('pTflops', 148);
  setP('pTpSize', 8); setP('pNvlinkBW', 900); setP('pPcieBW', 64); setP('pTierQuant', 1);
  setP('pDram', 1024); setP('pDramBW', 400); setP('pSsd', 20); setP('pSsdBW', 10);
  setP('pDtype', 1); setP('pWeightDtype', 1); // KV FP8(1B), 权重 FP8(1B) — DS-V3 实际部署
} else {
  // Qwen3-32B × H20 单卡
  setP('pAttnType', 'gqa'); setP('pLayers', 64); setP('pKvHeads', 8); setP('pHeadDim', 128);
  setP('pKvLora', 512); setP('pRopeDim', 64); setP('pHidden', 5120);
  setP('pParamsB', 32); setP('pActB', 32);
  setP('pGpuCount', 1); setP('pHbm', 96); setP('pHbmBW', 4); setP('pTflops', 148);
  setP('pTpSize', 1); setP('pNvlinkBW', 900); setP('pPcieBW', 64); setP('pTierQuant', 1);
  setP('pDram', 16); setP('pDramBW', 400); setP('pSsd', 20); setP('pSsdBW', 10);
  setP('pDtype', 2); setP('pWeightDtype', 2);
}
setP('pConcurrency', argv[0] || 8); setP('pInputLen', argv[1] || 2048); setP('pOutputLen', argv[2] || 256);
setP('pQps', argv[3] || 4); setP('pMfu', 50); setP('pLenDist', process.env.LENDIST || 'uniform'); setP('pSeed', argv[4] || 42);
setP('pMaxBatch', argv[5] || 8); setP('pBlockSize', 16); setP('pMultiTurn', 0); setP('pPrefixHit', argv[6] || 40);
setP('pArrivalDist', process.env.ARRIVAL || 'poisson');

// ---- 执行: 前置依赖 + 生成块 ----
(0, eval)(code + `
globalThis.__gen = (function(){
  let overrides = {};
  let p = getParams();
  let rng = mulberry32(p.seed >>> 0);
${genBlock}
  return { p: p, requests: requests.map(r => ({
    id: r.id, arrive: r.arrive, inputLen: r.inputLen, outputLen: r.outputLen,
    groupId: r.groupId, prefixTokLen: r.prefixTokLen, isFounder: r.isFounder,
    followUp: r.followUp, multiTurn: p.multiTurn
  })) };
});
`);

const out = globalThis.__gen();
// 汇总打印 + 输出 trace 文件
console.log('=== TRACE 摘要 ===');
console.log('N =', out.requests.length);
console.log('arrive 范围: 0 ~', out.requests[out.requests.length - 1].arrive.toFixed(3), 's');
const groups = {};
out.requests.forEach(r => {
  if (r.groupId) {
    if (!groups[r.groupId]) groups[r.groupId] = { n: 0, founders: 0, prefixLen: 0, reqs: [] };
    groups[r.groupId].n++; if (r.isFounder) groups[r.groupId].founders++;
    groups[r.groupId].prefixLen = r.prefixTokLen;
    groups[r.groupId].reqs.push(r.id);
  }
});
console.log('前缀组:', JSON.stringify(groups, (k, v) => k === 'reqs' ? v.length : v));
const inLens = out.requests.map(r => r.inputLen);
const outLens = out.requests.map(r => r.outputLen);
console.log('inputLen: min=' + Math.min(...inLens), 'max=' + Math.max(...inLens), 'avg=' + Math.round(inLens.reduce((a, b) => a + b, 0) / inLens.length));
console.log('outputLen: min=' + Math.min(...outLens), 'max=' + Math.max(...outLens), 'avg=' + Math.round(outLens.reduce((a, b) => a + b, 0) / outLens.length));
fs.writeFileSync('D:/Documents/KVCacheModeling/trace.json', JSON.stringify(out, null, 1));
console.log('trace.json 已写入');
