import { generateRequests } from "./requests.js";
import { hwPresets } from "./presets.js";
import { mulberry32, pctOf, unionSpanSec } from "./math.js";
import { calcAll, estimatePrefillParams, effL2LinkBW, prefillIntegral, prefillTau, perReqMs } from "./calculations.js";
import { autoNameStrategy } from "./strategy.js";

export function runSimulation(params, strategy, overrides, strategyMode = "dsl") {
  overrides = overrides || {};
  let p = JSON.parse(JSON.stringify(params));
  // ---- 硬件预设覆盖(2026-08-25, 为「形状=GPU」的多硬件扫描而加) ----
  // ⚠️ 三条口径约束, 都是实测踩出来的:
  //  1) **不覆盖 ssdBW**: 九款预设的 ssdBW 全是 50(零区分度) —— 它表示"外挂 L3 存储网带宽",
  //     是与加速卡无关的独立设施, 并非 GPU 硬件特征(对比 ssd 容量 10/20/40 是有区分的)。
  //     UI 点预设按钮会连带重置 pSsdBW=50, 那是"整机模板"语义; 但在**扫描**语境下横轴往往
  //     就是 L3 带宽, 覆盖它会把整条曲线压成一个点(实测: 不排除 ssdBW 时 hwPreset 路径
  //     TTFT 恒为 ssdBW=50 的值 96.4ms, 而非输入框 100GB/s 的 59.5ms)。
  //     ⇒ 硬件维度只负责"卡"(算力/显存/互联/主机链路), 存储网带宽交给专门的 ssd_bw 维度。
  //  2) **预设先套、其余 overrides 后套**: 顺序反了会让显式 overrides 被预设默认值冲掉。
  //  3) **a/b 必须重估, 且放在全部 overrides 之后**: a/b 是 prefill 速度的唯一权威, 但它
  //     来自输入框(getParams), 不随 p.tflops/gpus 自动变。实测 GLM-5.1 下 B300 a=4.83/
  //     b=2.84e-4 而 H20 a=67.95/b=4.32e-3(差 14.1×/15.2×) —— 漏掉这步 H20 会沿用 B300
  //     的速度, TTFT 失真 11.5×(图看着正常, 数全错)。放最后是为了让任何影响 a/b 的
  //     override(dtype/稀疏/MLA 路径等)都能被纳入推导, 而非只考虑硬件字段。
  //     ⚠️ 精度: 此处用 estimatePrefillParams 的**全精度**返回值, 而 UI 路径经输入框
  //     toFixed(2)/toFixed(6) 截断 ⇒ 两者 TTFT 有 ~0.2% 的量化差(实测 59.381 vs 59.506)。
  //     为与 UI 显示口径**逐位可复现**, 这里刻意做同样的截断(见 _verify_gpu_sweep.js B2)。
  let _hwOv = overrides.hwPreset && hwPresets[overrides.hwPreset] ? hwPresets[overrides.hwPreset] : null;
  if (_hwOv) {
    p.hbmPerGpu = _hwOv.hbm; p.hbmBW = _hwOv.hbmBW; p.tflops = _hwOv.tflops;
    p.tpSize = _hwOv.tp; p.nvlinkBW = _hwOv.nvlink; p.pcieBW = _hwOv.pcie;
    p.dram = _hwOv.dram; p.dramBW = _hwOv.dramBW; p.ssd = _hwOv.ssd;
    p.gpus = _hwOv.gpus;
    // 注意: 故意**不**写 p.ssdBW —— 见上方第 1 条
  }
  for (let k in overrides) { if (k !== 'seed' && k !== 'nreq' && k !== 'hwPreset') p[k] = overrides[k]; }
  if (_hwOv) {
    let _e = estimatePrefillParams(p);
    // 与 applyEstimatedParams() 写输入框的精度对齐(a 两位小数 / b、bIdx 六位小数),
    // 保证"扫描出来的点"与"手动点预设按钮跑出来的点"数值逐位一致。
    p.prefillA = parseFloat(_e.a.toFixed(2));
    p.prefillB = parseFloat(_e.b.toFixed(6));
    p.prefillBIdx = parseFloat(_e.bIdx.toFixed(6));
  }
  let r = calcAll(p);
  // ---------- PD 真分离: 双资源视图(2026-08-20) ----------
  // calcAll(p) 是纯函数, 资源全部由 p.gpus/tflops/hbmBW/hbmPerGpu 推导 ⇒ 直接换 gpus 即可
  // 得到 P/D 各自的算力/HBM/带宽视图, 无需重写资源模型。
  // 划分语义: 从现有 GPU 总数中划出 pdPrefillGpus 给 P, 余下归 D(P:D 配比), 总量守恒。
  // ⚠️ a/b 必须按 P 的卡数**重算**: estimatePrefillParams 内 peakFlops = tflops×gpus、
  //    aggHbmBW = hbmBW×gpus —— 输入框里的 a/b 是按**总卡数**拟合的, 直接拿给 4 卡的 P 用
  //    会让 prefill 速度错一整个倍数(见 MEMORY: a/b 是 prefill 速度的唯一权威)。
  // ---------- 多实例(S2, 2026-08-20) 与 PD 真分离 互斥 ----------
  // 两者都从 GPU 总数切分资源, 叠加会让状态维度乘开(N 实例 × 每个再 P/D 划分),
  // 且"哪一层先分"的语义歧义大。故约定: 多实例优先, 开多实例时 PD 降级为混合批。
  // instShare = 实例数, 用于把 DRAM/SSD/PCIe/NVMe 这些**整机资源**按实例数均分
  // (HBM 已随卡数由 calcAll 自然缩放, 不在此处除)。
  let instShare = Math.max(1, Math.min(p.instances || 1, Math.max(1, p.gpus)));
  let multiInst = instShare > 1;
  let pdReal = p.pdMode === 2 && !multiInst;
  let rP = r, rD = r, pP = p;
  let pdPrefillGpus = p.gpus, pdDecodeGpus = p.gpus;   // 非真分离: 两阶段都用全部卡(口径不变)
  if (pdReal) {
    let gP = Math.max(1, Math.min(p.pdPrefillGpus, Math.max(1, p.gpus - 1)));  // 至少给 D 留 1 卡
    let gD = Math.max(1, p.gpus - gP);
    pdPrefillGpus = gP; pdDecodeGpus = gD;
    // P 视图: 只改卡数(TP 规模随之收缩), 其余硬件参数共用
    // EP clamp(2026-08-31): P/D 各自的 EP 域不超过各自卡数
    pP = Object.assign({}, p, { gpus: gP, tpSize: Math.min(p.tpSize || gP, gP),
      epSize: Math.min(p.epSize || 1, gP) });
    let pD = Object.assign({}, p, { gpus: gD, tpSize: Math.min(p.tpSize || gD, gD),
      epSize: Math.min(p.epSize || 1, gD) });
    rP = calcAll(pP); rD = calcAll(pD);
    // P 节点 a/b 重算: mfuAuto 下走 Roofline, 否则按 MFU —— 与 estimatePrefillParams 同口径
    let eP = estimatePrefillParams(pP);
    pP.prefillA = eP.a; pP.prefillB = eP.b; pP.prefillBIdx = eP.bIdx;
  }
  // prefill 段消费 rP/pP(算力与 a/b), decode 段消费 rD(HBM 带宽/算力/权重读)。
  // 非真分离档下 rP===rD===r、pP===p —— 行为与改动前**逐位一致**(零回归)。
  let rng = mulberry32((overrides.seed != null ? overrides.seed : p.seed) >>> 0);

  let kvPerTok = r.kvPerToken;
  let blockBytes = r.blockBytes;
  let tierRatio = { hbm: 1, dram: p.tierQuant, ssd: p.tierQuant };

  const DT = 0.002;                 // 时间步长 2ms(原 20ms): fetchTime 亚步长分辨率——原 20ms 使 fetchTime<20ms 时
  // 被量化为 1 步, L3 带宽 >90GB/s 后 TTFT 假性饱和(带宽提升不再体现)。2ms 可分辨到 ~500GB/s。
  const TOUCH_EVERY = 10;          // 每10步(0.02s)刷新一次位置统计与访问记录
  const MAX_SIM_BLOCKS = 256;      // 单请求仿真块数上限（超出合并为超级块）
  const PREFILL_UTIL_CAP = 0.9;    // 并行 prefill 利用率上限：单请求利用率≈MFU，并行 batch 把 GPU 填满至该上限
  // decode 每请求开销见顶层 perReqMs()（校准: Qwen3-32B 单卡 6.4×n^0.75; DS-V3 8卡 5.2+3.7×n^0.75）

  // ================= 实例状态容器(S1, 2026-08-20) =================
  // 多实例 router 的基础: 把"一台推理实例"的全部私有状态收进一个对象。
  // 单实例(instances.length===1)时行为与改造前**逐位一致** —— 这是零回归的保证。
  //
  // 设计要点:
  //  · 资源(pools/caps/links/effL3BW) 与 队列(waitQueue..decoding) 与 波次(curWave/prepWave)
  //    与 拉取单飞(groupPull) 都是实例私有 —— 两台实例的显存/队列互不可见
  //  · now/DT/step/rng/pending/stats 保持**全局共享**: 共享时间轴是 router 能观测各实例
  //    实时队列长度的前提(若各实例独立走时间轴, 最短队列/cache-aware 路由无法表达)
  //  · 数组容器全程**原地修改**(push/splice), 故主循环可用局部视图变量绑定, 无需处处写 inst.;
  //    但 curWave/prepWave/prevDecodeL3 会被**重新赋值**, 必须走 inst.x
  function makeInstance(instId, instGpus) {
    // 该实例自己的资源视图: 从 GPU 总数切分(总量守恒), 沿用 PD 真分离的 calcAll 换卡数手法
    // EP clamp(2026-08-31, 改动4): EP 域不能超出本实例卡数(一阶段只做实例内 EP, §6 决策1)
    let iP = instGpus === p.gpus ? Object.assign({}, p,
      { epSize: Math.min(p.epSize || 1, instGpus) }) : Object.assign({}, p,
      { gpus: instGpus, tpSize: Math.min(p.tpSize || instGpus, instGpus),
        epSize: Math.min(p.epSize || 1, instGpus) });
    let iR = instGpus === p.gpus ? r : calcAll(iP);
    // ⚠️ prefill a/b 必须按**每实例卡数**重算(2026-08-21 修 bug, 与 PD 真分离同处理):
    // a 与 b 都 ∝ 1/gpus(peakFlops 与 aggHbmBW 都随卡数线性放大), 直接复用输入框里
    // 按**总卡数**拟合/推导的值, 会让每实例的 prefill 速度错一整个倍数 ——
    // 实测 16卡拆2实例时每台仍用 16卡的 a=18.13(应为 8卡的 35.87), prefill 快 2×,
    // 导致"多实例 TTFT 反而更低"的错误结论。
    // estimatePrefillParams 由架构+硬件纯推导, 不读输入框, 故此处重算不会吞掉用户手填值
    // 的语义 —— 手填值本就只对"总卡数"这一套硬件成立。
    let iPP = iP;
    if (instGpus !== p.gpus) {
      let eI = estimatePrefillParams(iP);
      iPP = Object.assign({}, iP, { prefillA: eI.a, prefillB: eI.b, prefillBIdx: eI.bIdx });
    }
    // 分层容量: HBM 随卡数缩放(calcAll 已算), DRAM/SSD 按实例数均分(一台机器的内存/盘由本实例独占)
    let iCaps = { hbm: iR.availHbm,
      dram: p.tieredKv ? iR.dramTotal / instShare : 0,
      ssd:  p.tieredKv ? iR.ssdTotal / instShare : 0 };
    let iPools = {};
    ['hbm','dram','ssd'].forEach(t => iPools[t] = { blocks: [], blockIndex: {}, used: 0, cap: iCaps[t], accessOrder: [], freq: {} });
    // 跨层链路：L2(PCIe/C2C) 与 L3(NVMe) 各为一条共享总线——
    // 物理上 PCIe/NVMe 是双向共享带宽的，故 hbm↔dram 双向共用 busyUntil(L2)，
    // dram↔ssd 双向共用 busyUntil(L3)。传输(预取/淘汰)与 decode 读(见 decode 段)
    // 都在同一总线上串行排队——竞争带宽，先到先服务。
    // 多实例: 每实例一条独立总线(各自的 PCIe/NVMe), 带宽按实例数均分
    // L2 带宽(2026-08-31, §3.2 修复): pcieBW 是**单卡规格**, 聚合 = pcieBW × f,
    // f = 实例卡数/attnTp(attnTp: TP 模式=tpSize 组内复制读; EP>1=DP-attention 形态读复制
    // 消失 ⇒ attnTp=1)。TP=实例卡数(默认)时 f=1 ⇒ 与旧 min(pcie,dram) 逐位一致。
    let iL2BW = effL2LinkBW(iP);
    let iLinks = {
      'hbm>dram': { bw: iL2BW * 1e9 / instShare, busyUntil: 0 },
      'dram>hbm': { bw: iL2BW * 1e9 / instShare, busyUntil: 0 },
      'dram>ssd': { bw: p.ssdBW * 1e9 / instShare, busyUntil: 0 },
      'ssd>dram': { bw: p.ssdBW * 1e9 / instShare, busyUntil: 0 },
    };
    iLinks['hbm>dram'].shared = iLinks['dram>hbm'];
    iLinks['dram>hbm'].shared = iLinks['hbm>dram'];
    iLinks['dram>ssd'].shared = iLinks['ssd>dram'];
    iLinks['ssd>dram'].shared = iLinks['dram>ssd'];
    let iEffL3 = p.ssdBW * 1e9 * 0.9 / instShare;
    // PD 真分离的 P/D 资源视图(与多实例互斥, 见 pdReal 计算): 单实例时沿用全局 rP/rD/pP
    return {
      id: instId, gpus: instGpus, p: iP, r: iR,
      pools: iPools, caps: iCaps, links: iLinks,
      effL3BW: iEffL3, l3PoolBytes: iEffL3 * DT, prevDecodeL3: 0,
      waitQueue: [], prefillQ: [], prefilling: [], kvXfer: [], decodeWait: [], decoding: [],
      curWave: null, prepWave: null,
      // lastWaveEndAt(2026-09-01, TTFT 时间戳口径): 上一执行波结算时刻。
      // 用途: 上岗时为成员打 _waveEmpty = max(prefillStart, lastWaveEndAt) 戳 ——
      //   "执行流水线自何时起空闲", fetchExposure 从该点起算 ⇒ 被上一波计算掩盖的拉取不计费。
      // ⚠️ 必须实例级(与 curWave/prepWave 同): 多实例下用全局变量会串台。
      lastWaveEndAt: 0,
      groupPull: {},
      // 每实例统计(S2 导出): 完成数 + 峰值队列/显存, 供负载均衡度评估
      nCompleted: 0, nRouted: 0, peakQueue: 0, peakHbm: 0, qLenSum: 0, qLenSamples: 0,
      qBusySum: 0, qBusySamples: 0,   // 仅"系统有负载"窗内的队列采样(均衡度用, 见主循环注释)
      // 该实例的 prefill 参数视图(含按本实例卡数重算的 a/b, 2026-08-21)
      pP: iPP,
      // S4 前缀亲和: 该实例自己的前缀缓存视图(gid → {prefixTokLen, blkIds, activated})。
      // 亲和关闭时全部实例共用同一个对象引用(= 全局共享前缀池, 口径与历史一致);
      // 亲和开启时每实例一份独立副本 ⇒ 命中要求"同前缀曾被路由到本实例"。
      prefixMap: null,
      // 每实例命中量(token 加权, S4): 用于输出各实例命中率
      hitTok: 0, reqTok: 0,
    };
  }

  let now = 0;
  let inFlight = [];
  let stats = { hbmAcc: 0, dramAcc: 0, ssdAcc: 0, latencies: [], ttfts: [], tpots: [], queueWaits: [],
    completed: 0, evictions: 0, activeEvictions: 0, prefetches: 0, drops: 0, transferBytes: 0,
    // TTFT/延迟分解累计（秒）：TTFT = 到达排队 + prefill排队 + L3拉取fetch + prefill计算；
    // 延迟 = TTFT + decode槽位等待 + decode执行（L3 读占比的落点）
    ttftQ: 0, ttftP: 0, ttftF: 0, ttftC: 0, latDw: 0, latDt: 0,
    // computeNet(2026-09-01 口径): 该请求**独占 GPU 时**的纯计算时长 —— 沿实际计算路径的
    // τ 积分 Σ(chunk × τ(posMid))(波次上岗时按成员 chunk 累计; 2026-09-03 起为唯一口径,
    // 流体路径的 perReqTok×τ 已随流体模型删除)。
    // 因 Σ chunk = 实算 token 数 ⇒ 等于 ∫τ dpos, 与 boost/并发数无关; 对 race/be 的
    // 不连续两段位置区间(前缀段 ∪ 后缀段)自动成立(路径积分性质)。
    // 于是 computeWait = compute − computeNet 就是**算力竞争等待**(被其他请求占用算力 +
    // 波次量化等待)。
    ttftCnet: 0,
    // cNetRawSum/cNetClampN(2026-09-01 诊断): _cNet 被 clamp 到 (compute − fetchExposure)
    // **之前**的累计值与触发次数。波次去掉 /wBoost 后 _cNet 不再保证 ≤ 波耗时(成员 τ 高于
    // 波内均值时会超出) ⇒ 用这两项量化截断幅度与频率, 避免"computeWait 恒 0"被静默掩盖。
    cNetRawSum: 0, cNetClampN: 0,
    // 方案A(2026-09-01) 诊断: ttftFq = fetch 分量中从 prefillQ 窗口划转来的部分(秒);
    // pqSkipN = 曾因未就绪被让过的请求数。方案A 关闭时两者恒 0。
    ttftFq: 0, pqSkipN: 0,
    // PD 真分离(2026-08-20): ttftX = P→D KV 传输段(TTFT 第5分量); pdXfer* = 传输量与耗时统计
    ttftX: 0, pdXferBytes: 0, pdXferSpanSum: 0, pdXferSoloSum: 0, pdXferCount: 0,
    fetchSoloSum: 0,                                        // prefill 传输独立用时累计(req.fetchTime, 未与计算重叠前的单独耗时)
    // GPU 占用画像(2026-08-21): 见 prefill 段 nAct 注释。跨实例累加(整机视角)
    pfGpuBusySec: 0, pfBusySteps: 0, pfActSum: 0,
    // prefill 吞吐(2026-08-25): 在 finishPrefill 埋点累计, 与 decode 侧 outTokens 完全独立。
    // pfReqTokens=名义输入 token / pfCompTokens=GPU 实算 token / pfReqDone=完成 prefill 的请求数
    pfReqTokens: 0, pfCompTokens: 0, pfReqDone: 0,
    // ---- 阶段时长区间(2026-08-26): 分母不再用 simEnd, 改为各阶段的**墙钟并集** ----
    // 为什么记区间而不是直接累加时长: Σ(逐请求时长) 会把并发重叠部分重复计入,
    // 分母被放大 ⇒ 吞吐被系统性低估(实测 Σ/并集 随 qps 可达 6.97 倍)。
    // 因此先收集 [start,end] 区间, 结算时合并求并集(见 mergeSpans)。
    pfSpans: [], dcSpans: [],
    // Σ逐请求时长(供"单请求体验速率"口径与诊断并发重叠程度用, 不作默认分母)
    pfSpanSum: 0, dcSpanSum: 0,
    // decode 输出 token 中已完成请求的部分(与 dcSpans 同源, 保证分子分母口径一致)
    dcOutTokens: 0,
    fetchSpanSum: 0,                                        // prefill 传输过程实际耗时累计(_ft1-_ft0, 含带宽排队/不含计算)
    fetchBytesPulled: 0,                                    // prefill 拉取字节总量(统一共享池口径, 单飞去重效果可由此观察)
    memUtilSamples: 0, memUtilSum: 0, memUtilPeak: 0, outTokens: 0,
    hbmReadBytes: 0, dramReadBytes: 0, ssdReadBytes: 0,       // 每步批次读取量的时间累计（÷仿真时长=平均读带宽）
    dramPeak: 0, ssdPeak: 0, dramUsedSum: 0, ssdUsedSum: 0,   // L2/L3 峰值与时间加权均值占用
    l2Inst: [], l3Inst: [],                                   // L2/L3 链路瞬时速率样本（decode读+换入换出差分）
    transferL2Bytes: 0, transferL3Bytes: 0, _prevL2: 0, _prevL3: 0, // 按链路归类的传输累计（供差分）
    ptHbm: 0, ptL2: 0, ptL3: 0, ptCmp: 0, ptComm: 0, ptSamples: 0,  // passTime 名义分量累计
    bnHbm: 0, bnL2: 0, bnL3: 0, bnCmp: 0, bnComm: 0,          // 每步瓶颈（时间主要花在哪层）计数
    l2Series: [], l3Series: [],                               // 各层驻留时间序列 [time, GB]
    prefixHits: 0, prefixSavedBytes: 0, sessionHits: 0, concSamples: [],
    // 实测分层命中(2026-08-20, token 加权): 输入 pPrefixHit 是**逻辑**命中率(每请求 inputLen×h),
    // 这里统计前缀块**物理**落在哪一层的实际命中量。注意 stats.prefixHits 是"命中过的请求次数",
    // 不是命中率——不能当命中率用(命中 1% 与 99% 的请求会被等价计数)。
    // 守恒: hitTokL1 + hitTokL2 + hitTokL3 + missTok == reqTokTotal
    hitTokL1: 0, hitTokL2: 0, hitTokL3: 0, missTok: 0, reqTokTotal: 0 };

  // ---------- 实例数组与"当前实例"视图(S1/S2, 2026-08-20) ----------
  // 从 GPU 总数切分: gpusPerInst = floor(gpus/instShare), 余数分给前几个实例(总量守恒)。
  let instances = [];
  {
    let base = Math.floor(p.gpus / instShare), rem = p.gpus % instShare;
    for (let ii = 0; ii < instShare; ii++) instances.push(makeInstance(ii, base + (ii < rem ? 1 : 0)));
  }
  // 主循环逐实例处理时, 用下列**视图变量**指向当前实例的容器 —— 数组全程原地修改
  // (push/splice), 故绑定引用即可, 无需把主循环里几百处 `prefillQ` 改写为 `inst.prefillQ`。
  // ⚠️ 但 curWave/prepWave/prevDecodeL3 会被**重新赋值**, 必须写 inst.x
  //    (视图变量赋值只会改局部, 不会回写实例 —— 这是本次重构最易出错的点)。
  let inst = instances[0];
  // 生效的路由策略: DSL 的 ROUTE 行优先, 未写则回退 UI 下拉(向后兼容)
  // (声明位置须早于前缀预热段 —— 亲和预热要按路由策略决定各组归属哪台实例)
  // 用 strategy 入参而非 s(后者声明在更后面) —— 两者是同一对象
  let routePolicy = (strategy && strategy.routing && strategy.routing.type)
    ? strategy.routing.type : (p.routePolicy || 'round_robin');
  // 字符串 → 32bit 哈希(FNV-1a): 用于 hash_prefix 的一致性映射与亲和预热的归属判定。
  // 必须是**确定性**的(不依赖 rng), 否则同一 prefixKey 在不同时刻会落到不同实例, 亲和性失效。
  function hashKey(str) {
    let h = 0x811c9dc5;
    let t = String(str);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
  }
  // 请求的前缀键: 复用已有的 groupId(pfx_A/B/C/D) —— 它天然就是"同前缀请求"的标识,
  // 无需新造。无组请求(不共享前缀)按自身 id 散列, 等价于随机分布。
  function prefixKeyOf(req) {
    return req.groupId ? req.groupId : ('r' + req.id);
  }
  // S4 前缀亲和(2026-08-20): 仅多实例时有意义 —— 单实例下"隔离"无对象可隔离。
  let affinity = !!p.prefixAffinity && instances.length > 1;
  // S4: 前缀池视图 —— 亲和关时全实例共享同一对象; 亲和开时指向当前实例的独立副本。
  // 必须在此前置声明(useInstance 与前缀预热段都会用到)。
  let prefixGroupMap = {};
  let pools = inst.pools, caps = inst.caps, links = inst.links;
  let waitQueue = inst.waitQueue, prefillQ = inst.prefillQ, prefilling = inst.prefilling;
  let kvXfer = inst.kvXfer, decodeWait = inst.decodeWait, decoding = inst.decoding;
  let groupPull = inst.groupPull;
  let effL3BW = inst.effL3BW, l3PoolBytes = inst.l3PoolBytes;
  // 仅重绑**资源类**视图(池/容量/链路/前缀表)。供前缀预热阶段使用 —— 那时波次/队列
  // 相关的视图变量(curWave/prepWave/prevDecodeL3)还未声明, 碰它们会 TDZ 报错。
  function usePools(x) {
    inst = x;
    pools = x.pools; caps = x.caps; links = x.links;
    if (x.prefixMap) prefixGroupMap = x.prefixMap;
  }
  // 切换当前实例: 重绑全部视图变量(在主循环的实例遍历里调用)
  function useInstance(x) {
    inst = x;
    pools = x.pools; caps = x.caps; links = x.links;
    waitQueue = x.waitQueue; prefillQ = x.prefillQ; prefilling = x.prefilling;
    kvXfer = x.kvXfer; decodeWait = x.decodeWait; decoding = x.decoding;
    groupPull = x.groupPull;
    effL3BW = x.effL3BW; l3PoolBytes = x.l3PoolBytes;
    curWave = x.curWave; prepWave = x.prepWave; prevDecodeL3 = x.prevDecodeL3;
    if (x.prefixMap) prefixGroupMap = x.prefixMap;   // S4: 前缀池视图(亲和开时各实例独立)
    // 多实例下 prefill/decode 的资源视图 = 该实例自己的(单实例时 rP/rD 由 PD 逻辑决定)
    // ⚠️ pP 用 x.pP 而非 x.p(2026-08-21 修 bug): x.pP 含**按本实例卡数重算的 a/b**;
    // 用 x.p 会让每实例沿用按总卡数推导的 a/b ⇒ prefill 速度快 gpus/instGpus 倍。
    if (multiInst) { rP = x.r; rD = x.r; pP = x.pP; }
  }

  function sizeInTier(blk, tier) { return blk.size * tierRatio[tier]; }

  function poolAdd(tier, blk) {
    let pool = pools[tier];
    pool.blocks.push(blk); pool.blockIndex[blk.id] = blk;
    pool.used += sizeInTier(blk, tier);
    pool.accessOrder.push(blk.id);
    pool.freq[blk.id] = (pool.freq[blk.id] || 0) + 1;
    blk.tier = tier;
  }
  function poolRemove(tier, blkId) {
    let pool = pools[tier];
    let blk = pool.blockIndex[blkId];
    if (!blk) return null;
    pool.used -= sizeInTier(blk, tier);
    delete pool.blockIndex[blkId];
    let bi = pool.blocks.indexOf(blk); if (bi >= 0) pool.blocks.splice(bi, 1);
    let ai = pool.accessOrder.indexOf(blkId); if (ai >= 0) pool.accessOrder.splice(ai, 1);
    return blk;
  }
  function touchBlock(tier, blkId) {
    // O(1) 访问记录：时间戳供 LRU，计数供 LFU（避免 accessOrder.indexOf 的 O(n²) 开销）
    let pool = pools[tier];
    let blk = pool.blockIndex[blkId];
    if (blk) blk.lastTouch = now;
    pool.freq[blkId] = (pool.freq[blkId] || 0) + 1;
  }

  // 跨层链路(L2 PCIe/C2C + L3 NVMe)与前缀拉取单飞状态已下沉到 makeInstance —— 每实例
  // 一条独立总线/一份单飞表。主循环通过 links / groupPull 视图变量访问当前实例的那份。
  let coalesce = !!p.fetchCoalesce;
  function scheduleTransfer(blk, from, to) {
    let link = links[from + '>' + to];
    if (!link) return 0;
    let bytes = blk.size * tierRatio[from]; // 读出一侧体积
    // 排队：等本方向 + 反方向(共享总线) 的最近完成时刻
    let start = Math.max(now, link.busyUntil, link.shared.busyUntil);
    let dur = bytes / link.bw;
    link.busyUntil = start + dur;
    link.shared.busyUntil = start + dur; // 共享总线：双向同时占用
    poolRemove(from, blk.id);
    blk.available = false;
    blk.arriveAt = start + dur;
    blk.srcTier = from; // 在途期间按源层读速计入decode成本（块未到达前不可用）
    poolAdd(to, blk); // 立即占用目标容量（预留）
    inFlight.push(blk);
    stats.transferBytes += bytes;
    // 按链路归类（供瞬时速率差分）：HBM↔DRAM 走 L2(PCIe/C2C)，DRAM↔SSD 走 L3(NVMe)
    if (from === 'hbm' || to === 'hbm') stats.transferL2Bytes += bytes;
    else stats.transferL3Bytes += bytes;
    return dur;
  }

  // ---------- 请求生成 ----------
  // N = 请求数（1:1 直接对应，不再 ×2）；上限256为性能保护；可通过 overrides.nreq 指定
  // s = strategy 声明提到最前(2026-08-28): 前缀预热段(双层)的 dram 容量判定要调
  // evictThreshold('dram')(读 s.eviction), 原声明在预热段之后 ⇒ TDZ 报错。
  // 'ssd' 分支恰好不读 s(直接 return 0.98)才一直没暴露。
  let s = strategy;
  let { N, requests } = generateRequests(p, overrides, rng, prefixGroupMap);
  if (p.prefixHit > 0.001) {
    // S4: 把前缀组表分发给各实例。
    // 亲和关 → 全部实例共用**同一个对象引用**(全局共享前缀池, 与历史口径逐位一致);
    // 亲和开 → 每实例一份**深拷贝**(blkIds 独立增长) ⇒ 命中要求同前缀落到同一实例。
    instances.forEach(x => {
      if (!affinity) { x.prefixMap = prefixGroupMap; return; }
      let cp = {};
      Object.keys(prefixGroupMap).forEach(gid => {
        let g = prefixGroupMap[gid];
        cp[gid] = { prefixTokLen: g.prefixTokLen, blkIds: [], refcount: 0, activated: false };
      });
      x.prefixMap = cp;
    });
    prefixGroupMap = instances[0].prefixMap;   // 当前视图指向实例0(useInstance 会按需重绑)

    // (单批 t=0 到达覆盖已移到请求生成之后、本组分配块之前 —— 见上方注释:
    //  原写在此处时被 prefixHit>0.001 的条件块包裹, prefixHit=0 时失效。)

    // ===== 前缀预热（HiCache 语义, 2026-08-11）=====
    // 模拟"热门前缀常驻 L3(SSD)"：仿真开始前为各组把前缀块直接放入 ssd 池（activated=true），
    // 组内 sharer/founder 到达即命中（attach 到 ssd 层块 → fetchTime 计入 TTFT）。
    // 物理对应：真实 prefix-cache 服务（sglang HiCache/mooncake）中前缀块已被历史请求写入 SSD
    // 并驻留，无需现场由 founder 建立——消除"founder 同时到达、sharer 必须等 founder 完成"
    // 造成的假性 miss（这正是构造"L3 带宽显著影响 TTFT"场景的前提）。
    // 开关：radix + prefixHit>0 + 前缀预热勾选时生效；SSD 容量放不下该组前缀则跳过（保底 miss 路径）。
    // 双层预热(2026-08-28, prefixWarmL2): 嵌套语义 h_l2 ≤ h_l3 —— 前缀 [0, P×h_l2/h) 段入 dram
    // (pwL_* 块), [P×h_l2/h, P) 段入 ssd (pw_* 块)。两组块 id 不重叠、不做真副本:
    // findBlock 按 hbm→dram→ssd 顺序查找, dram 命中天然遮蔽 ssd 同段(与"L2 是 L3 热子集"等价)。
    // ⚠️ L3 段必须扣掉 L2 段(l3Tok = P − l2Tok)——否则 ssdCoveredTok/fetchTime 不变, 旋钮没接线。
    // L2 命中按"免费"口径(不进 fetchTime/不占拉取带宽; decode 侧 L2 读本就有 busyUntil 排队)。
    // 容量回退: dram 放不下 L2 段 → L2 段并入 ssd(全量 L3, 主语义保住); ssd 放不下 → 整组跳过。
    // prefixWarmL2=0(默认) 时 l2Tok=0 走原路径, 与原实现逐位一致(零回归保证)。
    if (p.prefixCache === 'radix' && p.prefixWarm && p.prefixHit > 0.001) {
      // 预热到指定实例(亲和关时只有 instances[0] 这一份全局池)
      function warmInto(target, gmap) {
        let prevInst = inst;
        usePools(target);                    // 切到目标实例的池/容量视图(仅资源, 不碰波次状态)
        Object.keys(gmap).forEach(gid => {
          let g = gmap[gid];
          let nTok = g.prefixTokLen;
          if (nTok <= 0) return;
          // 双层预热: l2Tok = 组前缀的 h_l2/h 比例段(请求口径 h_l2×inputLen ⇒ 组口径 P×h_l2/h)
          let l2Tok = 0;
          if (p.prefixWarmL2 > 0.001) {
            l2Tok = Math.min(nTok, Math.max(0, Math.round(nTok * p.prefixWarmL2 / Math.max(p.prefixHit, 1e-9))));
          }
          let needBytes = nTok * kvPerTok;
          // C3 修复(2026-08-12): 注入容量口径与正常写入一致(evictThreshold=0.98),
          // 不再按 100% 填满——避免注入即满触发后续强制淘汰(prewarmed 无淘汰保护时被误伤)
          if (caps.ssd <= 0 || pools.ssd.used + needBytes * tierRatio.ssd > caps.ssd * evictThreshold('ssd')) return;
          // dram 容量判定用 dram 自己的阈值(勿照抄 ssd 的 0.98——阈值应来自该层语义);
          // 放不下则 L2 段并入 L3(回退单层预热, 与现状一致)
          if (l2Tok > 0 && (caps.dram <= 0 || pools.dram.used + l2Tok * kvPerTok * tierRatio.dram > caps.dram * evictThreshold('dram'))) {
            l2Tok = 0;
          }
          g.l2Tok = l2Tok;   // placeRequest 的 clamp 按层优先级判定要用(见 attach 段)
          // 分层注入: 同一段切分逻辑(merge/超级块)对两段各自适用; l2Tok=0 时 L3 段
          // 块数/id 与原实现逐位一致
          let blkIds = [];
          [ ['dram', l2Tok, 'pwL_'], ['ssd', nTok - l2Tok, 'pw_'] ].forEach(seg => {
            let tier = seg[0], segTok = seg[1], idPrefix = seg[2];
            if (segTok <= 0) return;
            let nBlocksRaw = Math.ceil(segTok / p.blockSize);
            let merge = Math.max(1, Math.ceil(nBlocksRaw / MAX_SIM_BLOCKS));
            let nSimBlocks = Math.ceil(nBlocksRaw / merge);
            let simBlockTokens = merge * p.blockSize;
            for (let b = 0; b < nSimBlocks; b++) {
              let tokHere = Math.min(simBlockTokens, segTok - b * simBlockTokens);
              if (tokHere <= 0) break;
              // ⚠️ 块 id 必须带实例号: 亲和开启时同一组会在多个实例各热一份, id 若相同
              // 则 findBlock 跨实例串味(它只查当前实例池, 但 id 冲突会让语义混乱)
              // 多实例时 id 必须带实例号(共享语义下各实例也各存一份, id 不能冲突);
              // 单实例保持原 id 格式 ⇒ 与历史逐位一致
              let id = (instances.length > 1) ? (idPrefix + 'i' + target.id + '_' + gid + '_' + b) : (idPrefix + gid + '_' + b);
              poolAdd(tier, { id: id, tokens: tokHere, size: tokHere * kvPerTok, refcount: 0,
                available: true, arriveAt: 0, shared: true, groupId: gid, reqId: -1, lastTouch: 0, prewarmed: true });
              blkIds.push(id);
            }
          });
          if (blkIds.length) { g.blkIds = blkIds; g.activated = true; }
        });
        usePools(prevInst);
      }
      if (!affinity) {
        // 全局共享前缀缓存(默认): 语义是"所有实例都能看到同一份前缀 KV"(相当于有全局共享
        // 存储层)。实现上 pools 仍按实例隔离(findBlock 只查当前实例池), 故必须给**每个实例**
        // 都注入一份预热块 —— 否则只有实例 0 能命中, 其余实例 findBlock 返回 null,
        // 命中率会随实例数虚假下降(h=80%/4实例 实测掉到 19.6%)。
        // 块 id 带实例号避免跨实例串味; prefixMap 仍是共享对象, 故 blkIds 由最后一次写入
        // 覆盖 —— 但各实例 findBlock 时只认自己池里的那些 id, 因此需要 id 与实例对应。
        // ⇒ 亲和关时也按实例生成 id, 但 blkIds 存**每实例各自的** id 列表。
        instances.forEach(x => {
          if (instances.length === 1) { warmInto(x, prefixGroupMap); return; }
          // 多实例 + 共享语义: 每实例独立一份 prefixMap 承载自己的 blkIds(内容相同、id 不同),
          // 命中判定因此对所有实例都成立 ⇒ 等价于"全局共享前缀缓存"
          let cp = {};
          Object.keys(prefixGroupMap).forEach(gid => {
            let g = prefixGroupMap[gid];
            cp[gid] = { prefixTokLen: g.prefixTokLen, blkIds: [], refcount: 0, activated: false };
          });
          x.prefixMap = cp;
          warmInto(x, cp);
        });
        prefixGroupMap = instances[0].prefixMap;
      } else {
        // 亲和开启: 预热块代表"历史同前缀流量在该实例留下的缓存"。
        // 关键语义 —— 一个组的前缀只会热到它**按当前路由策略应当归属**的那台实例:
        //  · hash_prefix: 归属确定(hash(gid) % n) ⇒ 该组请求必落到有缓存的那台 ⇒ 命中保住
        //  · 其他策略: 归属不可预知, 用 hash 选一台作为"历史上恰好落在那里"的代表 ⇒
        //    后续请求只有 1/n 概率落到有缓存的实例 ⇒ 命中率≈理想÷实例数(随机路由的塌陷)
        // 这样 pPrefixHit 就从"保证值"变成"上限", 实际命中由路由质量决定 —— 正是 S4 的目的。
        // (若给每台都热全部组, 等价于每台都有完整缓存, 任何策略都满命中, 无法体现路由差异)
        instances.forEach(x => {
          let own = {};
          Object.keys(x.prefixMap).forEach(gid => {
            if ((hashKey(gid) % instances.length) === x.id) own[gid] = x.prefixMap[gid];
          });
          warmInto(x, own);
        });
      }
    }
  }

  // ---------- JS 策略编译 ----------
  let jsAdmit = null, jsEvict = null, jsPrefetch = null, jsPlace = null, jsRoute = null;
  if (strategyMode === 'js' && strategy.dsl && strategy.dsl.trim()) {
    try {
      let helpers = {
        hbmUsage: function() { return caps.hbm > 0 ? pools.hbm.used / caps.hbm : 0; },
        dramUsage: function() { return caps.dram > 0 ? pools.dram.used / caps.dram : 0; },
        ssdUsage: function() { return caps.ssd > 0 ? pools.ssd.used / caps.ssd : 0; },
        hbmUsed: function() { return pools.hbm.used; },
        dramUsed: function() { return pools.dram.used; },
        ssdUsed: function() { return pools.ssd.used; },
        prefetchBlock: function(fromTier, blkId) {
          let from = pools[fromTier];
          let blk = from && from.blockIndex[blkId];
          if (!blk || !blk.available) return false;
          if (pools.hbm.used + blk.size > caps.hbm * 0.95) return false;
          scheduleTransfer(blk, fromTier, 'hbm');
          stats.prefetches++;
          return true;
        },
        hasBlock: function(tier, blkId) { return !!pools[tier].blockIndex[blkId]; },
        getBlocksIn: function(tier) { return Object.keys(pools[tier].blockIndex); },
      };
      let fn = new Function('hbmCap','dramCap','ssdCap','hbmUsage','dramUsage','ssdUsage','hbmUsed','dramUsed','ssdUsed','prefetchBlock','hasBlock','getBlocksIn',
        strategy.dsl + '\nreturn {admit:admit, evict:evict, shouldPrefetch:shouldPrefetch, place:place};');
      let userFns = fn(caps.hbm, caps.dram, caps.ssd, helpers.hbmUsage, helpers.dramUsage, helpers.ssdUsage,
        helpers.hbmUsed, helpers.dramUsed, helpers.ssdUsed, helpers.prefetchBlock, helpers.hasBlock, helpers.getBlocksIn);
      if (userFns.admit) jsAdmit = userFns.admit;
      if (userFns.evict) jsEvict = userFns.evict;
      if (userFns.shouldPrefetch) jsPrefetch = userFns.shouldPrefetch;
      if (userFns.place) jsPlace = userFns.place;
      if (userFns.route) jsRoute = userFns.route;   // S3: 路由钩子 route(req, instances) → 下标或实例对象
    } catch(e) { console.warn('JS strategy compile error:', e.message); }
  }

  // ---- 路由策略(S2: 轮询; S3 扩展) ----
  // 契约: 输入请求, 返回目标实例对象。只允许读**当前**可观测量(队列长度/KV 占用),
  // 不得读未来状态(否则成了"先知路由", 结论无参考价值)。
  // (s = strategy 已前移到请求生成段开头, 2026-08-28)
  let _rrCursor = 0;
  // 实例在途负载(请求数): 路由决策的主要可观测量。
  // 用"在途请求数"而非仅 waitQueue —— 排队中 + 正在算 + 正在传 + 正在解码都占该实例资源。
  function instLoad(x) {
    return x.waitQueue.length + x.prefillQ.length + x.prefilling.length
      + x.kvXfer.length + x.decodeWait.length + x.decoding.length;
  }
  // (instKvPressure 已删 2026-09-03: 它只服务 least_kv 路由档, 该档已随 sgl-router 对齐删除。)
  function routeRequest(req) {
    if (instances.length === 1) return instances[0];
    // JS 策略钩子优先(与 admit/evict/prefetch/place 同构): 返回实例下标或实例对象
    if (jsRoute) {
      try {
        let v = jsRoute(req, instances);
        if (typeof v === 'number' && instances[v]) return instances[v];
        if (v && typeof v === 'object' && v.pools) return v;
      } catch(e) {}
    }
    let n = instances.length;
    switch (routePolicy) {
      // (least_queue/least_kv 已删 2026-09-03: sgl-router 无 least-connection 实现 ——
      //  全局扫描取最空实例在生产 router 里因开销与状态同步问题不被采用,
      //  由 power_of_two 逼近同等均衡度; DSL 旧档已收敛到 power_of_two。)
      // 随机两选优(power of two choices): 随机抽 2 个取较空者。
      // 经典结论——只需 2 个采样即可把最大负载从 O(log n) 降到 O(log log n),
      // 开销远低于全局扫描(sgl-router 生产实现), 均衡度接近理想 least-connection。
      case 'power_of_two': {
        let i = Math.floor(rng() * n) % n;
        let j = Math.floor(rng() * n) % n;
        if (i === j) j = (j + 1) % n;
        return instLoad(instances[i]) <= instLoad(instances[j]) ? instances[i] : instances[j];
      }
      // 前缀一致性哈希: 同前缀恒定落同实例 ⇒ 缓存亲和最优, 但负载可能倾斜
      // (热前缀会把流量压到一台)。这正是 router 设计的核心 tradeoff。
      case 'hash_prefix':
        return instances[hashKey(prefixKeyOf(req)) % n];
      // 纯随机: 作为"最差缓存亲和"的对照基线
      case 'random':
        return instances[Math.floor(rng() * n) % n];
      case 'round_robin':
      default:
        return instances[_rrCursor++ % n];
    }
  }
  let completedReqs = [];
  // PD 真分离(2026-08-20): prefill 完成后等待 KV 从 P 传到 D 的队列(仅 pdReal 时非空)
  // P→D 互联有效带宽(B/s) = 标称 × 利用率
  let pdLinkEffBW = Math.max(p.pdLinkBW * 1e9 * p.pdLinkUtil, 1);
  // 每请求需跨节点搬运的 KV 字节数。
  // 关键事实(2026-08-20 核实): 引擎的 calcKvPerToken 对 MLA **已是压缩 latent 口径**
  //   MLA:     layers × (kvLora + ropeDim) × dtypeBytes     ← 压缩表示, 正是跨节点要传的量
  //   GQA/MHA: 2 × layers × kvHeads × headDim × dtypeBytes   ← 全秩
  // 所以"按 attention 类型自适应"= 直接用 kvPerTok 即可, MLA 的传输优势自动体现
  // (与平台B kv_transfer_cost 同口径, 可交叉验证)。
  // pdKvComp=false(全量档) 提供对照: 强制按**全秩** GQA 口径计费, 用于回答
  // "如果没有 MLA 压缩, PD 分离的传输代价会高多少" —— MLA 场景下两档差异显著。
  // 传输量按请求实际持有的 KV token 数(输入全长, 含命中前缀——KV 无论来自命中还是重算,
  // 都在 P 的 HBM 里, 都要搬到 D)。
  function pdKvXferBytes(q) {
    let tok = Math.max(0, q.inputLen || 0);
    if (p.pdKvComp) return tok * kvPerTok;   // 自适应: MLA 自动走压缩, GQA/MHA 走全秩
    // 全量对照档: 按全秩 KV 计费(MLA 也按 2×kvHeads×headDim 展开)
    let full = 2 * p.layers * Math.max(p.kvHeads || 0, 1) * Math.max(p.headDim || 0, 1) * p.dtypeBytes;
    return tok * Math.max(full, kvPerTok);
  }

  function admitTier(req) {
    // 2026-09-03 第4批: 恒 'hbm' —— sglang 新请求 KV 只能分配在 device pool;
    // 原 threshold/cost_based/priority 三档(新 KV 直接落 DRAM/SSD)已随 parseDSL 收敛删除。
    if (jsAdmit) { try { let r0 = jsAdmit(req); if (r0) return r0; } catch(e) {} }
    return 'hbm';
  }

  function evictThreshold(tier) {
    if (tier === 'hbm') return s.eviction.hbm_evict_threshold || 0.9;
    if (tier === 'dram') {
      // 主规则直接淘汰 dram（EVICT: lru from dram when XX% -> ssd）时阈值存于 hbm_evict_threshold
      if (s.eviction.second && s.eviction.second.from_tier === 'dram') return s.eviction.second.threshold || 0.95;
      if (s.eviction.from_tier === 'dram') return s.eviction.hbm_evict_threshold || 0.9;
      return 0.95;
    }
    return 0.98;
  }
  function downTier(tier) { return tier === 'hbm' ? 'dram' : 'ssd'; }

  function pickVictim(tier) {
    let pool = pools[tier];
    // C1 修复(2026-08-12): prewarmed 块为 L3 常驻(pinned)前缀, 永不被淘汰——HiCache 常驻语义
    let avail = pool.blocks.filter(b => b.available && !b.prewarmed);
    if (avail.length === 0) return null;
    if (jsEvict) {
      try { let v = jsEvict(pool, tier); if (v && pool.blockIndex[v.id] && v.available && !v.prewarmed) return v; } catch(e) {}
    }
    // 淘汰算法(2026-09-02): 恒 LRU —— 对齐 sglang RadixCache.evict(), 它按 last_access_time
    // 建最小堆逐个弹出最久未访问的叶子(radix_cache.py:568-590)。原 lfu/fifo 分支已删除
    // (sglang 无对应实现; DSL 侧也已收敛为只接受 lru)。
    return avail.reduce((a, b) => (a.lastTouch || 0) <= (b.lastTouch || 0) ? a : b);
  }

  // 放置请求：真实共享前缀块(引用计数) + 自有块；容量不足时按策略淘汰并跨层搬运
  function placeRequest(req, tier) {
    if (jsPlace) { try { let t0 = jsPlace(); if (t0) tier = t0; } catch(e) {} }
    // 2026-09-03 第4批: 原 placement tiered(>8K 直接落 DRAM)/adaptive(按水位选层)两档已删
    // —— 新请求 KV 直接落慢层在 sglang 里不存在; 慢层驻留只通过淘汰写回链产生。
    if (caps[tier] <= 0) tier = downTier(tier);

    // 1) 挂接已存在的共享/保留块（真实引用计数）
    req.prefixBlkIds = [];
    let coveredTok = 0;
    let attachIds = req.retainIds ? req.retainIds
      : (req.groupId && prefixGroupMap[req.groupId] ? prefixGroupMap[req.groupId].blkIds : []);
    let ssdCoveredTok = 0;
    // 分层命中记账(2026-08-20): findBlock 本就返回 tier, 此前只把 ssd 单独记账(供 fetchTime),
    // hbm/dram 被合并进"非 SSD"无从区分。这里补记 L1/L2 原始命中量, 用于输出**实测**分层命中率
    // ——与输入 pPrefixHit(逻辑命中率 h)对比可量化 clamp/容量淘汰对命中的侵蚀。
    let hbmCoveredTok = 0, dramCoveredTok = 0;
    attachIds.forEach(id => {
      let loc = findBlock(id);
      if (loc) { req.prefixBlkIds.push(id);
        if (!loc.blk.prewarmed) loc.blk.refcount++;   // 预热块 L3 常驻, 不参与引用计数(防 founder 完成归零误删)
        coveredTok += loc.blk.tokens;
        if (loc.tier === 'ssd') ssdCoveredTok += loc.blk.tokens;
        else if (loc.tier === 'dram') dramCoveredTok += loc.blk.tokens;
        else hbmCoveredTok += loc.blk.tokens; }
    });
    // 命中量不超过自身前缀长度: 组前缀 P 覆盖到最长请求, 短请求 attach 全部 P 块但
    // clamp 到自己的 inputLen×h——保证"不同长度请求命中固定比例 h"的语义
    // 2026-08-28 双层预热(g.l2Tok>0): 分层结构确定(前段 dram + 后段 ssd), clamp 必须按
    // 层优先级——L2 段是前缀最前段优先保留, L3 段吃剩余额度; 沿用"固定 ssd + 快层按比例
    // 分摊"会让短请求的 L2/L3 归因偏离设定值。非双层组保持原口径(零回归)。
    let _grp = req.groupId ? prefixGroupMap[req.groupId] : null;
    if (req.groupId && !req.isFounder && coveredTok > req.prefixTokLen) {
      coveredTok = req.prefixTokLen;
      if (_grp && _grp.l2Tok > 0) {
        let _cap = req.prefixTokLen;
        let _kD = Math.min(dramCoveredTok, _cap);
        let _kS = Math.min(ssdCoveredTok, _cap - _kD);
        let _kH = Math.min(hbmCoveredTok, _cap - _kD - _kS);
        dramCoveredTok = _kD; ssdCoveredTok = _kS; hbmCoveredTok = _kH;
      } else {
        ssdCoveredTok = Math.min(ssdCoveredTok, req.prefixTokLen);
      }
    }
    // clamp 后的分层归因(2026-08-20): ssd 口径必须与 fetchTime 所用的 ssdCoveredTok 完全一致
    // (不可改, 否则动到传输时间), 故先固定 ssd, 余量按 hbm/dram 原始比例分摊——保证
    // hitL1+hitL2+hitL3 == coveredTok 恒等(守恒), 分母用 inputLen ⇒ 三层+miss = 100%。
    // 双层预热组: clamp 已按层优先级完成, 三层直接记账(不再比例分摊)。
    let _statL3 = ssdCoveredTok;
    let _statL1, _statL2;
    if (_grp && _grp.l2Tok > 0) {
      _statL2 = dramCoveredTok;
      _statL1 = Math.max(0, coveredTok - _statL3 - _statL2);
    } else {
      let _rest = Math.max(0, coveredTok - _statL3);
      let _rawFast = hbmCoveredTok + dramCoveredTok;
      _statL1 = _rawFast > 0 ? _rest * (hbmCoveredTok / _rawFast) : 0;
      _statL2 = _rest - _statL1;
    }
    stats.hitTokL1 += _statL1; stats.hitTokL2 += _statL2; stats.hitTokL3 += _statL3;
    // 双层预热(2026-08-28): 每请求实际 L2 命中量(clamp 后)——race/be 的前缀区间适配要用:
    // L2 段[0, l2Hit) 免费可用, 拉取与 GPU 重算都只需覆盖 [l2Hit, H) 段。非双层组恒 0(零回归)。
    req._l2HitTok = (_grp && _grp.l2Tok > 0) ? dramCoveredTok : 0;
    // S4: 每实例命中量(token 加权) —— 用于输出各实例命中率与路由亲和效果
    if (instances[req.instId || 0]) {
      instances[req.instId || 0].hitTok += coveredTok;
      instances[req.instId || 0].reqTok += req.inputLen;
    }
    // miss = 需 GPU 重算的 token(与下方 req.prefillTokens 同口径); 分母 = 请求输入长度
    stats.missTok += Math.max(0, req.inputLen - coveredTok);
    stats.reqTokTotal += req.inputLen;
    // L3(SSD) 命中：前缀 KV 需从 L3 拉回 GPU。简化传输模型(2026-08-12):
    // 传输延迟 = 传输大小/有效带宽 = ssdCoveredTok×kvPerTok / (ssdBW×0.9)。
    // p.fetchFixedUs 默认 0（纯带宽）；填 >0 恢复"每块固定开销 + 带宽"双项模型
    //（原模型: n块×τ_pf + 字节/有效带宽, τ_pf=209μs 使 blockSize 小时带宽敏感性被淹没）。
    //（ssdBW 反映 page_size 效应：实测 sglang mooncake page1≈1.05GB/s → page64≈27GB/s）。
    // wait_complete 下 prefill 等 KV 到齐；HBM/DRAM 前缀命中近似免费（片内/近存拷贝 ~μs-ms 级）。
    // 双路径合并后：followUp（retainIds 含公共前缀块）命中 SSD 块同样计 L3 拉取
    // C6 修正(2026-08-18): 去掉 !req.isFounder 排除——预热(HiCache)语义下 founder 同样 attach
    // L3 常驻前缀块, 同样需把 KV 拉回 GPU 才能计算, 排除导致 founder 不付拉取时间且 decode 期
    // 前缀块按 SSD 读计费(与 sharer 口径不一致)。非预热组 founder 的 blkIds 为空 → ssdCoveredTok=0
    // → fetchTime=0, 行为不变。
    req.fetchTime = (req.groupId || req.retainIds) && ssdCoveredTok > 0
      ? Math.ceil(ssdCoveredTok / p.blockSize) * (isFinite(p.fetchFixedUs) ? p.fetchFixedUs : 209) * 1e-6
        + ssdCoveredTok * kvPerTok / Math.max(p.ssdBW * 1e9 * 0.9, 1) : 0;
    req._fetchDone = req._fetchDone || 0;   // C7(2026-08-18): 保留排队期已拉取进度, 不覆盖(best_effort)
    // ⚠️ 撤销"被估算目标提前盖的章"(2026-09-01, TTFT 时间戳口径):
    //   排队期拉取对 waitQueue 请求的目标量是 l3FetchEst(估算, 见 queueFetchTarget) ——
    //   若它 < 准入时算出的真实 fetchTime, 拉取作业会在达到估算目标时就盖章 _ft1, 而
    //   `_ft1 === undefined` 是一次性哨兵 ⇒ 之后永不可更新, _ft1 永远停在那个过早的时刻。
    //   后果: fetchExposure = max(0, _ft1 − waveEmpty) 会漏计 prefilling 里的剩余等待。
    //   触发条件: 前缀块在排队期间被降级到 SSD(ssdCoveredTok 变大); 预热(pinned)组不触发。
    //   修正: 准入时若"已盖章但实际未拉够", 撤销盖章, 交由 prefilling 拉取作业重新盖。
    if (req._ft1 !== undefined && (req._fetchDone || 0) < req.fetchTime) req._ft1 = undefined;
    // C4 修复(2026-08-18): 记录本请求已从 L3 命中拉取的前缀块——fetch 物理上把前缀 KV 搬入
    // GPU(HBM), 运行期 decode 每 pass 应读 HBM 而非按 SSD 读速重复计费(原实现前缀块常驻 SSD,
    // 高命中场景 decode 被 L3 带宽瓶颈化, TPOT/延迟虚高 20-30× 并反向挤压 prefill 抬高 TTFT)。
    // 池位置不变(L3 常驻/共享语义), 仅 decode 读账归 HBM; 因容量压力被真实淘汰到 SSD 的块不受影响。
    req._fetchedIds = (req.fetchTime > 0 && ssdCoveredTok > 0) ? {} : null;
    if (req._fetchedIds) attachIds.forEach(id => { let loc = findBlock(id); if (loc && loc.tier === 'ssd') req._fetchedIds[id] = loc.blk.tokens; });
    // 2) 计算自有 token（前缀块被丢弃的部分需要重算）
    let groupPrefixTokens = 0, ownTokens;
    if (req.retainIds) {
      ownTokens = Math.max(0, req.prevTotalTok - coveredTok) + Math.max(64, req.inputLen - req.prevTotalTok);
    } else if (req.isFounder && req.groupId && prefixGroupMap[req.groupId] && prefixGroupMap[req.groupId].blkIds.length === 0) {
      groupPrefixTokens = req.prefixTokLen;
      ownTokens = req.inputLen - groupPrefixTokens;
    } else if (req.groupId) {
      ownTokens = Math.max(0, req.inputLen - coveredTok);
      if (coveredTok > 0) { stats.prefixHits++; stats.prefixSavedBytes += coveredTok * kvPerTok; }
    } else {
      ownTokens = req.inputLen;
    }
    if (req.retainIds && coveredTok > 0) { stats.sessionHits = (stats.sessionHits || 0) + 1; stats.prefixSavedBytes += coveredTok * kvPerTok; }
    ownTokens = Math.max(0, Math.round(ownTokens));
    // 前缀缓存的核心收益：sharer/后续轮 跳过已缓存前缀的 prefill 计算（降 TTFT）
    // founder 需全量 prefill 以建立共享块；普通请求全量 prefill
    // (2026-08-13): 命中 100% 时 ownTokens/prefillTokens=0——完全跳过 prefill 计算,
    // 不再保底 64 token(那会让"100% 命中"仍有 ~7% compute 占比)
    req.prefillTokens = Math.max(0, req.inputLen - coveredTok);
    // P0-3(2026-08-12): 位置成本偏移——未命中段真实位置从命中量起算（修复前从 0 起算,
    // 低估 b·H·N 项: 命中越深偏移越大）。followUp 取历史总长(新 token 在其后)。
    req._pfStartPos = req.retainIds ? req.prevTotalTok : coveredTok;
    // P0-1/P0-2(2026-08-14): race 策略 —— 可复用前缀[0,H] 双向夹逼:
    // GPU 从前往后计算前缀 + L3 从后往前拉取前缀, 相遇即停(前缀完整); 相遇后 GPU 计算非复用后缀[H,L]。
    // 仅对"有 L3 命中(fetchTime>0)"的请求生效; 无命中请求走普通 prefill。
    req._race = !!(s.prefetch && s.prefetch.type === 'race' && req.fetchTime > 0);
    req._raceTok = 0;        // race: L3 从尾部(H端)已拉取的前缀 token 数
    req._raceMeetTok = -1;   // race: 相遇点 GPU 已算前缀 token 数; -1=尚未相遇(阶段0: GPU 算前缀)
    // best_effort(2026-08-14): 对齐 sglang —— 排队期(admit→准入prefill)尽力拉取,
    // 准入时终止拉取: 已拉**头部**直接消费, 未拉尾部前缀+后缀由 GPU 重算。
    // (2026-09-02 修正方向: head-first, 见 settleFetchStop/prefillPos 的依据注释。)
    // 仅对命中请求(fetchTime>0)生效。
    req._be = !!(s.prefetch && s.prefetch.type === 'best_effort' && req.fetchTime > 0);
    req._beFetchedTok = 0;  // be/timeout: 终止拉取时已拉前缀 token 数(定格)
    req._bePrefixCap = 0;   // be/timeout: 未拉前缀长度(终止时 = H - _beFetchedTok, GPU 重算段)
    req._beHeadTok = 0;     // be/timeout: head-first 下 GPU 重算段的起始位置(= 已拉头部末端)
    // timeout(2026-09-02, sglang 默认策略 hicache_storage_prefetch_policy=timeout):
    // 语义 = wait_complete + 超时上限。到达即异步拉取, 拉齐则照常等齐再算(等同 wc);
    // 但超过时限就**终止预取**, 已拉部分直接消费、未拉前缀由 GPU 重算(定格方式等同 be)。
    // 时限公式对齐 hiradix_cache.py:_prefetch_timeout_check_linear_func —
    //   base + pages × per_page, 默认 prefetch_timeout_base=1.0s, per_page=0.25s
    //   (hybrid_cache_controller.py:260-263 的 extra_config 默认值), page = blockSize。
    req._to = !!(s.prefetch && s.prefetch.type === 'timeout' && req.fetchTime > 0);
    req._toDeadline = req._to
      ? (isFinite(p.pfTimeoutBase) ? p.pfTimeoutBase : 1.0)
        + Math.ceil((req._pfStartPos || 0) / Math.max(p.blockSize, 1))
          * (isFinite(p.pfTimeoutPerPage) ? p.pfTimeoutPerPage : 0.25)
      : Infinity;

    // 3) 构造新块（PagedAttention 块；过多时合并为超级块保证性能）
    let totalNewTokens = groupPrefixTokens + ownTokens;
    let nBlocksRaw = Math.ceil(totalNewTokens / p.blockSize);
    let merge = Math.max(1, Math.ceil(nBlocksRaw / MAX_SIM_BLOCKS));
    let nSimBlocks = Math.ceil(nBlocksRaw / merge);
    let simBlockTokens = merge * p.blockSize;
    let newBlocks = [];
    for (let b = 0; b < nSimBlocks; b++) {
      let tokHere = Math.min(simBlockTokens, totalNewTokens - b * simBlockTokens);
      let isGroup = (b * simBlockTokens) < groupPrefixTokens;
      newBlocks.push({ id: isGroup ? ('g_' + req.groupId + '_' + b) : ('r' + req.id + '_b' + b),
        tokens: tokHere, shared: isGroup });
    }
    let needBytes = newBlocks.reduce((s2, nb) => s2 + nb.tokens * kvPerTok, 0);

    // 4) 容量确保：按策略淘汰 + 跨层搬运（有传输耗时）；放不下则降级
    function ensureSpace(tierKey, bytes) {
      let pool = pools[tierKey];
      if (pool.cap <= 0) return false;
      let thr = evictThreshold(tierKey);
      let guard = pool.blocks.length + 20;
      while (pool.used + bytes > pool.cap * thr && guard-- > 0) {
        let victim = pickVictim(tierKey);
        if (!victim) break;
        poolRemove(tierKey, victim.id);
        stats.evictions++;
        if (victim.refcount > 0) stats.activeEvictions++;
        let dt = downTier(tierKey);
        if (pools[dt].cap > 0 && pools[dt].used + sizeInTier(victim, dt) <= pools[dt].cap * evictThreshold(dt)) {
          scheduleTransfer(victim, tierKey, dt);
        } else {
          stats.drops++; // 下层也放不下 → 彻底丢弃（引用它的请求将按miss/重算处理）
        }
      }
      return pool.used + bytes <= pool.cap;
    }
    let targetTier = tier;
    if (!ensureSpace(targetTier, needBytes * tierRatio[targetTier])) {
      let alt = downTier(targetTier);
      if (caps[alt] > 0 && ensureSpace(alt, needBytes * tierRatio[alt])) targetTier = alt;
      else { ensureSpace('ssd', needBytes * tierRatio.ssd); targetTier = 'ssd'; }
    }

    // 5) 写入块
    newBlocks.forEach(nb => {
      let blk = { id: nb.id, size: nb.tokens * kvPerTok, tokens: nb.tokens,
        refcount: 1, available: true, arriveAt: 0,
        shared: nb.shared, groupId: nb.shared ? req.groupId : null, reqId: req.id, lastTouch: now };
      poolAdd(targetTier, blk);
      if (nb.shared) {
        // 前缀块暂记到 founder 自身，prefill 完成时才登记到组（激活）——
        // 时间窗：vLLM 前缀缓存需 founder 的 KV 已计算完成才可命中，创建即命中是物理错误
        (req.groupBlkIds = req.groupBlkIds || []).push(nb.id);
      } else req.ownBlkIds.push(nb.id);
    });
    req.placedTier = targetTier;
    // P0-1: 输出 KV 动态分配的块合并参数（限制输出块总数 ≤ MAX_SIM_BLOCKS）
    req._outMerge = Math.max(1, Math.ceil(Math.ceil(req.outputLen / p.blockSize) / MAX_SIM_BLOCKS));
    return true;
  }

  // P0-1: decode 阶段动态分配输出 KV 块——真实系统中输出 token 持续产生新 KV，
  // 显存占用与 decode 读取量随 tokensGen 增长。修复前输出 KV 从不建块。
  // 输出块优先放 HBM（decode 生成的 KV 本就在 GPU 上），容量不足按策略淘汰/下沉。
  function allocOutBlock(q, targetTok) {
    let want = Math.min(q.outputLen, targetTok);
    let chunk = Math.max(1, q._outMerge || 1) * p.blockSize;
    while (q._outAllocTok < want) {
      let tokHere = Math.min(chunk, want - q._outAllocTok);
      let bytes = tokHere * kvPerTok;
      let tier = 'hbm';
      if (pools.hbm.cap <= 0) tier = 'dram';
      if (pools[tier].cap > 0) {
        let thr = evictThreshold(tier);
        let guard = pools[tier].blocks.length + 20;
        while (pools[tier].used + bytes > pools[tier].cap * thr && guard-- > 0) {
          let victim = pickVictim(tier);
          if (!victim) break;
          poolRemove(tier, victim.id);
          stats.evictions++;
          if (victim.refcount > 0) stats.activeEvictions++;
          let dt = downTier(tier);
          if (pools[dt].cap > 0 && pools[dt].used + sizeInTier(victim, dt) <= pools[dt].cap * evictThreshold(dt)) {
            scheduleTransfer(victim, tier, dt);
          } else stats.drops++;
        }
      }
      if (pools[tier].cap <= 0 || pools[tier].used + bytes > pools[tier].cap) {
        let alt = downTier(tier);
        if (caps[alt] > 0 && pools[alt].used + bytes * tierRatio[alt] <= pools[alt].cap * evictThreshold(alt)) tier = alt;
        else { q._outAllocTok = want; return; } // 无处可放（不应发生）
      }
      let blk = { id: 'r' + q.id + '_o' + (++q._outSeq), size: bytes, tokens: tokHere,
        refcount: 1, available: true, arriveAt: 0, shared: false, groupId: null,
        reqId: q.id, lastTouch: now };
      poolAdd(tier, blk);
      q.ownBlkIds.push(blk.id);
      q._outAllocTok += tokHere;
    }
  }

  function findBlock(id) {
    if (pools.hbm.blockIndex[id]) return { tier: 'hbm', blk: pools.hbm.blockIndex[id] };
    if (pools.dram.blockIndex[id]) return { tier: 'dram', blk: pools.dram.blockIndex[id] };
    if (pools.ssd.blockIndex[id]) return { tier: 'ssd', blk: pools.ssd.blockIndex[id] };
    return null;
  }

  // 前缀树渐进激活（sglang RadixAttention）：founder prefill 每完成一段，已算好的前缀块即刻
  // 对组内后续请求可用。预热组跳过（预热块已驻留 SSD）；race 请求 GPU 从头重算不参与。
  // 流体模式每步调用; 波次模式在波结算时调用(波次粒度)
  function progressiveActivate(q) {
    let gid = q.groupId && prefixGroupMap[q.groupId];
    // 2026-08-28 双层预热: pw 判定改跨层 findBlock —— L2-only 预热(h_l2=h_l3 或 ssd 容量不足
    // 只热了 dram 段)时 blkIds[0] 在 dram 池, 硬编码查 ssd 会取到 undefined ⇒ pw=false ⇒
    // 预热组被当成"待 founder 建立"走进度激活, 把已注入的预热块覆盖掉(静默丢命中)
    let _pw0 = gid && gid.blkIds.length ? findBlock(gid.blkIds[0]) : null;
    let pw = !!(_pw0 && _pw0.blk.prewarmed);
    if (!q._race && p.prefixCache === 'radix' && q.groupId && q.groupBlkIds && gid && !pw) {
      let availN = Math.max(1, Math.min(q.groupBlkIds.length, Math.floor(q._pfDone / q._pfTotal * q.groupBlkIds.length)));
      prefixGroupMap[q.groupId].blkIds = q.groupBlkIds.slice(0, availN);
      prefixGroupMap[q.groupId].activated = true;
    }
  }

  // prefill 完成统一出口（2026-08-18, 波次模式提取共用）：单飞组状态 + 前缀激活 + 转 decode/decodeWait
  function finishPrefill(q) {
    q.prefillEnd = now;
    // ---- prefill 吞吐统计(2026-08-25) ----
    // 埋在此处而非 completeRequest: prefill 吞吐的完成事件是"prefill 算完", 与 decode 无关。
    // 长输入场景(1M tok)下大量请求 prefill 已完成但 decode 远未结束, 用 stats.completed
    // 当分子会系统性低估(实测 1M/H20 在 600s 窗口内 completed=0, 但 prefill 已处理若干请求)。
    // 双口径(二者都必要, 勿合并):
    //   pfReqTokens  = 名义输入 token —— 系统对外交付的 prompt 处理速率(用户可感知的"喂进去多少")
    //   pfCompTokens = GPU 实算 token(_pfTotal, 已扣除前缀命中/L3 拉取部分) —— 硬件真实算力产出
    // 前缀命中率 h 越高两者差越大(比值≈1/(1-h)); 只看名义会把"缓存命中"误记为"算力变强"。
    stats.pfReqDone++;
    stats.pfReqTokens += (q.inputLen || 0);
    stats.pfCompTokens += Math.max(0, q._pfTotal || 0);
    // 该请求的 prefill 服务区间 [prefillStart, prefillEnd] —— 结算时合并成并集作分母。
    // 用 prefillStart(真正开始算)而非 arrive: 排队等待不属于"prefill 在干活"的时间,
    // 把排队计入分母会让吞吐随 qps 虚降(排队越长分母越大, 而工作量没变)。
    if (q.prefillStart != null && q.prefillEnd != null && q.prefillEnd > q.prefillStart) {
      stats.pfSpans.push([q.prefillStart, q.prefillEnd]);
      stats.pfSpanSum += (q.prefillEnd - q.prefillStart);
    }
    if (q._coGpPuller && q._coGpPuller.doneAt === null) q._coGpPuller.doneAt = now; // 单飞: be/race 拉取者 prefill 完成 ⇒ 组前缀完整(拉取+重算合并)
    // 前缀缓存时间窗：founder 的 prefill 完成 → 组前缀 KV 才真正可用，激活供组内后续请求命中
    // （此前到达的组内请求按全量 prefill 处理——实测 vLLM 行为一致：组内请求同时到达时前缀
    //   完全未命中，TTFT 与 founder 相同）。hash 模式一次性激活全部；radix 渐进激活后此处兜底补齐。
    let gid = q.groupId && prefixGroupMap[q.groupId];
    // 2026-08-28 双层预热: pw 判定改跨层 findBlock(同 progressiveActivate 的修正)
    let _pw1 = gid && gid.blkIds.length ? findBlock(gid.blkIds[0]) : null;
    let pw = !!(_pw1 && _pw1.blk.prewarmed);
    if (q.groupId && q.groupBlkIds && gid && !pw) {
      // 2026-09-02: 原 prefixCache==='hash' 分支(整段哈希, 全命中才 activated 激活)已删,
      // prefixCache 恒 'radix' —— prefill 完成即把完整前缀集挂上组, 供后续请求逐块渐进命中。
      prefixGroupMap[q.groupId].blkIds = q.groupBlkIds;
    }
    // 单批模式(2026-08-19): prefill 完成即整个仿真终点——直接完成请求, 不进 decode/decodeWait
    if (p.singleBatch) { completeRequest(q); dirty = true; return; }
    // ---- PD 真分离(2026-08-20): prefill 在 P 节点算完, KV 必须经互联网络搬到 D 节点才能 decode ----
    // 物理: P/D 是两台机器, KV 不在同一片 HBM 里。传输耗时进入 TTFT(首 token 必须等 KV 到位)。
    // 单批模式已在上面返回(它不进 decode, 无需传输)。
    if (pdReal && !q._kvXferDone) {
      q._kvXferBytes = pdKvXferBytes(q);
      q._kvXferTotal = q._kvXferBytes / pdLinkEffBW;   // 秒(独立耗时, 实际可能因并发排队更久)
      q._kvXferSent = 0;
      // 传输起点 = 本步**初**(now 已是本步末)。若记 now, 则本步循环里立刻推进一份 quota,
      // 等于凭空多算 1 个 DT 的进度 ⇒ 实际墙钟恒比独立耗时少 DT(实测 28.09 vs 30.09ms),
      // 违反"共享链路只会更慢"的物理约束。
      q._kvX0 = now - DT;
      q.state = 'kvXfer';
      kvXfer.push(q);
      dirty = true;
      return;
    }
    finishKvXfer(q);
  }

  // KV 传输完成 → 原有的转 decode/decodeWait 逻辑(与非 PD 路径完全一致)
  function finishKvXfer(q) {
    // prefill 完成 → 转 decode。continuous 批下 decode 并发受 max_batch_size 约束：
    // 槽位满时先入 decodeWait（不占 prefill 流水线），槽位释放后补入。
    let decodeSlots = s.batching.max_batch_size || 8;
    let decodeOk = decoding.length < decodeSlots;   // 2026-09-02: 原 static 旁路已删
    if (decodeOk) {
      q.state = 'decode';
      q.decodeStart = now;
      if (jsPrefetch) { try { jsPrefetch(); } catch(e) {} }
      decoding.push(q);
    } else {
      q.state = 'decodeWait';
      decodeWait.push(q);
    }
    dirty = true;
  }

  // C5 修复(2026-08-18): best_effort 排队期拉取对"未准入"请求同样生效。
  // 原实现 _be 在 placeRequest(准入)才置位, 而排队期拉取循环只遍历 waitQueue/prefillQ 中
  // _be=true 的请求 → waitQueue 请求永远不被拉取, 准入即终止 → fetchTok≈0 → 全量重算
  // (h95/in8k 下 TTFT ≈ 13.6s, 60× 劣于 wait_complete 的 0.22s, 语义完全失效)。
  // 修复: 对未准入的 best_effort 候选按 groupId + 已激活组前缀实时估计 fetchTime(与
  // placeRequest 同口径: 块数×τ_fp + 字节/有效带宽), 排队期即开始拉取, 准入时定格。
  function beFetchTimeEst(r0) {
    if (r0._beFetchEst !== undefined) return r0._beFetchEst;
    r0._beFetchEst = 0;
    if (s.prefetch && s.prefetch.type === 'best_effort' && r0.groupId && prefixGroupMap[r0.groupId] && prefixGroupMap[r0.groupId].activated) {
      let ssdTok = 0;
      prefixGroupMap[r0.groupId].blkIds.forEach(id => { let loc = findBlock(id); if (loc && loc.tier === 'ssd') ssdTok += loc.blk.tokens; });
      let cap = r0.prefixTokLen || 0;
      if (ssdTok > cap) ssdTok = cap;
      if (ssdTok > 0) r0._beFetchEst = Math.ceil(ssdTok / p.blockSize) * (isFinite(p.fetchFixedUs) ? p.fetchFixedUs : 209) * 1e-6
        + ssdTok * kvPerTok / Math.max(p.ssdBW * 1e9 * 0.9, 1);
    }
    return r0._beFetchEst;
  }
  // L3 拉取量估算(wc 到达即拉专用, 2026-08-31): 与 beFetchTimeEst 同口径但**完全独立**
  // (不复用不重构 —— be 路径必须保持逐字节不变的零回归; 缓存字段也是独立名)。
  // ⚠️ waitQueue 的请求还没过 placeRequest(fetchTime 未算) —— wc 到达即拉必须
  //    在准入前拿到目标量, 只能靠这个估算(见 queueFetchTarget)。
  function l3FetchEst(r0) {
    if (r0._l3FetchEst !== undefined) return r0._l3FetchEst;
    r0._l3FetchEst = 0;
    if (r0.groupId && prefixGroupMap[r0.groupId] && prefixGroupMap[r0.groupId].activated) {
      let ssdTok = 0;
      prefixGroupMap[r0.groupId].blkIds.forEach(id => { let loc = findBlock(id); if (loc && loc.tier === 'ssd') ssdTok += loc.blk.tokens; });
      let cap = r0.prefixTokLen || 0;
      if (ssdTok > cap) ssdTok = cap;
      if (ssdTok > 0) r0._l3FetchEst = Math.ceil(ssdTok / p.blockSize) * (isFinite(p.fetchFixedUs) ? p.fetchFixedUs : 209) * 1e-6
        + ssdTok * kvPerTok / Math.max(p.ssdBW * 1e9 * 0.9, 1);
    }
    return r0._l3FetchEst;
  }
  // 排队期拉取目标(2026-08-31, wc arrival-fetch): 排队期拉取循环的统一入口。
  // be → 尽力拉取估算(含固定开销); wc → 到达即拉(2026-09-02 硬编码, 见 getParams 注释:
  // sglang 在 _add_request_to_queue 就发起预取, 无「准入才拉」分支); race → 不进排队期
  // 循环(race 的拉取在 prefilling 双向进行)。
  // ⚠️ wc 的目标量分两种来源: prefillQ(已准入)用 placeRequest 算好的 fetchTime;
  //    waitQueue(未准入, fetchTime 未算)必须用 l3FetchEst 同口径估算 —— 只读
  //    fetchTime 会让 waitQueue 恒得 0, 排队期拉取对真正的排队者全失效(实测踩到)。
  function queueFetchTarget(bq) {
    if (!s.prefetch) return 0;
    if (s.prefetch.type === 'best_effort') return beFetchTimeEst(bq);
    // wc 与 timeout 同为"到达即拉、拉齐再算", 排队期拉取口径一致(timeout 只多一个超时上限,
    // 在准入处判定 —— 见 prefilling 上岗分支的 _to 处理)。
    if (s.prefetch.type === 'none' || s.prefetch.type === 'timeout')
      return (bq.fetchTime || 0) > 0 ? bq.fetchTime : l3FetchEst(bq); // ★ 到达即拉
    return 0;
  }
  // timeout 超时判定(2026-09-02): 对齐 hiradix_cache.py:_prefetch_timeout_check_linear_func
  //   `time.monotonic() - operation.start_time > base + pages × per_page`
  // 超时后 can_terminate_prefetch 返回 true ⇒ 预取被终止, 请求照常进 batch,
  // 未拉部分由 GPU 重算(与 be 的定格路径同构, 见上岗块的 _be || _toFired 分支)。
  // 起算点 _ft0 = arrive(到达即拉), 与 sglang 的 operation.start_time 语义一致。
  function toExpired(q) {
    if (!q._to || q._toFired) return false;
    let t0 = (q._ft0 !== undefined) ? q._ft0 : q.arrive;
    return (now - t0) > q._toDeadline;
  }
  // 拉取已"结清"(拉齐 或 timeout 已超时终止) —— 三处等拉齐判据的统一口径
  // ⚠️ 必须含 _toFired(2026-09-03 修死锁): 已定格的请求其拉取**已被终止**(这正是 _toFired
  //   的含义), 它永远不会"拉齐", 而 toExpired 对已定格者又恒 false ⇒ 若没有 _toFired 分支,
  //   定格后仍需继续组波的成员(其 _pfTotal 在定格时变大, 需要后续波次)会永远卡在"未就绪",
  //   波永远上不了岗 —— 实测 timeout 阈值=0 时 0/24 全死锁。
  function fetchSettled(q) {
    return (q.fetchTime || 0) <= (q._fetchDone || 0) || q._toFired || toExpired(q);
  }
  // 拉取终止定格(2026-09-02 抽出): be 准入即停 / timeout 超时即停 —— 二者在 sglang 里
  // 都是 can_terminate_prefetch 返回 true ⇒ 终止预取, 已拉**头部**直接消费、未拉尾部由 GPU 重算。
  // 把"已拉时间进度"按比例折算成 token 数并重设 _pfTotal, 之后走同一条重算路径。
  //   双层预热(2026-08-28): L2 段 [0, l2h) 无条件可用(免费), 拉取进度只作用于 L3 段 [l2h, H)
  //   ⇒ fetchTok = l2h + 进度×(H−l2h)。l2h=0 退化为原式。
  // ⚠️ resetDone: 上岗时调用传 false(调用方随后统一置 _pfDone=0); prefilling 中途超时传 true
  //   (该请求可能已算过 token, 但重算段的位置口径变了, 必须归零重新计)。
  //
  // ★ 拉取方向 = head-first(2026-09-02 修正): 已拉的是前缀**头部** [l2h, l2h+pulled),
  //   GPU 重算段是**尾部** [l2h+pulled, H)。依据 hiradix_cache.py:1778-1782 —
  //     `if reverse is None:`
  //     `    # Default: suffix_race fetches tail-first (consumed at the chunk`
  //     `    # meeting point); all other policies fetch head-first (consumed`
  //     `    # via the contiguous tree-insert path).`
  //     `    reverse = self.prefetch_stop_policy == "suffix_race"`
  //   ⇒ 只有 suffix_race 是 tail-first(它要与 GPU 前向计算在中间相遇);
  //     wc/best_effort/timeout 全是 head-first —— 它们经由 radix tree 的
  //     **连续插入**路径消费, 而 radix 前缀树只能从根往下连续延伸, 尾部先到货
  //     无法插入(中间有空洞) ⇒ 物理上必须 head-first。
  //   _beHeadTok: GPU 重算段的**起始位置** = l2h + pulled。位置感知成本 τ(i)=a+b·i
  //   对方向敏感 —— 重算尾部(位置更靠后)比重算头部更贵, 这正是 head-first 的代价。
  function settleFetchStop(q, resetDone) {
    let H = q._pfStartPos || 0;
    let l2h = q._l2HitTok || 0;
    let fetchTok = H > 0 ? Math.min(H, l2h + Math.floor((q._fetchDone || 0) / Math.max(q.fetchTime, 1e-9) * (H - l2h))) : 0;
    q._beFetchedTok = fetchTok;
    if (q._ft0 !== undefined && q._ft1 === undefined) q._ft1 = now;  // 拉取被终止, 传输过程结束
    q._bePrefixCap = Math.max(0, H - fetchTok);   // 未拉前缀长度(GPU 重算段长度)
    q._beHeadTok = fetchTok;                       // head-first: 重算段起始位置 = 已拉头部末端
    q._pfTotal = q._bePrefixCap + Math.max(0, q.prefillTokens ?? q.inputLen);  // = inputLen - fetchTok
    if (resetDone) q._pfDone = 0;
  }
  // 计算前沿的**绝对位置**(2026-09-02 抽出): 请求已算 done 个 token 时, 下一个 token 在
  // 原始序列中的位置 —— 位置感知成本 τ(i)=a+b·i 要用它。
  // ★ 抽出原因: 流体路径(逐步推进)与波次路径(chunk 中点)此前各写一套, 波次那套一直用
  //   `_pfStartPos + _pfDone`, 对 be/timeout/race 都不成立(它们的计算起点不是 H):
  //     · be/timeout 定格后从 _beHeadTok(已拉头部末端) 起算 —— 用 H 会高估位置从而高估成本;
  //     · race 阶段0 从 l2h 起算前缀 —— 同样高估。
  //   两处口径不一致会让"同一请求在两种模式下成本不同", 属隐蔽偏差, 故统一到此函数。
  function prefillPos(q, done) {
    if (q._race) {
      let H = q._pfStartPos || 0;
      // 阶段0: GPU 从 l2h 起前向算前缀(L3 同时从 H 端反向拉, 相遇即停);
      // 阶段1: 相遇后转算非复用后缀 [H, L)
      return q._raceMeetTok < 0
        ? (q._l2HitTok || 0) + done
        : Math.min(q.inputLen, H + (done - q._raceMeetTok));
    }
    if (q._be || q._toFired) {
      // head-first: 已拉头部 [l2h, _beHeadTok) 直接可用, GPU 从 _beHeadTok 起算。
      // ★ 未拉前缀段 [_beHeadTok, H) 与非复用后缀 [H, L) **首尾相连** ⇒ 单段连续递增,
      //   无需像 tail-first 那样分两段跳转。这正对应 sglang 注释里 head-first 走
      //   "contiguous tree-insert path"(连续插入)的说法。
      return (q._beHeadTok || 0) + done;
    }
    // wc / timeout(未超时): 命中前缀已整体到位, 从 _pfStartPos 起算未命中段
    return (q._pfStartPos || 0) + done;
  }
  // (occupiesSlot 已于 2026-09-03 第4批随流体路径一并删除 —— 它服务流体的"请求数槽位"
  //  口径; sglang 里未拉齐请求留在等待队列 continue, 不占 running batch, 该语义在波次
  //  路径由 waveFetchReady 的"跳过"表达, 无需槽位计数。)

  // 波次就绪判据: 该请求的 L3 前缀拉取是否已完成 ⇒ 能否被编入筹备波。
  // 与整波上岗的 allReady 检查(fetchSettled)同口径, 否则会出现"组波认为就绪但上岗判定
  // 不就绪"之类的自相矛盾。
  // ⚠️ 含 _coGp 分支: 单飞(coalesce)等待者的拉取进度由组内拉取者代为推进, gp.doneAt 才是
  //   权威完成信号。目前 _coGp 只在 prefilling 阶段的拉取循环里赋值(prefillQ 阶段的等待者
  //   靠排队期循环的 `_fetchDone = gp.frac * bfte` 直接推进) ⇒ 该分支在本调用点暂为惰性;
  //   保留是为了与拉取循环同构 —— 2026-08-19 曾因遗漏单飞语义踩到波次死锁。
  // 纯查询, 不改状态: _fetchDone/_ft1 的落账仍由拉取循环与 上岗 块统一负责(保持单一写入点)。
  function waveFetchReady(q) {
    let gp = q._coGp;
    if (gp && gp.doneAt !== null && now >= gp.doneAt) return true;
    return fetchSettled(q);   // timeout 超时视为已结清(见 fetchSettled/toExpired)
  }

  // 主动预取(doPrefetchFor)已于 2026-09-02 删除: 原实现按 HBM 水位线把 DRAM/SSD 块搬回 HBM
  // (服务 DSL 的 on_demand/eager 两档)。sglang 无此机制 —— host→device 只在前缀命中时由
  // load_back 按需搬运, 不存在"水位线触发的后台预取"。两档 DSL 关键字同步移除。

  // ---------- 完成与释放 ----------
  let pending = requests;
  let timeline = [], followUpCount = 0;

  function completeRequest(req) {
    req.state = 'done'; req.completeTime = now;
    stats.latencies.push((now - req.arrive) * 1000);
    // TTFT 口径(2026-08-20 PD 真分离): 首 token 产出时刻。
    // 非 PD / 近似档: = prefillEnd(prefill 算完即可出首 token)。
    // 真分离: KV 必须先从 P 传到 D, 首 token 只能在传输完成后产出 ⇒ TTFT 含传输段。
    // _kvXferEnd 由传输完成时写入(= prefillEnd + 实际传输墙钟)。
    let _ttftAt = (req._kvXferEnd != null) ? req._kvXferEnd : req.prefillEnd;
    stats.ttfts.push((_ttftAt - req.arrive) * 1000);
    stats.tpots.push((now - (req.decodeStart || _ttftAt)) / Math.max(1, req.outputLen) * 1000); // ms/token（剔除 decodeWait 排队）
    stats.queueWaits.push(req.admitTime - req.arrive);
    // ===== TTFT 分解: 事件时间戳口径(2026-09-01 重构) =====
    // 加性恒等式: queue + prefillQ + fetch + computeNet + computeWait (+xfer) = TTFT
    // 全部由 8 个**事件时刻**导出, 不再依赖逐步累加器(原 _fetchWait 的 5 处累计点已删):
    //   arrive → admitTime → [_ft0, _ft1] → prefillStart → _waveEmpty → prefillEnd
    //   (+ _pqSkipped 标记: 方案A 下"是否曾因未就绪被让过", 决定 prefillQ→fetch 的划转)
    // dW=decode槽位等待, dT=decode执行(延迟分解用): qW+pW+fW+cW+dW+dT = 端到端延迟。
    let _qW = Math.max(0, req.admitTime - req.arrive);
    // ---- P4: 无 L3 命中 ⇒ 无传输过程, 拉取相关量全 0 ----
    // ⚠️ 不能改用"_ft0/_ft1 默认值 = arrive"实现: 二者以 `=== undefined` 作"尚未发生"哨兵
    //   (共 11 处置位点), 预置任何值都会让全部守卫失效 ⇒ _ft1 永远停在初值 ⇒ 所有请求的
    //   fetch 恒为 0(不只是无命中的), 整条分量消失。必须靠显式守卫。
    let _hasFetch = (req.fetchTime || 0) > 0;
    let _ft0v = (_hasFetch && req._ft0 !== undefined) ? req._ft0 : null;
    let _ft1v = (_hasFetch && req._ft1 !== undefined) ? req._ft1 : null;
    let _T = Math.max(0, req.prefillEnd - req.prefillStart);   // prefill 墙钟(父项)
    // ---- 方案A: 把 prefillQ 窗口内"等自己的 KV"那段, 从 prefillQ 分量划转到 fetch 分量 ----
    // ★ 为什么必须划转: 方案A 下请求只在**就绪后**才被编入波 ⇒ _ft1 ≤ prefillStart ≤ _waveEmpty
    //   ⇒ 下方的窗口内暴露 _fWin 恒为 0。若不划转, fetch 分量会**整体塌成 0** —— 而等待并没有
    //   消失, 只是从 prefill 窗口移到了 prefillQ 窗口。L3 带宽敏感性是本平台的主分析轴,
    //   fetch 恒 0 会让 ttft_fetch / fetch_ratio 等指标全部失效。
    // 划分点 = _ft1(自身拉取完成时刻), 把 [admitTime, prefillStart] 切成两段:
    //   [admitTime, _ft1]      = 等自己的 KV      → fetch 因 ⇒ 记入 fetch
    //   [_ft1, prefillStart]   = 已就绪但等波预算 → 调度因 ⇒ 留在 prefillQ
    //   两段互不重叠且与 _fWin 不重叠(_waveEmpty ≥ prefillStart ≥ _ft1) ⇒ 加性成立。
    // ⚠️ 只对**真被跳过过**的请求生效(_pqSkipped, 由组波循环置位): 方案A 关闭时该标记恒
    //   undefined ⇒ _fqW ≡ 0 ⇒ 记账逐位零回归。否则旧口径下 _ft1 > prefillStart 的请求会被
    //   `min(_ft1, prefillStart)` 误划走**整段** prefillQ。
    // ⚠️ 与 _fWin **不同**在于这里不做"被计算掩盖"折扣: _fWin 那边请求已在波内, GPU 忙说明
    //   它是被流水线阻塞(非自身原因) ⇒ 不计费; 这里请求是**因自身未就绪被让过**, 后方请求
    //   之所以能超车正是因为它没就绪 ⇒ 延迟应归自己的拉取。归因方向不同, 不是不一致。
    let _fqW = (req._pqSkipped && _ft1v !== null)
      ? Math.max(0, Math.min(_ft1v, req.prefillStart || 0) - req.admitTime)
      : 0;
    let _pW = Math.max(0, (req.prefillStart || 0) - req.admitTime - _fqW);
    // ---- _fWin: 开算之后仍未到位的那段(prefill 窗口内的拉取暴露) ----
    // P3: 起点用 _waveEmpty("执行流水线自何时起空闲") 而非 prefillStart ⇒ 被上一波计算
    //     掩盖的拉取不计费(不暴露就不付费)。非波次/fetch-only 请求从不进波 ⇒ _waveEmpty
    //     未定义 ⇒ 回退 prefillStart, 与原流体/fetch-only 口径等价。
    // P2: race/be 恒 0 —— 二者 _ft1 的语义是"拉取被**终止**"(race=双向相遇点, be=准入时刻)
    //     而非"拉取**完成**", 它们的请求从未等待过 KV:
    //       race 的 _ft1 − prefillStart = 阶段0 的 GPU 计算时长(边算前缀边拉), 按它算会
    //            把计算误记成拉取等待(慢拉取场景误差最大, 可达整段阶段0);
    //       be   的未拉部分由 GPU 重算, 排队期已拉部分藏在 queue 里。
    //     修正前靠 min(fetchTime, _fetchDone) 且 race 的 _fetchDone 从不推进(用 _raceTok)
    //     这一**隐含不变量**碰巧得到 0 —— 现改为显式写死, 避免后续改动静默破坏。
    // ⚠️ clamp 到 _T: 防御性(所有正常路径下 _ft1 ≤ prefillEnd, 恒不触发 —— 未拉齐时计算
    //   无法推进, 见 prefilling 各 continue 分支)。作用是保证 _fWin ≤ _T ⇒
    //   computeWait ≥ 0 ⇒ 堆叠柱不溢出 100%; 万一 _ft1 被某边界路径置晚, 退化为"整个窗口
    //   算成 fetch"而非加性破裂。
    let _waveEmpty = (req._waveEmpty !== undefined) ? req._waveEmpty : (req.prefillStart || 0);
    let _fWin = (!_hasFetch || req._race || req._be || _ft1v === null)
      ? 0 : Math.max(0, Math.min(_ft1v - _waveEmpty, _T));
    let _fW = _fqW + _fWin;            // 对外的 fetch 分量 = prefillQ 期划转 + 窗口内暴露
    // ⚠️ _cW 只减 _fWin, **绝不能**减 _fqW: 后者落在 [admitTime, prefillStart] 窗口内,
    //   不在 [prefillStart, prefillEnd] 里。减了会让 _cW 偏小甚至被 Math.max(0,·) 截断
    //   ⇒ 加性恒等式破裂(六分量之和 < TTFT)。
    let _cW = Math.max(0, _T - _fWin);   // compute(扣除窗口内拉取暴露) = computeNet + computeWait
    // ---- computeNet: 沿**实际计算路径**的 τ 积分 = 该请求独占 GPU 时的时长 ----
    // _cNet 由主循环累计(波次口径, 2026-09-03 起唯一): Σ(chunk × τ(posMid))。
    //   因 Σ chunk = 实算 token 数, 它等于 ∫τ dpos **沿路径** ⇒ 与 boost/并发无关,
    //   且对 race/be 的**不连续两段位置区间**(前缀段 ∪ 后缀段)自动成立 —— 这也是不能改用
    //   闭式 prefillIntegral(_pfStartPos + _pfTotal) 的原因(那会把两段误当连续区间, 越界)。
    // ⚠️ clamp 必须夹在 (_T − _fWin) 即 _cW 上, **不能**夹在 _T 上: 夹 _T 时若 _cNet + _fWin > _T,
    //   computeWait 会被 max(0,·) 截断为 0, 而三项之和 > _T ⇒ 堆叠柱合计 > TTFT(溢出 100%)。
    // 超出来源: ①DT 离散化(末步推进超出 _pfTotal); ②波次去掉 /wBoost 后成员 τ 高于波内均值
    //   (见上岗处说明) ⇒ 由 cNetRawSum/cNetClampN 诊断被截断的幅度与频率。
    let _cNetRaw = Math.max(0, req._cNet || 0);
    let _cNet = Math.min(_cW, _cNetRaw);
    stats.ttftCnet += _cNet;
    stats.cNetRawSum += _cNetRaw;
    if (_cNetRaw > _cW + 1e-12) stats.cNetClampN++;
    stats.ttftQ += _qW; stats.ttftP += _pW; stats.ttftF += _fW; stats.ttftC += _cW;
    stats.ttftFq += _fqW;   // 方案A 诊断: fetch 分量中来自 prefillQ 期"被跳过"的部分
    if (req._pqSkipped) stats.pqSkipN++;
    // PD 真分离: P→D KV 传输段(prefillEnd → KV 到位), 是 TTFT 的第 5 个分量。
    // 非真分离档恒为 0 ⇒ 分解口径与改动前一致。
    let _xW = (req._kvXferEnd != null) ? Math.max(0, req._kvXferEnd - req.prefillEnd) : 0;
    stats.ttftX += _xW;
    stats.fetchSoloSum += (req.fetchTime || 0); // prefill 传输独立用时(不重叠时 L3 拉取单独耗时): race/be 与计算重叠后实际等待≈0, 但独立用时仍在
    // fetchNet(诊断, 不进堆叠柱): 传输过程实际墙钟 = _ft1 − _ft0, 含 L3 并发带宽排队、不含计算。
    // wc: 到达→拉完(到达即拉档); race: prefillStart→相遇点; be: 到达→拉完或准入终止。
    if (_ft0v !== null && _ft1v !== null) stats.fetchSpanSum += Math.max(0, _ft1v - _ft0v);
    // decode 槽位等待: 从"KV 可用时刻"起算(真分离下 = 传输完成; 否则 = prefillEnd),
    // 避免把 P→D 传输时间重复计入 decodeWait(它已单列为 _xW)
    let _kvReady = (req._kvXferEnd != null) ? req._kvXferEnd : req.prefillEnd;
    let _dW = Math.max(0, (req.decodeStart || _kvReady) - _kvReady);
    let _dT = Math.max(0, req.completeTime - (req.decodeStart || _kvReady));
    // ---- decode 吞吐的时间区间(2026-08-26) ----
    // [decodeStart, completeTime] = 该请求真正在产出 token 的时段。
    // 与 prefill 侧对称: 用 decodeStart 而非 _kvReady, 把 decodeWait(槽位排队)排除在分母外。
    // 分子只累加**已完成请求**的 outputLen, 与区间同源 ⇒ 分子分母口径一致。
    {
      let _ds = (req.decodeStart != null && req.decodeStart > 0) ? req.decodeStart : _kvReady;
      if (req.completeTime > _ds) {
        stats.dcSpans.push([_ds, req.completeTime]);
        stats.dcSpanSum += (req.completeTime - _ds);
      }
      stats.dcOutTokens += (req.outputLen || 0);
    }
    stats.latDw += _dW; stats.latDt += _dT;
    stats.completed++; stats.outTokens += req.outputLen;
    // 每实例完成计数(S2): 按请求被路由到的实例归属(不用当前 inst, 更稳)
    if (instances[req.instId || 0]) instances[req.instId || 0].nCompleted++;
    if (timeline.length < 320) timeline.push({ id: req.id, arrive: req.arrive, admitTime: req.admitTime,
      prefillStart: req.prefillStart, prefillEnd: req.prefillEnd, completeTime: now });

    // 多轮会话：保留KV，安排后续轮次复用（真实前缀命中）
    // 单批模式: 不产生后续轮次——仿真范围严格限定为"单批 prefill"
    let retain = (!req.followUp && !p.singleBatch && p.multiTurn > 0 && rng() < p.multiTurn);
    if (retain) {
      // 双路径合并：会话延续同时保留 ①自有块(历史对话+输出) ②共享前缀块(系统提示/公共前缀，
      // sharer 存于 prefixBlkIds、founder 存于 groupBlkIds，指向同一批公共块)。
      // 之前只保留 ownBlkIds → followUp 的系统提示段被当作新 token 重算（TTFT 高估）。
      let retainIds = [];
      let seen = {};
      (req.ownBlkIds || []).concat(req.prefixBlkIds || [], req.groupBlkIds || []).forEach(id => {
        if (!seen[id] && findBlock(id)) { seen[id] = 1; retainIds.push(id); }
      });
      if (retainIds.length > 0) {
        let fu = { id: N + followUpCount++, arrive: now + 1 + rng() * 4,
          inputLen: Math.round(req.inputLen * (1.1 + 0.3 * rng())),
          outputLen: Math.max(64, Math.round(req.outputLen * (0.8 + 0.4 * rng()))),
          groupId: null, prefixTokLen: 0, isFounder: false, followUp: true,
          retainIds: retainIds, prevTotalTok: req.inputLen,
          state: 'wait', tokensGen: 0, admitTime: 0, prefillStart: 0, prefillEnd: 0, decodeStart: 0, completeTime: 0,
          prefixBlkIds: [], ownBlkIds: [], kvHbm: 0, kvDram: 0, kvSsd: 0, prefillTokens: 0,
          _outAllocTok: 0, _outSeq: 0, _outMerge: 1, _recomputeTok: 0 };
        pending.push(fu); pending.sort((a, b) => a.arrive - b.arrive);
        req.ownBlkIds = []; // 所有权移交给保留集
      }
    }
    req.ownBlkIds.forEach(id => { ['hbm','dram','ssd'].forEach(t0 => poolRemove(t0, id)); });
    req.prefixBlkIds.forEach(id => {
      let loc = findBlock(id);
      // 预热块为 L3 常驻数据, 不随请求完成释放(否则 founder 完成时 refcount 归零 → 后续 sharer miss)
      if (loc && !loc.blk.prewarmed) { loc.blk.refcount--; if (loc.blk.refcount <= 0) poolRemove(loc.tier, id); }
    });
    completedReqs.push(req);
  }

  // ---------- 主循环 ----------
  let lastArrive = pending.length ? pending[pending.length - 1].arrive : 0;
  // 自适应仿真窗口（初始值）：覆盖全部 prefill 工作 + 分波 decode 排水时间的估计；
  // 触顶时不截断，由 estimateRemainingDrain 按剩余负载自动延长，直至全部请求排空
  // （estPass 需含 decode 每请求开销，与 perReqMs 校准一致——旧公式低估导致
  //   Aggressive 静态批高并发场景 0 完成、P99 显示 0；权重项保守按总权重）
  // P0-2: 位置感知 prefill 的窗口估计——per-token 成本 τ(i)（稠密 a+b·i / 稀疏含 topk 截断）
  //（线性公式 2P·L/F 低估长上下文 prefill，导致重负载场景仿真窗口截断、0 完成）
  let totalPrefillEst = pending.reduce((s2, q) => s2 + prefillIntegral(p, q.inputLen), 0);
  let estN = Math.min(s.batching.max_batch_size || 8, N);
  // decode 单 pass 排水估计（与仿真引擎同口径的 KV 分层减速，2541-2550 行）：
  // 批 KV = n×avgLifetimeKv，按 快层(availHbm) → DRAM → SSD 水注分层；
  // passTime = max(权重读+KV_hbm /HBM + perReqMs + KV_dram/min(PCIe,DRAM) + KV_ssd/(ssdBW×0.9), 算力下限) + TP通信
  // —— 旧 estPass 纯 HBM 口径严重低估 KV 下沉后 decode 减速（H20×1/DRAM32/in32768 差 ~36×：
  //    估计 46ms/pass vs 实际 ~1.7s/pass），导致窗口/排水估计不足（1700s 估计 vs 数万秒实际），
  //    是"设大窗口仍截断"的根因之一
  function estDecodePass(n) {
    let kv = Math.max(0, n * r.avgLifetimeKv);
    let kvH = Math.min(kv, r.availHbm);
    let kvD = Math.min(kv - kvH, r.dramTotal);
    let kvS = Math.max(0, kv - kvH - kvD);
    let mem = (r.modelWeightBytes * r.decodeWeightRatio + kvH) / r.aggHbmBW
      + perReqMs(n, r.activatedParams, p.gpus) / 1000
      + kvD / (effL2LinkBW(p) * 1e9)
      + kvS / (p.ssdBW * 1e9 * 0.9);
    let cmp = 2 * r.activatedParams * n / r.computeFlops;
    return Math.max(mem, cmp, 1e-6) + r.commTime(n);
  }
  let estPass = estDecodePass(estN);
  let drainEst = totalPrefillEst + p.outputLen * estPass * Math.ceil(N / Math.max(1, estN)) * 2;
  // 仿真窗口 = min(排水估计, 可调上限 simMaxTime)：上限是硬保险（默认 1200s 防极端负载卡死），
  // 排水估计含 KV 下沉减速（与引擎同口径）；触顶未排空时按剩余负载自动延长（见循环末尾），
  // 但不得超过 simCap（用户上限）——因此"设大上限即可跑完全部请求"，即使排水估计低估也不会
  // 被 min 结构截断在错误的小窗口（旧 bug：drainEst 低估 → 设 120000 仍截断）。
  // 120s 为下限保护；只有实际排水超过用户上限才截断（truncated=true，警告给出建议上限值）。
  let maxTime = lastArrive + Math.min(Math.max(drainEst, 120), Math.max(p.simMaxTime || 1200, 60));
  let maxSteps = Math.ceil(maxTime / DT);
  let simCap = lastArrive + Math.max(p.simMaxTime || 1200, 60); // 硬保险：仿真墙钟不超过此值
  // 剩余排水估计：基于当前未完成请求（排队/在飞/decode），供窗口自动延长使用。
  // 与 drainEst 同口径（位置感知 prefill + 分波 decode），保证延长量覆盖剩余工作
  function estimateRemainingDrain() {
    let all = pending.slice();
    for (let ii = 0; ii < instances.length; ii++) {
      let xi = instances[ii];
      all = all.concat(xi.waitQueue, xi.prefillQ, xi.prefilling, xi.kvXfer, xi.decodeWait, xi.decoding);
    }
    let pf = 0, remTok = 0;
    for (let q of all) {
      let L = Math.max(0, (q._pfTotal || q.inputLen || 0) - (q._pfDone || 0));
      if (L > 0) pf += prefillIntegral(p, L);
      if (q.inputLen) remTok += Math.max(0, (q.outputLen || 0) - (q.tokensGen || 0));
    }
    return pf + Math.ceil(remTok / Math.max(1, estN)) * estDecodePass(estN) * 2;
  }
  let dirty = true;
  let drained = false; // 是否因请求全部排空而正常结束（否则=窗口截断）
  // L3 统一共享池(2026-08-18, 问题②修复): prefill 拉取与 decode L3 读共享同一条 NVMe
  // 总线——decode 按需读优先(全速), prefill 拉取使用剩余带宽(替代原独立 l3FetchBudget
  // 池与 busyUntil 双通道互不排队的旧模型)
  // (2026-08-20 S1: effL3BW / l3PoolBytes 已下沉到 makeInstance, 每实例一条 NVMe;
  //  上方视图变量已绑定当前实例的值, 此处不再重复声明)
  // 下列三者是**实例私有且会被重新赋值**的状态: 声明为视图变量便于读取, 写入必须走 inst.x
  let prevDecodeL3 = inst.prevDecodeL3;   // 上一步 decode L3 读需求(字节/步), 从拉取预算中扣除(2ms 滞后)
  // 波次组批(2026-09-03 第4批: 唯一 prefill 路径, 连续流体模型已删除): 对齐 sglang
  // chunked-prefill —— token 预算(maxPrefillTok, 对应 max_prefill_tokens)组波 + 长请求按
  // chunkSize 切分跨波 + 筹备波拉取与执行波计算重叠(overlap 事件循环语义)。
  // 沿革: 原 pPrefillWave 开关(2026-08-18 引入, 2026-09-02 第2批改默认开启)已删 ——
  //  sglang 只有 chunked-prefill 一种组批方式, "连续流体模型"(N 个请求连续分摊算力)没有
  //  对应机制; 四档预取策略也全部走此路径(见第2批: scheduler.py:3016-3031/3171-3187,
  //  hiradix_cache.py:1973-1991, 策略差异只在"预取何时停 + 未拉部分是否重算")。
  // singleBatch(2026-09-03 移植): 原依赖流体路径("并发=请求数、跳过全部槽位门控"), 现
  //  由波次路径承载 —— 组波时 token 预算与 chunk 均为 ∞, 成员上限即 max_batch_size ⇒
  //  一波 = 整个 batch 整段算完, 语义与原来逐位一致且更贴近 sglang(见组波块的 sbBudget)。
  // 组波跳过未就绪(恒真): 对齐 sglang get_new_batch_prefill 扫 waiting_queue 的 continue
  // 语义(scheduler.py: `if not prefetch_done: continue`), 未就绪请求进不了 batch, 后方
  // 已就绪请求直接超车。原「整波等拉齐」档在 sglang 里不存在, 已删除。
  let waveMode = true;
  let curWave = inst.curWave;   // 执行中的波 {members:[{q,chunk}], endT}
  let prepWave = inst.prepWave; // 筹备中的波 {members:[{q,chunk}]}(等待成员 L3 拉取完成)

  function refreshLocations() {
    decoding.forEach(q => {
      let h = 0, d = 0, sd = 0;
      // P0-1: 平均块大小按实际 token 数（输入+已生成输出）计算，修复前只用 inputLen
      let nIds = Math.max(1, q.prefixBlkIds.length + q.ownBlkIds.length);
      let totalTok = q.inputLen + Math.min(q.outputLen, Math.floor(q.tokensGen || 0));
      let avgBlkSize = totalTok * kvPerTok / nIds;
      function chargeInFlight(blk) {
        let src = blk.srcTier || 'ssd';
        if (src === 'hbm') { h += blk.size; stats.hbmAcc++; }
        else if (src === 'dram') { d += sizeInTier(blk, 'dram'); stats.dramAcc++; }
        else { sd += sizeInTier(blk, 'ssd'); stats.ssdAcc++; }
      }
      q.prefixBlkIds.concat(q.ownBlkIds).forEach(id => {
        let hb = pools.hbm.blockIndex[id];
        if (hb) { if (hb.available) { h += hb.size; touchBlock('hbm', id); stats.hbmAcc++; } else chargeInFlight(hb); return; }
        let db = pools.dram.blockIndex[id];
        if (db) { if (db.available) { d += sizeInTier(db, 'dram'); touchBlock('dram', id); stats.dramAcc++; } else chargeInFlight(db); return; }
        let sb = pools.ssd.blockIndex[id];
        if (sb) {
          // C4(2026-08-18): 已拉取(命中)前缀块 decode 期按 HBM 读计费(见 placeRequest 注释)。
          // 2026-09-02: 原 pDecodeL3Read 开关(勾选=回退按 SSD 读)已删除 —— 运行中请求的 KV
          // 被 inc_lock_ref 锁住不可逐出, decode 期重读 L3 在 sglang 里物理上不存在。
          if (q._fetchedIds && q._fetchedIds[id]) { h += sb.size; stats.hbmAcc++; }
          else if (sb.available) { sd += sizeInTier(sb, 'ssd'); stats.ssdAcc++; } else chargeInFlight(sb);
          return;
        }
        // P0-3: 已丢弃块不再按 SSD 读速计费（原 sd += avgBlkSize），
        // 改为累计重算 token 数——decode 阶段按 GPU 位置感知重算代价消化
        q._recomputeTok += Math.max(1, Math.round(avgBlkSize / kvPerTok));
      });
      q.kvHbm = h; q.kvDram = d; q.kvSsd = sd;
    });
  }

  for (let step = 0; step < maxSteps; step++) {
    now = step * DT;

    // 事件跳跃(2026-08-18): 系统全空闲(无在途请求, 拉取/波次自然也不存在)时直接快进至
    // 下一事件时刻——下一到达 或 在途传输完成(inFlight), 跳过中间空转步。低 qps/短输出
    // 场景省 50%+ 墙钟且结果逐点一致: 空闲期池状态/队列/rng 序列均不变, 唯二影响口径的
    // 是 ①时间加权均值类采样(利用率/DRAM/SSD 占用)按跳过步数加权补齐 ②时间序列图表
    // (concSamples/l2/l3Series)在跳跃终点补一个平坦段样本。busyUntil 链路是纯时间戳无需
    // 步进结算; 跳过 maxSteps 触顶由循环末尾的延长/截断逻辑照常处理。
    // 多实例(S2): "全空闲"须**所有实例**都空(任一实例有在途请求就不能跳)
    let allIdle = true;
    for (let ii = 0; ii < instances.length; ii++) {
      let xi = instances[ii];
      if (xi.waitQueue.length || xi.prefillQ.length || xi.prefilling.length
        || xi.kvXfer.length || xi.decodeWait.length || xi.decoding.length) { allIdle = false; break; }
    }
    if (pending.length && allIdle) {
      let nextEv = pending[0].arrive;
      for (let ei = 0; ei < inFlight.length; ei++) nextEv = Math.min(nextEv, inFlight[ei].arriveAt);
      if (nextEv > now) {
        let skip = Math.ceil((nextEv - now) / DT);   // 落到首个 now >= nextEv 的步
        let idleSteps = skip - 1;                    // 被完全跳过的空转步(本步末尾照常采样 1 次)
        if (idleSteps > 0) {
          let u0 = pools.hbm.used / Math.max(caps.hbm, 1);
          stats.memUtilSum += u0 * idleSteps; stats.memUtilSamples += idleSteps;
          stats.dramUsedSum += pools.dram.used * idleSteps;
          stats.ssdUsedSum += pools.ssd.used * idleSteps;
          stats._prevL2 = stats.transferL2Bytes;
          stats._prevL3 = stats.transferL3Bytes;
          let landT = (step + skip) * DT;
          stats.concSamples.push([+landT.toFixed(2), 0, 0, 0]);
          stats.l2Series.push([+landT.toFixed(2), +(pools.dram.used / 1e9).toFixed(2)]);
          stats.l3Series.push([+landT.toFixed(2), +(pools.ssd.used / 1e9).toFixed(2)]);
          step += skip;
          now = step * DT;
        }
      }
    }

    // ---- 路由: 请求到达 → 选实例(策略集对齐 sgl-router, 见 parseDSL 的 ROUTE 注释) ----
    // 决策只用**当前可观测量**(队列长度/KV 占用), 不读未来 —— 保证因果性。
    while (pending.length && pending[0].arrive <= now) {
      let req0 = pending.shift();
      let tgt = routeRequest(req0);
      req0.instId = tgt.id;
      tgt.nRouted++;
      tgt.waitQueue.push(req0);
    }

    // 均衡度采样窗: 本步系统整体是否仍有在途负载(或还有未到达请求)。
    // 排空后的长尾不计入 —— 否则先完成的实例被 0 值拉低, CV 失真(见下方采样处注释)。
    let _busyPhase = pending.length > 0;
    for (let ii = 0; !_busyPhase && ii < instances.length; ii++) {
      let xi = instances[ii];
      if (xi.waitQueue.length || xi.prefillQ.length || xi.prefilling.length
        || xi.kvXfer.length || xi.decodeWait.length || xi.decoding.length) _busyPhase = true;
    }

    // ======== 逐实例推进(S2): 每个实例独立完成准入→prefill→传输→decode ========
    // 单实例时循环体只执行一次, 且 useInstance 重绑的就是原来那套容器 ⇒ 行为逐位不变。
    for (let _ii = 0; _ii < instances.length; _ii++) {
      useInstance(instances[_ii]);

    // 准入：prefill 槽位与 decode 槽位解耦（连续批）
    // 原模型把 prefill/decode 计入同一 running 上限 → decode 波次占满槽位会阻塞后续请求的
    // prefill 准入，使 TTFT 与 outputLen 强耦合（高并发长输出时 TTFT 虚高 1-2 个数量级）。
    // 修复：continuous 下 prefill 准入不受 decode 槽位数量阻塞（TTFT 只由 prefill 算力排队
    // 决定），只受 ①prefill 流水线缓冲（prefillSlots，chunked-prefill 并行度）
    // ②上层 KV 容量（HBM+DRAM）约束——容量不足时请求留在 waitQueue 等待（物理正确：资源
    // 不足则排队），而不是无限准入把 KV 挤进慢速 SSD 引发 decode 灾难。
    // decodeWait（prefill 完成等 decode 槽位）无数量上限：其 KV 已计入 pools 用量，容量
    // 检查自然约束；prefill→decode 转换处由 decode 槽位上限单独执行。
    // (2026-09-02: priority 排序与 static 波次门控已删 —— sglang 只有 continuous batching,
    //  waiting_queue 的排序由 schedule_policy(FCFS/LPM 等)决定, 不是 BATCH 关键字的一档。)
    // (2026-09-03 第4批: 流体路径的"prefillSlots 请求数槽位"门控已删 —— 波次路径的并发由
    //  token 预算(max_prefill_tokens)驱动, 与 sglang PrefillAdder 一致; 准入只保留下方的
    //  KV 容量判据 —— 对应 sglang 的 available_size/new_token_ratio 检查, 不足则在
    //  waiting_queue 等待。)
    let fastCap = (caps.hbm + caps.dram) * 0.98; // 快层容量：HBM+DRAM 为"软家"，SSD 是最后手段
    for (let i = 0; i < waitQueue.length; i++) {
      // 单批模式: 准入门控全部跳过——所有请求立即准入, 构成单批 batch
      // 快层容量：按"在途请求 KV 总量"估算（含 decodeWait），而非 pools.used——
      // 淘汰会把块移出快层导致 pools.used 虚低，只有按在途请求数×平均KV才能真实反映
      // 快层占用（放不下 → 等解码释放，物理正确：资源不足则排队）
      if (!p.singleBatch) {
        let kvInFlight = (decoding.length + decodeWait.length + prefillQ.length + prefilling.length) * r.avgLifetimeKv;
        if (kvInFlight > fastCap) break;
      }
      let req = waitQueue.splice(i, 1)[0]; i--;
      placeRequest(req, admitTier(req));
      req.state = 'prefillQ'; req.admitTime = now;
      prefillQ.push(req);
      dirty = true;
    }

    // 传输完成
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].arriveAt <= now) { inFlight[i].available = true; delete inFlight[i].srcTier; inFlight.splice(i, 1); dirty = true; }
    }

    // (流体派发循环已于 2026-09-03 第4批删除 —— 原"prefillSlots 个请求连续分摊算力"的
    //  连续流体模型在 sglang 中无对应机制。prefillQ → prefilling 的转移现在唯一地发生在
    //  下方波次组批块: 按 token 预算(max_prefill_tokens)组波, 长请求按 chunk 切分跨波。)
    // ===== L3 拉取（2026-08-18 统一共享池, 问题②修复 + 拉取单飞开关）=====
    // ★ 位置(2026-09-01 搬移): 本块原先**嵌套在下方 `if (prefilling.length)` 的 compute 块内**,
    //   导致两个问题:
    //   ① 结构性 bug —— "没有请求在 prefill 时, 排队期拉取也不推进"。方案A 下若某步全部
    //      prefillQ 请求都未就绪, 无人进 prefilling ⇒ 拉取永不推进 ⇒ 永久死锁
    //      (实测 0/32 完成, 组波跳过 878 万次)。
    //   ② 离散化滞后 —— 拉取在 compute/组波**之后**才跑, 本步拉齐的请求要等下一步才被看到。
    //   现搬到"准入之后、派发/组波之前", 使拉取与 prefill 在同一步内**先推进后可见**, 对齐
    //   sglang: 其 HiCache 预取跑在独立线程(cache_controller), 与调度器 forward 循环完全并发,
    //   不存在"没有 batch 在跑就不预取"或"拉齐了本步看不到"。
    //   实测影响(scripts/debug 探针, 7 档): 完成数/命中率/fetch 分量**全部不变**;
    //   ΔTTFT 恰为 −1·DT(−2ms) 且仅出现在"拉取处于关键路径"的档位 ——
    //   F原档 108.66→106.66ms(−1.84%)、方案A 低带宽 836.92→834.92、方案A 高带宽 42.11→40.11;
    //   波次 OFF / be / race 三档 **0 变化**(它们的完成判定本就在拉取之后, 已是同步的)。
    //   方案A 的步内定序代价随之从 2·DT 降到 1·DT。
    // ⚠️ 搬移后 be 的准入折算(_beFetchedTok, 见上方派发循环)会多看到一步拉取进度 —— 这正是
    //   "拉取与调度并发"的正确语义; 探针实测 be 档 ΔTTFT = 0(其拉取不在关键路径)。
    // prefill fetch / race 拉取 / be 排队期拉取 与 decode 的 L3 读共享同一条 NVMe 总线
    // (effL3BW)——替代原独立 l3FetchBudget 预算池(与 decode 读互不排队, decode L3 重读
    // 无法挤占 prefill 拉取)。优先级: **decode 按需读优先**(与生产存储系统一致:
    // on-demand IO > 后台预取), prefill 拉取使用剩余带宽 fetchBudget = 池−decode需求
    // (上一步, 2ms 滞后)——decode L3 重读饱和时拉取被挤占变慢, TTFT 随之上升。
    // 注意: 按比例共享在 decode 自适应节流(passTime 伸缩使需求∝1/passTime)下会塌缩成
    // 拉取优先(decode 需求越饿越小), 不能产生挤占效果, 故采用优先级模型。
    // 单飞(coalesce, 默认关): 同组前缀拉取只发生一次(groupPull={frac,doneAt}, 拉取者推进
    // frac, 等待者共享进度/完成时刻, 前缀完整点: wc=拉完 / race=相遇 / be=prefill完成);
    // 关 = 每请求独立重拉(模拟并发同前缀请求各自发起预取: sglang 的 prefetch_from_storage
    //      按 rid 独立入队, 无跨请求单飞去重)。
    let fetchJobs = [];
    for (let fi = 0; fi < prefilling.length; fi++) {
      let fq = prefilling[fi];
      if (fq._race) {
        if (fq._raceMeetTok >= 0) continue;
        let H = fq._pfStartPos || 0;
        let l2h = fq._l2HitTok || 0;
        let Hl = H - l2h;   // 双层预热: 拉取目标只含 L3 段 [l2h, H), L2 段不占 L3 带宽
        if (coalesce && fq.groupId) {
          let gp = groupPull[fq.groupId];
          if (gp && fq._coGpPuller !== gp) { // 单飞等待者(非本组拉取者): 共享组拉取进度
            fq._coGp = gp;
            fq._raceTok = gp.doneAt !== null ? Hl : Math.max(fq._raceTok, gp.frac * Hl);
            continue;
          }
          if (!gp) fq._coGpPuller = groupPull[fq.groupId] = { frac: 0, doneAt: null };
        }
        let rem = Math.max(0, Hl - fq._raceTok) * kvPerTok;
        if (rem > 0) fetchJobs.push({ req: fq, rem: rem, kind: 'race' });
      } else if (fq._be || fq._toFired) {
        // be: 准入时已终止拉取(排队期尽力拉的量已定格), 剩余由 GPU 重算, 无拉取
        // _toFired: timeout 已超时定格, 同理不再拉取(2026-09-02)
      } else if ((fq.fetchTime || 0) > (fq._fetchDone || 0)) {
        if (coalesce && fq.groupId) {
          let gp = groupPull[fq.groupId];
          if (gp && fq._coGpPuller !== gp) { fq._coGp = gp; continue; }  // 单飞等待者(完成判定在推进循环)
          if (!gp) fq._coGpPuller = groupPull[fq.groupId] = { frac: 0, doneAt: null };
        }
        fetchJobs.push({ req: fq, rem: (fq.fetchTime - (fq._fetchDone || 0)) * effL3BW, kind: 'wc' });
      }
    }
    // 排队期拉取(be: 尽力拉取 2026-08-14; wc: 到达即拉 2026-08-31, 对齐 sglang HiCache):
    // 遍历 waitQueue+prefillQ 中所有已到达未准入的请求, 拉取从 arrive 起持续
    // (与 prefilling/decode 共享容量池, 排队期拉取自然受 decode 挤占 —— 真实行为)。
    // be: 准入即终止("调度即停, 未拉重算"); wc: 准入后由 prefilling 的 kind 'wc' 分支
    // 从 _fetchDone 续拉(该分支已存在且进位兼容, 无需改动)。
    // ★ 排队期拉取**不产生 fetch 分量**: 这段时间已计入 queue/prefillQ, 再记一次会重复计时。
    //   (2026-09-01 时间戳口径: fetchExposure 从 waveEmpty ≥ prefillStart 起算, 天然满足)
    for (let qi2 = 0; qi2 < waitQueue.length + prefillQ.length; qi2++) {
      let bq = qi2 < waitQueue.length ? waitQueue[qi2] : prefillQ[qi2 - waitQueue.length];
      let bfte = queueFetchTarget(bq);
      if (bfte <= 0) continue;
      if (bq._ft0 === undefined) bq._ft0 = bq.arrive; // be/wc: 传输过程自到达起(到达即拉语义)
      if (coalesce && bq.groupId) {
        let gp = groupPull[bq.groupId];
        if (gp && bq._coGpPuller !== gp) { // 单飞等待者(非本组拉取者): 共享组拉取进度
          bq._fetchDone = gp.frac * bfte;
          if (gp.frac < 1) { /* 拉取中: 时间戳口径下无需累计(2026-09-01, 原 be 累计为死代码) */ }
          else if (gp.doneAt !== null && bq._ft1 === undefined) bq._ft1 = gp.doneAt;
          continue;
        }
        if (!gp) bq._coGpPuller = groupPull[bq.groupId] = { frac: 0, doneAt: null };
      }
      let rem = (bfte - (bq._fetchDone || 0)) * effL3BW;
      if (rem > 0) {
        // kind 打 be/wc: 共用 fetchBudget 与进度落账分支(wc 按 fetchTime 判完成, be 按 bfte)
        fetchJobs.push({ req: bq, rem: rem, kind: bq._be ? 'be' : 'wc', bfte: bfte });
      }
      else if (bq._ft1 === undefined) bq._ft1 = now;
    }
    // decode 按需读优先: 拉取只用剩余带宽(上一步 decode L3 读需求, 2ms 滞后)
    let fetchBudget = Math.max(0, l3PoolBytes - inst.prevDecodeL3);
    for (let j of fetchJobs) {
      if (fetchBudget <= 1) break;
      let take = Math.min(Math.min(j.rem, l3PoolBytes), fetchBudget);
      fetchBudget -= take;
      stats.transferL3Bytes += take; stats.fetchBytesPulled += take;
      let q2 = j.req;
      if (j.kind === 'race') {
        q2._raceTok += take / Math.max(kvPerTok, 1);
        // 双层预热: frac 分母 = L3 段长度(H − l2h), 与拉取目标同口径
        if (q2._coGpPuller) q2._coGpPuller.frac = Math.min(1, q2._raceTok / Math.max((q2._pfStartPos || 0) - (q2._l2HitTok || 0), 1));
      } else if (j.kind === 'wc') {
        q2._fetchDone = (q2._fetchDone || 0) + take / effL3BW;
        // 完成目标: 排队期 job 用 job 自带的 bfte(waitQueue 请求 fetchTime 未算, 读它会
        // 恒 0 ⇒ 第一步就误判完成, _ft1 被污染); prefilling job 无 bfte ⇒ 回退 fetchTime
        let tgt = (j.bfte !== undefined) ? j.bfte : (q2.fetchTime || 0);
        if (q2._coGpPuller) q2._coGpPuller.frac = Math.min(1, q2._fetchDone / Math.max(tgt, 1e-9));
        if (q2._fetchDone >= tgt) {
          if (q2._ft1 === undefined) q2._ft1 = now;
          if (q2._coGpPuller && q2._coGpPuller.doneAt === null) q2._coGpPuller.doneAt = now;
        }
      } else { // be: 进度(时间当量), 准入时按 _fetchDone/fetchTime 定格已拉前缀
        q2._fetchDone = (q2._fetchDone || 0) + take / effL3BW;
        if (q2._coGpPuller) q2._coGpPuller.frac = Math.min(1, q2._fetchDone / Math.max(j.bfte, 1e-9));
        if (q2._fetchDone >= j.bfte && q2._ft1 === undefined) q2._ft1 = now;
      }
    }
    // ===== 波次组批(waveMode, sglang chunked-prefill 对齐, 2026-08-18) =====
    if (waveMode) {
      // 1) fetch-only 请求(命中100%/无剩余计算): 直接进 prefilling 等拉取, 不占波次 token 预算
      for (let i = 0; i < prefillQ.length; i++) {
        let rq = prefillQ[i];
        if ((rq.prefillTokens ?? rq.inputLen) > 0) continue;
        prefillQ.splice(i, 1); i--;
        rq.state = 'prefill'; rq.prefillStart = now;
        rq._pfTotal = 0; rq._pfDone = 0;
        if ((rq.fetchTime || 0) > 0 && rq._ft0 === undefined) rq._ft0 = now;
        prefilling.push(rq); dirty = true;
      }
      // 2) 组筹备波: 继续中的未完成成员优先(sglang 恢复 chunked_req), 再按 prefillQ 顺序纳入;
      //    每成员本波推进 chunk = min(剩余, chunkSize, 剩余预算), 总预算 = maxPrefillTok。
      //    与执行波重叠: 筹备波成员的 L3 拉取在执行波计算期间推进(overlap 事件循环)
      if (!prepWave) {
        // sbBudget(2026-09-03, singleBatch 移植): 单批 prefill 微基准 = "整个 batch 一波整段算完",
        // 故 token 预算与 chunk 切分均放开为 ∞ —— 每成员 chunk = 其全部剩余, 成员数上限由
        // bCap(= max_batch_size) 限制 ⇒ 一波恰好就是一个 batch, 与 sglang 的
        // `run_batch(batch)` 整批一次 forward 语义一致。
        let sb = !!p.singleBatch;
        let W = sb ? Infinity : Math.max(p.chunkSize, p.maxPrefillTok || 16384);
        let sbChunk = sb ? Infinity : p.chunkSize;
        let wv = { members: [] }, waveTok = 0;
        // 继续中的成员(含执行波成员的下一段 chunk, 须扣除在飞 chunk 防重复计算——
        // 否则连续波会在单请求间交替, 波永远装不满, 效率塌回 boost=1)
        for (let q of prefilling) {
          // race 阶段0: _pfTotal 尚未确定(=0), 但它**确实要算前缀** —— 不能按 fetch-only 跳过。
          // 剩余量用"前缀未算完的部分"估: H_eff = _pfStartPos − l2HitTok(L2 段免费不用算),
          // 再扣掉已由 L3 反向拉来的 _raceTok(那部分不用重算) —— 与相遇判据同口径。
          if (q._race && q._raceMeetTok < 0) {
            let Heff = Math.max(0, (q._pfStartPos || 0) - (q._l2HitTok || 0));
            let remR = Heff - q._pfDone - (q._raceTok || 0) - (q._wvInFlight || 0);
            if (remR <= 0) continue;   // 前缀已被"算+拉"覆盖: 等推进块判相遇
            let chunkR = Math.min(remR, sbChunk, W - waveTok);
            if (chunkR <= 0) break;
            wv.members.push({ q: q, chunk: chunkR }); waveTok += chunkR;
            if (waveTok >= W) break;
            continue;
          }
          if (q._pfTotal <= 0) continue; // fetch-only 不占预算
          let rem = q._pfTotal - q._pfDone - (q._wvInFlight || 0);
          if (rem <= 0) continue;
          let chunk = Math.min(rem, sbChunk, W - waveTok);
          if (chunk <= 0) break; // 预算用完
          wv.members.push({ q: q, chunk: chunk }); waveTok += chunk;
          if (waveTok >= W) break;
        }
        // prefillQ 段: 方案A 开启时按索引遍历(可跳过未就绪成员); 关闭时与原 shift() 循环
        // **逐位等价** —— 不跳过时 qi 恒为 0(splice(qi,1) 后 qi-- 再 qi++ 回到 0), 等同于
        // 反复取队首, 取用顺序 / waveTok 累加 / wv.members 顺序全部一致。
        for (let qi = 0; qi < prefillQ.length && waveTok < W; qi++) {
          let rq = prefillQ[qi];
          let tot = rq.prefillTokens ?? rq.inputLen;
          if (tot <= 0) break; // fetch-only 已在上面处理(顺序保持)
          // ★ 入波就绪判据(2026-09-02 第2批, 四档策略统一):
          //   wc/timeout —— waveFetchReady(拉齐 或 timeout 已超时) ⇒ 未就绪就 continue 让路;
          //   be         —— 恒就绪(sglang can_terminate_prefetch 对 best_effort 直接 return True,
          //                 即"任何时候都可以停下来进 batch", 未拉部分重算);
          //   race       —— 恒就绪(tail-first 预取与 GPU 前向计算**并行**推进, 请求立刻进 batch,
          //                 每轮组批前由 _race_step 消费已到货的尾部, 见 scheduler.py:3016-3031)。
          // 组波跳过未就绪(恒真, sglang continue 语义): 拉取未齐 ⇒ 跳过, 让后方已就绪请求超车。
          // _pqSkipped: 记账标记 —— 该请求的 prefillQ 等待里含"等自己的 KV"那一段,
          //   需在 completeRequest 里从 prefillQ 分量划转到 fetch 分量(见那里的 _fqW)。
          // ⚠️ 残留 ≤1·DT(2ms) 的步内定序代价: 拉取块已搬到组波之前(见其块头注释), 故本步
          //   拉齐的请求本步即可入波; 但请求**首次**落到 prefillQ 的那一步拉取才刚起步,
          //   必然被让过一次。sglang 无此代价: 预取在独立线程与调度并发,
          //   check_prefetch_progress 读实时状态。
          if (!rq._be && !rq._race && !waveFetchReady(rq)) {
            rq._pqSkipped = true;
            continue;
          }
          prefillQ.splice(qi, 1); qi--;
          rq.state = 'prefill'; rq.prefillStart = now;
          if ((rq.fetchTime || 0) > 0 && rq._ft0 === undefined) rq._ft0 = now;
          // ★ 入波时确定本请求的**计算总量** _pfTotal(2026-09-02 第2批, 四档统一):
          //   ⚠️ 必须在算 chunk **之前**做 —— be/timeout 的定格会改变 _pfTotal(未拉前缀转重算),
          //     若先按 tot 切 chunk 会切错(实测会出现 chunk > _pfTotal 的越界波)。
          if (rq._be || (rq._to && toExpired(rq))) {
            // be: 进 batch 即终止预取(can_terminate_prefetch 对 best_effort 恒 True);
            // timeout: 已超时 ⇒ 同样终止。二者都是"已拉头部直接用, 未拉尾部 GPU 重算"。
            if (rq._to) rq._toFired = true;
            settleFetchStop(rq, true);
          } else if (rq._race) {
            // race: 阶段0 —— GPU 从 l2h 位置起前向计算前缀, L3 从尾部(H端)反向拉取,
            // 相遇即停。_pfTotal 在相遇时才能确定(= 已算前缀 + 非复用后缀), 故先置 0,
            // 由波次推进块的相遇判定重设(与流体路径的 _race 分支同语义)。
            rq._pfTotal = 0; rq._pfDone = 0;
          } else {
            rq._pfTotal = tot; rq._pfDone = 0;   // wc/timeout(未超时): 拉齐后算未命中段
          }
          prefilling.push(rq);
          // race 的 _pfTotal=0 表示"总量待定", 本波先按 chunk 预算给它一段推进前缀
          let remIn = rq._race ? tot : rq._pfTotal;
          let chunk = Math.min(remIn, sbChunk, W - waveTok);
          if (chunk > 0) { wv.members.push({ q: rq, chunk: chunk }); waveTok += chunk; }
          dirty = true;
        }
        if (wv.members.length) inst.prepWave = prepWave = wv;
      }
    }
    // 守卫: 有请求在 prefill 才需要算算力分配。
    // (2026-09-01) L3 拉取块已搬到本块**之前**且不受此守卫约束 —— 原先嵌套在这里造成
    // "没有请求在 prefill 时排队期拉取也不推进"的结构性 bug, 见搬移后的块头注释。
    if (prefilling.length) {
      // ===== 波次推进(sglang chunked-prefill 对齐) =====
      // (2026-09-03 第4批: 流体成本拆分块已删 —— 原"gpuTime=DT×boost×pfFactor 按 τ 加权分摊、
      //  每请求每步推进 perReqTok"的连续流体模型在 sglang 中无对应机制; boost/pfFactor/perReqTok/
      //  _tauNow 均为流体专用量, 一并移除。波次的 boost 由 上岗 处的 wBoost 独立计算,
      //  混合批互斥由 decode 段的 pfShare 表达, _cNet 由 上岗 处的 m._cost 累计。)
      {
        // GPU 占用画像(2026-09-03 改波次口径): 执行波在岗 ⇒ 本步 GPU 在算 prefill,
        // 活跃请求数取执行波成员数 —— 比旧流体口径(所有拉齐的 prefilling 请求都算活跃)
        // 更准: 筹备波成员与等下一段 chunk 的成员并不占算力。
        if (curWave) { stats.pfGpuBusySec += DT; stats.pfBusySteps++; stats.pfActSum += curWave.members.length; }
        // fetch-only 成员: 拉取完成即完成 prefill(不占算力不占波次预算)
        for (let i = prefilling.length - 1; i >= 0; i--) {
          let q = prefilling[i];
          if (q._pfTotal > 0) continue;
          // 单飞等待者: 共享组拉取完成 ⇒ 命中完成(与流体循环 3163 同语义; 否则 _fetchDone
          // 永不更新 → 波次模式死锁, 2026-08-19 单批基准发现)
          let fgp = q._coGp;
          if (fgp && fgp.doneAt !== null && now >= fgp.doneAt) {
            q._fetchDone = q.fetchTime;
            if (q._ft1 === undefined) q._ft1 = fgp.doneAt;
          }
          if ((q.fetchTime || 0) > (q._fetchDone || 0)) continue;   // 拉取未齐: 不完成(时间戳口径无需累计等待)
          prefilling.splice(i, 1);
          finishPrefill(q);
        }
        // 筹备波上岗: 等全员 L3 拉取完成(wait_complete 语义: 整波等拉齐, 对应 sglang scheduler
        // 循环 continue 等 prefetch)。波耗时 = Σ 成员 chunk 位置感知成本(中点近似) ÷ 算力×boost×混合批折扣
        if (prepWave && !curWave) {
          let allReady = true;
          for (let m of prepWave.members) {
            // be/race 不等拉齐(2026-09-02 第2批):
            //   be   —— can_terminate_prefetch 恒 True, 入波时已 settleFetchStop 定格;
            //   race —— 预取与计算**并行**, 等拉齐就失去了 race 的全部意义。
            if (m.q._be || m.q._race) continue;
            // 单飞等待者: 共享组拉取完成 ⇒ 就绪(同上, 流体语义在波次判定的对齐)
            let wgp = m.q._coGp;
            if (wgp && wgp.doneAt !== null && now >= wgp.doneAt) {
              m.q._fetchDone = m.q.fetchTime;
              if (m.q._ft1 === undefined) m.q._ft1 = wgp.doneAt;
            }
            // timeout: 超时即视为结清(fetchSettled), 不再拖住整波
            if (!fetchSettled(m.q)) allReady = false;   // 拉取未齐: 整波等(时间戳口径无需累计)
          }
          if (allReady) {
            // timeout 上岗定格(2026-09-02 第2批): 成员里若有"因超时而结清"的, 在此按 be 路径
            // 定格 —— 已拉头部直接用, 未拉尾部转 GPU 重算。必须在算 cost 之前(它改 _pfTotal)。
            // ⚠️ 定格会缩小/放大 _pfTotal, 成员的 chunk 是组波时按旧值切的 ⇒ 需夹紧, 否则
            //   结算时 _pfDone 会超过 _pfTotal(表现为请求"算完了还留在 prefilling")。
            for (let m of prepWave.members) {
              if (m.q._race) continue;   // race: _pfTotal=0 是"待定", 不适用夹紧
              if (m.q._to && !m.q._toFired && !((m.q.fetchTime || 0) <= (m.q._fetchDone || 0))) {
                m.q._toFired = true;
                settleFetchStop(m.q, true);
              }
              let capRem = m.q._pfTotal - m.q._pfDone;
              if (m.chunk > capRem) m.chunk = Math.max(0, capRem);
            }
            inst.curWave = curWave = prepWave; inst.prepWave = prepWave = null;
            // ★ _waveEmpty 打戳(2026-09-01, TTFT 时间戳口径): "执行流水线自何时起空闲"。
            //   fetchExposure = max(0, _ft1 − _waveEmpty) ⇒ 被上一波计算掩盖的拉取不计费
            //   (等价于原 _fetchWait 只在 !curWave 时累计的语义, 见下方等价性说明)。
            //   等价性: prepWave 非空时禁止组新波(见组波处 !prepWave 守卫), 且 curWave 只能由
            //   prepWave 上岗产生 ⇒ [lastWaveEndAt, waveStart] 是一段**连续**空闲区间 ⇒
            //   Σ(!curWave 且未拉齐的步) = max(0, _ft1 − max(prefillStart, lastWaveEndAt))。
            // ⚠️ 必须 `=== undefined` 守卫(仅首次上岗记录): 后续波会覆盖成更晚的时刻, 而拉取
            //   只可能在第 1 波未完成(fetchTime 准入时定格且单调完成) ⇒ 覆盖后 _ft1 < 新时刻,
            //   max(0, ...) 恒得 0, 真值丢失。
            let _idleFrom = inst.lastWaveEndAt || 0;
            for (let m of curWave.members)
              if (m.q._waveEmpty === undefined)
                m.q._waveEmpty = Math.max(m.q.prefillStart || 0, _idleFrom);
            // 波次效率按波 token 量标定: a/b 校准于 chunkSize 大小的前向(权重读/TP 固定开销按
            // chunk 分摊——见 estimatePrefillParams 的 wRead/tp 项), 更大的波摊薄这些固定项,
            // 上限 PREFILL_UTIL_CAP/mfu(GPU 饱和); ≤chunkSize 的波保持校准基线 boost=1。
            // (不能用成员请求数: 单请求 16k-token 波本身就是大批次, 物理上已接近满效率)
            let waveTokTotal = 0;
            for (let m of curWave.members) waveTokTotal += m.chunk;
            // mfuAuto: a/b 即硬件 Roofline 极限, 不再叠加 boost(同流体模式口径)
            let wBoost = p.mfuAuto ? 1
              : Math.max(1, Math.min(waveTokTotal / Math.max(p.chunkSize, 1), PREFILL_UTIL_CAP / Math.max(p.mfu, 0.05)));
            // 混合批口径(2026-09-02 第3批, 对齐 enable_mixed_chunk=False 默认):
            // sglang 的事件循环**每次只跑一个 batch** —— get_next_batch_to_run 里
            //   `if new_batch is not None: ret = new_batch   # Run prefill first if possible`
            //   `else: ... ret = self.running_batch          # Run decode`
            // (scheduler.py:2880-2892) ⇒ prefill 波与 decode pass **交替独占** GPU,
            // 而非"同批共享算力打折"。故波耗时不再乘 0.7 折扣; 互斥改由 decode 侧实现
            // (prefill 波执行期间 decode 不推进, 见 decode 段的 gpuBusyByPrefill 门控)。
            // ⚠️ PD 真分离(pdSep)下 P/D 各有独立 GPU, 本就无互斥 —— 见 decode 段的判据。
            let wPfFactor = 1;
            // 波耗时 = Σ 成员 chunk 的 τ(i) 位置积分(中点近似, 秒) ÷ (boost × 混合批折扣)
            // 2026-08-19: 与流体模式统一为 τ 口径(旧实现按 2·act·(1+b/a·pos)/computeFlops,
            // 量纲上等价于强制 a=2·act/computeFlops, 手填/实测 a 被忽略)
            let cost = 0;
            for (let m of curWave.members) {
              // 位置取本 chunk 的**中点**(积分中点近似)。起点口径统一走 prefillPos ——
              // 2026-09-02 修正: 原式写死 `_pfStartPos + _pfDone`, 对 be/timeout(定格后
              // 从 _beHeadTok 起算) 与 race(阶段0 从 l2h 起算) 都偏大 ⇒ 高估 τ 成本。
              let posMid = prefillPos(m.q, m.q._pfDone + m.chunk / 2);
              m._cost = m.chunk * prefillTau(pP, posMid);   // PD 真分离: 波次同样走 P 节点 a/b
              cost += m._cost;
            }
            curWave.endT = now + cost / Math.max(wBoost * wPfFactor, 1e-9);
            // computeNet(2026-09-01 修正, 波次口径): 成员自身 chunk 的**独占计算时长**。
            // ★ 修正前除了 wBoost, 使其变成"份额"(Σ成员 = 波耗时) —— 与 computeNet 的定义
            //   ("该请求若独占 GPU 需算多久", 见 stats.ttftCnet 与 compute_net tooltip)矛盾:
            //   批量化让 3 个 chunk 的波耗时 ≈ 单 chunk 独占耗时(wBoost≈3 抵消线性成本),
            //   此时真实竞争代价为 0, 而份额口径却记出 2/3 的假性"算力竞争等待"(mfu=30 实测 +67%)。
            //   流体模式的累加(perReqTok × τ)本就与 boost/并发无关 —— 此处去掉 /wBoost 后两模式口径统一。
            // ⚠️ 保留 /wPfFactor(D1=A): decode 混跑的降速仍按份额折算, 使 mfuAuto 档(wBoost≡1)
            //   与修正前逐位一致(零回归)。"pfFactor 是否应全部归入 computeWait"留作独立改动 ——
            //   它还牵扯 sglang 默认 enable_mixed_chunk=False 的对齐问题。
            // ⚠️ 去掉 wBoost 后 _cNet 理论上不再保证 ≤ 波耗时(成员 τ 高于波内均值时可能超出),
            //   由 completeRequest 的 clamp 夹到 (T − fetchExposure)。实测(8 档)修掉上方
            //   "_cNet 流体累加在波次模式双重计入"的 bug 后 clampRate 恒为 0, 即实际未触发。
            for (let m of curWave.members)
              m.q._cNet = (m.q._cNet || 0) + m._cost / Math.max(wPfFactor, 1e-9);
            for (let m of curWave.members) m.q._wvInFlight = m.chunk; // 在飞 chunk 登记(组波时扣除)
          }
        }
        // 执行波结算: 整波成员同时完成各自 chunk(波次量化完成——与流体模式的核心分布差异);
        // 未完成的成员留在 prefilling(解除在飞标记), 下一波优先继续(sglang stash/resume chunked_req)
        if (curWave && now >= curWave.endT) {
          let finished = curWave.members;
          inst.curWave = curWave = null;
          // 执行流水线转为空闲的时刻(2026-09-01): 下一波上岗时作为成员 _waveEmpty 的起点。
          inst.lastWaveEndAt = now;
          for (let m of finished) {
            let q = m.q;
            q._wvInFlight = 0;
            q._pfDone += m.chunk;
            // ★ race 相遇判定(2026-09-02 第2批, 对齐 scheduler.py 的 _race_step):
            //   sglang 在**每轮组批前**对 chunked_req 调 _race_step, 检查 GPU 计算前沿(cur)
            //   与 L3 反向预取已到货的起点(fetched_from) 是否相遇:
            //     · 相遇(cur >= fetched_from): 尾部全部到货, 一次性拼接并 finalize 预取;
            //     · 未相遇但下一 chunk 会与已到货尾部重叠: trim —— 把 chunk 截到 fetched_from
            //       (add_chunked_req 的 cap), 终止预取, 计算前沿到达时再拼上。
            //   本模型的波次粒度天然对应"每轮组批", 故在波结算处判定; trim 由下一轮组波的
            //   remR(已扣 _raceTok) 自动实现 —— 那正是"chunk 不越过已到货边界"的等价表述。
            if (q._race && q._raceMeetTok < 0) {
              // 双层预热: 相遇区间 = [l2h, H) —— L2 段免费可用, 不占"已算+已拉"的覆盖目标
              if (q._pfDone + (q._raceTok || 0) >= (q._pfStartPos || 0) - (q._l2HitTok || 0)) {
                q._raceMeetTok = q._pfDone;              // 相遇点: GPU 已算前缀 token 数
                if (q._ft1 === undefined) q._ft1 = now;  // 相遇即停止拉取, 传输过程结束
                if (q._coGpPuller && q._coGpPuller.doneAt === null) q._coGpPuller.doneAt = now;
                // 总任务 = 已算前缀 + 非复用后缀全量(与流体路径同式)
                q._pfTotal = q._raceMeetTok + Math.max(0, q.inputLen - (q._pfStartPos || 0));
              }
            }
            progressiveActivate(q);   // radix 渐进激活(波次粒度)
            // race 阶段0(_pfTotal=0 待定)不判完成 —— 否则 0>=0 会让它在相遇前"假完成"
            if (!(q._race && q._raceMeetTok < 0) && q._pfDone >= q._pfTotal) {
              let idx = prefilling.indexOf(q);
              if (idx >= 0) prefilling.splice(idx, 1);
              finishPrefill(q);
            }
          }
        }
      }
      // (流体推进分支已于 2026-09-03 第4批删除 —— 连续流体模型在 sglang 中无对应机制;
      //  race 相遇/be 定格/wc 等拉齐三件套在上方波次结算块均有对应实现。)
    } // end if (prefilling.length)
    // ---- PD 真分离: P→D KV 传输推进(2026-08-20) ----
    // 互联带宽在同时传输的请求间**平分**(共享一条链路), 与 L3 拉取的共享池同思路:
    // 并发传输越多, 每个请求越慢 —— 这是 PD 分离在高负载下的真实代价(传输成为新瓶颈)。
    if (kvXfer.length) {
      let share = pdLinkEffBW / kvXfer.length;      // 每请求本步可用带宽
      let quota = share * DT;                       // 每请求本步可传字节
      for (let i = kvXfer.length - 1; i >= 0; i--) {
        let q = kvXfer[i];
        let need = Math.max(0, q._kvXferBytes - q._kvXferSent);   // 剩余待传
        let moved = Math.min(quota, need);
        q._kvXferSent += moved;
        stats.pdXferBytes += moved;
        if (q._kvXferSent >= q._kvXferBytes - 1e-9) {
          q._kvXferDone = true;
          // 完成时刻按**亚步长**精确结算: 本步只需 moved 字节(< quota)时, 传输在步内
          // now-DT + moved/share 时刻就结束, 而非拖到步末 now。
          // 不修正会把最后一步整个 DT 记进耗时 ⇒ 少量并发下实际墙钟可能被算得比
          // 独立耗时(_kvXferTotal)还短(实测 7.46ms < 8.46ms), 违反"共享链路只会更慢"的物理。
          let finishAt = Math.min(now, (now - DT) + (share > 0 ? moved / share : 0));
          q._kvXferEnd = Math.max(finishAt, q._kvX0);   // KV 到达 D 的时刻(TTFT 截止点)
          q._kvXferSpan = q._kvXferEnd - q._kvX0;       // 实际墙钟(含并发排队), >= 独立耗时
          stats.pdXferSpanSum += q._kvXferSpan;
          stats.pdXferSoloSum += q._kvXferTotal;    // 独立耗时(无竞争基准)
          stats.pdXferCount++;
          kvXfer.splice(i, 1);
          // KV 已到 D 节点 ⇒ 走原转 decode 逻辑。注意 prefillEnd 不变(prefill 确实那时算完),
          // 传输时间通过 _kvXferEnd 体现, 并单列进 TTFT 分解的 xfer 分量。
          finishKvXfer(q);
        }
      }
    }
    // decode 槽位释放 → 从 decodeWait 补入
    // (2026-09-02: 原 `s.batching.type === 'static'` 旁路已删 —— sglang 只有 continuous
    //  batching, 无 static 波次语义, 该分支恒不成立。)
    while (decodeWait.length && decoding.length < (s.batching.max_batch_size || 8)) {
      let q = decodeWait.shift();
      q.state = 'decode';
      q.decodeStart = now;
      decoding.push(q);
      dirty = true;
    }

    // Eager 预取块已于 2026-09-02 删除(连同 doPrefetchFor): 原按水位线做 SSD→DRAM→HBM 的
    // 后台搬运, 服务 DSL 的 eager 档。sglang 无水位触发的预取, host→device 只在命中时
    // load_back 按需搬运 —— 详见 doPrefetchFor 删除处的注释。

    // Decode：批次 Roofline —— passTime = max(访存时间, 算力下限) + TP AllReduce通信
    if (decoding.length) {
      if (dirty || step % TOUCH_EVERY === 0) { refreshLocations(); dirty = false; }
      // decodeWait 中的块视为活跃（即将进入 decode）：touch 刷新 LRU 时间戳防误淘汰——
      // 否则 LRU 把等待中的 KV 挤到慢层，进入 decode 时读 SSD 拖垮批次（恶性循环：
      // decode 慢 → decodeWait 更多 → HBM 被等待 KV 占满 → decode 块被挤出 → 更慢）
      if (decodeWait.length) {
        for (let q of decodeWait) {
          for (let id of q.prefixBlkIds.concat(q.ownBlkIds)) {
            touchBlock('hbm', id); touchBlock('dram', id);
          }
        }
      }
      let sumH = 0, sumD = 0, sumS = 0;
      decoding.forEach(q => { sumH += q.kvHbm; sumD += q.kvDram; sumS += q.kvSsd; });
      // Decode Roofline：权重读为 batch 共享项（每 step 读一次权重；MoE 按激活参数比例缩放——
      // 每 token 只读激活专家权重，671B 只激活 37B 时按总权重会高估 ~18×），KV 读取随 batch 线性；
      // 另加每请求 attention/采样/调度开销（固定调度项+幂律项，随 GPU 数分摊——见顶层 perReqMs 校准）
      // P1 修复(2026-08-10): L2/L3 读从线性计费改为链路排队——
      //  旧: passTime 直接 + sumD/PCIe + sumS/(ssdBW×0.9)（独立带宽, 与预取/淘汰互不竞争, 失真）
      //  新: decode 每 pass 读 KV 字节排入 dram>hbm / ssd>dram 链路的 busyUntil 队列,
      //      与预取/淘汰/换入换出先到先服务共享带宽; 排队等待 + 传输时间并入 passTime;
      //      无竞争(链路空闲)时排队等待=0 → 退化为旧线性模型(完全一致);
      //      有竞争(预取占带宽)时 decode 读被拖慢——物理正确。
      // PD 真分离(2026-08-20): decode 只用 D 节点资源(rD = calcAll 换卡数视图);
      // 非真分离档 rD===r 且 dGpus===p.gpus ⇒ 与改动前逐位一致。
      let passTime = (rD.modelWeightBytes * rD.decodeWeightRatio + sumH) / rD.aggHbmBW
        + perReqMs(decoding.length, rD.activatedParams, pdDecodeGpus) / 1000;
      let cmpFloor = 2 * rD.activatedParams * decoding.length / rD.computeFlops;
      // ===== prefill/decode 交替独占 GPU(2026-09-02 第3批, enable_mixed_chunk=False) =====
      // sglang 事件循环每次只跑一个 batch: 有 prefill batch 就跑 prefill(优先),
      // 否则跑 decode(scheduler.py:2880-2892 "Run prefill first if possible") ⇒ 二者
      // **交替独占**算力, 不是同批共享。
      // 建模方式: 本步 DT 内 GPU 花在 prefill 上的时间片占比 pfShare, 余下 (1−pfShare)
      // 才归 decode ⇒ decode 的有效步长按 (1−pfShare) 缩放(见下方 dtEff)。
      //   · 波次模式: 执行波在 [waveStart, endT] 独占 ⇒ 本步与波区间的重叠比例即 pfShare;
      //     筹备波只做 L3 拉取(不占算力) ⇒ 不计入。
      //   · 流体对照基线: 无"波区间"概念, 退化为"有请求在算就按算力份额折算"(保留原
      //     0.5·n 放大口径, 见下方 else 分支) —— 它本就不是 sglang 行为, 不做对齐。
      // ⚠️ PD 真分离: P/D 各有独立 GPU, 无互斥 ⇒ pfShare 恒 0。
      let pfShare = 0;
      if (!p.pdSep) {
        if (waveMode) {
          if (curWave) {
            // 执行波覆盖本步的比例(波可能在步中途结束)
            let ovl = Math.min(now + DT, curWave.endT) - now;
            pfShare = Math.max(0, Math.min(1, ovl / Math.max(DT, 1e-12)));
          }
        } else if (prefilling.length) {
          // 流体基线: 维持原"算力竞争放大"口径(非 sglang 行为, 仅作对照)
          cmpFloor *= (1 + 0.5 * prefilling.length);
        }
      }
      passTime = Math.max(passTime, cmpFloor, 1e-6) + rD.commTime(decoding.length);
      // dtEff: 本步真正归 decode 的 GPU 时间(2026-09-02 第3批)。
      // prefill 波独占了 pfShare 比例的时间片 ⇒ decode 只剩 (1−pfShare)·DT。
      // 下游所有"本步前向次数"换算(pIt/pFinal/passes/tok)统一用 dtEff, 保证
      // token 产出、KV 读字节、链路占用三者口径一致 —— 只改其一会让带宽统计与吞吐脱节。
      // pfShare=0(流体基线 / PD 真分离 / 无执行波)时 dtEff===DT ⇒ 逐位零回归。
      let dtEff = DT * (1 - pfShare);
      // ---- L2 读链路排队(busyUntil) + L3 读统一共享池(2026-08-18, 问题②修复) ----
      // L2(dram>hbm): 维持 busyUntil 排队模型(decode 读与预取/淘汰共享带宽)。
      // L3(ssd>dram): decode 按需读优先于 prefill 拉取(见拉取段注释)——decode 始终按全速
      // effL3BW 读, prefill 拉取只能用剩余带宽(本步 decode 需求经 prevDecodeL3 影响下一步
      // 拉取预算); 同一根 NVMe 总线上 decode 重读饱和 ⇒ 拉取被挤占 ⇒ TTFT 上升。
      // (注: 淘汰/swap-in 的 scheduleTransfer 仍走 busyUntil, 与本池是剩余的小口径差异——
      //  容量危机场景的淘汰突发与拉取/读不互斥, 影响有限, 记录为已知简化)
      let l2Link = links['dram>hbm'];
      let l3RateAvail = effL3BW;  // decode 按需读优先: 全速读取(不受拉取影响)
      let l2Fin = now;
      let l3ReadPerPass = sumS > 0 ? sumS / Math.max(l3RateAvail, 1) : 0;
      for (let it = 0; it < 4; it++) {
        let pIt = dtEff / Math.max(passTime, 1e-9);
        let l2B = sumD * pIt;                                     // 本步 L2 读字节
        // 排队: 读请求从 max(now, 本方向+反方向共享总线忙到何时) 开始传输
        let l2Start = Math.max(now, l2Link.busyUntil, l2Link.shared.busyUntil);
        l2Fin = l2B > 0 ? l2Start + l2B / Math.max(l2Link.bw, 1) : l2Start;
        let l2Wait = Math.max(0, l2Fin - now);                    // 本步 L2 读完成所需墙钟(含排队)
        // L3: 每 pass 读时间 = 需求/可用速率(共享池, 无需迭代)
        let stepWait = Math.max(l2Wait, l3ReadPerPass * pIt);     // 取 L2/L3 较大者(与旧 max 语义一致)
        let readPerPass = stepWait / Math.max(pIt, 1e-9);          // 分摊到每 pass
        // passTime = 基础项 + 排队读时间(累加, 与旧模型 sumD/bw+sumS/bw 语义一致)
        let newPt = (r.modelWeightBytes * r.decodeWeightRatio + sumH) / r.aggHbmBW
          + perReqMs(decoding.length, r.activatedParams, p.gpus) / 1000
          + readPerPass + rD.commTime(decoding.length);
        newPt = Math.max(newPt, cmpFloor + rD.commTime(decoding.length), 1e-6);
        if (Math.abs(newPt - passTime) < 1e-12) break;
        passTime = newPt;
      }
      // 提交链路占用: decode L2 读推进共享总线 busyUntil（后续预取/淘汰在此排队）;
      // L3 读不再写 busyUntil(共享池口径), 改为记录需求供下一步拉取份额分配
      let pFinal = dtEff / Math.max(passTime, 1e-9);
      if (sumD > 0) {
        let st = Math.max(now, l2Link.busyUntil, l2Link.shared.busyUntil);
        let fin = st + sumD * pFinal / Math.max(l2Link.bw, 1);
        l2Link.busyUntil = fin; l2Link.shared.busyUntil = fin;
      }
      inst.prevDecodeL3 = sumS * pFinal; // 本步 decode L3 读需求(字节/步, 供下一步拉取预算扣除)
      // decode 读字节计入链路累计 → 瞬时差分(instL2/L3)同时含 decode 读 + 预取/淘汰突发
      stats.transferL2Bytes += sumD * pFinal;
      stats.transferL3Bytes += sumS * pFinal;
      // L2/L3 实测读带宽：本步等效前向次数 = DT/passTime，每次前向读 ΣKV_T 字节
      let passes = dtEff / Math.max(passTime, 1e-9);
      stats.hbmReadBytes += sumH * passes;
      stats.dramReadBytes += sumD * passes;
      stats.ssdReadBytes += sumS * passes;
      // 瞬时链路速率样本（需求推导用）：全部字节差分/DT = decode读 + 换入换出 + 预取/淘汰。
      // 该样本含排队与突发，供 P50/P95/P99/峰值分位统计——平均口径会低估"所需带宽"。
      let instL2 = (stats.transferL2Bytes - stats._prevL2) / Math.max(DT, 1e-9);
      let instL3 = (stats.transferL3Bytes - stats._prevL3) / Math.max(DT, 1e-9);
      stats.l2Inst.push(Math.max(instL2, 0)); stats.l3Inst.push(Math.max(instL3, 0));
      // passTime 名义分量 + 瓶颈归因（时间主要花在哪一层；comm 为通信项，cmp 为算力下限）
      let tHbm = (r.modelWeightBytes * r.decodeWeightRatio + sumH) / r.aggHbmBW
        + perReqMs(decoding.length, r.activatedParams, p.gpus) / 1000;
      // 实际读等待(含排队)分摊到每 pass —— 与 tHbm/comm 同量纲(每 pass 名义时间)
      let tL2 = Math.max(0, l2Fin - now) / Math.max(passes, 1e-9);
      let tL3 = l3ReadPerPass; // L3 共享池口径: 每 pass 读时间 = ΣKV_ssd/可用速率(含拉取挤占)
      stats.ptHbm += tHbm; stats.ptL2 += tL2; stats.ptL3 += tL3;
      stats.ptCmp += cmpFloor; stats.ptComm += rD.commTime(decoding.length);
      stats.ptSamples++;
      let bn = tHbm; let bnk = 'bnHbm';
      if (tL2 > bn) { bn = tL2; bnk = 'bnL2'; }
      if (tL3 > bn) { bn = tL3; bnk = 'bnL3'; }
      if (cmpFloor > bn) { bn = cmpFloor; bnk = 'bnCmp'; }
      if (rD.commTime(decoding.length) > bn) bnk = 'bnComm';
      stats[bnk]++;
      let tok = dtEff / passTime;
      for (let i = decoding.length - 1; i >= 0; i--) {
        let q = decoding[i];
        // P0-3: 缺失块重算——块被彻底丢弃(drop)后需按 GPU 重算代价恢复（位置感知），
        // 而非按 SSD 读速近似。重算期间该请求不产出 token，进度让位于重算。
        if (q._recomputeTok > 0) {
          // 位置感知重算速率: 每秒重算 token 数 = 1/τ_rec(pos)，pos 取当前已生成位置
          let recPos = Math.min(q.inputLen + q._outAllocTok, q.inputLen + q.outputLen - 1);
          let perTokRec = prefillTau(p, recPos);                    // 秒/token
          let recRate = 1 / Math.max(perTokRec, 1e-9);              // token/s
          // 重算算力竞争：与 decode 共享 GPU，按算力占比折算（简化：同批平分）
          let recPerStep = recRate * DT / Math.max(1, decoding.length);
          q._recomputeTok -= recPerStep;
          if (q._recomputeTok > 0) continue; // 本步全部用于重算，不产出 token
          q._recomputeTok = 0;
        }
        q.tokensGen += tok;
        // P0-1: 输出 KV 动态分配——真实系统输出 token 每生成一块就建一个块（PagedAttention 粒度），
        // 跨过块边界才分配（避免每步都分配整块造成虚增），纳入 pools.used 与 decode 读取量
        let chunk = Math.max(1, q._outMerge || 1) * p.blockSize;
        let targetTok = Math.min(q.outputLen, Math.floor(q.tokensGen / chunk) * chunk);
        if (targetTok > q._outAllocTok) allocOutBlock(q, targetTok);
        if (q.tokensGen >= q.outputLen) { decoding.splice(i, 1); completeRequest(q); dirty = true; }
      }
    }

      // 每实例队列/显存画像(S2/S3): 供负载均衡度(CV)评估
      let _qh = inst.waitQueue.length + inst.prefillQ.length + inst.prefilling.length
        + inst.kvXfer.length + inst.decodeWait.length + inst.decoding.length;
      if (_qh > inst.peakQueue) inst.peakQueue = _qh;
      if (inst.pools.hbm.used > inst.peakHbm) inst.peakHbm = inst.pools.hbm.used;
      inst.qLenSum += _qh; inst.qLenSamples++;
      // ⚠️ 均衡度专用采样(S3 修正): avgQueue 按**全仿真时长**平均会被"排空后的长尾 0 值"
      // 严重污染 —— 各实例完成时刻不同, 先排空的实例被大量 0 拉低均值, 使均衡型路由的
      // CV 反而比 round_robin 更差(实测 74.7% vs 49.0%), 与物理直觉矛盾。
      // 正确口径: 只在**系统整体仍有在途负载**的时间窗内采样(此时路由决策才有意义)。
      if (_busyPhase) { inst.qBusySum += _qh; inst.qBusySamples++; }
    } // ======== end 逐实例推进 ========

    // 显存利用率采样（峰值 + 时间加权平均）+ 并发度采样
    // 多实例(S2): 容量/占用类指标按**全部实例求和**(整机视角), 利用率按总容量归一
    let _sHbmUsed = 0, _sHbmCap = 0, _sDram = 0, _sSsd = 0, _sDec = 0, _sPf = 0, _sQ = 0;
    for (let ii = 0; ii < instances.length; ii++) {
      let xi = instances[ii];
      _sHbmUsed += xi.pools.hbm.used; _sHbmCap += xi.caps.hbm;
      _sDram += xi.pools.dram.used;   _sSsd += xi.pools.ssd.used;
      _sDec += xi.decoding.length;    _sPf += xi.prefilling.length;
      _sQ += xi.waitQueue.length + xi.prefillQ.length;
    }
    let u = _sHbmUsed / Math.max(_sHbmCap, 1);
    stats.memUtilSum += u; stats.memUtilSamples++;
    if (u > stats.memUtilPeak) stats.memUtilPeak = u;
    stats.dramPeak = Math.max(stats.dramPeak, _sDram);
    stats.ssdPeak = Math.max(stats.ssdPeak, _sSsd);
    stats.dramUsedSum += _sDram;
    stats.ssdUsedSum += _sSsd;
    // 传输差分基准：本步末的累计值 → 下一步初的差分起点
    stats._prevL2 = stats.transferL2Bytes;
    stats._prevL3 = stats.transferL3Bytes;
    if (step % 5 === 0) {
      stats.concSamples.push([+now.toFixed(2), _sDec, _sPf, _sQ]);
      // L2/L3 驻留时间序列（GB）——策略行为的瞬态画像（预取/淘汰波次可见）
      stats.l2Series.push([+now.toFixed(2), +(_sDram / 1e9).toFixed(2)]);
      stats.l3Series.push([+now.toFixed(2), +(_sSsd / 1e9).toFixed(2)]);
    }

    let _allDone = !pending.length;
    for (let ii = 0; _allDone && ii < instances.length; ii++) {
      let xi = instances[ii];
      if (xi.waitQueue.length || xi.prefillQ.length || xi.prefilling.length
        || xi.kvXfer.length || xi.decodeWait.length || xi.decoding.length) _allDone = false;
    }
    if (_allDone) { drained = true; break; }
    // 触顶未排空 → 按剩余负载自动延长（覆盖排水估计低估，保证"设大上限即可跑完"）；
    // 延长后超过用户上限 simCap ⇒ 截断退出（truncated=true，结果警示并给出建议上限值）。
    if (step + 1 >= maxSteps) {
      let rem = estimateRemainingDrain();
      if (rem <= 0) break; // 剩余估计异常，防御性退出
      if (now + rem > simCap) break; // 超出用户上限 → 截断
      maxSteps = step + 1 + Math.ceil(Math.max(rem, 120) / DT);
    }
  }
  let simEnd = Math.max(now, 1e-6);
  let truncated = !drained; // 未排空即结束 ⇒ 窗口截断（实际排水超上限；调大「仿真窗口上限」可跑完）

  // ---------- 指标 ----------
  let totalAcc = stats.hbmAcc + stats.dramAcc + stats.ssdAcc;
  // ⚠️ 命名(2026-08-20 修 bug): 这是**HBM 访问命中率**(hbmAcc/总访问), 与下方的
  // hitRate(分层**前缀**命中率对象) 是两回事。此前两者同名 ⇒ 返回对象字面量里
  // 后定义的对象覆盖了前面的数字, UI 的 sr.hitRate.toFixed(1) 直接报
  // 'toFixed is not a function'。故老字段改名 hbmHitRate。
  let hbmHitRate = totalAcc > 0 ? stats.hbmAcc / totalAcc * 100 : 0;
  let sortedLats = stats.latencies.slice().sort((a, b) => a - b);
  let p50 = sortedLats.length ? sortedLats[Math.floor(sortedLats.length * 0.5)] : 0;
  let p99 = sortedLats.length ? sortedLats[Math.min(sortedLats.length - 1, Math.floor(sortedLats.length * 0.99))] : 0;
  let mean = sortedLats.length ? sortedLats.reduce((a, b) => a + b, 0) / sortedLats.length : 0;
  let variance = sortedLats.length ? sortedLats.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sortedLats.length : 0;
  let fairnessCV = mean > 0 ? Math.sqrt(variance) / mean * 100 : 0;
  let avgTtft = stats.ttfts.length ? stats.ttfts.reduce((a, b) => a + b, 0) / stats.ttfts.length : 0;
  let sortedTtft = stats.ttfts.slice().sort((a, b) => a - b);
  let p50Ttft = sortedTtft.length ? sortedTtft[Math.floor(sortedTtft.length * 0.5)] : 0;
  let p99Ttft = sortedTtft.length ? sortedTtft[Math.min(sortedTtft.length - 1, Math.floor(sortedTtft.length * 0.99))] : 0;
  let avgTpot = stats.tpots.length ? stats.tpots.reduce((a, b) => a + b, 0) / stats.tpots.length : 0;
  let sortedTpot = stats.tpots.slice().sort((a, b) => a - b);
  let p50Tpot = sortedTpot.length ? sortedTpot[Math.floor(sortedTpot.length * 0.5)] : 0;
  let p99Tpot = sortedTpot.length ? sortedTpot[Math.min(sortedTpot.length - 1, Math.floor(sortedTpot.length * 0.99))] : 0;
  let avgQueue = stats.queueWaits.length ? stats.queueWaits.reduce((a, b) => a + b, 0) / stats.queueWaits.length : 0;

  // 未完成请求：记录截至仿真结束的部分生命周期（甘特图浅色显示）
  let incomplete = [];
  // 未完成请求列表: 跨全部实例汇总(S2)
  instances.forEach(xi => {
    xi.waitQueue.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: null, prefillStart: null, prefillEnd: null, completeTime: null, state: 'queued' }));
    xi.prefillQ.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: null, prefillEnd: null, completeTime: null, state: 'prefillQ' }));
    xi.kvXfer.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: q.prefillEnd, completeTime: null, state: 'kvXfer' }));
    xi.decodeWait.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: q.prefillEnd, completeTime: null, state: 'decodeWait' }));
    xi.prefilling.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: null, completeTime: null, state: 'prefilling' }));
    xi.decoding.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: q.prefillEnd, completeTime: null, state: 'decoding' }));
  });

  return {
    name: strategy.name || autoNameStrategy(strategy),
    hbmHitRate, p50, p99, avgLatency: mean, avgTtft, p50Ttft, p99Ttft, avgTpot, p50Tpot, p99Tpot, avgQueue, fairnessCV,
    throughput: stats.outTokens / simEnd,
    // ================= 分阶段吞吐(2026-08-26 改造) =================
    // 【改造动机】原先 prefill 吞吐的分母用 simEnd(整机墙钟, 含 decode)，量纲错位：
    //   simEnd 被 decode 独占时间主导 ⇒ prefill 侧的优化(如提 L3 带宽)在该口径下几乎不可见。
    //   实测 out=1000 时 decode 占 70.3s 而 TTFT 仅 89ms ⇒ TTFT 只占端到端 0.127%,
    //   于是「L3 带宽 25→400GB/s」让 ttft_fetch 变化 2235%, 而 prefill 吞吐只动 0.2%。
    // 【修正】各阶段用**自己的墙钟并集**作分母:
    //   prefill 吞吐 = Σ输入token ÷ 并集[prefillStart, prefillEnd]
    //   decode  吞吐 = Σ输出token ÷ 并集[decodeStart, completeTime]
    // 【为什么用并集而非 Σ逐请求】见 unionSpanSec 注释: Σ 重复计入并发重叠段, 分母虚增。
    // 【口径自检】该口径对 outputLen **免疫** —— 改 out 时 prefill 吞吐应基本不动(≈1.0×),
    //   而旧的 simEnd 口径会漂 8.8×、端到端延迟口径漂 40.5×。这是最强的筛子。
    prefillThroughput: (function () {
      let d = unionSpanSec(stats.pfSpans);
      return d > 0 ? stats.pfReqTokens / d : 0;
    })(),
    prefillComputeThroughput: (function () {
      let d = unionSpanSec(stats.pfSpans);
      return d > 0 ? stats.pfCompTokens / d : 0;
    })(),
    decodeThroughput: (function () {
      let d = unionSpanSec(stats.dcSpans);
      return d > 0 ? stats.dcOutTokens / d : 0;
    })(),
    // 阶段活跃墙钟(秒): 并集 = 分母本身; Sum = Σ逐请求(诊断并发重叠程度用)
    prefillActiveSec: unionSpanSec(stats.pfSpans),
    decodeActiveSec: unionSpanSec(stats.dcSpans),
    prefillSpanSumSec: stats.pfSpanSum,
    decodeSpanSumSec: stats.dcSpanSum,
    // 重叠系数 = Σ ÷ 并集。1.0 = 完全串行; 越大说明并发重叠越多。
    // 它同时是"单请求体验速率"与"整机产能"两口径的比值, 便于换算而无需重跑。
    prefillOverlap: (function () {
      let u = unionSpanSec(stats.pfSpans);
      return u > 0 ? stats.pfSpanSum / u : 0;
    })(),
    decodeOverlap: (function () {
      let u = unionSpanSec(stats.dcSpans);
      return u > 0 ? stats.dcSpanSum / u : 0;
    })(),
    // 单请求视角吞吐(分母 = Σ逐请求时长): 回答"一个请求能多快", 随并发下降
    prefillThroughputPerReq: stats.pfSpanSum > 0 ? stats.pfReqTokens / stats.pfSpanSum : 0,
    decodeThroughputPerReq: stats.dcSpanSum > 0 ? stats.dcOutTokens / stats.dcSpanSum : 0,
    prefillReqDone: stats.pfReqDone,
    prefillTokensTotal: stats.pfReqTokens,
    prefillComputeTokensTotal: stats.pfCompTokens,
    decodeTokensTotal: stats.dcOutTokens,
    // 缓存放大倍数: 名义÷实算。=1 表示全部靠 GPU 重算(无有效命中), 越大说明缓存省得越多
    // (与分母无关 —— 两者共用同一分母, 比值恒等于 1/(1-h_eff))
    prefillCacheAmp: stats.pfCompTokens > 0 ? stats.pfReqTokens / stats.pfCompTokens : 0,
    memUtilAvg: stats.memUtilSamples ? stats.memUtilSum / stats.memUtilSamples * 100 : 0,
    memUtilPeak: stats.memUtilPeak * 100,
    evictions: stats.evictions, activeEvictions: stats.activeEvictions,
    prefetches: stats.prefetches, drops: stats.drops,
    transferGB: stats.transferBytes / 1e9,
    fetchGB: stats.fetchBytesPulled / 1e9,  // prefill 拉取字节总量(单飞开启时应显著下降)
    // L2/L3 实测：平均读带宽（累计读字节÷仿真时长）、跨层传输带宽、峰值/均值占用
    l2ReadBW: simEnd > 0 ? stats.dramReadBytes / simEnd : 0,
    l3ReadBW: simEnd > 0 ? stats.ssdReadBytes / simEnd : 0,
    hbmReadBW: simEnd > 0 ? stats.hbmReadBytes / simEnd : 0,
    transferBW: simEnd > 0 ? stats.transferBytes / simEnd : 0,
    l2PeakGB: stats.dramPeak / 1e9,
    l3PeakGB: stats.ssdPeak / 1e9,
    l2AvgGB: stats.memUtilSamples ? stats.dramUsedSum / stats.memUtilSamples / 1e9 : 0,
    l3AvgGB: stats.memUtilSamples ? stats.ssdUsedSum / stats.memUtilSamples / 1e9 : 0,
    // ---- 需求推导（目标驱动：让该层不成为瓶颈的最小资源） ----
    // 带宽需求 = 瞬时链路速率分位数（含预取/淘汰突发，平均口径会低估）：
    // P50/P95/P99 由样本排序取分位；P99 为推荐"所需带宽"，峰值供评估最坏突发
    l2BWp50: pctOf(stats.l2Inst, 0.50), l2BWp95: pctOf(stats.l2Inst, 0.95), l2BWp99: pctOf(stats.l2Inst, 0.99),
    l3BWp50: pctOf(stats.l3Inst, 0.50), l3BWp95: pctOf(stats.l3Inst, 0.95), l3BWp99: pctOf(stats.l3Inst, 0.99),
    l2BWPeak: pctOf(stats.l2Inst, 1), l3BWPeak: pctOf(stats.l3Inst, 1),
    // L2 链路实际生效带宽(GB/s, 2026-08-31 EP 诊断): 实例0 的 dram>hbm 链路值,
    // = min(pcieBW×f, dramBW)/instShare —— 经 makeInstance 接线后的真实值(验证 f 因子用)
    l2LinkBwGbs: instances[0] ? instances[0].links['dram>hbm'].bw / 1e9 : 0,
    // 容量需求 = 峰值占用（容量低于该值必发生淘汰/丢弃/排队）
    // passTime 分解（名义分量占比）与瓶颈归因（时间主要花在哪层）
    // TTFT 分解（平均 ms）：queue/prefillQ/fetch/compute 构成 prefill 段时间账；
    // dWait/dTime 为 decode 段（延迟分解用）。TTFT = queue+prefillQ+fetch+compute
    ttftBreakdown: stats.completed > 0 ? {
      queue: stats.ttftQ / stats.completed * 1000,
      prefillQ: stats.ttftP / stats.completed * 1000,
      fetch: stats.ttftF / stats.completed * 1000,
      // 方案A(2026-09-01) 诊断: fetch 分量中从 prefillQ 窗口划转来的部分(ms)与被让过的请求占比。
      //  · fetchQueueSkip ≈ fetch  ⇒ 拉取等待全部发生在**组波前**(超车生效, 波内无干等);
      //  · fetchQueueSkip = 0      ⇒ 方案A 未开启或未触发, fetch 全部来自波内暴露。
      fetchQueueSkip: stats.ttftFq / stats.completed * 1000,
      skipRate: stats.pqSkipN / stats.completed,
      compute: stats.ttftC / stats.completed * 1000,
      // ---- compute 的二级拆分: compute = computeNet + computeWait ----
      // computeNet : **纯 GPU 计算**(沿实际计算路径的 τ 积分, 见 stats.ttftCnet)。与并发数
      //   无关, 等于"该请求若独占 GPU 需算多久" ⇒ 可直接对标解析式 prefillIntegral 的增量。
      // computeWait: **算力竞争等待** = compute − computeNet。N 个请求瓜分算力时, 每个请求
      //   都把整段墙钟记进自己的 compute, 差额就是被别人占用算力的时长。
      //   (注意: 拉取暴露已单列为 fetch 且已从 compute 中扣除, 不在这里。)
      // 波次模式下 computeWait 还含"等整波其他成员算完"的波次量化等待 —— 同一波里,
      //   最慢就绪的成员把等待记进 fetch, 其余成员记进 computeWait(各自只为自己没就绪的段负责)。
      computeNet: stats.ttftCnet / stats.completed * 1000,
      computeWait: Math.max(0, (stats.ttftC - stats.ttftCnet)) / stats.completed * 1000,
      // computeNetRaw / computeNetClampRate(2026-09-01 诊断): clamp 前的 computeNet 与截断率。
      //   ⚠️ 截断是 **DT 离散化的边界 artifact**, 不是逻辑错误, 量级恒 ≤ 1·DT(2ms):
      //   拉取完成的那一步(_ft1 所在步)**既完成拉取又开始计算**, 但 fetchExposure =
      //   _ft1 − waveEmpty 把整段算作纯等待 ⇒ _cW = T − _fW 比"实际计算步数×DT"少一步。
      //   (2026-09-01 拉取块搬到组波之前后暴露: 搬移前那一步被浪费掉, 恰好给 _cW 垫了 1·DT。
      //    根因是 prefillEnd 记为完成步的**起点**而非终点, 修它会动 TTFT 本身, 不划算。)
      //   ⇒ 影响: compute 只有数步的场景(如 F 档 ~5 步)相对误差可达 20%, computeWait 被压到 0。
      //   读图规则: computeWait ≈ 0 且 Raw > computeNet ⇒ **不能**断言"无算力竞争", 需看
      //   Raw − computeNet 的绝对量; 若接近 1·DT 说明是分辨率极限, 应加大 compute 规模再看。
      //   回归断言用"截断量 ≤ 1·DT"(见 _verify_ttft_timestamp.js), 而非 clampRate == 0。
      computeNetRaw: stats.cNetRawSum / stats.completed * 1000,
      computeNetClampRate: stats.cNetClampN / stats.completed,
      // 平均截断量(ms): 应恒 ≤ DT×1000 = 2ms。超出 ⇒ _cNet 累加口径与波耗时脱钩, 回查两处累加点。
      computeNetClampMs: (stats.cNetRawSum - stats.ttftCnet) / stats.completed * 1000,
      dWait: stats.latDw / stats.completed * 1000,
      dTime: stats.latDt / stats.completed * 1000,
      // prefill 传输独立用时（ms, 未与计算重叠前）: wait_complete 下 ≈fetch(串行);
      // race/best_effort 下与计算重叠 → 实际等待 fetch≈0 但独立用时仍在此体现(重叠收益 = fetchSolo − fetch)
      fetchSolo: stats.fetchSoloSum / stats.completed * 1000,
      // prefill 传输过程实际耗时（ms, = _ft1 − _ft0, 仿真中传输的真实时长）: 含 L3 并发带宽
      // 排队、不含计算 —— 为避免被计算延迟覆盖而单列为"独立"展示;
      // wc 下 ≈fetch(实际暴露等待), race/be 下为被计算重叠**隐藏**的拉取过程时长(fetch 恒 0)
      fetchReal: stats.fetchSpanSum / stats.completed * 1000,
      // ---- GPU 占用画像(2026-08-21): compute 是残差, 这两项才反映算力真实使用 ----
      // computeBusyMs: prefill 期间 GPU 真的在算的**墙钟总时长**(ms, 跨实例累加, 非每请求平均)。
      //   与 compute(每请求残差平均)是完全不同的量, 不要混用。
      // computeConc: 平均同时占算力的请求数。≈1 ⇒ 流水线空转(拉取跟不上, GPU 被饿死);
      //   远大于 1 ⇒ 算力被填满, 此时 compute 才真实反映计算成本。
      computeBusyMs: stats.pfGpuBusySec * 1000,
      computeConc: stats.pfBusySteps > 0 ? stats.pfActSum / stats.pfBusySteps : 0,
      // GPU 忙碌占仿真总时长的比例(%): 低 ⇒ 算力闲置(瓶颈在存储/排队)
      computeBusyPct: simEnd > 0 ? stats.pfGpuBusySec / simEnd * 100 : 0,
      // PD 真分离: P→D KV 传输段(ms) —— TTFT 第5分量。
      // TTFT = queue + prefillQ + fetch + compute + xfer(真分离时非0)
      xfer: stats.ttftX / stats.completed * 1000
    } : null,
    // 多实例指标(S2, 2026-08-20): 仅 instances>1 时有效
    multi: instances.length > 1 ? {
      count: instances.length,
      routePolicy: routePolicy,          // 实际生效的策略(DSL ROUTE 行 > UI 下拉)
      routeFromDsl: !!(strategy && strategy.routing && strategy.routing.type),
      routeHook: !!jsRoute,              // 是否被 JS route() 钩子接管
      gpusPerInst: instances.map(x => x.gpus),
      // 每实例明细: 路由到的请求数 / 完成数 / 平均与峰值在途队列 / HBM 峰值占用(GB)
      perInst: instances.map(x => ({
        id: x.id, gpus: x.gpus, routed: x.nRouted, completed: x.nCompleted,
        epSize: x.p.epSize || 1,            // EP clamp 后的实际生效值(2026-08-31, 供验证/诊断)
        prefillA: x.pP.prefillA,            // 按本实例卡数重估的 a(EP>1 时含 AllToAll 分摊)
        l2BwGbs: x.links['dram>hbm'].bw / 1e9,  // 本实例 L2 链路带宽(含 f 因子与 /instShare)
        avgQueue: x.qLenSamples > 0 ? x.qLenSum / x.qLenSamples : 0,
        // busyQueue: 只在系统有负载时统计的平均在途 —— 衡量路由均衡度应看这个
        busyQueue: x.qBusySamples > 0 ? x.qBusySum / x.qBusySamples : 0,
        peakQueue: x.peakQueue, peakHbmGB: x.peakHbm / 1e9,
        hbmCapGB: x.caps.hbm / 1e9
      })),
      // 队列均衡度 CV(%): 基于 busyQueue —— 这是评价路由策略的主指标
      // (完成数 CV 受请求长度分布干扰: 长度倾斜下"请求数均分"未必等于"负载均分")
      queueCV: (function(){
        let arr = instances.map(x => x.qBusySamples > 0 ? x.qBusySum / x.qBusySamples : 0);
        let n = arr.length; if (!n) return 0;
        let m = arr.reduce((a, b) => a + b, 0) / n;
        if (m <= 0) return 0;
        let v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
        return Math.sqrt(v) / m * 100;
      })(),
      // 峰值队列极差: 最直观的失衡度量(最忙实例 vs 最闲实例的峰值差)
      peakSpread: Math.max.apply(null, instances.map(x => x.peakQueue))
        - Math.min.apply(null, instances.map(x => x.peakQueue)),
      // 负载均衡度: 完成数的变异系数(CV=std/mean)。轮询应接近 0, 越大越不均衡
      loadCV: (function(){
        let arr = instances.map(x => x.nCompleted);
        let n = arr.length; if (!n) return 0;
        let m = arr.reduce((a, b) => a + b, 0) / n;
        if (m <= 0) return 0;
        let v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
        return Math.sqrt(v) / m * 100;
      })(),
      // 校验用: Σ每实例完成 应 == 全局 completed
      sumCompleted: instances.reduce((a, x) => a + x.nCompleted, 0),
      sumRouted: instances.reduce((a, x) => a + x.nRouted, 0),
      // S4 前缀亲和(2026-08-20)
      affinity: affinity,
      // 各实例实测命中率(%, token 加权)
      instHitRate: instances.map(x => x.reqTok > 0 ? x.hitTok / x.reqTok * 100 : 0),
      // 命中率损失: 输入 h(理想上限) 与全局实测的差值(个百分点)。
      // 亲和开启后这个差值 = 路由质量的直接代价 —— hash_prefix 接近 0, random 接近 h×(1-1/n)
      hitIdeal: p.prefixHit * 100,
      hitActual: stats.reqTokTotal > 0
        ? (stats.hitTokL1 + stats.hitTokL2 + stats.hitTokL3) / stats.reqTokTotal * 100 : 0,
      hitLossPct: stats.reqTokTotal > 0
        ? p.prefixHit * 100 - (stats.hitTokL1 + stats.hitTokL2 + stats.hitTokL3) / stats.reqTokTotal * 100 : 0
    } : null,
    // PD 真分离指标(2026-08-20): 仅 pdMode=2 时有效
    pd: p.pdMode === 2 && instances.length === 1 ? {
      prefillGpus: pdPrefillGpus, decodeGpus: pdDecodeGpus,
      linkBW: p.pdLinkBW, linkUtil: p.pdLinkUtil, linkEffBW: pdLinkEffBW,
      kvComp: p.pdKvComp,
      xferGB: stats.pdXferBytes / 1e9,
      // 每请求传输量(MB)与耗时: solo=独立(无竞争)基准, span=实际墙钟(含并发平分带宽的排队)
      xferPerReqMB: stats.pdXferCount > 0 ? stats.pdXferBytes / stats.pdXferCount / 1e6 : 0,
      xferSoloMs: stats.pdXferCount > 0 ? stats.pdXferSoloSum / stats.pdXferCount * 1000 : 0,
      xferSpanMs: stats.pdXferCount > 0 ? stats.pdXferSpanSum / stats.pdXferCount * 1000 : 0,
      xferCount: stats.pdXferCount
    } : null,
    // decode 每 pass 名义分量的绝对用时（ms/pass, 未 max 取大前的单独耗时）：
    // 传输 = l2+l3（跨层 KV 读含链路排队）; 计算侧 = hbm(权重+KV读+每请求开销) + cmp(算力下限) + comm(TP通信)
    passMs: stats.ptSamples > 0 ? {
      hbm: stats.ptHbm / stats.ptSamples * 1000,
      l2: stats.ptL2 / stats.ptSamples * 1000,
      l3: stats.ptL3 / stats.ptSamples * 1000,
      cmp: stats.ptCmp / stats.ptSamples * 1000,
      comm: stats.ptComm / stats.ptSamples * 1000
    } : null,
    ptBreakdown: stats.ptSamples > 0 ? {
      hbm: stats.ptHbm / (stats.ptHbm + stats.ptL2 + stats.ptL3 + stats.ptCmp + stats.ptComm) * 100,
      l2: stats.ptL2 / (stats.ptHbm + stats.ptL2 + stats.ptL3 + stats.ptCmp + stats.ptComm) * 100,
      l3: stats.ptL3 / (stats.ptHbm + stats.ptL2 + stats.ptL3 + stats.ptCmp + stats.ptComm) * 100,
      cmp: stats.ptCmp / (stats.ptHbm + stats.ptL2 + stats.ptL3 + stats.ptCmp + stats.ptComm) * 100,
      comm: stats.ptComm / (stats.ptHbm + stats.ptL2 + stats.ptL3 + stats.ptCmp + stats.ptComm) * 100
    } : null,
    ptSamples: stats.ptSamples,
    bottleneckPct: {
      hbm: stats.bnHbm, l2: stats.bnL2, l3: stats.bnL3, cmp: stats.bnCmp, comm: stats.bnComm
    },
    l2Series: stats.l2Series, l3Series: stats.l3Series,
    prefixHits: stats.prefixHits || 0, prefixSavedMB: (stats.prefixSavedBytes || 0) / 1e6,
    sessionHits: stats.sessionHits || 0,
    // 实测分层命中率(2026-08-20, token 加权 %): 分母 = 全部请求输入 token 总量。
    // hitL1+hitL2+hitL3+miss == 100(守恒)。hitTotal 与输入 p.prefixHit×100 的差值 =
    // clamp(组前缀按最长请求, 短请求被截) + 容量淘汰/丢弃 造成的命中侵蚀。
    hitRate: stats.reqTokTotal > 0 ? {
      l1: stats.hitTokL1 / stats.reqTokTotal * 100,
      l2: stats.hitTokL2 / stats.reqTokTotal * 100,
      l3: stats.hitTokL3 / stats.reqTokTotal * 100,
      miss: stats.missTok / stats.reqTokTotal * 100,
      total: (stats.hitTokL1 + stats.hitTokL2 + stats.hitTokL3) / stats.reqTokTotal * 100,
      input: p.prefixHit * 100
    } : null,
    hitTok: { l1: stats.hitTokL1, l2: stats.hitTokL2, l3: stats.hitTokL3,
      miss: stats.missTok, total: stats.reqTokTotal },
    prefixGroups: Object.keys(prefixGroupMap).length,
    fragPct: r.fragPct,
    completed: stats.completed, totalReqs: N + followUpCount,
    truncated: truncated, simEnd: simEnd, drainEst: drainEst, // 截断标志 + 仿真结束时间 + 排水估计(截断时建议上限值)
    latencies: stats.latencies, timeline: timeline, concTimeline: stats.concSamples,
    incomplete: incomplete,   // (simEnd 已在上一行给出, 此处原有重复 key 已删 —— 2026-08-20)
    admission: strategy.admission.type, eviction: strategy.eviction.type, prefetch: strategy.prefetch.type,
  };
}
