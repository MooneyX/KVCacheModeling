export function readParams(readControl) {
  function gv(id) { const el = readControl(id); return el ? parseFloat(el.value) || 0 : 0; }
  function gi(id) { const el = readControl(id); return el ? parseInt(el.value) || 0 : 0; }
  return {
    attn: readControl('pAttnType').value,
    layers: gi('pLayers'), kvHeads: gi('pKvHeads'), headDim: gi('pHeadDim'),
    kvLora: gi('pKvLora'), ropeDim: gi('pRopeDim'),
    hidden: gi('pHidden'), dtypeBytes: gv('pDtype'), weightDtype: gv('pWeightDtype'), vocab: gi('pVocab'),
    // Q head 数(2026-08-19): 用于推导 prefill 位置斜率 b 的 attention 计算量。
    // 0 = 自动(GQA 按 hidden/headDim 等价推导; MLA 会低估, 建议显式填 —— DS-V3 = 128)
    qHeads: gi('pQHeads'),
    // MLA prefill 路径与维度(2026-08-20): prefill 走解压式 MHA 时 QK 维 = qkNope+ropeDim, PV 维 = vHeadDim。
    // 0 = 回退用 headDim(DS-V3 两者恰好都是 128)。mlaPrefillPath: 'mha'(默认) | 'absorb'
    qkNope: gi('pQkNope'), vHeadDim: gi('pVHeadDim'),
    mlaPrefillPath: (function(){ var el = readControl('pMlaPrefillPath');
      return (el && el.value) ? el.value : 'mha'; })(),
    // 稀疏注意力(2026-08-20): DS-V3.2 Indexer / V4 NSA —— 每 query 只对 top-k 个 KV 做 attention,
    // 位置成本在 pos>topk 后不再增长; 但 Indexer 仍需扫全历史打分(bIdx 项, 见 prefillTau)
    sparseAttn: !!(readControl('pSparseAttn') && readControl('pSparseAttn').checked),
    sparseTopk: gi('pSparseTopk') || 2048,
    idxHeads: gi('pIdxHeads') || 64, idxHeadDim: gi('pIdxHeadDim') || 128,
    // 到达即拉(2026-09-02 硬编码): sglang 在 _add_request_to_queue() 就调 _prefetch_kvcache(req),
    // 预取跑在 cache_controller 独立线程, 与调度循环完全并发 —— 「准入才开始拉取」在 sglang 里
    // 不存在, 故原 pWcArrivalFetch 开关(其 OFF 档为历史 A/B 口径)已删除, 此处恒 true。
    // 保留字段名: 引擎内多处判据读它, 且旧导出 JSON 里可能带该键(读到也被忽略)。
    wcArrivalFetch: true,
    // timeout 策略参数(2026-09-02): 对齐 sglang 的 prefetch_timeout_base(默认 1.0s) 与
    // prefetch_timeout_per_ki_token(默认 0.25s/页) —— 见 hybrid_cache_controller.py:260-263。
    // 超时判据: now - 预取起点 > base + ceil(命中前缀 token / blockSize) × perPage。
    pfTimeoutBase: (function(){ var el = readControl('pPfTimeoutBase');
      var v = el ? parseFloat(el.value) : NaN; return isFinite(v) && v >= 0 ? v : 1.0; })(),
    pfTimeoutPerPage: (function(){ var el = readControl('pPfTimeoutPerPage');
      var v = el ? parseFloat(el.value) : NaN; return isFinite(v) && v >= 0 ? v : 0.25; })(),
    prefillBIdx: (function(){ var el=readControl('pPrefillBIdx');
      if(!el) return 0; var v=parseFloat(el.value); return isFinite(v)&&v>=0 ? v : 0; })(),
    paramsB: gv('pParamsB'), actB: gv('pActB'),
    // EP(专家并行)部署旋钮(2026-08-31): epSize=1/moeLayers=0/denseB=0 为默认 ⇒ 与历史口径逐位一致。
    // 无头 harness 的 DOM stub 恒 value='0' ⇒ gi||1 / gv||1 兜底后恰好是默认值(回归隔离)。
    epSize: gi('pEpSize') || 1,
    moeLayers: gi('pMoeLayers') || 0,
    denseB: gv('pDenseB') || 0,
    a2aFactor: gv('pA2aFactor') || 1,
    gpus: gi('pGpuCount'), hbmPerGpu: gv('pHbm'), hbmBW: gv('pHbmBW'),
    tflops: gv('pTflops'), tpSize: gi('pTpSize'), nvlinkBW: gv('pNvlinkBW'),
    pcieBW: gv('pPcieBW'), tierQuant: gv('pTierQuant'),
    dram: gv('pDram'), dramBW: gv('pDramBW'), ssd: gv('pSsd'), ssdBW: gv('pSsdBW'),
    concurrency: gi('pConcurrency'), inputLen: gi('pInputLen'),
    outputLen: gi('pOutputLen'), qps: gv('pQps'),
    // MFU 语义(2026-08-19 Roofline 改造): 填值 = 用户断言"计算瓶颈", prefill 直接用
    // 峰值算力×MFU 算计算时间并作为最终时间(访存全被 overlap); 留空/0 = mfuAuto,
    // 由引擎逐项 Roofline 自动判定计算 vs 访存瓶颈并取 max(见 estimatePrefillParams)。
    // mfu 数值本身在 auto 模式下回退 1.0(峰值算力), 供 decode 算力项与 boost 上限使用。
    mfuAuto: (function(){ var el = readControl('pMfu'); if (!el) return false;
      var raw = (el.value === undefined || el.value === null) ? '' : String(el.value).trim();
      if (raw === '') return true; var v = parseFloat(raw); return !isFinite(v) || v <= 0; })(),
    mfu: (function(){ var v = gv('pMfu')/100; return v > 0 ? v : 1.0; })(),
    maxBatch: gi('pMaxBatch'), blockSize: gv('pBlockSize'),
    simMaxTime: gi('pSimMaxTime') || 1200,  // 仿真窗口上限(秒)：窗口 = min(排水估计, 此值)
    prefixHit: gi('pPrefixHit')/100,
    prefixWarm: !!(readControl('pPrefixWarm') && readControl('pPrefixWarm').checked),
    // L2 预热命中率(2026-08-28 双层预热): 嵌套语义 ≤ prefixHit。0(默认)=全部命中段在 L3(原行为)
    prefixWarmL2: gi('pPrefixWarmL2')/100,
    // Decode 从 L3 重读(2026-09-02 删除开关): 运行中请求的 KV 被 sglang 用 inc_lock_ref /
    // protected_size 锁住, **物理上不可能**在 decode 期被逐出后重新从 L3 拉取。KV 池吃紧时
    // sglang 走 retract_decode(抢占请求 → 释放其 KV → 重新排队后**重算**), 不是重读 SSD。
    // 故此开关(其 ON 档为 C4 修复前的错误计费)已删除, 恒 false。
    decodeL3Read: false,
    // 前缀拉取开关(2026-08-18 v2, 语义反转): pFetchRepull 勾选(默认)=每请求独立从 L3 重复拉取
    // 完整前缀(模拟前缀在两请求间被逐出快层); 不勾=同组前缀只拉一次、后续请求共享(HiCache
    // 单飞/去重)。引擎内部仍用 fetchCoalesce(单飞)标志, 取反得到。元素缺失或 checked 非布尔
    // (旧导出 JSON/无头 harness 桩元素)时回退默认: 重复拉取(coalesce=false)
    fetchCoalesce: (function(){ var el = readControl('pFetchRepull'); if (!el || el.checked === undefined) return false; return !el.checked; })(),
    // 位置感知 prefill 参数：显式 0 合法（b=0 关闭位置项 / fetchFixedUs=0 纯带宽），
    // 仅未设置(NaN)时回退默认值（与仿真引擎的实测校准一致）
    prefillA: (function(){ var v=parseFloat(readControl('pPrefillA').value); return isFinite(v)&&v>0 ? v : 79.5; })(),   // μs/tok 固定项
    prefillB: (function(){ var v=parseFloat(readControl('pPrefillB').value); return isFinite(v) ? v : 5.33e-3; })(),     // μs/tok² 位置斜率(0=关闭)
    fetchFixedUs: (function(){ var v=parseFloat(readControl('pFetchFixedUs').value); return isFinite(v) ? v : 209; })(), // 每块固定拉取开销 μs(0=纯带宽)
    chunkSize: gi('pChunkSize') || 2048,              // chunked-prefill 波大小（推导 a 的权重读分摊项）
    // (prefillSlotsCap 已删 2026-09-03 第4批: "请求数口径的 prefill 并发上限"只服务流体路径,
    //  sglang 由 max_prefill_tokens 的 token 预算驱动, 请求数侧只有 max_running_requests
    //  (对应 max_batch_size)。)
    maxPrefillTok: Math.max(256, gi('pMaxPrefillTok') || 16384),  // prefill 波次 token 预算(sglang max_prefill_tokens)
    // (prefillWave 开关已删 2026-09-03 第4批: 波次组批成为唯一 prefill 路径 —— sglang 只有
    //  chunked-prefill 一种组批方式; 连续流体模型(开关 OFF 档)无对应机制, 已删除。)
    // 单批 prefill 微基准(2026-08-19): 全部请求 t=0 到达 + 跳过准入/槽位门控 + prefill 完成即结束
    // (不进 decode)——隔离观察 batchsize(=并发请求数) 对 prefill 计算/传输占比的影响
    singleBatch: !!(readControl('pSingleBatch') && readControl('pSingleBatch').checked),
    lenDist: readControl('pLenDist').value, multiTurn: gi('pMultiTurn')/100, seed: gi('pSeed'),
    arrivalDist: readControl('pArrivalDist') ? readControl('pArrivalDist').value : 'poisson',
    framework: 'sglang',   // 2026-08-12 起固定 sglang（移除推理引擎区分）
    // 前缀缓存(2026-09-02 硬编码 radix): 引擎已固定 sglang, RadixAttention 用 match_prefix
    // 做前缀树逐块渐进匹配 —— 部分前缀命中即可复用。原 'hash' 档(vLLM 式整段 block hash,
    // 全命中才激活复用组)已删除。⚠️ 原默认值是 'hash', 若此处仍读 DOM 会因元素已删而
    // 回落到 hash, 使 radix 渐进逻辑(见 finishKvXfer/placeRequest 的 p.prefixCache 判据)整体失效。
    prefixCache: 'radix',
    // PD 分离两档(2026-09-02): 0=关(混合批) / 2=真分离(双资源池)。原 1=近似(同卡免竞争)已删。
    // pdSep 保持布尔语义**向后兼容** —— 真分离取消混合批算力竞争(三处旧逻辑不用改判据);
    // pdMode 区分档位, 仅真分离(2)额外启用双资源视图 + P→D KV 传输。
    pdMode: gi('pPdSep') || 0,
    pdSep: (gi('pPdSep') || 0) >= 1,
    // 真分离专属: P 节点卡数(从 gpus 总数划出, 余下归 D)、互联带宽/利用率、KV 传输量口径
    pdPrefillGpus: Math.max(1, gi('pPdPrefillGpus') || 2),
    pdLinkBW: Math.max(1, gv('pPdLinkBW') || 400),
    pdLinkUtil: (function(){ var v = gv('pPdLinkUtil'); return v > 0 && v <= 1 ? v : 0.7; })(),
    pdKvComp: (function(){ var el = readControl('pPdKvComp'); return el ? gi('pPdKvComp') === 1 : true; })(),
    // 多实例(S2, 2026-08-20): 实例数, 从 GPU 总数切分(总量守恒)。1=单实例(默认, 口径不变)。
    // 与 PD 真分离**互斥**(见 runSimulation 的 pdReal 判据): 两者都切分 GPU, 叠加语义歧义大。
    instances: Math.max(1, gi('pInstances') || 1),
    // 路由策略(S3, 对齐 sgl-router): round_robin/power_of_two/hash_prefix/random
    // (least_queue/least_kv 已删 2026-09-03, 见 parseDSL 的 ROUTE 注释)
    routePolicy: (function(){ var el = readControl('pRoutePolicy'); return (el && el.value) ? el.value : 'round_robin'; })(),
    // 前缀缓存亲和(S4, 2026-08-20): 默认**关**。
    // 关: 前缀池全局一份 —— 所有实例共享前缀缓存(等价于有全局共享 KV 存储层),
    //     pPrefixHit 是**保证命中率**, 与历史全部结论口径一致。
    // 开: 前缀池按实例隔离 —— 命中要求"同前缀曾被路由到同一实例", 于是
    //     pPrefixHit 变成**理想上限**, 实际命中由路由策略决定(随机路由会塌陷)。
    //     这才能量化 router 的缓存亲和价值, 但会改变命中率语义 ⇒ 显式开关而非默认。
    prefixAffinity: !!(readControl('pPrefixAffinity') && readControl('pPrefixAffinity').checked),
    tieredKv: gi('pTieredKv') === 1
  };
}
