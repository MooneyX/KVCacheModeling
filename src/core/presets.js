export let models = {
  'Llama-3-70B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-72B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:151936, paramsB:0, actB:0},
  'Llama-3-8B':    {attn:'gqa', layers:32, kvHeads:8, headDim:128, hidden:4096, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-7B':    {attn:'gqa', layers:28, kvHeads:4, headDim:128, hidden:3584, vocab:151936, paramsB:0, actB:0},
  'Qwen3-32B':     {attn:'gqa', layers:64, kvHeads:8, headDim:128, hidden:5120, vocab:151936, paramsB:32, actB:32},
  'Qwen3-30B-A3B': {attn:'gqa', layers:48, kvHeads:4, headDim:128, hidden:2048, vocab:151936, paramsB:30.5, actB:3.3,
    // EP 字段(2026-08-31): 48 层全 MoE ⇒ moeLayers=48; denseB = embed 0.62 + 48×GQA attn 0.019 ≈ 1.5B
    moeLayers:48, denseB:1.5},
  // qHeads: attention query head 数（Roofline 推导 prefill 位置斜率 b 用）。
  // GQA 省略即可（hidden/headDim 自动推导等价）；MLA 必须显式——DS-V3 有 128 head 而
  // hidden/headDim=56，自动推导低估 attention 计算量 2.3×。V2-Lite 恰好 16=2048/128，可省。
  // qkNope/vHeadDim(2026-08-20): MLA 解压式 prefill 的 QK non-RoPE 维与 V 头维（DS 系列均 128）。
  'DeepSeek-V2-Lite': {attn:'mla', layers:27, kvLora:512, ropeDim:64, hidden:2048, vocab:128256, paramsB:15.7, actB:2.4, qHeads:16, qkNope:128, vHeadDim:128},
  // 腾讯混元 Hy3 (2026-07-06 GA, Apache 2.0): MoE 192专家/top-8, 80层主网络(+1层MTP),
  // GQA 64头/8KV头/headDim128, hidden 4096, interm 13312, vocab 120832, 256K 上下文, BF16/FP8
  // KV/tok(BF16) = 2×80×8×128×2 = 320KB → 256K 上下文单请求 KV 达 85.9GB(长上下文 KV 压力大)
  'Hunyuan-Hy3':    {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:4096, vocab:120832, paramsB:295, actB:21,
    // EP 字段为**估算值**(官方 config 未逐项核对, 2026-08-31): 80 层按全 MoE 处理,
    // denseB=embed 1.0 + 80×GQA attn ~0.05 ≈ 5B。⚠️ 填错只影响 EP 容量项, 不进 a/b 主链
    moeLayers:80, denseB:5},
  // 混元翻译旗舰 Hy-MT2-30B-A3B: MoE 30B/3B 激活（架构细节未完整公开，层数/hidden 按同级 MoE 估计）
  'Hunyuan-MT2-30B-A3B': {attn:'gqa', layers:48, kvHeads:4, headDim:128, hidden:2048, vocab:120832, paramsB:30, actB:3,
    moeLayers:48, denseB:1.5},  // EP 字段按同级 Qwen3-30B-A3B 估算(2026-08-31), 待官方 config 核对
  // Hunyuan Hy4-preview (2026-08-28 发布并开源, Apache 2.0): 770B-A49B MoE + Gated MLA
  // + Gated DSA 稀疏注意力 + IndexCache, 1M 上下文。官方 config.json 逐字段
  // (HF tencent/Hy4-preview, model_type=hy_v4):
  //   num_hidden_layers=78(mlp_layer_types: 1 dense + 77 sparse) / hidden 6144 / heads 64 /
  //   kv_lora_rank 512 / q_lora_rank 2048 / qk_nope 192 / qk_rope 64 / v_head_dim 256 /
  //   vocab 120832 / 256 路由专家 top-8 + 1 共享 / moe_intermediate 2048 / dense interm 18432 /
  //   index_n_heads 32 / index_head_dim 128 / index_topk 2048 / MTP 1 层(nextn)。
  // ★ 注意力维度与 GLM-5.1 完全相同(64头/qkNope192/vHead256/indexer 32×128×2048), 层数同 78
  //   ⇒ **KV/token 与 GLM-5.1 一字不差**: BF16 87.8KB / FP8 43.9KB(比 DS-V3/K2 高 27.9%);
  //   prefill b 同样偏贵(解压维度 512 vs DS 的 320)。
  // ⚠️ 与本引擎口径的三个差异(已知简化, 不建模):
  //   ① IndexCache 跨层索引复用(indexer_types 约 1/4 full + 3/4 shared) ⇒ 引擎 bIdx 按每层
  //      全量 Indexer 计, 是**上限**估计(实际 prefill 略快);
  //   ② MTP 层(HF 文件 780B 口径含 10B MTP)不进 paramsB —— 官方 backbone 口径 770B, 投机不建模;
  //   ③ Gated MLA / iHC 4 残差流对 KV 量与主计算量影响可忽略。
  // denseB 核算(EP 用): embed+lm_head(不共享) 2×120832×6144≈1.5B + 1 个 dense 层
  //   (attn 0.17 + MLP 0.34)≈0.5B + 77 MoE 层×(attn 0.17+shared 0.038+indexer ~0.02)≈17.6B
  //   ⇒ ≈20B(校验: 20 + 77×256 专家×37.75M = 764B ≈ 官方 770 ✓)。
  // calibA/calibB 不设: 无实测校准值, 由 Roofline 自动推导。
  'Hunyuan-Hy4': {attn:'mla', layers:78, kvLora:512, ropeDim:64, hidden:6144, vocab:120832,
    paramsB:770, actB:49, qHeads:64, qkNope:192, vHeadDim:256,
    sparse:true, sparseTopk:2048, idxHeads:32, idxHeadDim:128,
    moeLayers:77, denseB:20},
  'DeepSeek-V3':   {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:128256, paramsB:671, actB:37, qHeads:128,
    qkNope:128, vHeadDim:128,
    // EP 字段(2026-08-31, 官方 config 核算): 61 层 = 3 dense + **58 MoE**(first_k_dense_replace=3)。
    // denseB 核算: embed 1.84 + 3×dense层(attn 0.19+mlp 0.40)1.75 + 58×(MLA attn 0.19 + shared expert 0.044) ≈ 17.2B
    // ⚠️ 设计文档示例曾按 ~37B(=actB) 示意, 那是把"激活参数"当 dense —— actB 含 8 个激活专家
    //    (58层×8×44M ≈ 20.4B), 真实 dense ≈ 17B。以 config 逐项核算值为准。
    moeLayers:58, denseB:17,
    // 实测校准(2026-08-10, 8×H20 分散到达口径): 单请求 2048 tok prefill=444ms → a≈216μs/tok
    // (8/6 同时发送口径曾拟合 79.5, 分散到达实测修正; b=kvPerTok/aggHbmBW=1.1e-3 物理确定)
    // ⚠️ 2026-08-20: b 的口径已从吸收式改为解压式 MHA(降 3.4×), calibB 是更早期口径拟合值, 建议重新校准
    calibA: 216, calibB: 0.0011},
  // DeepSeek-V3.2-Exp (2026-09 发布): 架构与 V3 相同(MLA/61层/671B-37B), 新增 DSA
  // (DeepSeek Sparse Attention) —— lightning indexer 对全部历史 KV 打分后取 top-k,
  // 每 query 只对 top-k 个 KV 做 attention。配置来自官方: index_n_heads=64,
  // index_head_dim=128, index_topk=2048。
  // ⚠️ 稀疏不是"消掉二次项": indexer 仍扫全历史 ⇒ b_idx 项积分后依然是二次, 只是系数
  //    小得多(约完整 attention 的 20%)。收益随长度显现: 2K 约 1.0×, 32K 约 1.55×, 512K 约 4×。
  // calibA/calibB 不继承 V3 的实测值 —— 那是稠密口径拟合的, 稀疏下由 Roofline 自动推导。
  'DeepSeek-V3.2-Exp': {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:128256,
    paramsB:671, actB:37, qHeads:128, qkNope:128, vHeadDim:128,
    sparse:true, sparseTopk:2048, idxHeads:64, idxHeadDim:128,
    moeLayers:58, denseB:17},  // EP 字段同 V3(2026-08-31): 架构相同, Indexer 仅 +~0.3B 已含在 17 的舍入内
  // ===== 1T 级开源模型(2026-08-21 新增, 用于对齐《Agentic AI 推理流量模型分析》的"1T 模型"口径) =====
  // Kimi K2 (Moonshot AI, 2025-07, Modified MIT): 真正的 1T MoE + MLA。
  // 官方 config.json 逐字段: 61 层(1 dense + 60 MoE) / hidden 7168 / kv_lora_rank 512 /
  //   qk_rope_head_dim 64 / qk_nope_head_dim 128 / v_head_dim 128 / num_attention_heads 64 /
  //   vocab 163840 / 384 experts top-8 + 1 shared / moe_intermediate 2048 / FP8(e4m3) 原生。
  // ⚠️ 与 DS-V3 的两个关键差异:
  //   ① qHeads = 64(DS-V3 是 128) ⇒ prefill attention 计算量(位置斜率 b)只有 DS-V3 的一半
  //   ② KV 结构完全相同(61层 × (512+64)) ⇒ **KV/token 与 DS-V3 一字不差**: BF16 68.6KB / FP8 34.3KB
  //   ⇒ 对存储网/L3 带宽建模而言 K2 与 DS-V3 等价, 但 prefill 更快 ⇒ 存储网占比更高
  // 参数量核算(按 config 手算, 与官方宣称对表): 激活 32.7B(官方 32B) / 总 1026B(官方 1T) ✓
  'Kimi-K2': {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:163840,
    paramsB:1000, actB:32, qHeads:64, qkNope:128, vHeadDim:128,
    // EP 字段(2026-08-31, 官方 config 核算): 61 层 = 1 dense + **60 MoE**。
    // denseB: embed 2.35 + 1×dense层 0.5 + 60×(attn 0.10 + shared 0.044) ≈ 11.6B
    moeLayers:60, denseB:12},
  // Kimi K2 Thinking (2025-11, Modified MIT): 架构与 K2 完全相同, 差异在 256K 上下文
  // + 原生 INT4 量化(QAT) + 思维链。Agentic 长上下文场景更贴近报告设定。
  // 权重 INT4 ⇒ 权重精度选 FP8 会高估显存 2×, 但引擎权重精度下拉最细到 FP8, 故 paramsB 保持
  // 1000 由用户按需调权重精度; KV 仍是 BF16/FP8(INT4 只量化权重不量化 KV)。
  'Kimi-K2-Thinking': {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:163840,
    paramsB:1000, actB:32, qHeads:64, qkNope:128, vHeadDim:128,
    moeLayers:60, denseB:12},  // EP 字段同 K2(2026-08-31)
  // Ling-1T (蚂蚁 inclusionAI, 2025-10, MIT): 1T MoE 但用 **GQA** —— 与 K2 形成关键对照。
  // 官方 config: 80 层 / hidden 8192 / num_key_value_heads 8 / head_dim 128 / 64 q 头 /
  //   vocab 157184 / 256 experts top-8 + 1 shared / BF16。
  // ⚠️ **KV/token BF16 = 320KB, 是 Kimi K2(68.6KB) 的 4.7 倍** —— 同样 1T 参数,
  //    GQA vs MLA 让存储网压力差近 5 倍。这是"1T 模型"这个说法本身不足以确定 KV 流量的铁证:
  //    做存储网/L3 建模必须看 attention 类型, 不能只看参数量。
  // 参数量核算: 激活 50.9B(官方 ~50B) / 总 1000B(官方 1T) ✓
  'Ling-1T': {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:157184,
    paramsB:1000, actB:51,
    // EP 字段为**估算值**(2026-08-31, 待官方 config 核对): 按 1 dense + 79 MoE;
    // denseB = embed 2.6 + dense层 ~0.7 + 79×(GQA attn 0.067) ≈ 8.6B
    moeLayers:79, denseB:9},
  // GLM-5.1 (智谱 AI, 2026-04, MIT): 744B-A40B MoE + MLA + DSA 稀疏注意力。
  // 官方 config.json 逐字段(三源交叉验证: HF raw / transformers 文档 / ModelScope 量化版):
  //   model_type=glm_moe_dsa / num_hidden_layers=78(前 3 层 dense + 75 层 MoE) / hidden_size=6144 /
  //   num_attention_heads=64 / kv_lora_rank=512 / qk_rope_head_dim=64 / qk_nope_head_dim=192 /
  //   v_head_dim=256 / vocab_size=154880 / n_routed_experts=256 top-8 + 1 shared /
  //   index_topk=2048 / index_n_heads=32 / index_head_dim=128 / max_position_embeddings=202752
  // ★ 与 DeepSeek 系列(V3/V3.2/K2)的两处关键差异, 直接影响本平台的 KV 与 prefill 口径:
  //   ① **层数 78 而非 61** ⇒ KV/token = 78×(512+64)×dt, 比 DS 系列高 27.9%
  //      (BF16 87.8KB / FP8 43.9KB, 对比 DS-V3/K2 的 68.6KB / 34.3KB)
  //   ② **解压式 prefill 维度翻倍**: qk_nope 192(DS 是 128) + v_head_dim 256(DS 是 128)
  //      ⇒ 每层每 head 维度和 = (192+64)+256 = 512, 是 DS 系列 320 的 1.60×
  //      ⇒ 位置斜率 b 显著高于同为 MLA 的 K2, prefill 更贵 ⇒ 存储网占 TTFT 比例相应下降
  // ⚠️ index_n_heads=32(DS-V3.2 是 64) ⇒ Indexer 打分开销只有 V3.2 的一半, 稀疏收益更纯。
  // calibA/calibB 不设: 本架构无实测校准值, 由 Roofline 自动推导(见 estimatePrefillParams)。
  'GLM-5.1': {attn:'mla', layers:78, kvLora:512, ropeDim:64, hidden:6144, vocab:154880,
    paramsB:744, actB:40, qHeads:64, qkNope:192, vHeadDim:256,
    sparse:true, sparseTopk:2048, idxHeads:32, idxHeadDim:128,
    // EP 字段(2026-08-31, 官方 config: 前 3 层 dense + 75 层 MoE)。
    // denseB: embed 1.9 + 3×dense层 0.4 + 75×(MLA attn 0.155 + shared expert 0.038) ≈ 17.6B
    moeLayers:75, denseB:18},
  'Custom':        {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128000, paramsB:0, actB:0}
};

export let hwPresets = {
  'h20x8':  {hbm:96, hbmBW:4,   tflops:148, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:50, gpus:8},
  'h100x8': {hbm:80, hbmBW:3.35,tflops:989, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:50, gpus:8},
  'a100x8': {hbm:80, hbmBW:2,   tflops:312, tp:8, nvlink:600,  pcie:32,  dram:512,  dramBW:300, ssd:10, ssdBW:50, gpus:8},
  'b200x8': {hbm:192,hbmBW:8,   tflops:2250,tp:8, nvlink:1800, pcie:128, dram:2048, dramBW:500, ssd:40, ssdBW:50, gpus:8},
  // NVIDIA HGX/DGX B300 (Blackwell Ultra, 2026): 288GB HBM3E/卡 × 8 = 2.3TB 显存池。
  // ⚠️ tflops 口径与其他预设一致 = **BF16/FP16 dense**(NVIDIA 官方 B200/B300 同为 2.25 PFLOPS)。
  //    Blackwell Ultra 相对 B200 的提升在 **显存容量(192→288GB)** 与 **NVFP4(10→15 PFLOPS dense)**
  //    + attention softmax 加速(SFU EX2 5→10.7 TeraExp/s), BF16 与 FP8 dense 算力**未变** ——
  //    所以本仿真(BF16 口径)下 B300 与 B200 的算力相同, 差异体现在 KV 容量, 这正是它对
  //    长上下文/高前缀命中场景的价值所在。若要按 FP8 或 NVFP4 口径评估请手动改此字段。
  // NVLink5 1.8TB/s; PCIe Gen6 x16 = 256GB/s 双向(B200 为 Gen5 128GB/s)。
  'b300x8': {hbm:288,hbmBW:8,   tflops:2250,tp:8, nvlink:1800, pcie:256, dram:2048, dramBW:500, ssd:40, ssdBW:50, gpus:8},

  // ======== 国产 AI 芯片(2026-08-24 新增) ========
  // ⚠️ 算力口径统一说明: 上面 NVIDIA 各卡填的是 **BF16/FP16 dense**。国产卡官方普遍
  //    只公布 FP8/FP4 峰值(昇腾 950)或 FP16 峰值(昆仑芯), 为保证可比性:
  //    · 昇腾 950PR/DT: 官方 FP8 = 1 PFLOPS。本仿真默认 dtype 常用 FP8, 但 tflops 字段
  //      口径是 BF16 ⇒ 按"FP8 吞吐通常为 BF16 的 2×"折算 BF16 ≈ 500 TFLOPS。
  //      若你的负载确实跑 FP8, 请手动把 tflops 改成 1000。
  //    · 昆仑芯 P800: 官方直接给 FP16/BF16 = 345 TFLOPS, 可直接填。
  //    · 昆仑芯 P900: 官方未公布单卡算力细节, 按 P800 的 2× 估 690(**估算值**)。

  // 华为昇腾 950PR (2026Q1, Atlas 350 标卡): 面向 **推理 Prefill 与推荐** 场景。
  // 自研 HBM HiBL 1.0: 128GB / 1.6TB/s —— 容量尚可但**带宽是四款里最低的**,
  // 这正好对应它的定位(prefill 是算力密集型, 对带宽不敏感)。
  // 灵衢(UB)互联 2TB/s = 2000GB/s(相当于 NVLink 位置); 主机侧按 PCIe 5.0 x16 = 128GB/s。
  'a950pr8': {hbm:128,hbmBW:1.6, tflops:500, tp:8, nvlink:2000, pcie:128, dram:1024, dramBW:400, ssd:20, ssdBW:50, gpus:8},

  // 华为昇腾 950DT (2026Q4): 面向 **推理 Decode 与训练**。自研 HBM HiZQ 2.0:
  // 144GB / **4TB/s** —— 带宽是 950PR 的 2.5×, 这是 PR/DT 分工的核心区别
  // (decode 是访存密集型)。算力/互联与 950PR 相同。
  // ⚠️ 注意有媒体(中国电子报等)把 PR/DT 的显存参数写反了(说 PR=144GB/4TB/s、
  //    DT=128GB/1.6TB/s), 此处以华为全联接大会 2025 官方口径为准(多个一手来源一致)。
  'a950dt8': {hbm:144,hbmBW:4,   tflops:500, tp:8, nvlink:2000, pcie:128, dram:1024, dramBW:400, ssd:20, ssdBW:50, gpus:8},

  // 昆仑芯 P800 (百度, 昆仑芯三代 XPU-P, 2024 量产): 96GB HBM3 / 2.4TB/s,
  // FP16 345 TFLOPS(官方称约为 H20 的 2.3×), 400W, OAM 模组。
  // 单机 8 卡即可跑 DS-V3/R1 671B 满血版 —— 96×8=768GB 刚好装下 FP8 权重。
  // 节点内 XPU Link; 主机 PCIe 5.0 x16 = 128GB/s。
  'klxp800x8': {hbm:96, hbmBW:2.4, tflops:345, tp:8, nvlink:400, pcie:128, dram:1024, dramBW:400, ssd:20, ssdBW:50, gpus:8},

  // 昆仑芯 P900 (天池超节点, 2026): **单柜 32 卡**全互联, 显存池 3072GB ⇒ 每卡 96GB。
  // 卡间 400GB/s、时延 1.5μs。这是四款里唯一的**超节点形态**, gpus 默认给 32
  // (而非 8) —— 百度官方 DS-R1 部署方案正是 32 卡占满一个 P900 做 Decode(TP1+EP32)。
  // ⚠️ 单卡算力官方未公布, 690 TFLOPS 是按 P800 的 2× **估算**; 显存带宽同样按
  //    P800 的 2× 估为 4.8TB/s。这两项不确定性较大, 做定量结论前请自行校准。
  'klxp900x32': {hbm:96, hbmBW:4.8, tflops:690, tp:32, nvlink:400, pcie:128, dram:2048, dramBW:500, ssd:40, ssdBW:50, gpus:32}
};

export var strategyPresets = {
  // 2026-09-03 第4批: ADMIT 收敛为 always、PLACE 收敛为 hbm_first —— 原 threshold/priority/
  // cost_based 与 tiered/adaptive 档隐含"新请求 KV 直接落 DRAM/SSD", sglang 无此机制
  // (新 KV 只能分配在 device pool, 慢层驻留只经淘汰写回链产生)。
  // ⇒ 预设间剩余的真实自由度: EVICT 写回链阈值 + PREFETCH 策略 + BATCH max(decode 并发)。
  'Pure-HBM': 'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(8)\nPLACE: hbm_first',
  'HBM+DRAM': 'ADMIT: always\nEVICT: lru from hbm when 90% -> dram\nPREFETCH: best_effort\nBATCH: continuous max(16)\nPLACE: hbm_first',
  'Tiered-3L':  'ADMIT: always\nEVICT: lru from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: timeout\nBATCH: continuous max(32)\nPLACE: hbm_first',
  'Aggressive':'ADMIT: always\nEVICT: lru from hbm when 75% -> dram, lru from dram when 80% -> ssd\nPREFETCH: race\nBATCH: continuous max(64)\nPLACE: hbm_first',
  'Conservative':'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(4)\nPLACE: hbm_first',
  // SGLang 默认语义: continuous batching + RadixAttention(lru 驱逐) + HiCache 分层写回
  // + 静态内存池(mem-fraction 由 HBM 容量直接表达)。
  // PREFETCH: none = wait_complete(命中即等 KV 拉齐再算); 改 race = 前缀 GPU前向计算+L3后向预取, 相遇即停后再算后缀
  'SGLang-Default': 'ADMIT: always\nEVICT: lru from hbm when 90% -> dram, lru from dram when 90% -> ssd\nPREFETCH: none\nBATCH: continuous max(8)\nPLACE: hbm_first',
};

export var strategyPresetsJS = {
  'Pure-HBM':
`function admit(req) { return 'hbm'; }
function evict(pool, name) {
  if (name === 'hbm' && hbmUsage() > 0.95) {
    return pool.blocks.reduce(function(a,b){return pool.accessOrder.indexOf(a.id)<pool.accessOrder.indexOf(b.id)?a:b;});
  }
  return null;
}
function shouldPrefetch() { return false; }
function place() { return 'hbm'; }`,

  'HBM+DRAM':
`function admit(req) {
  if (hbmUsage() < 0.8) return 'hbm';
  return 'dram';
}
function evict(pool, name) {
  if (name === 'hbm' && hbmUsage() > 0.9) {
    return pool.blocks.reduce(function(a,b){return pool.accessOrder.indexOf(a.id)<pool.accessOrder.indexOf(b.id)?a:b;});
  }
  return null;
}
function shouldPrefetch() {
  if (hbmUsage() >= 0.5) return false;
  var d = getBlocksIn('dram'), c = 0;
  for (var i = 0; i < d.length && c < 10; i++) { if (prefetchBlock('dram', d[i])) c++; }
  return c > 0;
}
function place() { return 'hbm'; }`,

  'Tiered-3L':
`function admit(req) {
  if (hbmUsage() < 0.7) return 'hbm';
  if (req.inputLen > 4096) return 'dram';
  return 'dram';
}
function evict(pool, name) {
  if (name === 'hbm' && hbmUsage() > 0.85) {
    return pool.blocks.reduce(function(a,b){return (pool.freq[a.id]||0)<(pool.freq[b.id]||0)?a:b;});
  }
  if (name === 'dram' && dramUsage() > 0.9) {
    return pool.blocks.reduce(function(a,b){return pool.accessOrder.indexOf(a.id)<pool.accessOrder.indexOf(b.id)?a:b;});
  }
  return null;
}
function shouldPrefetch() {
  if (hbmUsage() >= 0.4) return false;
  var d = getBlocksIn('dram'), c = 0;
  for (var i = 0; i < d.length && c < 20; i++) { if (prefetchBlock('dram', d[i])) c++; }
  return c > 0;
}
function place() { return hbmUsage() < 0.9 ? 'hbm' : 'dram'; }`,

  'Aggressive':
`function admit(req) { return 'hbm'; }
function evict(pool, name) {
  var thr = name === 'hbm' ? 0.75 : 0.8;
  if ((pool.used/pool.cap) > thr) {
    return pool.blocks.reduce(function(a,b){return (pool.freq[a.id]||0)<(pool.freq[b.id]||0)?a:b;});
  }
  return null;
}
function shouldPrefetch() {
  var d = getBlocksIn('dram'), c = 0;
  for (var i = 0; i < d.length && c < 30; i++) { if (prefetchBlock('dram', d[i])) c++; }
  return c > 0;
}
function place() { return 'hbm'; }`,

  'Conservative':
`function admit(req) {
  if (req.inputLen < 2048) return 'hbm';
  return 'dram';
}
function evict(pool, name) {
  if (name === 'hbm' && hbmUsage() > 0.95) {
    return pool.blocks.reduce(function(a,b){return (a.lastTouch||0)<(b.lastTouch||0)?a:b;});
  }
  return null;
}
function shouldPrefetch() { return false; }
function place() { return hbmUsage() < 0.95 ? 'hbm' : 'dram'; }`,

  'SGLang-Default':
`function admit(req) { return hbmUsage() < 0.9 ? 'hbm' : 'dram'; }
function evict(pool, name) {
  if (name === 'hbm' && hbmUsage() > 0.9) {
    return pool.blocks.reduce(function(a,b){return (a.lastTouch||0)<(b.lastTouch||0)?a:b;});
  }
  if (name === 'dram' && dramUsage() > 0.9) {
    return pool.blocks.reduce(function(a,b){return (a.lastTouch||0)<(b.lastTouch||0)?a:b;});
  }
  return null;
}
function shouldPrefetch() { return false; }
function place() { return hbmUsage() < 0.9 ? 'hbm' : 'dram'; }`,
};

export const jsTemplate = `// JavaScript 策略定义 — 自由编写调度逻辑
// 可用全局变量: hbmCap, dramCap, ssdCap (字节)
// 可用函数: hbmUsage(), dramUsage(), ssdUsage() → 返回 0~1
//           hbmUsed(), dramUsed() → 返回已用字节
//           prefetchBlock(fromTier, blockId) → 调度一次跨层搬运(有传输耗时)
//           hasBlock(tier, blockId) → 检查 block 是否在指定层
//           getBlocksIn(tier) → 返回该层所有 block 的 id 数组

function admit(req) {
  if (hbmUsage() < 0.8) return 'hbm';
  if (dramUsage() < 0.9) return 'dram';
  return 'ssd';
}

function evict(pool, poolName) {
  if (poolName === 'hbm' && hbmUsage() > 0.85) {
    var victim = pool.blocks.reduce(function(a,b){
      return pool.accessOrder.indexOf(a.id) < pool.accessOrder.indexOf(b.id) ? a : b;
    });
    return victim;
  }
  return null;
}

function shouldPrefetch() {
  if (hbmUsage() >= 0.6) return false;
  var dramBlocks = getBlocksIn('dram');
  var count = 0;
  for (var i = 0; i < dramBlocks.length && count < 10; i++) {
    if (prefetchBlock('dram', dramBlocks[i])) count++;
  }
  return count > 0;
}

function place() {
  return hbmUsage() < 0.9 ? 'hbm' : 'dram';
}
`;
