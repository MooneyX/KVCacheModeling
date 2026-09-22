const { createLegacyHarness } = require("../../../dist/node/library.cjs");
// 最终推荐场景复现: H20×8 + Llama-3-70B(预置模型, BF16) → L3(SSD)带宽 10/30/50/70/90 GB/s 对 TTFT 影响显著
// 机制(代码阅读结论):
//  ① HBM24GB/卡 恰好装下 BF16 权重(141GB)+开销 → availHbm≈0.3GB → KV 全部下沉 DRAM(12GB)/SSD
//  ② 前缀预热✓(HiCache/L3常驻): 共享前缀块常驻 SSD, sharer prefill 现场从 L3 拉取(fetchTime 计入 TTFT)
//  ③ 策略用 Tiered-3L 无预取变体: PREFETCH:none —— eager 预取会把前缀块提前搬回 HBM, 后续免费命中 → 带宽不敏感
//  ④ 快层容量(fastCap≈12GB) < 在途请求 KV(2×5.4GB) → 请求在 SSD 解码波次后排队长
//  ⑤ L3 带宽决定波次排水速度 → TTFT 10GB/s≈35.2s → 90GB/s≈5.6s (avg 6.35×, p50 9.05×; 2026-08-11 prefixHit 缩放修复后数值)
// 用法: node sim_l3ttft_final.js
const fs = require('fs');

function makeEl(value) { return { value: value !== undefined ? String(value) : "0" }; }
const elements = {};
const readControl = id => elements[id] || (elements[id] = makeEl());

const sim = createLegacyHarness(readControl);
const $ = (id) => readControl(id);
const set = (id, v) => { $(id).value = String(v); };

// ===== 模型: Llama-3-70B 预置 (GQA 80×8×128) + BF16 → kvPerTok=320KB =====
set('pAttnType', 'gqa'); set('pLayers', 80); set('pKvHeads', 8); set('pHeadDim', 128);
set('pKvLora', 512); set('pRopeDim', 64); set('pHidden', 8192); set('pVocab', 128256);
set('pParamsB', 0); set('pActB', 0); set('pWeightDtype', 2); set('pDtype', 2);
// ===== 硬件: H20×8 (TP8) — HBM 24GB/卡(KV下沉), DRAM 12GB, NVMe 20TB =====
set('pGpuCount', 8); set('pHbm', 24); set('pHbmBW', 4); set('pTflops', 148); set('pTpSize', 8);
set('pNvlinkBW', 900); set('pPcieBW', 64); set('pTierQuant', 1);
set('pDram', 12); set('pDramBW', 400); set('pSsd', 20); set('pSsdBW', 10);
// ===== 负载: conc4 · in16384 · out16 · hit95% · 前缀预热 · qps0.4 =====
set('pConcurrency', 4); set('pInputLen', 16384); set('pOutputLen', 16);
set('pPrefixHit', 95); set('pBlockSize', 256); set('pQps', 0.4);
set('pMfu', 60); set('pMaxBatch', 8);
set('pMultiTurn', 0); set('pLenDist', 'uniform'); set('pArrivalDist', 'poisson'); set('pSeed', 42);
set('pFramework', 'sglang'); set('pPrefixCache', 'radix'); set('pPdSep', '0'); set('pTieredKv', '1');
set('pSimMaxTime', 1200);
$('pPrefixWarm').checked = true;
// prefill 参数用推导值(网页上点"推导"按钮自动填充)
const p0 = sim.getParams();
const e0 = sim.estimatePrefillParams(p0);
set('pPrefillA', e0.a.toFixed(3)); set('pPrefillB', e0.b.toFixed(7));
set('pFetchFixedUs', 209); set('pChunkSize', 2048);

// ===== 策略: Tiered-3L 无预取变体 =====
const strat = sim.parseDSL('ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: dynamic max(32)\nPLACE: tiered');
strat.name = 'Tiered-3L(无预取)';

const r = sim.calcAll(p0);
console.log('== 物理量 ==');
console.log('  kvPerTok = ' + (r.kvPerToken / 1e3).toFixed(0) + ' KB/tok | 权重 = ' + (r.modelWeightGB).toFixed(0) + ' GB | HBM总 = ' + (p0.hbmPerGpu * p0.gpus) + ' GB');
console.log('  availHbm(KV可用) = ' + (r.availHbm / 1e9).toFixed(2) + ' GB | DRAM = ' + (r.dramTotal / 1e9).toFixed(0) + ' GB | SSD = ' + (r.ssdTotal / 1e9).toFixed(0) + ' GB');
console.log('  单请求KV(含碎片) = ' + (r.perRequestKv / 1e9).toFixed(2) + ' GB | 生命周期均值 = ' + (r.avgLifetimeKv / 1e9).toFixed(2) + ' GB');
console.log('  prefill推导: a=' + e0.a.toFixed(2) + ' μs/tok, b=' + (e0.b * 1e3).toFixed(2) + 'e-3 μs/tok²');
console.log('  fastCap(HBM+DRAM) = ' + ((r.availHbm + r.dramTotal) * 0.98 / 1e9).toFixed(1) + ' GB < 在途KV(2×' + (r.avgLifetimeKv / 1e9).toFixed(1) + 'GB) → 请求排队');

const BWS = [10, 30, 50, 70, 90];
console.log('\n== 种子42(默认, 与网页一致) ==');
console.log('ssdBW | avgTTFT | p50TTFT | p99TTFT | avgQueue | 完成 | l3BWp99 | 瓶颈');
let rows = [];
for (const bw of BWS) {
  const out = sim.runSimulation(strat, { seed: 42, ssdBW: bw, prefixHit: 0.95 });
  rows.push(out);
  const bn = Object.keys(out.bottleneckPct).reduce((m, k) => out.bottleneckPct[k] > (m ? out.bottleneckPct[m] : -1) ? k : m, null);
  console.log(String(bw).padStart(5) + ' | ' + out.avgTtft.toFixed(0).padStart(8) + ' | ' + out.p50Ttft.toFixed(0).padStart(8)
    + ' | ' + out.p99Ttft.toFixed(0).padStart(9) + ' | ' + out.avgQueue.toFixed(1).padStart(8)
    + ' | ' + out.completed + '/' + out.totalReqs + (out.truncated ? '(截断!)' : '') + ' | ' + (out.l3BWp99 / 1e9).toFixed(0).padStart(5) + ' | ' + bn);
}
console.log('  avgTTFT 10→90 = ' + (rows[0].avgTtft / rows[4].avgTtft).toFixed(2) + 'x | p50 10→90 = ' + (rows[0].p50Ttft / rows[4].p50Ttft).toFixed(2) + 'x');

console.log('\n== 种子7(稳健性) ==');
for (const bw of [10, 50, 90]) {
  const out = sim.runSimulation(strat, { seed: 7, ssdBW: bw, prefixHit: 0.95 });
  console.log('  bw' + String(bw).padStart(2) + ': avgTTFT=' + out.avgTtft.toFixed(0) + ' p50=' + out.p50Ttft.toFixed(0) + ' ' + out.completed + '/' + out.totalReqs);
}

// JSON 输出供报告
fs.writeFileSync('l3ttft_final_results.json', JSON.stringify({
  params: {
    model: 'Llama-3-70B(预置) BF16', hw: 'H20×8 TP8', hbmPerGpu: 24, dram: 12,
    concurrency: 4, inputLen: 16384, outputLen: 16, prefixHit: 95, qps: 0.4, seed: 42,
    blockSize: 256, mfu: 60, framework: 'sglang', prefixCache: 'radix', prefixWarm: true,
    strategy: strat.dsl, prefillA: e0.a, prefillB: e0.b
  },
  results: rows.map(o => ({ bw: null, avgTtft: o.avgTtft, p50Ttft: o.p50Ttft, p99Ttft: o.p99Ttft, avgQueue: o.avgQueue, l3BWp99: o.l3BWp99, completed: o.completed, totalReqs: o.totalReqs }))
    .map((o, i) => ({ ...o, bw: BWS[i] })),
  physics: { kvPerTok: r.kvPerToken, weightGB: r.modelWeightGB, availHbmGB: r.availHbm / 1e9, perReqKvGB: r.perRequestKv / 1e9, avgLifetimeKvGB: r.avgLifetimeKv / 1e9 }
}, null, 2));
console.log('\n结果已写入 l3ttft_final_results.json');
