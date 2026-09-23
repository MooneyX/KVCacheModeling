export const TTFT_STACK_KEY = 'ttft_stack';

export const TTFT_STACK_PARTS = [
  { key: 'ttft_queue',        label: '排队等待',     color: '#64748b',
    tip: '请求到达 → 进入 prefill 队列前的等待。占比高 ⇒ 系统整体过载(降 qps / 加实例)' },
  { key: 'ttft_prefillq',     label: 'Prefill排队',  color: '#8b5cf6',
    tip: '在 prefill 队列中等待被调度(受 pPrefillSlots 准入限制)' },
  { key: 'ttft_fetch',        label: 'L3拉取等待',   color: '#f59e0b',
    tip: '等待 KV 从 L3(SSD/远端存储)拉取到位的**暴露**时长。波内暴露 = _ft1 − waveEmpty(被上一波计算掩盖的不计); 方案A 开启时还含 prefillQ 期"因未就绪被让过"的等待。race/best_effort 恒为 0(拉取与计算重叠/未拉部分重算)' },
  { key: 'compute_net',       label: '纯计算',       color: '#10b981',
    tip: '独占 GPU 时该请求的真实计算时长(沿实际计算路径的 τ 积分)。与并发/带宽无关 ⇒ 占比高才是"真缺算力"' },
  { key: 'compute_wait',      label: '算力竞争等待', color: '#ef4444',
    tip: '算力被其他并发请求占用 + 波次量化(等整波其他成员算完)的时长。占比高 ⇒ 应收紧准入做并发控制, 加卡收益有限' },
  { key: 'ttft_xfer',         label: 'PD KV传输',    color: '#06b6d4',
    tip: 'PD 真分离时 P 节点 → D 节点的 KV 传输段(非真分离恒为 0)' }
];

export function isTtftStack(metric) { return metric === TTFT_STACK_KEY; }

export const SENS_LEVELS = {
  evict_threshold: [10,30,50,70,90],
  max_batch_size: [4,8,16,32,64,128,256],
  prefix_hit: [0,25,50,75,100],
  prefix_warm_l2: [0,10,25,50,75],  // L2 预热命中率(嵌套 ≤ prefix_hit; 引擎侧超出会被 clamp)
  // 2026-08-18: 默认档位改为覆盖整机8卡聚合带宽 50→400GB/s 收益区间（原 1..80 停在收益饱和点之前）
  ssd_bw: [10,25,50,100,150,200,300,400],
  input_len: [2048,8192,16384,32768,65536],
  qps: [0.1,0.3,1,3,8],
  concurrency: [8,16,32,64,128,256],  // 单批Prefill基准: batch 规模扫描(2026-08-19)
  // GPU 硬件预设(2026-08-25): **唯一的非数值扫描维度**, 档位是 hwPresets 的 key 字符串。
  // 因此凡是对档位做算术的地方(parseRangeOrList / sensParamUnit / 图例排序)都必须为它开分支。
  gpu_preset: ['h20x8','b300x8']
};

export const SENS_GPU_LABEL = { 'h20x8':'H20×8', 'h100x8':'H100×8', 'a100x8':'A100×8',
  'b200x8':'B200×8', 'b300x8':'B300×8', 'a950pr8':'昇腾950PR×8', 'a950dt8':'昇腾950DT×8',
  'klxp800x8':'昆仑芯P800×8', 'klxp900x32':'昆仑芯P900×32' };

export const SENS_PARAM_LABEL = {evict_threshold:'淘汰触发阈值', max_batch_size:'最大Batch Size', prefix_hit:'前缀命中率', prefix_warm_l2:'L2预热命中率', ssd_bw:'L3聚合带宽', input_len:'输入长度', qps:'到达率QPS', concurrency:'并发请求数', gpu_preset:'GPU硬件'};

export const SENS_METRIC_LABEL = {
  hit_rate:'HBM命中率(%)', prefix_hit_rate:'前缀命中率实测(%)',
  latency:'平均延迟(ms)', latency_p50:'延迟P50(ms)', p99_latency:'延迟P99(ms)',
  ttft:'平均TTFT(ms)', ttft_p50:'TTFT P50(ms)', ttft_p99:'TTFT P99(ms)',
  tpot:'平均TPOT(ms/tok)', tpot_p50:'TPOT P50(ms/tok)', tpot_p99:'TPOT P99(ms/tok)',
  throughput:'吞吐(tok/s)', mem_util:'显存利用率峰值(%)',
  prefill_thr:'Prefill吞吐-名义(tok/s)', prefill_comp_thr:'Prefill吞吐-GPU实算(tok/s)', prefill_cache_amp:'缓存放大倍数(×)',
  // 分阶段吞吐(2026-08-26): 分母 = 各阶段墙钟并集。decode_thr 与 throughput(simEnd 口径)互补
  decode_thr:'Decode吞吐(tok/s)',
  prefill_thr_per_req:'Prefill吞吐-单请求(tok/s)', decode_thr_per_req:'Decode吞吐-单请求(tok/s)',
  prefill_active_s:'Prefill活跃时长(s)', decode_active_s:'Decode活跃时长(s)',
  prefill_overlap:'Prefill并发重叠系数(×)', decode_overlap:'Decode并发重叠系数(×)',
  fetch_ratio:'L3拉取时间占比(%)',
  compute_net:'纯计算(ms)', compute_wait:'算力竞争等待(ms)', compute_wait_ratio:'算力竞争等待占比(%)',
  // TTFT 六分量(2026-08-26): 既是堆叠柱的组成部分, 也可各自单独作折线纵轴
  ttft_queue:'TTFT分量-排队等待(ms)', ttft_prefillq:'TTFT分量-Prefill排队(ms)',
  ttft_fetch:'TTFT分量-L3拉取等待(ms)', ttft_xfer:'TTFT分量-PD KV传输(ms)',
  measurement_arrival_qps:'measurement 到达QPS', measurement_completion_qps:'measurement 完成QPS',
  measurement_ttft:'measurement 平均TTFT(ms)', measurement_ttft_p50:'measurement TTFT P50(ms)', measurement_ttft_p99:'measurement TTFT P99(ms)',
  measurement_tpot:'measurement 平均TPOT(ms/tok)', measurement_tpot_p50:'measurement TPOT P50(ms/tok)', measurement_tpot_p99:'measurement TPOT P99(ms/tok)',
  measurement_latency:'measurement 平均延迟(ms)', measurement_latency_p50:'measurement 延迟P50(ms)', measurement_latency_p99:'measurement 延迟P99(ms)',
  measurement_hit_rate:'measurement 前缀命中率(%)',
  // ★ 特殊指标: 值不是单一数字而是 6 分量堆叠柱(见 TTFT_STACK_PARTS)。
  //   放在最后 —— 导出页 ←/→ 键按此顺序遍历, 结构特殊的放末尾不打断折线指标的连续浏览。
  ttft_stack:'TTFT构成(堆叠柱)'
};

export function sensParamUnit(param, v) {
  if (param === 'gpu_preset') return SENS_GPU_LABEL[v] || String(v);  // 非数值维度, 直接查表
  if (param === 'ssd_bw') return v + 'GB/s';
  if (param === 'max_batch_size') return 'B=' + v;
  if (param === 'concurrency') return 'N=' + v;
  if (param === 'input_len') return v >= 1024 ? (v / 1024) + 'k tok' : v + ' tok';
  // Prefill token 预算(2026-08-31): 它不是正式扫描维, 但整合导出里可作区分参数出现
  // (如 P5 批次 4096/16384/65536) —— 走默认分支会被加成 '4096%'(用户实测)
  if (param === 'maxPrefillTok') return v >= 1024 ? (v / 1024) + 'k tok' : v + ' tok';
  if (param === 'qps') return v + ' qps';
  return v + '%';
}
