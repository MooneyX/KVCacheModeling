export function extractSensMetrics(r) {
  let b = r.ttftBreakdown || null;
  let tt = b ? (b.queue + b.prefillQ + b.fetch + b.compute) : 0;
  return { ttft: r.avgTtft, ttft_p50: r.p50Ttft, ttft_p99: r.p99Ttft, tpot: r.avgTpot,
    tpot_p50: r.p50Tpot, tpot_p99: r.p99Tpot, latency: r.avgLatency, latency_p50: r.p50,
    // hit_rate 保持"HBM 访问命中率"语义(历史敏感性/导出口径); 前缀分层命中率见 prefix_hit_rate
    throughput: r.throughput, hit_rate: r.hbmHitRate, mem_util: r.memUtilPeak, p99_latency: r.p99,
    // prefill 吞吐(2026-08-25): 与 throughput(decode 输出口径)是两条独立通道, 勿混用。
    // 分阶段吞吐(2026-08-26 改口径): 分母 = 各阶段自己的墙钟并集, 不再是 simEnd。
    // prefill_thr      = 名义 prompt 处理速率; prefill_comp_thr = GPU 实算速率
    // prefill_cache_amp= 名义÷实算 = 缓存放大倍数
    // decode_thr       = decode 输出速率(分母 = decode 活跃并集), 与 throughput(整机 simEnd 口径)不同
    // ⚠️ throughput 保留原 simEnd 口径不动 —— 它是"整机对外交付速率", 与阶段口径互补, 勿混用
    prefill_thr: r.prefillThroughput || 0,
    prefill_comp_thr: r.prefillComputeThroughput || 0,
    prefill_cache_amp: r.prefillCacheAmp || 0,
    decode_thr: r.decodeThroughput || 0,
    // 阶段活跃时长与重叠系数: 用于诊断"分母到底多长""并发重叠多严重"
    prefill_active_s: r.prefillActiveSec || 0,
    decode_active_s: r.decodeActiveSec || 0,
    prefill_overlap: r.prefillOverlap || 0,
    decode_overlap: r.decodeOverlap || 0,
    // 单请求视角(分母 = Σ逐请求时长): 回答"单个请求能多快", 随并发下降
    prefill_thr_per_req: r.prefillThroughputPerReq || 0,
    decode_thr_per_req: r.decodeThroughputPerReq || 0,
    prefix_hit_rate: r.hitRate ? r.hitRate.total : 0,
    fetch_ratio: tt > 0 ? 100 * b.fetch / tt : 0,   // L3拉取时间占比(%) = fetch/(queue+pfQ+fetch+compute)
    // compute 二级拆分的扫描指标(2026-08-24): 用于扫出"带宽/并发提升把等待从存储搬到算力"的曲线。
    // compute_net  : 纯计算(ms) —— 与并发/带宽都无关的基线, 扫描曲线应近似水平(可作正确性哨兵)
    // compute_wait : 算力竞争等待(ms) —— 随并发单调上升
    // compute_wait_ratio: 竞争等待占 compute 的比例(%) —— >50% ⇒ 该做并发准入控制而非加算力
    compute_net: b ? (b.computeNet || 0) : 0,
    compute_wait: b ? (b.computeWait || 0) : 0,
    compute_wait_ratio: (b && b.compute > 0) ? 100 * (b.computeWait || 0) / b.compute : 0,
    // ---- TTFT 六分量(2026-08-26): 供「TTFT 构成」堆叠柱使用, 同时各自可作独立折线指标 ----
    // ★ 已用 _dbg_ttft_identity.js 在 12 个场景(wc/be/race × 命中0/60/90/100% × PD分离/
    //   多实例/长输入/低slots)逐一验证: 六项之和 == r.avgTtft, 最大相对残差 7.28e-12(浮点噪声)。
    //   ⇒ 堆叠柱的**柱高就是 TTFT**, 不是近似。
    // 为什么用 computeNet/computeWait 而不是合并的 compute:
    //   compute 是**兜底残差**(prefill 墙钟 − 拉取等待), 把"真缺算力"与"算力被别人占用"
    //   混在一起。拆开后堆叠柱能直接回答"该加卡还是该收紧准入"(见 NOTES_engine.md)。
    // 为什么不用 fetchReal: fetchReal 是"拉取过程真实时长", race/best_effort 下与计算重叠,
    //   计入堆叠会导致 Σ > TTFT(重复计时)。堆叠柱必须用**互不重叠**的墙钟分段 ⇒ 用 fetch。
    ttft_queue: b ? (b.queue || 0) : 0,
    ttft_prefillq: b ? (b.prefillQ || 0) : 0,
    ttft_fetch: b ? (b.fetch || 0) : 0,
    ttft_xfer: b ? (b.xfer || 0) : 0 };
}
