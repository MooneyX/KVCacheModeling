const { createLegacyHarness } = require("../../dist/node/library.cjs");
// 探针: 敏感性分析中 prefix_hit 扫描的 TTFT 区分度验证（2026-08-11 修复后）
// 修复: index.html 组分配 pTokLen = h×ratio×avgInput（旧版固定、仅 nTotal 随 h → maxAssign 封顶后不敏感）
// 修复后: 期望实际覆盖 = h×totalInput, prefixHit 全程单调; hit95 场景覆盖 = 0.95×旧值
// 用法: node sim_prefixhit_probe.js

function makeEl(value) { return { value: value !== undefined ? String(value) : "0" }; }
const elements = {};
const readControl = id => elements[id] || (elements[id] = makeEl());

const sim = createLegacyHarness(readControl);
const $ = (id) => readControl(id);
const set = (id, v) => { $(id).value = String(v); };

// ===== 与 sim_l3ttft_final.js 相同的场景 =====
set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 2); set('pDtype', 2);
set('pGpuCount', 8); set('pHbm', 24); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 12); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
set('pConcurrency', 4); set('pInputLen', 16384); set('pOutputLen', 16);
set('pPrefixHit', 95); set('pBlockSize', 256); set('pQps', 0.4);
set('pMfu', 60); set('pMaxBatch', 8);
set('pMultiTurn', 0); set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pSimMaxTime', 1200);
$('pPrefixWarm').checked = true;
const p0 = sim.getParams();
const e0 = sim.estimatePrefillParams(p0);
set('pPrefillA', e0.a.toFixed(3)); set('pPrefillB', e0.b.toFixed(7));
set('pFetchFixedUs', 209); set('pChunkSize', 2048);
const strat = sim.parseDSL('ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: dynamic max(32)\nPLACE: tiered');
strat.name = 'Tiered-3L(无预取)';

const r0 = sim.calcAll(p0);
const kvPerTok = r0.kvPerToken;
const N = p0.concurrency * 2;                       // 8
const totalInput = N * p0.inputLen;                  // 期望总输入 token
console.log('N = ' + N + ' | maxAssign = ' + Math.floor(N * 0.9) + ' | 期望总输入 ≈ ' + totalInput + ' tok | kvPerTok = ' + (kvPerTok/1e3).toFixed(0) + ' KB');
console.log('组比例 [12,22,35,48]% 固定; 单请求覆盖 = 组比例×avgInput (clamp 0.7×inputLen); 入组数由 prefixHit 决定, 上限 ' + Math.floor(N*0.9));
console.log('理论饱和: 实际最大覆盖率 ≈ 0.9N × Σ(ratio²)/Σratio / N = ' + (0.9 * (0.12*0.12+0.22*0.22+0.35*0.35+0.48*0.48) / 1.17 * 100).toFixed(1) + '% 总输入\n');

for (const bw of [10, 90]) {
  console.log('===== L3 带宽 = ' + bw + ' GB/s =====');
  console.log('prefixHit | avgTTFT | p50TTFT | 实际覆盖tok | 实际覆盖率 | 完成');
  for (const ph of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const out = sim.runSimulation(strat, { seed: 42, ssdBW: bw, prefixHit: ph });
    const covTok = (out.prefixSavedMB || 0) * 1e6 / kvPerTok;
    console.log(('  ' + (ph * 100)).slice(0, 6).padStart(6) + '% | ' + out.avgTtft.toFixed(0).padStart(7) + ' | ' + out.p50Ttft.toFixed(0).padStart(7)
      + ' | ' + covTok.toFixed(0).padStart(10) + ' | ' + (covTok / totalInput * 100).toFixed(1).padStart(8) + '% | ' + out.completed + '/' + out.totalReqs);
  }
}
