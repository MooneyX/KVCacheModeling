export function perReqMs(n, actParams, gpus) {
  let actScale = Math.max(1, actParams / 32e9);
  let fixed = 5.2 * actScale * (gpus > 1 ? 1 : 0);                     // 多卡 TP 固定通信/调度项
  let attn = 6.4 * actScale * Math.pow(Math.max(gpus, 1), -0.33) * Math.pow(n, 0.75); // attention 随 batch 幂律、随卡数分摊
  return fixed + attn;
}

export function calcKvPerToken(p){
  if (p.attn === 'mla') return p.layers * (p.kvLora + p.ropeDim) * p.dtypeBytes;
  return 2 * p.layers * p.kvHeads * p.headDim * p.dtypeBytes;
}

export function prefillTau(p, pos) {
  let a = p.prefillA > 0 ? p.prefillA : 79.5;
  let b = p.prefillB >= 0 ? p.prefillB : 5.33e-3;
  let pp = Math.max(pos, 0);
  if (p.sparseAttn && p.sparseTopk > 0) {
    return (a + b * Math.min(pp, p.sparseTopk) + (p.prefillBIdx || 0) * pp) * 1e-6;
  }
  return (a + b * pp) * 1e-6;
}

export function prefillIntegral(p, L) {
  let a = p.prefillA > 0 ? p.prefillA : 79.5;
  let b = p.prefillB >= 0 ? p.prefillB : 5.33e-3;
  let n = Math.max(L, 0);
  if (p.sparseAttn && p.sparseTopk > 0) {
    let k = p.sparseTopk;
    let attnPos = n <= k ? 0.5 * n * n : 0.5 * k * k + k * (n - k);
    return (a * n + b * attnPos + (p.prefillBIdx || 0) * 0.5 * n * n) * 1e-6;
  }
  return (a * n + 0.5 * b * n * n) * 1e-6;
}

export function estimatePrefillParams(p){
  let aggHbmBW = Math.max(p.hbmBW * 1e12 * p.gpus, 1);       // B/s 聚合 HBM 带宽
  let kvPerTok = calcKvPerToken(p);                          // B/tok
  // 激活参数量：覆盖值优先，否则按 dense 公式自动推导（与 calcAll 同口径）
  let totalP = p.paramsB > 0 ? p.paramsB * 1e9 : calcDenseParams(p);
  let act = Math.max(p.actB > 0 ? p.actB * 1e9 : totalP, 1e6);
  let peakFlops = Math.max(p.tflops * 1e12 * p.gpus, 1);     // B/s 峰值算力（不含 MFU）
  let effFlops = Math.max(peakFlops * p.mfu, 1);             // 有效算力（MFU 模式用）
  let chunk = Math.max(p.chunkSize || 2048, 16);             // chunked-prefill 波大小 = C

  // ---- attention 每 token 每位置的计算量 ----
  // GQA: 每层 QK^T(2×hidden) + PV(2×hidden)，q 侧总维度 = qHeads×headDim ≈ hidden
  //   → 4 × layers × hidden
  // MLA(2026-08-20 修正): prefill 与 decode 走**不同 kernel 路径**，计算量差 3.4×——
  //   · prefill = 解压式 MHA(sglang `MHA_CHUNKED_KV`/`MHA_ONE_SHOT`, vLLM `forward_mha`):
  //     kv_b_proj 先把压缩 latent 解压成全秩 K/V，再做标准 MHA。
  //     QK 维度 = qk_nope + qk_rope = 128+64 = 192；PV 维度 = v_head_dim = 128。
  //     → 2 × layers × nHeads × [(nope+rope) + vHead] = 2×61×128×320
  //   · decode = 吸收式 MQA(sglang `MLA`, vLLM `forward_mqa`): W_UK 吸收进 Q 侧，
  //     KV cache 保持压缩不解压，每 head 直接与 c_kv(kvLora) + k_rope(ropeDim) 内积。
  //     → 2 × layers × nHeads × [(kvLora+ropeDim) + kvLora] = 2×61×128×1088
  //   本函数只推导 **prefill** 的 a/b，故用解压式。旧实现误用吸收式口径，
  //   使 DS-V3 的 b 高估 1088/320 = 3.40×（decode 侧不受影响，见 calcAll 的 passTime）。
  //   依据: sglang `_handle_attention_backend`(deepseek_common/attention_backend_handler.py L93-108)
  //   ——extend 且 (前缀命中量 ≥ chunked_prefix_cache_threshold 或 无前缀) 时走 MHA 分支，
  //   即常规 prefill(含纯新请求与长前缀命中)主路径都是解压式 MHA；仅短前缀/投机/CP 落回吸收式。
  //   nope 维度取值: 优先 pQkNope 输入；留空时按 headDim 回退(DS-V3 两者恰好都是 128)。
  let attnFlop;
  if (p.attn === 'mla') {
    let nHeads = p.qHeads > 0 ? p.qHeads : Math.round(p.hidden / Math.max(p.headDim || 128, 1));
    if (p.mlaPrefillPath === 'absorb') {
      // 吸收式(可选): 短前缀/投机解码/CP 场景, 或用户显式指定
      attnFlop = 2 * p.layers * nHeads * ((p.kvLora + p.ropeDim) + p.kvLora);
    } else {
      // 解压式 MHA(默认, sglang prefill 主路径)
      let nope = p.qkNope > 0 ? p.qkNope : (p.headDim || 128);
      let vHead = p.vHeadDim > 0 ? p.vHeadDim : (p.headDim || 128);
      attnFlop = 2 * p.layers * nHeads * ((nope + p.ropeDim) + vHead);
    }
  } else {
    attnFlop = 4 * p.layers * p.hidden;
  }

  // ---- 分项计算量 / 访存量 ----
  let gemmFlop  = 2 * act;                                   // FLOP/tok  非 attention GEMM
  let gemmBytes = act * p.weightDtype / chunk;               // B/tok     权重读（chunk 分摊）
  let attnBytes = kvPerTok / chunk;                          // B/tok/pos     KV 读（chunk 内共享）
  let kvWBytes  = kvPerTok;                                  // B/tok     KV 写（纯访存，无计算）
  let tp = 2 * p.layers * 5 / chunk;                         // μs/tok    TP AllReduce 固定延迟（始终相加）
  // EP AllToAll 分摊(2026-08-31, 设计文档 §4.2/改动3): 与 tp 项同构叠加, 独立于 tpSize
  // (TP=1 时 AllReduce 归零但 A2A 仍在)。带宽项 = 2×L_moe×hidden×2B×factor B/tok ÷ NVLink;
  // 固定延迟项 = 2×L_moe×5μs/chunk(dispatch+combine 两次)。EP=1/非MoE ⇒ 0(零回归锚点)。
  let a2a = 0;
  {
    let epE = Math.max(1, Math.min(p.epSize || 1, p.gpus));
    let Lm = Math.max(0, Math.min(p.moeLayers || 0, p.layers));
    if (epE > 1 && Lm > 0) {
      let a2aF = p.a2aFactor > 0 ? p.a2aFactor : 1;
      a2a = 2 * Lm * p.hidden * 2 * a2aF / Math.max(p.nvlinkBW * 1e9, 1) * 1e6
          + 2 * Lm * 5 / chunk;
    }
  }

  // ---- 稀疏注意力的 Indexer 每 token 每位置成本(2026-08-20) ----
  // DS-V3.2 Indexer(NSA 风格选择器): 每层为每个 query 对**全部**历史 KV 打分, 再取 top-k。
  // attention 主体被 topk 截断(见 prefillTau), 但 Indexer 的扫描量仍随位置线性增长。
  // 逐项(对齐 B 的 mla_indexer, 每 token 每位置):
  //   · score  : 2 × layers × idxHeads × idxHeadDim   (q·k 内积, 每 head 每维 1 MAC)
  //   · combine: 2 × layers × idxHeads                (按 head 重要性加权求和)
  //   · topk   : 1 × layers                            (单遍扫描计一次比较)
  //   · 访存   : idxHeadDim × dtype / chunk            (Indexer 的单头 K cache, chunk 内共享)
  // 数量级对比(V3.2): Indexer 2×61×64×128 = 1.0e6 vs 完整 attention 2×61×128×320 = 5.0e6
  //   → Indexer 约为完整 attention 的 20%, 故 topk 截断在 L≫topk 时仍有 ~5× 收益。
  let idxFlop = 0, idxBytes = 0;
  if (p.sparseAttn) {
    let iH = Math.max(p.idxHeads || 64, 1), iD = Math.max(p.idxHeadDim || 128, 1);
    idxFlop  = p.layers * (2 * iH * iD + 2 * iH + 1);
    idxBytes = p.layers * iD * p.dtypeBytes / chunk;
  }

  let a, b, bIdx, aBound, bBound, bIdxBound;
  if (p.mfuAuto) {
    // ② 自动判瓶颈: 每项独立 max(计算时间, 访存时间)，计算侧用峰值算力
    let gCmp = gemmFlop / peakFlops * 1e6, gMem = gemmBytes / aggHbmBW * 1e6;
    let aCmp = attnFlop / peakFlops * 1e6, aMem = attnBytes / aggHbmBW * 1e6;
    let iCmp = idxFlop / peakFlops * 1e6, iMem = idxBytes / aggHbmBW * 1e6;
    let kvW = kvWBytes / aggHbmBW * 1e6;                     // KV 写无计算可 overlap → 计入
    a = Math.max(gCmp, gMem) + kvW + tp + a2a;
    b = Math.max(aCmp, aMem);
    bIdx = p.sparseAttn ? Math.max(iCmp, iMem) : 0;
    aBound = gCmp >= gMem ? '计算' : '访存';
    bBound = aCmp >= aMem ? '计算' : '访存';
    bIdxBound = iCmp >= iMem ? '计算' : '访存';
  } else {
    // ① MFU 模式: 只算计算时间，访存（权重读/KV读/KV写）全部视为被计算 overlap
    a = gemmFlop / effFlops * 1e6 + tp + a2a;
    b = attnFlop / effFlops * 1e6;
    bIdx = p.sparseAttn ? idxFlop / effFlops * 1e6 : 0;
    aBound = bBound = bIdxBound = '计算(MFU)';
  }
  let tauPf = 100 + 110;                                     // μs: NVMe IO(100) + RPC/软件(110)
  return {a, b, bIdx, tauPf, aBound, bBound, bIdxBound, mfuAuto: !!p.mfuAuto,
    sparseAttn: !!p.sparseAttn, sparseTopk: p.sparseTopk,
    // 诊断: 算术强度与 ridge point（供 UI 解释瓶颈判定）
    gemmIntensity: gemmFlop / Math.max(gemmBytes, 1e-9),
    attnIntensity: attnFlop / Math.max(attnBytes, 1e-9),
    idxIntensity: idxFlop / Math.max(idxBytes, 1e-9),
    // 分项原始量(供推导明细面板展开, 公式与计算同源)
    parts: {gemmFlop, gemmBytes, attnFlop, attnBytes, kvWBytes, idxFlop, idxBytes, tp, a2a, chunk,
      peakFlops, effFlops, aggHbmBW, act, kvPerTok},
    ridgePoint: peakFlops / aggHbmBW};
}

export function calcDenseParams(p){
  let vocab = p.vocab || 128000;
  let interm = Math.round(p.hidden * 3.5);
  let attn;
  if (p.attn === 'mla') attn = 2 * p.hidden * p.hidden + 2 * p.hidden * (p.kvLora + p.ropeDim);
  else attn = 2 * p.hidden * p.hidden + 2 * p.hidden * p.kvHeads * p.headDim;
  let mlp = 3 * p.hidden * interm;
  return p.layers * (attn + mlp) + 2 * vocab * p.hidden;
}

export function l2AttnTp(p){ return (p.epSize||1) > 1 ? 1 : Math.max(1, Math.min(p.tpSize||1, p.gpus||1)); }

export function effL2LinkBW(p){ let g = Math.max(1, p.gpus||1); return Math.min(p.pcieBW * (g / l2AttnTp(p)), p.dramBW); }

export function calcAll(p){
  let kvPerToken = calcKvPerToken(p);
  // 参数量：覆盖值优先（MoE 必须显式给出总参数与激活参数）
  let totalParams = p.paramsB > 0 ? p.paramsB * 1e9 : calcDenseParams(p);
  let activatedParams = p.actB > 0 ? p.actB * 1e9 : totalParams;
  // ---- 权重显存: TP/EP 通式(2026-08-31, 设计文档 §4.1 + §3.1 bug 修复) ----
  // 每卡权重 = dense 部分/TP(TP 组内分片, 组间复制 G/T 组) + 专家部分/E(EP 域分片)。
  //   clusterW = (G/T)×denseB×wd + (G/max(T,E))×expertB×wd
  // ⚠️ 专家分母是 max(T,E) 而非文档化简稿里的 E: EP≤TP 时专家随 TP 组分片(EP 未激活),
  //    此时 (G/T)×(dense+expert) = G/T × 全模型 —— EP=1 且 TP=G(历史默认)逐位等于旧公式
  //    "整模型只扣一次"; TP=1(纯 DP)时 G/T=G ⇒ 每卡全量权重, 修掉"权重只扣一次"的容量 bug。
  // 非 MoE(moeLayers=0 或 denseB 未填) ⇒ expertParams=0, 退化为 (G/T)×全模型。
  let G = Math.max(1, p.gpus);
  let T = Math.max(1, Math.min(p.tpSize || 1, G));
  let E = Math.max(1, Math.min(p.epSize || 1, G));
  let moeL = Math.max(0, Math.min(p.moeLayers || 0, p.layers));
  let denseParams = totalParams, expertParams = 0;
  if (moeL > 0 && p.denseB > 0 && p.denseB * 1e9 < totalParams) {
    denseParams = p.denseB * 1e9;
    expertParams = totalParams - denseParams;
  }
  let modelWeightBytes, wd = p.weightDtype;
  if (expertParams > 0 && E > T) {
    modelWeightBytes = (G / T) * denseParams * wd + (G / E) * expertParams * wd;
  } else {
    // EP 未超出 TP(含默认 EP=1): 专家随 TP 组分片 ⇒ 等价整模型按 G/T 扣——
    // 单表达式保证 TP=G 时与旧"totalParams×wd"逐位一致(避免 (a+b)c vs ac+bc 的 ulp 漂移)
    modelWeightBytes = (G / T) * totalParams * wd;
  }
  let modelWeightGB = modelWeightBytes / 1e9;

  let totalHbm = p.gpus * p.hbmPerGpu * 1e9;
  // 每卡固定开销（CUDA上下文/激活工作区/通信缓冲，实测 H20 ≈6GB/卡）+ 权重读写预留 2%。
  // 旧实现 totalHbm×10% 在 671B FP8(671GB) 场景给 availHbm 仅 20GB，过于保守导致仿真失真。
  let overhead = p.gpus * 6e9 + modelWeightBytes * 0.02;
  let availHbm = Math.max(0, totalHbm - modelWeightBytes - overhead);

  // PagedAttention 块碎片：每请求平均浪费 blockSize/2 token
  let blockBytes = p.blockSize * kvPerToken;
  let blocksPerReq = Math.ceil(p.inputLen / p.blockSize);
  let perRequestKv = blocksPerReq * blockBytes;             // 含碎片
  let fragPct = perRequestKv > 0 ? (perRequestKv - p.inputLen * kvPerToken) / perRequestKv * 100 : 0;
  // 生命周期平均占用：输入全部 + 输出一半（输出随 decode 线性增长）
  let avgLifetimeKv = perRequestKv + Math.ceil(p.outputLen / 2 / p.blockSize) * blockBytes;

  // 前缀共享抵扣（期望值模型，与引擎的前缀组分配一致）：
  // 命中率定义 = 可复用前缀token / 总输入token → 每请求期望复用 prefixHit × inputLen
  // （AVG_PREFIX_RATIO 仅描述前缀组结构，不参与缩放）
  let prefixSavedPerReq = p.prefixHit * p.inputLen * kvPerToken;
  let effPerReqKv = Math.max(perRequestKv - prefixSavedPerReq, perRequestKv * 0.25);
  let effLifetimeKv = Math.max(avgLifetimeKv - prefixSavedPerReq, avgLifetimeKv * 0.25);

  let maxHbmRequests = availHbm > 0 ? Math.floor(availHbm / effPerReqKv) : 0;

  // 算力（TFLOPS × MFU）与带宽分离 —— Roofline 基础
  let computeFlops = p.tflops * 1e12 * p.gpus * p.mfu;
  let aggHbmBW = p.hbmBW * 1e12 * p.gpus;
  // P0-2: Prefill 位置感知 —— per-token 成本 τ(i)（稠密 a+b·i；稀疏 a+b·min(i,topk)+bIdx·i）。
  // 第 i 个 token 的 attention 需读 i 个 KV → 成本随位置增长。位置积分见 prefillIntegral()。
  // prefillTps 定义为位置 0 的基准速率（与旧模型兼容），TTFT 用位置积分（下方 ttftEst）。
  let prefillTps = computeFlops / (2 * activatedParams);
  // 位置积分统一走 prefillIntegral（顶层唯一权威, 稠密/稀疏分支都在那里）
  let prefillTimeL = prefillIntegral(p, p.inputLen); // 秒

  // TP AllReduce 通信开销（Megatron式：每层2次AllReduce；ring有效数据 2×(TP-1)/TP × 消息）
  // 带宽项随token数线性增长；小消息延迟项每次前向固定 2×layers×5μs
  // EP AllToAll(2026-08-31, 设计文档 §4.2): 每个 MoE 层 dispatch+combine 两次, 与 AllReduce
  // **相互独立**(TP=1 时 AR 归零但 A2A 仍在); EP=1 时 A2A=0 ⇒ 与旧口径逐位一致(零回归锚点)。
  // 理想专家均衡假设(§6 决策2), a2aFactor 兼作实现差异/倾斜 derating 旋钮。
  const AR_LAT = 5e-6;
  let tpSize = Math.max(1, Math.min(p.tpSize || 1, p.gpus));
  let epSizeC = Math.max(1, Math.min(p.epSize || 1, p.gpus));
  let moeLC = Math.max(0, Math.min(p.moeLayers || 0, p.layers));
  function commTime(tokens){
    let t = 0;
    if (tpSize > 1) {
      let ringFactor = 2 * (tpSize - 1) / tpSize;
      let bytes = 2 * p.layers * tokens * p.hidden * 2 * ringFactor; // 2B激活(bf16)
      t += bytes / (p.nvlinkBW * 1e9) + 2 * p.layers * AR_LAT;
    }
    if (epSizeC > 1 && moeLC > 0) {
      let a2aF = p.a2aFactor > 0 ? p.a2aFactor : 1;
      let bytes = 2 * moeLC * tokens * p.hidden * 2 * a2aF;          // dispatch+combine, 2B激活
      t += bytes / (p.nvlinkBW * 1e9) + 2 * moeLC * AR_LAT;
    }
    return t;
  }

  // Decode：带宽瓶颈，每次前向 = 读权重 + 读批次全部KV + 每请求开销 + TP通信；与算力下限取 max
  // 每请求开销(attention/采样/调度)见顶层 perReqMs()（Qwen3-32B 单卡 6.4×n^0.75；DS-V3 8卡 5.2+3.7×n^0.75）
  // 22.5ms@1 → 46.6ms@8：6.5ms×n^0.75×actParams缩放），保证"快速结果"与仿真 TPOT 一致
  // MoE decode 权重读取：每 token 只读激活参数对应权重（dense 全读 + 激活专家）——
  // 按总权重带宽会高估 MoE 访存（DS-V3 671B 只激活 37B → 高估 ~18×，实测 TPOT 10ms vs 仿真 34ms）
  // Decode 时间合成口径(2026-08-19 确认): 始终 Roofline 取 max(访存, 算力) + 通信 —— 不求和。
  // decode 的算术强度只有 ~2·batchN FLOP/byte(每 token 读全部激活权重却只做 2·act FLOP),
  // 远低于 ridge point(H20 = 37) → 结构性访存瓶颈, max 自然落在访存项上。
  // 注: MFU 输入框的"只算计算时间"语义**只作用于 prefill**(计算瓶颈阶段)。decode 若也忽略访存,
  // TPOT 会从 ~50ms 塌到 ~2ms(25×失真), 且 perReqMs 等实测校准全部失效 —— 故此处不套用。
  let decodeWeightRatio = (p.actB > 0 && p.paramsB > 0) ? Math.max(p.actB / p.paramsB, 0.02) : 1;
  let batchN = Math.max(1, Math.min(p.maxBatch, p.concurrency));
  // 访存项含每请求实测开销 perReqMs(attention kernel/采样/调度), 它是无法被 overlap 的串行开销
  let passMemTime = (modelWeightBytes * decodeWeightRatio + batchN * avgLifetimeKv) / aggHbmBW
    + perReqMs(batchN, activatedParams, p.gpus) / 1000;
  let passCmpTime = 2 * activatedParams * batchN / computeFlops;
  let commOverhead = commTime(batchN);
  let passTime = Math.max(passMemTime, passCmpTime) + commOverhead;
  let decodeBound = passCmpTime >= passMemTime ? '算力' : '访存';
  let decodeTpsPerReq = 1 / passTime;                 // 每请求 tok/s（同批次各请求一致）
  let decodeTpsTotal = batchN / passTime;

  let kvGenSpeed = prefillTps * kvPerToken;           // prefill 期 KV 写入带宽需求
  let dramTotal = p.dram * 1e9;
  let ssdTotal = p.ssd * 1e12;
  let totalKvDemand = p.concurrency * effLifetimeKv;

  // Little 定律稳态并发估计：L = prefill + output × passTime（位置感知 prefill）
  let estLatency = prefillTimeL + p.outputLen * passTime;
  let littleConcurrency = p.qps * estLatency;
  // TTFT / TPOT 估计（单请求、无排队；TTFT 用位置积分 prefillTimeL）
  let ttftEst = prefillTimeL + commTime(p.inputLen);
  let tpotEst = passTime;

  return {kvPerToken, blockBytes, blocksPerReq, perRequestKv, avgLifetimeKv, fragPct,
    prefixSavedPerReq, effPerReqKv, effLifetimeKv,
    totalHbm, availHbm, modelWeightBytes, modelWeightGB, overhead, decodeWeightRatio,
    maxHbmRequests, computeFlops, aggHbmBW, prefillTps, passTime, passMemTime, passCmpTime, decodeBound,
    commOverhead, commTime, tpSize, decodeTpsPerReq, decodeTpsTotal,
    epSize: epSizeC, moeLayers: moeLC, denseParams, expertParams,
    kvGenSpeed, dramTotal, ssdTotal, totalKvDemand, totalParams, activatedParams,
    estLatency, littleConcurrency, ttftEst, tpotEst};
}
