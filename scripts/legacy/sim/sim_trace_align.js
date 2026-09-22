const { createLegacyHarness } = require("../../../dist/node/library.cjs");
// sim_trace_align.js: 用与实测 trace 完全一致的参数运行仿真(供 aligned_bench.py 实测对照)
// 注意: 实测服务器为 sglang 混合批(非PD) → fw=sglang, pc=radix, pdSep=0, tiered=1
// trace: seed=42, conc8/in2048/out256/qps4/hit40/uniform/poisson
const fs = require('fs');

function makeEl(value) { return { value: value !== undefined ? String(value) : "0" }; }
const elements = {};
const readControl = id => elements[id] || (elements[id] = makeEl());

const sim = createLegacyHarness(readControl);
const $ = (id) => readControl(id);
const set = (id, v) => { $(id).value = String(v); };

// 从 trace.json 读取参数(与实测请求流完全一致)
const trace = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname, '../../../data/results/trace.json'), 'utf8'));
const P = trace.p;
set('pAttnType', 'mla'); set('pLayers', 61); set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 7168); set('pVocab', 129280);
set('pParamsB', 671); set('pActB', 37); set('pWeightDtype', 1); set('pDtype', 1);
set('pGpuCount', 8); set('pHbm', 96); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1); set('pDram', 1024); set('pDramBW', 400);
set('pSsd', 20); set('pSsdBW', 10);
set('pConcurrency', P.concurrency); set('pInputLen', P.inputLen); set('pOutputLen', P.outputLen);
set('pLenDist', 'fixed');
set('pQps', P.qps); set('pMfu', 30); set('pMaxBatch', 8);
set('pBlockSize', 16); set('pMultiTurn', 0); set('pPrefixHit', P.prefixHit * 100);
set('pLenDist', P.lenDist); set('pArrivalDist', P.arrivalDist); set('pSeed', P.seed);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
// 位置感知 prefill 参数(与建模默认一致)
set('pPrefillA', 79.5); set('pPrefillB', 0.00533); set('pFetchFixedUs', 209); set('pChunkSize', 2048);

const p = sim.getParams();
const r = sim.calcAll(p);
console.log('===== calcAll 静态估算 =====');
console.log('KV/Token:', (r.kvPerToken / 1024).toFixed(1), 'KB | prefillTps:', Math.round(r.prefillTps), '| TPOT:', (r.tpotEst * 1000).toFixed(2), 'ms | TTFT:', (r.ttftEst * 1000).toFixed(0), 'ms');

console.log('\n===== 仿真 runSimulation(trace 同参数, fw=sglang 混合批) =====');
const names = ['Pure-HBM', 'Tiered-3L'];
for (const name of names) {
  const s = sim.parseDSL(sim.strategyPresets[name]);
  s.name = name;
  const out = sim.runSimulation(s);
  console.log(name + ':');
  console.log('  TTFT avg=' + out.avgTtft.toFixed(1) + 'ms p50=' + out.p50Ttft.toFixed(1) + 'ms p99=' + out.p99Ttft.toFixed(1) + 'ms');
  console.log('  TPOT avg=' + out.avgTpot.toFixed(2) + 'ms | Lat p50=' + out.p50.toFixed(1) + 'ms | hitRate=' + out.hitRate.toFixed(1) + '%');
  console.log('  throughput=' + out.throughput.toFixed(1) + ' tok/s | completed=' + out.completed + '/' + out.totalReqs + ' | queue=' + out.avgQueue.toFixed(2) + 's | truncated=' + out.truncated);
}
