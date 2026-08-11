
// ======================== GLOBAL STATE ========================
// attn: 'gqa' | 'mla'; paramsB/actB: 0 = 按dense公式自动估算
let models = {
  'Llama-3-70B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-72B':   {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:151936, paramsB:0, actB:0},
  'Llama-3-8B':    {attn:'gqa', layers:32, kvHeads:8, headDim:128, hidden:4096, vocab:128256, paramsB:0, actB:0},
  'Qwen2.5-7B':    {attn:'gqa', layers:28, kvHeads:4, headDim:128, hidden:3584, vocab:151936, paramsB:0, actB:0},
  'Qwen3-32B':     {attn:'gqa', layers:64, kvHeads:8, headDim:128, hidden:5120, vocab:151936, paramsB:32, actB:32},
  'Qwen3-30B-A3B': {attn:'gqa', layers:48, kvHeads:4, headDim:128, hidden:2048, vocab:151936, paramsB:30.5, actB:3.3},
  'DeepSeek-V2-Lite': {attn:'mla', layers:27, kvLora:512, ropeDim:64, hidden:2048, vocab:128256, paramsB:15.7, actB:2.4},
  'DeepSeek-V3':   {attn:'mla', layers:61, kvLora:512, ropeDim:64, hidden:7168, vocab:128256, paramsB:671, actB:37},
  'Custom':        {attn:'gqa', layers:80, kvHeads:8, headDim:128, hidden:8192, vocab:128000, paramsB:0, actB:0}
};

let hwPresets = {
  'h20x8':  {hbm:96, hbmBW:4,   tflops:148, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:10, gpus:8},
  'h100x8': {hbm:80, hbmBW:3.35,tflops:989, tp:8, nvlink:900,  pcie:64,  dram:1024, dramBW:400, ssd:20, ssdBW:14, gpus:8},
  'a100x8': {hbm:80, hbmBW:2,   tflops:312, tp:8, nvlink:600,  pcie:32,  dram:512,  dramBW:300, ssd:10, ssdBW:7,  gpus:8},
  'b200x8': {hbm:192,hbmBW:8,   tflops:2250,tp:8, nvlink:1800, pcie:128, dram:2048, dramBW:500, ssd:40, ssdBW:14, gpus:8}
};

let currentModel = 'Llama-3-70B';

// ======================== HELPERS ========================
function $(id){return document.getElementById(id)}
function gv(id){let el=$(id);return el?parseFloat(el.value)||0:0}
function gi(id){let el=$(id);return el?parseInt(el.value)||0:0}

// Seeded RNG (mulberry32) — 所有仿真/采样的可复现性基础
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function getParams(){
  return {
    attn: $('pAttnType').value,
    layers: gi('pLayers'), kvHeads: gi('pKvHeads'), headDim: gi('pHeadDim'),
    kvLora: gi('pKvLora'), ropeDim: gi('pRopeDim'),
    hidden: gi('pHidden'), dtypeBytes: gv('pDtype'), weightDtype: gv('pWeightDtype'), vocab: gi('pVocab'),
    paramsB: gv('pParamsB'), actB: gv('pActB'),
    gpus: gi('pGpuCount'), hbmPerGpu: gv('pHbm'), hbmBW: gv('pHbmBW'),
    tflops: gv('pTflops'), tpSize: gi('pTpSize'), nvlinkBW: gv('pNvlinkBW'),
    pcieBW: gv('pPcieBW'), tierQuant: gv('pTierQuant'),
    dram: gv('pDram'), dramBW: gv('pDramBW'), ssd: gv('pSsd'), ssdBW: gv('pSsdBW'),
    concurrency: gi('pConcurrency'), inputLen: gi('pInputLen'),
    outputLen: gi('pOutputLen'), qps: gv('pQps'), mfu: gv('pMfu')/100,
    maxBatch: gi('pMaxBatch'), blockSize: gi('pBlockSize'),
    prefixHit: gi('pPrefixHit')/100,
    lenDist: $('pLenDist').value, multiTurn: gi('pMultiTurn')/100, seed: gi('pSeed'),
    arrivalDist: $('pArrivalDist') ? $('pArrivalDist').value : 'poisson',
    framework: $('pFramework') ? $('pFramework').value : 'generic',
    prefixCache: $('pPrefixCache') ? $('pPrefixCache').value : 'hash',
    pdSep: gi('pPdSep') === 1, tieredKv: gi('pTieredKv') === 1
  };
}

function formatBytes(b){
  if(b>=1e15) return (b/1e15).toFixed(2)+' PB';
  if(b>=1e12) return (b/1e12).toFixed(2)+' TB';
  if(b>=1e9)  return (b/1e9).toFixed(2)+' GB';
  if(b>=1e6)  return (b/1e6).toFixed(2)+' MB';
  if(b>=1e3)  return (b/1e3).toFixed(2)+' KB';
  return b.toFixed(0)+' B';
}

function formatRate(bps){
  if(bps>=1e12) return (bps/1e12).toFixed(2)+' TB/s';
  if(bps>=1e9)  return (bps/1e9).toFixed(2)+' GB/s';
  if(bps>=1e6)  return (bps/1e6).toFixed(2)+' MB/s';
  return bps.toFixed(0)+' B/s';
}

function formatNum(n){
  if(n>=1e9) return (n/1e9).toFixed(1)+'B';
  if(n>=1e6) return (n/1e6).toFixed(1)+'M';
  if(n>=1e3) return (n/1e3).toFixed(1)+'K';
  return n.toFixed(0);
}

// Chart registry + single resize handler (避免监听器累积)
let chartRegistry = [];
function initChart(domId){
  let el=$(domId);
  let old=echarts.getInstanceByDom(el);
  if(old) old.dispose();
  let ch = echarts.init(el);
  chartRegistry.push(ch);
  return ch;
}
window.addEventListener('resize',()=>{chartRegistry.forEach(c=>{try{c.resize()}catch(e){}})});

function setFormula(id, html){
  let el=$(id); if(el) el.innerHTML=html;
}

// ======================== CORE CALCULATIONS ========================
// 单 token KV 字节数：GQA = 2(K,V) × L × kvHeads × headDim × dt
// MLA = L × (kvLoraRank + ropeDim) × dt  (压缩潜变量 + 解耦RoPE)
// decode 每请求开销（权重带宽之外的 attention/采样/调度，ms）：
// = 固定调度项(多卡 TP 通信/调度, 单卡≈0) + attention 幂律项(随 batch 增长, 随 GPU 数分摊)
// 校准来源: Qwen3-32B×H20 单卡 6.4ms×n^0.75(单请求 22.5ms=权重16+6.5 → 8并发 46.6ms);
//           DS-V3×8×H20 实测 5.2+3.7×n^0.75(单请求 8.9ms → 8并发 22.8ms, 激活参数缩放 37/32)
function perReqMs(n, actParams, gpus) {
  let actScale = Math.max(1, actParams / 32e9);
  let fixed = 5.2 * actScale * (gpus > 1 ? 1 : 0);                     // 多卡 TP 固定通信/调度项
  let attn = 6.4 * actScale * Math.pow(Math.max(gpus, 1), -0.33) * Math.pow(n, 0.75); // attention 随 batch 幂律、随卡数分摊
  return fixed + attn;
}

function calcKvPerToken(p){
  if (p.attn === 'mla') return p.layers * (p.kvLora + p.ropeDim) * p.dtypeBytes;
  return 2 * p.layers * p.kvHeads * p.headDim * p.dtypeBytes;
}

// 与仿真引擎一致的前缀组模型：4组差异化前缀比例的均值
const PREFIX_RATIOS = [0.12, 0.22, 0.35, 0.48];
const AVG_PREFIX_RATIO = PREFIX_RATIOS.reduce((s, x) => s + x, 0) / PREFIX_RATIOS.length; // 0.2925

// Dense 模型参数量估算（GQA 下 K/V 投影维度 = kvHeads×headDim，不是 hidden）
function calcDenseParams(p){
  let vocab = p.vocab || 128000;
  let interm = Math.round(p.hidden * 3.5);
  let attn;
  if (p.attn === 'mla') attn = 2 * p.hidden * p.hidden + 2 * p.hidden * (p.kvLora + p.ropeDim);
  else attn = 2 * p.hidden * p.hidden + 2 * p.hidden * p.kvHeads * p.headDim;
  let mlp = 3 * p.hidden * interm;
  return p.layers * (attn + mlp) + 2 * vocab * p.hidden;
}

function calcAll(p){
  let kvPerToken = calcKvPerToken(p);
  // 参数量：覆盖值优先（MoE 必须显式给出总参数与激活参数）
  let totalParams = p.paramsB > 0 ? p.paramsB * 1e9 : calcDenseParams(p);
  let activatedParams = p.actB > 0 ? p.actB * 1e9 : totalParams;
  // 权重使用独立精度
  let modelWeightBytes = totalParams * p.weightDtype;
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
  // Prefill：计算瓶颈，FLOPs/token = 2 × 激活参数
  let prefillTps = computeFlops / (2 * activatedParams);

  // TP AllReduce 通信开销（Megatron式：每层2次AllReduce；ring有效数据 2×(TP-1)/TP × 消息）
  // 带宽项随token数线性增长；小消息延迟项每次前向固定 2×layers×5μs
  const AR_LAT = 5e-6;
  let tpSize = Math.max(1, Math.min(p.tpSize || 1, p.gpus));
  function commTime(tokens){
    if (tpSize <= 1) return 0;
    let ringFactor = 2 * (tpSize - 1) / tpSize;
    let bytes = 2 * p.layers * tokens * p.hidden * 2 * ringFactor; // 2B激活(bf16)
    return bytes / (p.nvlinkBW * 1e9) + 2 * p.layers * AR_LAT;
  }

  // Decode：带宽瓶颈，每次前向 = 读权重 + 读批次全部KV + 每请求开销 + TP通信；与算力下限取 max
  // 每请求开销(attention/采样/调度)见顶层 perReqMs()（Qwen3-32B 单卡 6.4×n^0.75；DS-V3 8卡 5.2+3.7×n^0.75）
  // 22.5ms@1 → 46.6ms@8：6.5ms×n^0.75×actParams缩放），保证"快速结果"与仿真 TPOT 一致
  // MoE decode 权重读取：每 token 只读激活参数对应权重（dense 全读 + 激活专家）——
  // 按总权重带宽会高估 MoE 访存（DS-V3 671B 只激活 37B → 高估 ~18×，实测 TPOT 10ms vs 仿真 34ms）
  let decodeWeightRatio = (p.actB > 0 && p.paramsB > 0) ? Math.max(p.actB / p.paramsB, 0.02) : 1;
  let batchN = Math.max(1, Math.min(p.maxBatch, p.concurrency));
  let passMemTime = (modelWeightBytes * decodeWeightRatio + batchN * avgLifetimeKv) / aggHbmBW
    + perReqMs(batchN, activatedParams, p.gpus) / 1000;
  let passCmpTime = 2 * activatedParams * batchN / computeFlops;
  let commOverhead = commTime(batchN);
  let passTime = Math.max(passMemTime, passCmpTime) + commOverhead;
  let decodeTpsPerReq = 1 / passTime;                 // 每请求 tok/s（同批次各请求一致）
  let decodeTpsTotal = batchN / passTime;

  let kvGenSpeed = prefillTps * kvPerToken;           // prefill 期 KV 写入带宽需求
  let dramTotal = p.dram * 1e9;
  let ssdTotal = p.ssd * 1e12;
  let totalKvDemand = p.concurrency * effLifetimeKv;

  // Little 定律稳态并发估计：L = prefill + output × passTime
  let estLatency = p.inputLen / prefillTps + p.outputLen * passTime;
  let littleConcurrency = p.qps * estLatency;
  // TTFT / TPOT 估计（单请求、无排队）
  let ttftEst = p.inputLen / prefillTps + commTime(p.inputLen);
  let tpotEst = passTime;

  return {kvPerToken, blockBytes, blocksPerReq, perRequestKv, avgLifetimeKv, fragPct,
    prefixSavedPerReq, effPerReqKv, effLifetimeKv,
    totalHbm, availHbm, modelWeightBytes, modelWeightGB, overhead, decodeWeightRatio,
    maxHbmRequests, computeFlops, aggHbmBW, prefillTps, passTime, commOverhead, commTime, tpSize, decodeTpsPerReq, decodeTpsTotal,
    kvGenSpeed, dramTotal, ssdTotal, totalKvDemand, totalParams, activatedParams,
    estLatency, littleConcurrency, ttftEst, tpotEst};
}

// ======================== TAB SWITCHING & NAV ========================
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    $(btn.dataset.tab).classList.add('active');
    setTimeout(refreshActiveTab,100);
  });
});

function refreshActiveTab(){
  let active = document.querySelector('.tab-panel.active');
  if(!active) return;
  switch(active.id){
    case 'tab-params': updateQuickResults(); initStrategyTab(); break;
    case 'tab-storage': refreshStorageTab(); break;
    case 'tab-schedule': refreshScheduleTab(); break;
    case 'tab-cross': refreshCrossTab(); break;
  }
}

// ======================== TAB 1: PARAMETERS ========================
function initParamsTab(){
  let bar = $('modelPresets');
  Object.keys(models).forEach(name=>{
    let btn = document.createElement('button');
    btn.className='preset-tag'+(name===currentModel?' active':'');
    btn.textContent=name;
    btn.onclick=function(){applyModel(name,this)};
    bar.appendChild(btn);
  });
  $('hwPresets').querySelectorAll('.preset-tag').forEach(btn=>{
    btn.onclick=()=>{
      $('hwPresets').querySelectorAll('.preset-tag').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      let hw=hwPresets[btn.dataset.hw];
      if(hw){
        $('pHbm').value=hw.hbm;$('pHbmBW').value=hw.hbmBW;$('pTflops').value=hw.tflops;
        $('pTpSize').value=hw.tp;$('pNvlinkBW').value=hw.nvlink;$('pPcieBW').value=hw.pcie;
        $('pDram').value=hw.dram;$('pDramBW').value=hw.dramBW;$('pSsd').value=hw.ssd;$('pSsdBW').value=hw.ssdBW;$('pGpuCount').value=hw.gpus;
        recalcAll();
      }
    };
  });
  $('pPrefixHit').oninput=()=>{$('pPrefixHitVal').textContent=$('pPrefixHit').value+'%';recalcAll();};
  $('pAttnType').onchange=()=>{toggleMlaFields(); recalcAll();};
  toggleMlaFields();
}

function toggleMlaFields(){
  let mla = $('pAttnType').value === 'mla';
  $('mlaFields').style.display = mla ? 'flex' : 'none';
}

// 推理框架预设：切换时自动设置 前缀缓存/PD分离/分层KV 的默认值（用户可再手动覆盖）
function applyFramework(fw) {
  if (fw === 'vllm') {
    // vLLM: 整段哈希前缀缓存(block级) · 无PD分离 · 无分层KV卸载(HiCache 等价物)
    $('pPrefixCache').value = 'hash'; $('pPdSep').value = '0'; $('pTieredKv').value = '0';
  } else if (fw === 'sglang') {
    // sglang: RadixAttention 前缀树(渐进可用) · 原生PD分离 · HiCache 分层KV
    $('pPrefixCache').value = 'radix'; $('pPdSep').value = '1'; $('pTieredKv').value = '1';
  } else {
    // 通用: 保持当前默认行为(整段哈希 + 混合批 + 分层KV参与)
    $('pPrefixCache').value = 'hash'; $('pPdSep').value = '0'; $('pTieredKv').value = '1';
  }
  recalcAll();
}

function applyModel(name,el){
  currentModel=name;
  document.querySelectorAll('#modelPresets .preset-tag').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  let m=models[name];
  $('pAttnType').value = m.attn;
  $('pLayers').value=m.layers;
  if(m.attn==='mla'){ $('pKvLora').value=m.kvLora; $('pRopeDim').value=m.ropeDim; }
  else { $('pKvHeads').value=m.kvHeads; $('pHeadDim').value=m.headDim; }
  $('pHidden').value=m.hidden;
  if (m.vocab) $('pVocab').value=m.vocab;
  $('pParamsB').value=m.paramsB||0; $('pActB').value=m.actB||0;
  toggleMlaFields();
  recalcAll();
}

function updateQuickResults(){
  let p=getParams(), r=calcAll(p);
  let grid=$('quickResultGrid');
  let littleOk = Math.abs(r.littleConcurrency - p.concurrency) / Math.max(p.concurrency,1) < 0.5;
  grid.innerHTML=[
    {l:'单Token KV',v:formatBytes(r.kvPerToken),c:'green'},
    {l:'单请求KV(含碎片)',v:formatBytes(r.perRequestKv),c:'green'},
    {l:'块碎片率',v:r.fragPct.toFixed(1)+'%',c:r.fragPct>20?'orange':'green'},
    {l:'模型权重('+p.weightDtype+'B)',v:formatBytes(r.modelWeightBytes),c:'orange'},
    {l:'总参数量',v:formatNum(r.totalParams),c:'orange'},
    {l:'HBM可用(KV)',v:formatBytes(r.availHbm),c:r.availHbm>0?'accent':'red'},
    {l:'前缀节省/请求',v:formatBytes(r.prefixSavedPerReq),c:p.prefixHit>0?'green':'orange'},
    {l:'HBM可容纳请求',v:r.maxHbmRequests+'个',c:r.maxHbmRequests>=p.concurrency?'green':'red'},
    {l:'总KV需求(含前缀抵扣)',v:formatBytes(r.totalKvDemand),c:r.totalKvDemand<=r.availHbm?'green':'red'},
    {l:'Prefill速度',v:formatNum(r.prefillTps)+' tok/s',c:'green'},
    {l:'Decode速度/请求',v:r.decodeTpsPerReq.toFixed(0)+' tok/s',c:'accent'},
    {l:'TTFT(估计)',v:(r.ttftEst*1000).toFixed(0)+' ms',c:'accent'},
    {l:'TPOT(估计)',v:(r.tpotEst*1000).toFixed(2)+' ms/tok',c:'accent'},
    {l:'TP通信开销/步',v:(r.commOverhead*1000).toFixed(2)+' ms',c:r.commOverhead>r.passTime*0.1?'orange':'green'},
    {l:'稳态并发(Little定律)',v:r.littleConcurrency.toFixed(0)+' vs 设定'+p.concurrency,c:littleOk?'green':'orange'},
  ].map(d=>'<div class="result-item"><div class="rl">'+d.l+'</div><div class="rv '+d.c+'">'+d.v+'</div></div>').join('');
  setFormula('formulaQuick',
    '<b>📐 核心公式（Roofline 分相建模）</b><br>'+
    '• KV/token: '+(p.attn==='mla'
      ? '<code>MLA: L×(kvLora+rope)×dt = '+p.layers+'×('+(p.kvLora+p.ropeDim)+')×'+p.dtypeBytes+' = '+formatBytes(r.kvPerToken)+'</code>'
      : '<code>2×L×kvHeads×headDim×dt = '+formatBytes(r.kvPerToken)+'</code>')+'<br>'+
    '• 单请求KV含碎片: <code>⌈S/blockSize⌉×blockSize×kv/tok = '+r.blocksPerReq+'块×'+formatBytes(r.blockBytes)+' = '+formatBytes(r.perRequestKv)+'</code>（碎片 '+r.fragPct.toFixed(1)+'%）<br>'+
    '• 前缀抵扣: <code>'+(p.prefixHit*100).toFixed(0)+'% × S<sub>in</sub> × kv/tok = '+formatBytes(r.prefixSavedPerReq)+'/请求</code> → 有效占用 '+formatBytes(r.effPerReqKv)+'（命中率=可复用前缀token占总输入的比例；前缀组结构[12/22/35/48]%决定分布，不影响期望总量）<br>'+
    '• Prefill(算力瓶颈): <code>TFLOPS×GPU×MFU / (2×激活参数) = '+formatNum(r.computeFlops)+' / '+formatNum(2*r.activatedParams)+' = '+formatNum(r.prefillTps)+' tok/s</code><br>'+
    '• Decode(带宽瓶颈): <code>passTime = max[(权重+批次KV)/HBM带宽, 2×激活参数×B/算力] + TP通信 = '+(r.passTime*1000).toFixed(2)+' ms</code> → 每请求 '+r.decodeTpsPerReq.toFixed(0)+' tok/s<br>'+
    '• TP通信(AllReduce): <code>2×L×(2(TP−1)/TP × B×hidden×2B)/NVLink + 2×L×5μs = '+(r.commOverhead*1000).toFixed(2)+' ms/步</code>（TP='+r.tpSize+'，占 passTime '+(r.commOverhead/r.passTime*100).toFixed(0)+'%）<br>'+
    '• Little定律: <code>稳态并发 = QPS × 估计延迟('+r.estLatency.toFixed(2)+'s) = '+r.littleConcurrency.toFixed(0)+'</code>'+(littleOk?' ✓ 与设定并发一致':' ⚠ 与设定并发('+p.concurrency+')偏差较大，仿真中多余请求将排队')
  );
}

function recalcAll(){
  updateQuickResults();
  let active=document.querySelector('.tab-panel.active');
  if(active) refreshActiveTab();
}

// ======================== TAB 2: STORAGE ========================
function refreshStorageTab(){
  drawTierOverview();
  drawKvCurve();
  drawConcurrency();
}

function drawTierOverview(){
  let p=getParams(), r=calcAll(p);
  let ch=initChart('chartTierOverview');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
    legend:{data:['容量(GB)','读带宽(GB/s)','写带宽(GB/s)','延迟(μs)'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:80,right:20,top:40,bottom:20},
    xAxis:{type:'value',axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'category',data:['L0: HBM\n(GPU显存)','L1: DRAM\n(CPU内存)','L2: NVMe SSD\n(本地盘)'],axisLabel:{color:'#e4e4e7',fontSize:11}},
    series:[
      {name:'容量(GB)',type:'bar',data:[
        {value:p.gpus*p.hbmPerGpu,itemStyle:{color:'#f87171'}},
        {value:p.dram,itemStyle:{color:'#fb923c'}},
        {value:p.ssd*1000,itemStyle:{color:'#6c63ff'}},
      ],label:{show:true,position:'right',color:'#9ca0b0',formatter:p=>p.value+' GB'}},
      {name:'读带宽(GB/s)',type:'bar',data:[
        {value:p.hbmBW*p.gpus*1000,itemStyle:{color:'rgba(248,113,113,.4)'}},
        {value:p.dramBW,itemStyle:{color:'rgba(251,146,60,.4)'}},
        {value:p.ssdBW,itemStyle:{color:'rgba(108,99,255,.4)'}},
      ]},
      {name:'写带宽(GB/s)',type:'bar',data:[
        {value:p.hbmBW*p.gpus*1000*0.7,itemStyle:{color:'rgba(248,113,113,.2)'}},
        {value:p.dramBW*0.8,itemStyle:{color:'rgba(251,146,60,.2)'}},
        {value:p.ssdBW*0.9,itemStyle:{color:'rgba(108,99,255,.2)'}},
      ]},
      {name:'延迟(μs)',type:'bar',data:[
        {value:0.1,itemStyle:{color:'rgba(52,211,153,.5)'}},
        {value:1,itemStyle:{color:'rgba(52,211,153,.5)'}},
        {value:80,itemStyle:{color:'rgba(52,211,153,.5)'}},
      ],label:{show:true,position:'right',color:'var(--accent2)',formatter:p=>p.value+' μs'}},
    ]
  });
  setFormula('formulaTier',
    '<b>📐 计算方式</b><br>'+
    '• <b>容量</b>: HBM = <code>'+p.gpus+'×'+p.hbmPerGpu+'='+(p.gpus*p.hbmPerGpu)+' GB</code> · DRAM & SSD 为设定值<br>'+
    '• <b>读带宽</b>: HBM聚合 = <code>'+p.gpus+'×'+p.hbmBW+'='+(p.gpus*p.hbmBW).toFixed(1)+' TB/s</code><br>'+
    '• <b>跨层链路</b>: HBM↔DRAM 走 PCIe/C2C = <code>'+p.pcieBW+' GB/s</code>（搬 1GB KV ≈ '+(1e9/(p.pcieBW*1e9)*1000).toFixed(1)+'ms）· DRAM↔SSD 走 NVMe = <code>'+p.ssdBW+' GB/s</code>（搬 1GB ≈ '+(1e9/(p.ssdBW*1e9)*1000).toFixed(0)+'ms）<br>'+
    '• <b>下沉层量化比</b>: DRAM/SSD 中 KV 存储体积 × '+p.tierQuant+'（当前设置）<br>'+
    '• 写带宽为经验系数 70%~90%；延迟为典型值 HBM ~0.1μs · DRAM ~1μs · NVMe ~80μs'
  );
}

function drawKvCurve(){
  let p=getParams();
  let seqLens=[512,1024,2048,4096,8192,16384,32768,65536,131072];
  let ch=initChart('chartKvCurve');
  let series=[];
  let kvPerTok=calcKvPerToken(p);
  let totalHbmGB = p.gpus*p.hbmPerGpu;
  series.push({name:'当前模型 ('+currentModel+')',type:'line',smooth:true,data:seqLens.map(s=>kvPerTok*s/1e9),
    lineStyle:{color:'#6c63ff',width:2},areaStyle:{color:'rgba(108,99,255,.1)'},
    markLine:{silent:true,data:[{yAxis:totalHbmGB,label:{formatter:'当前硬件 HBM总量\n'+totalHbmGB+'GB',color:'#f87171'}}],lineStyle:{color:'#f87171',type:'dashed'}}});
  ['Llama-3-70B','Qwen3-30B-A3B','DeepSeek-V3','Llama-3-8B'].forEach((mn,i)=>{
    let mm=models[mn];
    let pp = {attn:mm.attn, layers:mm.layers, kvHeads:mm.kvHeads||8, headDim:mm.headDim||128,
      kvLora:mm.kvLora||512, ropeDim:mm.ropeDim||64, dtypeBytes:p.dtypeBytes};
    let k = calcKvPerToken(pp);
    let colors=['#fb923c','#34d399','#f87171','#60a5fa'];
    series.push({name:mn,type:'line',smooth:true,data:seqLens.map(s=>k*s/1e9),
      lineStyle:{color:colors[i],width:1.5,type:'dashed'}});
  });
  ch.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v.toFixed(2)+' GB'},
    legend:{top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:80,right:20,top:40,bottom:30},
    xAxis:{type:'category',data:seqLens.map(s=>formatNum(s)),name:'序列长度(tokens)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'KV Cache (GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:series
  });
  setFormula('formulaKvCurve',
    '<b>📐 计算方式</b><br>'+
    'GQA: <code>S<sub>kv/tok</sub> = 2 × layers × kv_heads × head_dim × dtype</code> · MLA: <code>S<sub>kv/tok</sub> = layers × (kv_lora_rank + rope_dim) × dtype</code><br>'+
    '当前模型: <code>'+formatBytes(kvPerTok)+' / token</code> · DeepSeek-V3(MLA): <code>61×576×'+p.dtypeBytes+' = '+formatBytes(61*576*p.dtypeBytes)+' / token</code>（压缩 ~23×）<br>'+
    '虚线 = 当前硬件 HBM 总容量 '+totalHbmGB+'GB（随硬件参数联动）'
  );
}

function drawConcurrency(){
  let p=getParams(), r=calcAll(p);
  let levels=[],hbmVals=[],dramVals=[],ssdVals=[];
  let step=Math.max(1,Math.floor(p.concurrency/8));
  // 前缀共享抵扣（与引擎同模型的期望值近似）：每请求期望复用 prefixHit × inputLen
  let savedPerReq = r.prefixSavedPerReq;
  for(let n=step;n<=p.concurrency*2;n+=step){
    levels.push(n);
    let demand=Math.max(0, n*(r.avgLifetimeKv - savedPerReq));
    let h=Math.min(demand,r.availHbm);
    let d=Math.max(0,Math.min((demand-h)*p.tierQuant,r.dramTotal));
    let ssd=Math.max(0,(demand-h)*p.tierQuant-d);
    hbmVals.push(h/1e9); dramVals.push(d/1e9); ssdVals.push(ssd/1e9);
  }
  let ch=initChart('chartConcurrency');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(1)+' GB'},
    legend:{data:['HBM占用','DRAM占用','SSD占用'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:20,top:40,bottom:40},
    xAxis:{type:'category',data:levels,name:'并发请求数',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'存储占用(GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'HBM占用',type:'bar',stack:'total',data:hbmVals,itemStyle:{color:'#f87171'},
        markLine:{silent:true,data:[{yAxis:r.availHbm/1e9}],label:{formatter:'HBM可用(KV)',color:'#f87171'},lineStyle:{color:'#f87171',type:'dashed'}}},
      {name:'DRAM占用',type:'bar',stack:'total',data:dramVals,itemStyle:{color:'#fb923c'},
        markLine:{silent:true,data:[{yAxis:(r.availHbm+r.dramTotal)/1e9}],label:{formatter:'HBM+DRAM上限',color:'#fb923c'},lineStyle:{color:'#fb923c',type:'dashed'}}},
      {name:'SSD占用',type:'bar',stack:'total',data:ssdVals,itemStyle:{color:'#6c63ff'}},
    ]
  });
  setFormula('formulaConcurrency',
    '<b>📐 计算方式（生命周期需求模型）</b><br>'+
    '单请求生命周期KV: <code>S<sub>life</sub> = ⌈S<sub>in</sub>/B⌉×B×kv + ⌈S<sub>out</sub>/2/B⌉×B×kv = '+formatBytes(r.avgLifetimeKv)+'</code>（含块碎片与输出增长）<br>'+
    '前缀抵扣: <code>−'+formatBytes(savedPerReq)+'/请求</code>（命中率 '+(p.prefixHit*100).toFixed(0)+'% × S<sub>in</sub>，期望值模型）<br>'+
    'N并发需求: <code>D = N × (S<sub>life</sub> − 抵扣)</code>，DRAM/SSD 存储体积 × 下沉量化比 '+p.tierQuant+'<br>'+
    '注意：此为静态容量视角；动态调度下的排队/淘汰行为见"调度策略"页仿真'
  );
}

// ======================== TAB 3: SCHEDULING ========================
function refreshScheduleTab(){
  drawGantt();
  drawBatching();
  drawPrefixSharing();
  drawEviction();
}

function drawGantt(){
  let s = savedStrategies.length > 0 ? savedStrategies[0] : getCurrentStrategy();
  if (!s) s = {name:'Default', admission:{type:'always'}, eviction:{type:'lru',hbm_evict_threshold:0.9}, prefetch:{type:'none'}, placement:{type:'hbm_first'}, batching:{type:'continuous',max_batch_size:8}, dsl:''};
  let r = runSimulation(s);
  let simEnd = r.simEnd || 1;
  // 合并已完成 + 未完成请求（未完成的最终阶段用浅色显示，截至仿真结束时刻）
  let timeline = (r.timeline || []).map(t => Object.assign({}, t, { state: 'done' }))
    .concat(r.incomplete || [])
    .sort((a, b) => a.arrive - b.arrive);
  // 容器高度随行数增长（每行22px，页面自然滚动），避免多请求被压扁成不可见的细线
  let ganttEl = $('chartGantt');
  let contH = Math.min(4400, Math.max(320, timeline.length * 22));
  ganttEl.style.height = contH + 'px';
  ganttEl.style.maxHeight = 'none';
  let ch = initChart('chartGantt');
  if (timeline.length === 0) {
    ch.setOption({title:{text:'仿真窗口内无完成的请求（试试提高QPS/降低输出长度）',left:'center',top:'center',textStyle:{color:'#9ca0b0',fontSize:13}}});
    setFormula('formulaGantt','无完成请求');
    return;
  }
  const FADE = { opacity: 0.35 };
  let categories = timeline.map(t => 'Req #' + t.id + (t.state !== 'done' ? ' ⏸' : ''));
  let queueData = [], waitComputeData = [], prefillData = [], decodeData = [];
  timeline.forEach(t => {
    if (t.admitTime != null) queueData.push([t.id, t.arrive, t.admitTime]);
    else queueData.push({ value: [t.id, t.arrive, simEnd], itemStyle: FADE });
    if (t.prefillStart != null) waitComputeData.push([t.id, t.admitTime, t.prefillStart]);
    else if (t.state === 'prefillQ') waitComputeData.push({ value: [t.id, t.admitTime, simEnd], itemStyle: FADE });
    if (t.prefillEnd != null) prefillData.push([t.id, t.prefillStart, t.prefillEnd]);
    else if (t.state === 'prefilling') prefillData.push({ value: [t.id, t.prefillStart, simEnd], itemStyle: FADE });
    if (t.completeTime != null) decodeData.push([t.id, t.prefillEnd, t.completeTime]);
    else if (t.state === 'decoding' || t.state === 'decodeWait') decodeData.push({ value: [t.id, t.prefillEnd, simEnd], itemStyle: FADE });
  });
  let maxT = Math.max(simEnd, ...timeline.map(t => t.completeTime || 0), 0.01);

  function makeGanttSeries(name, color, data) {
    return { name: name, type: 'custom', renderItem: function(params, api) {
      let cat = api.value(0), start = api.coord([api.value(1), cat]), end = api.coord([api.value(2), cat]);
      let h = api.size([0, 1])[1] * 0.6;
      return { type: 'rect', shape: { x: start[0], y: start[1] - h / 2, width: Math.max(end[0] - start[0], 2), height: h }, style: api.style() };
    }, itemStyle: { color: color, borderRadius: 3 }, encode: { x: [1, 2], y: 0 }, data: data };
  }

  ch.setOption({
    tooltip: { trigger: 'item', formatter: p => {
      let d = p.data; return p.seriesName + '<br/>开始: ' + d[1].toFixed(3) + 's<br/>结束: ' + d[2].toFixed(3) + 's<br/>持续: ' + (d[2] - d[1]).toFixed(3) + 's';
    }},
    legend: { data: ['Queue(等槽位/显存)', 'Wait(等算力)', 'Prefill', 'Decode'], top: 0, textStyle: { color: '#9ca0b0' } },
    grid: { left: 80, right: 46, top: 40, bottom: 20 },
    dataZoom: [
      { type: 'slider', yAxisIndex: 0, right: 4, width: 14,
        start: 0, end: 100,
        borderColor: 'transparent', backgroundColor: 'rgba(46,51,71,.4)',
        fillerColor: 'rgba(108,99,255,.25)', handleStyle: { color: '#6c63ff' },
        textStyle: { color: '#9ca0b0' } },
      { type: 'inside', yAxisIndex: 0, zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: false }
    ],
    xAxis: { type: 'value', name: '时间(s)', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' }, max: maxT },
    yAxis: { type: 'category', data: categories, axisLabel: { color: '#e4e4e7', fontSize: 9 } },
    series: [
      makeGanttSeries('Queue(等槽位/显存)', 'rgba(228,228,235,0.55)', queueData),
      makeGanttSeries('Wait(等算力)', '#fbbf24', waitComputeData),
      makeGanttSeries('Prefill', '#fb923c', prefillData),
      makeGanttSeries('Decode', '#6c63ff', decodeData),
    ]
  });

  // 批次并发占用时间线：直观展示多请求并行 decode
  let occ = r.concTimeline || [];
  let ch2 = initChart('chartBatchOcc');
  ch2.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['Decode并发数', 'Prefill占用', '排队深度'], top: 0, textStyle: { color: '#9ca0b0', fontSize: 10 } },
    grid: { left: 60, right: 30, top: 30, bottom: 25 },
    xAxis: { type: 'value', name: '时间(s)', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' } },
    yAxis: { type: 'value', name: '请求数', nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' }, minInterval: 1 },
    series: [
      { name: 'Decode并发数', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[1]]),
        showSymbol: false, lineStyle: { color: '#6c63ff', width: 2 }, areaStyle: { color: 'rgba(108,99,255,.22)' } },
      { name: 'Prefill占用', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[2]]),
        showSymbol: false, lineStyle: { color: '#fb923c', width: 1.5 }, areaStyle: { color: 'rgba(251,146,60,.22)' } },
      { name: '排队深度', type: 'line', step: 'end', data: occ.map(smp => [smp[0], smp[3]]),
        showSymbol: false, lineStyle: { color: '#9ca0b0', width: 1.5, type: 'dashed' } },
    ]
  });
  setFormula('formulaGantt',
    '<b>📐 计算方式 — 仿真引擎真实事件（两级排队）</b><br>'+
    '• <b>Queue(灰)</b> = 到达 → 准入：等 batch 槽位(≤max_batch_size) + 显存可放置(含淘汰/传输耗时)<br>'+
    '• <b>Wait(黄)</b> = 准入 → prefill开始：等算力——prefill 串行，同一时刻只有一个请求在做 prefill，排在前面的 prefill 全部完成才轮到<br>'+
    '• <b>Prefill(橙)</b> = 串行计算：<code>t = 2×激活参数×S<sub>prefill</sub> / (TFLOPS×GPU×MFU)</code>（sharer 跳过已缓存前缀）<br>'+
    '• <b>Decode(紫)</b> = 批次前向：<code>passTime = max[(权重+批次KV)/HBM带宽, Σ下层KV/链路带宽, 算力下限]</code>，KV在下层时批次整体变慢<br>'+
    '• "Queue短+黄段长" = 槽位/显存充裕但 prefill 是瓶颈的典型形态 · 策略 <code>'+(s.name||'当前策略')+'</code> · 完成 <code>'+r.completed+'/'+r.totalReqs+'</code> · 平均排队 <code>'+r.avgQueue.toFixed(2)+'s</code><br>'+
    '• 共 <code>'+timeline.length+'</code> 行（完成 '+r.completed+' + 未完成 '+(r.incomplete||[]).length+'，按到达排序；浅色段=仿真结束时仍滞留在该阶段 ⏸）<br>'+
    '• 下方并发占用图: Decode并发数>1 的时段即多请求并行计算（同一批次共享一次前向）；Prefill 串行为建模简化（期间 decode 减速×2 近似 chunked-prefill 竞争）'
  );
}

function drawBatching(){
  let p=getParams(), r=calcAll(p);
  let batchSizes=[1,2,4,8,16,32,64,128];
  let avgKv = r.avgLifetimeKv;
  let pts = batchSizes.map(b=>{
    let passMem = (r.modelWeightBytes * r.decodeWeightRatio + b*avgKv)/r.aggHbmBW
      + perReqMs(b, r.activatedParams, p.gpus)/1000; // 与引擎 per-req 校准一致
    let passCmp = 2*r.activatedParams*b/r.computeFlops;
    let passT = Math.max(passMem, passCmp) + r.commTime(b);
    let tp = b/passT;                                  // 批次总吞吐 tok/s
    let lat = (p.inputLen/r.prefillTps + p.outputLen*passT)*1000;  // ms
    return {b:b, lat:lat, tp:tp, bound:passCmp>passMem?'算力':'带宽'};
  });
  let ch=initChart('chartBatching');
  ch.setOption({
    tooltip:{trigger:'item',formatter:d=>{let q=pts[d.dataIndex];return 'Batch='+q.b+'<br/>延迟: '+q.lat.toFixed(0)+'ms<br/>吞吐: '+formatNum(q.tp)+' tok/s<br/>受限: '+q.bound;}},
    grid:{left:70,right:20,top:20,bottom:40},
    xAxis:{type:'value',name:'单请求端到端延迟(ms)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:{type:'value',name:'批次吞吐量(tok/s)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[{type:'scatter',data:pts.map(q=>[q.lat,q.tp]),symbolSize:val=>10+Math.sqrt(val[1])/3,
      itemStyle:{color:new echarts.graphic.LinearGradient(0,0,1,1,[
        {offset:0,color:'#6c63ff'},{offset:1,color:'#34d399'}])},
      label:{show:true,formatter:(d)=>'B='+pts[d.dataIndex].b,position:'top',color:'#9ca0b0',fontSize:10},
      markLine:{silent:true,data:[{xAxis:(r.estLatency*1000),label:{formatter:'当前配置估计',color:'#f87171'}}],lineStyle:{color:'#f87171',type:'dashed'}}
    }]
  });
  setFormula('formulaBatching',
    '<b>📐 计算方式（Roofline 模型 + TP通信）</b><br>'+
    '每次前向(pass)耗时: <code>T(b) = max[(W + b×KV̄)/BW<sub>hbm</sub>, 2P<sub>act</sub>×b/FLOPS] + comm(b)</code><br>'+
    '&nbsp;&nbsp;W='+formatBytes(r.modelWeightBytes)+' · KV̄='+formatBytes(avgKv)+' · BW='+(p.hbmBW*p.gpus).toFixed(1)+'TB/s · FLOPS='+formatNum(r.computeFlops)+'<br>'+
    '&nbsp;&nbsp;comm(b) = TP='+r.tpSize+' AllReduce开销 = <code>2L×(2(TP−1)/TP×b×hidden×2B)/NVLink + 2L×5μs</code>（延迟项在小batch时占主导）<br>'+
    '吞吐: <code>TP(b) = b / T(b)</code> —— b小时带宽瓶颈（TP近线性增长），b大时算力瓶颈（TP饱和）<br>'+
    '延迟: <code>Lat(b) = prefill + S<sub>out</sub> × T(b)</code>（不含排队）· 曲线右上的拐点即 Roofline 拐点'
  );
}

function drawPrefixSharing(){
  let p=getParams(), r=calcAll(p);
  let hitRates=[0,10,20,30,40,50,60,70,80,90,100];
  let groupRatios=PREFIX_RATIOS;
  let ch=initChart('chartPrefix');
  // 期望模型：每请求期望复用 = hit × inputLen（命中率=可复用前缀token占总输入的比例）
  let savedData=hitRates.map(hr=>hr/100*p.concurrency*p.inputLen*r.kvPerToken/1e9);
  let extraReqData=hitRates.map(hr=>Math.floor(hr/100*p.concurrency*p.inputLen*r.kvPerToken/r.avgLifetimeKv));
  ch.setOption({
    tooltip:{trigger:'axis'},
    legend:{data:['显存节省(GB)','额外并发数'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:60,top:40,bottom:30},
    xAxis:{type:'category',data:hitRates.map(h=>h+'%'),name:'前缀命中率(复用token占比)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    yAxis:[
      {type:'value',name:'显存节省(GB)',nameTextStyle:{color:'#6c63ff'},axisLabel:{color:'#9ca0b0'}},
      {type:'value',name:'额外并发数',nameTextStyle:{color:'#34d399'},axisLabel:{color:'#9ca0b0'}}
    ],
    series:[
      {name:'显存节省(GB)',type:'bar',data:savedData,itemStyle:{color:'rgba(108,99,255,.6)'},
        label:{show:true,position:'top',formatter:p=>p.value.toFixed(1),color:'#6c63ff',fontSize:9}},
      {name:'额外并发数',type:'line',yAxisIndex:1,data:extraReqData,
        lineStyle:{color:'#34d399',width:2},itemStyle:{color:'#34d399'},
        label:{show:true,position:'top',color:'#34d399',fontSize:9}}
    ]
  });
  let ratiosStr=groupRatios.map(x=>(x*100).toFixed(0)+'%').join(', ');
  setFormula('formulaPrefix',
    '<b>📐 计算方式（期望值模型）</b><br>'+
    '命中率定义: <code>hit = 可复用前缀token / 总输入token</code> → 每请求期望复用 <code>hit × '+p.inputLen+' tok</code><br>'+
    '显存节省: <code>S = N × hit × S<sub>in</sub> × S<sub>kv/tok</sub></code> · 额外并发: <code>ΔN = S / S<sub>life</sub></code><br>'+
    '前缀组结构 <code>ratios = ['+ratiosStr+']</code>（均值 '+(AVG_PREFIX_RATIO*100).toFixed(0)+'%）只决定仿真中前缀长度的分布与可达上限，不影响期望节省量'
  );
}

function drawEviction(){
  let p=getParams();
  let cacheSizes_pct=[5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95];
  let nBlocks=200,nRequests=5000;
  // 固定种子生成同一条 Zipf trace —— 所有策略/容量共用，保证公平可比
  let rng = mulberry32(p.seed);
  let zipfCdf=[],sum=0;
  for(let i=1;i<=nBlocks;i++){sum+=1/Math.pow(i,1.2);zipfCdf.push(sum);}
  let trace=[];
  for(let t=0;t<nRequests;t++){
    let r0=rng()*sum,cum=0;
    for(let i=0;i<nBlocks;i++){if(zipfCdf[i]>=r0){trace.push('b'+(i+1));break;}}
  }
  // Belady 最优：预计算每个位置的下次使用索引
  let nextUse=new Array(nRequests);
  {
    let lastSeen={};
    for(let t=nRequests-1;t>=0;t--){let b=trace[t];nextUse[t]=(lastSeen[b]!==undefined)?lastSeen[b]:Infinity;lastSeen[b]=t;}
  }
  function simulate(strategy,cacheSize){
    let cache=[],hits=0,freq={},lastT={},inCacheT={};
    for(let t=0;t<nRequests;t++){
      let block=trace[t];
      freq[block]=(freq[block]||0)+1;
      let idx=cache.indexOf(block);
      if(idx>=0){hits++;lastT[block]=t;continue;}
      if(cache.length>=cacheSize){
        let victim;
        if(strategy==='lru') victim=cache.reduce((a,b)=>(lastT[a]||0)<=(lastT[b]||0)?a:b);
        else if(strategy==='lfu') victim=cache.reduce((a,b)=>(freq[a]||0)<=(freq[b]||0)?a:b);
        else if(strategy==='fifo') victim=cache.reduce((a,b)=>inCacheT[a]<=inCacheT[b]?a:b);
        else{ // belady: 淘汰下次使用最远的
          victim=cache.reduce((a,b)=>{
            let na=Infinity,nb=Infinity;
            for(let k=t+1;k<nRequests;k++){if(trace[k]===a){na=k;break;}}
            for(let k=t+1;k<nRequests;k++){if(trace[k]===b){nb=k;break;}}
            return na>=nb?a:b;
          });
        }
        cache.splice(cache.indexOf(victim),1);
        delete freq[victim];
      }
      cache.push(block);lastT[block]=t;inCacheT[block]=t;
    }
    return hits/nRequests*100;
  }
  // Belady 的 O(n×cache) 在内层扫描太慢，改用 nextUse 数组的版本
  function simulateBelady(cacheSize){
    let cache=[],hits=0;
    let posIdx={}; // block -> array of positions (pointer)
    let positions={};
    trace.forEach((b,t)=>{(positions[b]=positions[b]||[]).push(t);});
    let ptr={};
    for(let t=0;t<nRequests;t++){
      let b=trace[t];ptr[b]=(ptr[b]||0)+1;
      if(cache.indexOf(b)>=0){hits++;continue;}
      if(cache.length>=cacheSize){
        let victim=cache[0],worst=-1;
        cache.forEach(c=>{
          let arr=positions[c],pi=ptr[c]||0;
          let nu=pi<arr.length?arr[pi]:Infinity;
          if(nu>worst){worst=nu;victim=c;}
        });
        cache.splice(cache.indexOf(victim),1);
      }
      cache.push(b);
    }
    return hits/nRequests*100;
  }
  let strategies=[
    {name:'LRU',color:'#6c63ff',fn:s=>simulate('lru',s)},
    {name:'LFU',color:'#34d399',fn:s=>simulate('lfu',s)},
    {name:'FIFO',color:'#fb923c',fn:s=>simulate('fifo',s)},
    {name:'Optimal(Belady)',color:'#f87171',fn:s=>simulateBelady(s)},
  ];
  let ch=initChart('chartEviction');
  ch.setOption({
    tooltip:{trigger:'axis',valueFormatter:v=>v.toFixed(1)+'%'},
    legend:{data:strategies.map(s=>s.name),top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:60,right:20,top:40,bottom:30},
    xAxis:{type:'category',data:cacheSizes_pct.map(c=>c+'%'),name:'缓存容量(占全部Block的百分比)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0',fontSize:9,rotate:45}},
    yAxis:{type:'value',name:'命中率(%)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'},max:100},
    series:strategies.map(s=>({
      name:s.name,type:'line',smooth:true,
      data:cacheSizes_pct.map(c=>s.fn(Math.max(1,Math.floor(c/100*nBlocks)))),
      lineStyle:{color:s.color,width:2},
      itemStyle:{color:s.color}
    }))
  });
  setFormula('formulaEviction',
    '<b>📐 计算方式</b><br>'+
    '固定种子(seed='+p.seed+')生成唯一一条trace: <code>'+nBlocks+'</code>个块 · <code>'+nRequests+'</code>次访问 · Zipf(α=1.2)<br>'+
    '• <b>LRU</b>: 淘汰最久未访问 · <b>LFU</b>: 淘汰频率最低 · <b>FIFO</b>: 淘汰最早入缓存<br>'+
    '• <b>Optimal(Belady)</b>: 真实实现——预计算每个块的下次访问位置，淘汰未来最远才被访问的块（理论命中率上界）<br>'+
    '所有策略跑同一条trace，曲线差异完全来自策略本身（共同随机数法）'
  );
}

// ======================== TAB 4: CROSS ANALYSIS ========================
function refreshCrossTab(){
  // 懒加载：不默认跑 24+4 次全量仿真（高并发档每次墙钟 5-20s，串行执行会长时间阻塞 UI）。
  // 进入界面先显示占位，用户点按钮按需运行；已运行过则直接重绘。
  if (window.__crossAnalyzed) { drawCrossAnalysis(); return; }
  $('chartHeatmap').innerHTML = '<div class="progress-note" style="padding:28px 16px;text-align:center;line-height:2">'+
    '交叉分析需运行 <b>24</b> 次「策略 × 并发」仿真 + <b>4</b> 次综合评分仿真<br>'+
    '高并发档(64/128/256)每次约 5-20s，串行执行期间页面会短暂无响应<br><br>'+
    '<button class="btn" onclick="runCrossAnalysis()" style="font-size:.85rem">▶️ 按需运行交叉分析</button></div>';
  $('chartRadar').innerHTML = '';
  $('formulaHeatmap').innerHTML = '';
  $('formulaRadar').innerHTML = '';
}
function runCrossAnalysis(){
  window.__crossAnalyzed = true;
  drawCrossAnalysis();
}

// 热力图+雷达图共用一批真实仿真（异步执行避免阻塞UI）
function drawCrossAnalysis(){
  let p=getParams();
  let presetNames=['Pure-HBM','HBM+DRAM','Tiered-3L','Aggressive'];
  let strategies=[];
  savedStrategies.slice(0,4).forEach(s=>strategies.push(s));
  for(let i=strategies.length;i<4;i++) strategies.push(parseDSL(strategyPresets[presetNames[i]]));
  strategies.forEach((s,i)=>{if(!s.name)s.name=presetNames[i]||('S'+i);});
  let concurrencies=[8,16,32,64,128,256];
  let heatData=new Array(concurrencies.length*4);
  let radarResults=new Array(4);
  let totalJobs=concurrencies.length*4+4, doneJobs=0;

  let heatEl=$('chartHeatmap');
  heatEl.innerHTML='<div class="progress-note">⏳ 交叉分析仿真中... 0/'+totalJobs+'</div>';
  $('chartRadar').innerHTML='<div class="progress-note">⏳ 等待仿真...</div>';

  let jobs=[];
  concurrencies.forEach((c,i)=>{strategies.forEach((s,j)=>{
    jobs.push({type:'heat',i:i,j:j,c:c,s:s});
  });});
  strategies.forEach((s,j)=>{jobs.push({type:'radar',j:j,s:s});});

  let idx=0;
  function runNext(){
    if(idx>=jobs.length){renderAll();return;}
    let job=jobs[idx];
    setTimeout(()=>{
      try{
        let overrides = job.type==='heat'
          ? {concurrency:job.c, nreq:Math.min(job.c*1.5,60), seed:p.seed}
          : {nreq:Math.min(p.concurrency*2,80), seed:p.seed};
        let r=runSimulation(job.s, overrides);
        if(job.type==='heat'){
          // 无完成请求 → 延迟无定义，显示 ∞ 而非误导性的 0
          let v = (r.completed > 0 && r.p99 > 0) ? +r.p99.toFixed(0) : null;
          heatData[job.i*4+job.j]=[job.i,job.j,v];
        }
        else radarResults[job.j]=r;
      }catch(e){
        if(job.type==='heat') heatData[job.i*4+job.j]=[job.i,job.j,null];
      }
      doneJobs++;
      heatEl.innerHTML='<div class="progress-note">⏳ 交叉分析仿真中... '+doneJobs+'/'+totalJobs+'</div>';
      idx++; runNext();
    },0);
  }

  function renderAll(){
    // ---- Heatmap ----
    let maxV=Math.max(...heatData.map(d=>d[2]==null?0:d[2]),100);
    let ch=initChart('chartHeatmap');
    ch.setOption({
      tooltip:{trigger:'item',formatter:d=>'并发: '+concurrencies[d.value[0]]+'<br/>策略: '+strategies[d.value[1]].name
        +'<br/>P99延迟: '+(d.value[2]==null?'无完成请求(∞)':d.value[2]+'ms')},
      grid:{left:110,right:40,top:20,bottom:40},
      xAxis:{type:'category',data:concurrencies,name:'并发数',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
      yAxis:{type:'category',data:strategies.map(s=>s.name),name:'策略',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#e4e4e7',fontSize:10}},
      visualMap:{min:0,max:maxV,calculable:true,orient:'vertical',right:0,top:'center',
        inRange:{color:['#34d399','#fbbf24','#fb923c','#f87171']},textStyle:{color:'#9ca0b0'}},
      series:[{type:'heatmap',data:heatData,
        label:{show:true,color:'#e4e4e7',fontSize:10,formatter:d=>d.value[2]==null?'∞':(d.value[2]>=1000?(d.value[2]/1000).toFixed(1)+'k':d.value[2])},
        emphasis:{itemStyle:{shadowBlur:10,shadowColor:'rgba(0,0,0,.5)'}}}]
    });
    setFormula('formulaHeatmap',
      '<b>📐 计算方式</b><br>'+
      '每个格子 = 一次完整事件驱动仿真（并发覆盖为该格并发数，请求数=min(1.5×并发,60)，同一种子）<br>'+
      'P99延迟来自仿真真实统计：排队 + 并行Prefill + 批次Decode + 跨层传输 · 高并发下超出批处理容量 → 排队主导，延迟非线性上升<br>'+
      '<b>∞</b> = 仿真窗口内无请求完成（高并发长输出下排水时间超过窗口，策略在该负载下不可用）'
    );
    // ---- Radar ----
    let valid=radarResults.filter(Boolean);
    if(valid.length===0)return;
    let maxT=Math.max(...valid.map(r=>r.throughput),1);
    let minP50=Math.min(...valid.map(r=>r.p50)),maxP50=Math.max(...valid.map(r=>r.p50),1);
    let minP99=Math.min(...valid.map(r=>r.p99)),maxP99=Math.max(...valid.map(r=>r.p99),1);
    let score=(v,lo,hi)=>hi>lo?Math.max(5,(hi-v)/(hi-lo)*100):80; // 越低越好 → 映射到 5~100
    let ch2=initChart('chartRadar');
    ch2.setOption({
      tooltip:{},
      legend:{data:valid.map(r=>r.name),bottom:0,textStyle:{color:'#9ca0b0',fontSize:10}},
      radar:{
        center:['50%','48%'],radius:'62%',
        indicator:[
          {name:'吞吐量',max:100},{name:'P50延迟',max:100},{name:'P99延迟',max:100},
          {name:'显存利用率',max:100},{name:'低碎片',max:100},{name:'公平性',max:100},
        ],
        axisName:{color:'#9ca0b0'}
      },
      series:[{
        type:'radar',
        data:valid.map((r,i)=>{
          let colors=['#6c63ff','#34d399','#fb923c','#f87171'];
          return {
            value:[
              +(r.throughput/maxT*100).toFixed(0),
              +score(r.p50,minP50,maxP50).toFixed(0),
              +score(r.p99,minP99,maxP99).toFixed(0),
              +Math.min(100,r.memUtilAvg).toFixed(0),
              +Math.max(0,100-r.fragPct).toFixed(0),
              +Math.max(0,100-r.fairnessCV).toFixed(0),
            ],
            name:r.name,lineStyle:{color:colors[i%4]},areaStyle:{color:colors[i%4]+'26'},itemStyle:{color:colors[i%4]}
          };
        })
      }]
    });
    setFormula('formulaRadar',
      '<b>📐 计算方式（全部来自仿真）</b><br>'+
      '• 吞吐量: 各策略 ÷ 最优 ×100 · P50/P99延迟: 相对最差值的反向映射<br>'+
      '• 显存利用率: 仿真时间加权平均 HBM 占用 · 低碎片: 100 − 块碎片率 · 公平性: 100 − 延迟变异系数CV%<br>'+
      '仿真条件: 当前参数 · 请求数=min(2×并发,80) · 种子='+p.seed
    );
  }
  runNext();
}

// ======================== STRATEGY ENGINE ========================
let savedStrategies = [];
let simResults = [];
var strategyMode = 'dsl';

const jsTemplate = `// JavaScript 策略定义 — 自由编写调度逻辑
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

function switchMode(mode) {
  strategyMode = mode;
  $('modeDsl').classList.toggle('active', mode === 'dsl');
  $('modeJs').classList.toggle('active', mode === 'js');
  let ref = $('strategyRef');
  if (mode === 'js') {
    $('strategySubtitle').textContent = 'JavaScript模式：自由编写调度函数。引擎在每个决策点调用你的 admit/evict/prefetch/place';
    if (!$('sDsl').value.trim() || $('sDsl').value.match(/^ADMIT:/m)) {
      $('sDsl').value = strategyPresetsJS['Pure-HBM'];
    }
    ref.innerHTML = '<b style="color:var(--accent2)">JS API 参考</b><br>'+
      '<code>admit(req)</code> → tier<br>'+
      '<code>evict(pool, name)</code> → block|null<br>'+
      '<code>shouldPrefetch()</code> → bool<br>'+
      '<code>place()</code> → tier<br><br>'+
      '<b>辅助函数:</b><br>'+
      '<code>hbmUsage() → 0~1</code><br>'+
      '<code>dramUsage()</code><br>'+
      '<code>prefetchBlock(dram,id)</code><br>'+
      '<code>getBlocksIn(\'dram\')</code><br>'+
      '<code>hasBlock(\'hbm\', id)</code><br>'+
      '<code>pool.accessOrder</code><br>'+
      '<code>pool.freq[id]</code>';
  } else {
    $('strategySubtitle').textContent = 'DSL模式：规则语言描述。点击"JS"切换为编程模式获得完全自由度';
    if ($('sDsl').value.trim().startsWith('// JavaScript')) {
      $('sDsl').value = strategyPresets['Pure-HBM'];
    }
    ref.innerHTML = '<b style="color:var(--accent)">DSL 语法参考</b><br>'+
      '<code>ADMIT: always</code><br>'+
      '<code>&nbsp;| threshold(hbm=0.8)</code><br>'+
      '<code>EVICT: lru from hbm when 85% -> dram</code><br>'+
      '<code>PREFETCH: on_demand from dram when hbm<70%</code><br>'+
      '<code>BATCH: continuous max(8)</code><br>'+
      '<code>PLACE: hbm_first | tiered</code>';
  }
}

var strategyPresets = {
  'Pure-HBM': 'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(8)\nPLACE: hbm_first',
  'HBM+DRAM': 'ADMIT: threshold(hbm=0.8)\nEVICT: lru from hbm when 90% -> dram\nPREFETCH: on_demand from dram when hbm<50%\nBATCH: continuous max(16)\nPLACE: hbm_first',
  'Tiered-3L':  'ADMIT: threshold(hbm=0.7)\nEVICT: lfu from hbm when 85% -> dram, lru from dram when 90% -> ssd\nPREFETCH: eager from dram when hbm<40%\nBATCH: dynamic max(32)\nPLACE: tiered',
  'Aggressive':'ADMIT: always\nEVICT: lfu from hbm when 75% -> dram, lfu from dram when 80% -> ssd\nPREFETCH: eager\nBATCH: static max(64)\nPLACE: hbm_first',
  'Conservative':'ADMIT: priority(<2048:hbm, >=2048:dram)\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: priority max(4)\nPLACE: hbm_first',
};

var strategyPresetsJS = {
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
};

// ======================== DSL PARSER ========================
function parseDSL(text) {
  let s = {
    name: '', dsl: text,
    admission: { type: 'always' },
    eviction: { type: 'lru', hbm_evict_threshold: 0.9 },
    prefetch: { type: 'none' },
    placement: { type: 'hbm_first' },
    batching: { type: 'continuous', max_batch_size: 8 }
  };
  let lines = text.split('\n').filter(l => l.trim());
  for (let line of lines) {
    let l = line.trim();
    if (l.startsWith('ADMIT:')) {
      let body = l.substring(7).trim();
      if (body.startsWith('threshold(')) { let m = body.match(/threshold\(hbm=(\d+\.?\d*)\)/); s.admission = {type:'threshold', hbm_threshold: m ? parseFloat(m[1]) : 0.8 }; }
      else if (body.startsWith('priority(')) { s.admission = {type:'priority', rule: body.substring(9, body.lastIndexOf(')'))}; }
      else if (body === 'always') s.admission = {type:'always'};
      else if (body === 'cost_based') s.admission = {type:'cost_based'};
    }
    else if (l.startsWith('EVICT:')) {
      let body = l.substring(7).trim();
      let parts = body.split(',').map(p=>p.trim());
      let p0 = parts[0];
      let m0 = p0.match(/(\w+)\s+from\s+(\w+)\s+when\s+(\d+\.?\d*)%\s*->\s*(\w+)/);
      if (m0) {
        s.eviction = {type: m0[1], from_tier: m0[2], hbm_evict_threshold: parseFloat(m0[3])/100, target_tier: m0[4]};
      }
      if (parts.length > 1) {
        let m1 = parts[1].match(/(\w+)\s+from\s+(\w+)\s+when\s+(\d+\.?\d*)%\s*->\s*(\w+)/);
        if (m1) s.eviction.second = {type: m1[1], from_tier: m1[2], threshold: parseFloat(m1[3])/100, target_tier: m1[4]};
      }
    }
    else if (l.startsWith('PREFETCH:')) {
      let body = l.substring(10).trim();
      if (body === 'none') s.prefetch = {type:'none'};
      else if (body === 'eager') s.prefetch = {type:'eager', prefetch_threshold: 0.5};
      else {
        let m = body.match(/(\w+(?:_\w+)?)\s*(?:from\s+(\w+))?\s*(?:when\s+hbm\s*<\s*(\d+\.?\d*)%)?/);
        if (m) {
          s.prefetch = {type: m[1]};
          if (m[2]) s.prefetch.from_tier = m[2];
          if (m[3]) s.prefetch.prefetch_threshold = parseFloat(m[3])/100;
          else s.prefetch.prefetch_threshold = 0.5;
        }
      }
    }
    else if (l.startsWith('BATCH:')) {
      let body = l.substring(7).trim();
      let m = body.match(/(\w+)\s+max\((\d+)\)(?:\s+wait\((\d+)ms\))?/);
      if (m) { s.batching = {type: m[1], max_batch_size: parseInt(m[2])}; if (m[3]) s.batching.max_wait = parseInt(m[3]); }
    }
    else if (l.startsWith('PLACE:')) {
      let body = l.substring(7).trim();
      if (body === 'hbm_first') s.placement = {type:'hbm_first'};
      else if (body === 'tiered') s.placement = {type:'tiered'};
      else if (body.startsWith('adaptive(')) { let m = body.match(/adaptive\(hbm=(\d+\.?\d*)\)/); s.placement = {type:'adaptive', adaptive_threshold: m ? parseFloat(m[1]) : 0.7}; }
    }
  }
  return s;
}

function dslToText(s) {
  let lines = [];
  let a = s.admission;
  if (a.type === 'always') lines.push('ADMIT: always');
  else if (a.type === 'threshold') lines.push('ADMIT: threshold(hbm='+(a.hbm_threshold||0.8)+')');
  else if (a.type === 'priority') lines.push('ADMIT: priority('+(a.rule||'<2048:hbm, >=2048:dram')+')');
  else lines.push('ADMIT: cost_based');
  let e = s.eviction;
  let eLine = 'EVICT: '+e.type+' from '+(e.from_tier||'hbm')+' when '+Math.round((e.hbm_evict_threshold||0.9)*100)+'% -> '+(e.target_tier||'dram');
  if (e.second) eLine += ', '+e.second.type+' from '+e.second.from_tier+' when '+Math.round(e.second.threshold*100)+'% -> '+e.second.target_tier;
  lines.push(eLine);
  let p = s.prefetch;
  if (p.type === 'none') lines.push('PREFETCH: none');
  else if (p.type === 'eager') lines.push('PREFETCH: eager');
  else lines.push('PREFETCH: '+p.type+' from '+(p.from_tier||'dram')+' when hbm<'+(Math.round((p.prefetch_threshold||0.5)*100))+'%');
  let b = s.batching;
  lines.push('BATCH: '+b.type+' max('+(b.max_batch_size||8)+')');
  let pl = s.placement;
  if (pl.type === 'hbm_first') lines.push('PLACE: hbm_first');
  else if (pl.type === 'tiered') lines.push('PLACE: tiered');
  else lines.push('PLACE: adaptive(hbm='+(pl.adaptive_threshold||0.7)+')');
  return lines.join('\n');
}

function autoNameStrategy(s) {
  let a = s.admission.type, e = s.eviction.type, p = s.prefetch.type;
  return (a==='always'?'AH':a==='threshold'?'TH':'PR')+'-'+(e==='lru'?'LRU':e==='lfu'?'LFU':e.toUpperCase())+'-'+(p==='none'?'NP':p==='on_demand'?'OD':'EG');
}

function getCurrentStrategy() {
  let dslEl = $('sDsl'), nameEl = $('sName');
  if (!dslEl) return {name:'Default', admission:{type:'always'}, eviction:{type:'lru',hbm_evict_threshold:0.9}, prefetch:{type:'none'}, placement:{type:'hbm_first'}, batching:{type:'continuous',max_batch_size:8}};
  try {
    let s = parseDSL(dslEl.value);
    s.name = (nameEl ? nameEl.value : '') || autoNameStrategy(s);
    s.dsl = dslEl.value;
    $('sDslError').textContent = '';
    return s;
  } catch(e) {
    $('sDslError').textContent = '⚠ DSL 解析错误: ' + e.message;
    return null;
  }
}

function saveStrategy() {
  let s = getCurrentStrategy();
  if (!s) return;
  if (!s.name) s.name = autoNameStrategy(s);
  $('sName').value = s.name;
  s.dsl = $('sDsl').value;
  let idx = savedStrategies.findIndex(x => x.name === s.name);
  if (idx >= 0) savedStrategies[idx] = s;
  else savedStrategies.push(s);
  renderSavedStrategies();
}

function deleteStrategy(name) {
  savedStrategies = savedStrategies.filter(s => s.name !== name);
  renderSavedStrategies();
}

function renderSavedStrategies() {
  let el = $('savedStrategiesList');
  if (savedStrategies.length === 0) { el.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);padding:8px 0">暂无已保存策略，配置DSL并点击"保存策略"</div>'; return; }
  el.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);margin-bottom:6px">已保存的策略 ('+savedStrategies.length+'个):</div>' +
    savedStrategies.map((s,i) => '<div style="display:inline-flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:4px 10px;margin:0 6px 6px 0;font-size:.75rem">'+
      '<span style="color:var(--accent);cursor:pointer" onclick="loadStrategy('+i+')">'+s.name+'</span>'+
      '<span style="color:var(--text-dim);font-size:.6rem">['+autoNameStrategy(s)+']</span>'+
      '<span style="color:var(--accent4);cursor:pointer;font-size:.65rem" onclick="deleteStrategy(\''+s.name+'\')">✕</span></div>'
    ).join('');
}

function loadStrategy(idx) {
  let s = savedStrategies[idx];
  if (!s) return;
  $('sName').value = s.name;
  $('sDsl').value = s.dsl || dslToText(s);
  $('sDslError').textContent = '';
}

// ======================== SIMULATION ENGINE ========================
// 事件驱动仿真：
//  - 泊松到达(seeded) / 均匀或对数正态长度
//  - 准入排队：batch槽位(max_batch_size真实生效) + 显存可放置
//  - 串行Prefill(算力模型) / 批次Decode(带宽Roofline模型)
//  - 跨层搬运有真实耗时(链路带宽+串行队列)
//  - 前缀共享=真实共享块+引用计数 / 多轮会话保留KV
//  - LRU/LFU按访问真实更新
function runSimulation(strategy, overrides) {
  overrides = overrides || {};
  let p = getParams();
  for (let k in overrides) { if (k !== 'seed' && k !== 'nreq') p[k] = overrides[k]; }
  let r = calcAll(p);
  let rng = mulberry32((overrides.seed != null ? overrides.seed : p.seed) >>> 0);

  let kvPerTok = r.kvPerToken;
  let blockBytes = r.blockBytes;
  let tierRatio = { hbm: 1, dram: p.tierQuant, ssd: p.tierQuant };
  let caps = { hbm: r.availHbm, dram: p.tieredKv ? r.dramTotal : 0, ssd: p.tieredKv ? r.ssdTotal : 0 };
  let pools = {};
  ['hbm','dram','ssd'].forEach(t => pools[t] = { blocks: [], blockIndex: {}, used: 0, cap: caps[t], accessOrder: [], freq: {} });

  const DT = 0.02;
  const TOUCH_EVERY = 10;          // 每10步(0.2s)刷新一次位置统计与访问记录
  const MAX_SIM_BLOCKS = 256;      // 单请求仿真块数上限（超出合并为超级块）
  const PREFILL_UTIL_CAP = 0.9;    // 并行 prefill 利用率上限：单请求利用率≈MFU，并行 batch 把 GPU 填满至该上限
  // decode 每请求开销见顶层 perReqMs()（校准: Qwen3-32B 单卡 6.4×n^0.75; DS-V3 8卡 5.2+3.7×n^0.75）

  let now = 0;
  let inFlight = [];
  let stats = { hbmAcc: 0, dramAcc: 0, ssdAcc: 0, latencies: [], ttfts: [], tpots: [], queueWaits: [],
    completed: 0, evictions: 0, activeEvictions: 0, prefetches: 0, drops: 0, transferBytes: 0,
    memUtilSamples: 0, memUtilSum: 0, memUtilPeak: 0, outTokens: 0,
    prefixHits: 0, prefixSavedBytes: 0, sessionHits: 0, concSamples: [] };

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

  // 跨层链路：每条链路串行排队，带宽决定搬运耗时
  let links = {
    'hbm>dram': { bw: p.pcieBW * 1e9, busyUntil: 0 },
    'dram>hbm': { bw: p.pcieBW * 1e9, busyUntil: 0 },
    'dram>ssd': { bw: p.ssdBW * 1e9, busyUntil: 0 },
    'ssd>dram': { bw: p.ssdBW * 1e9, busyUntil: 0 },
  };
  function scheduleTransfer(blk, from, to) {
    let link = links[from + '>' + to];
    if (!link) return 0;
    let bytes = blk.size * tierRatio[from]; // 读出一侧体积
    let start = Math.max(now, link.busyUntil);
    let dur = bytes / link.bw;
    link.busyUntil = start + dur;
    poolRemove(from, blk.id);
    blk.available = false;
    blk.arriveAt = start + dur;
    blk.srcTier = from; // 在途期间按源层读速计入decode成本（块未到达前不可用）
    poolAdd(to, blk); // 立即占用目标容量（预留）
    inFlight.push(blk);
    stats.transferBytes += bytes;
    return dur;
  }

  // ---------- 请求生成 ----------
  // N = 2×并发（让请求流足以形成排队压力），上限256为性能保护；可通过 overrides.nreq 指定
  let N = overrides.nreq || Math.min(p.concurrency * 2, 256);
  let requests = [], t = 0, lambda = Math.max(p.qps, 0.1);
  let sigma = 0.6, muL = Math.log(Math.max(p.inputLen,1)) - sigma*sigma/2;
  let muO = Math.log(Math.max(p.outputLen,1)) - sigma*sigma/2;
  function sampleLen(avg, mu){
    if (p.lenDist === 'fixed') return Math.max(64, Math.round(avg)); // 严格固定 = 均值(输入/输出均精确)
    if (p.lenDist === 'lognormal') {
      let u1 = Math.max(rng(), 1e-9), u2 = rng();
      let z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
      return Math.max(64, Math.min(avg*8, Math.round(Math.exp(mu + sigma*z))));
    }
    return Math.max(64, Math.round(avg * (0.5 + rng())));
  }
  for (let i = 0; i < N; i++) {
    // 到达间隔: 泊松(指数分布, 有突发) 或 均匀(固定间隔 1/λ)
    t += p.arrivalDist === 'uniform' ? 1 / lambda : -Math.log(Math.max(rng(), 1e-9)) / lambda;
    let inLen = sampleLen(p.inputLen, muL);
    let outLen = sampleLen(p.outputLen, muO);
    requests.push({ id: i, arrive: t, inputLen: inLen, outputLen: outLen,
      groupId: null, prefixTokLen: 0, isFounder: false, followUp: false, retainIds: null,
      state: 'wait', tokensGen: 0, admitTime: 0, prefillStart: 0, prefillEnd: 0, decodeStart: 0, completeTime: 0,
      prefixBlkIds: [], ownBlkIds: [], kvHbm: 0, kvDram: 0, kvSsd: 0, prefillTokens: inLen });
  }
  requests.sort((a, b) => a.arrive - b.arrive);

  // 前缀组分配（与旧版相同思想：4组差异化前缀，按命中率目标配比，seeded）
  let prefixGroupMap = {};
  if (p.prefixHit > 0.001) {
    let totalInput = requests.reduce((s, r) => s + r.inputLen, 0);
    let targetReused = totalInput * p.prefixHit;
    let avgInput = Math.max(p.inputLen, 1);
    let groupDefs = [
      { id: 'pfx_A', ratio: 0.12 }, { id: 'pfx_B', ratio: 0.22 },
      { id: 'pfx_C', ratio: 0.35 }, { id: 'pfx_D', ratio: 0.48 },
    ];
    let sumRatioSq = groupDefs.reduce((s, g) => s + g.ratio * g.ratio, 0);
    let k = sumRatioSq > 0 ? (targetReused / avgInput) / sumRatioSq : 0;
    let assignments = [], totalAssigned = 0;
    groupDefs.forEach(g => {
      let pTokLen = Math.round(avgInput * g.ratio);
      if (pTokLen <= 0) return;
      let nTotal = Math.max(1, Math.round(k * g.ratio)) + 1;
      assignments.push({ group: g, prefixTokLen: pTokLen, nTotal: nTotal });
      totalAssigned += nTotal;
    });
    let maxAssign = Math.floor(N * 0.9);
    if (totalAssigned > maxAssign) {
      let scale = maxAssign / totalAssigned;
      assignments.forEach(a => { a.nTotal = Math.max(2, Math.floor(a.nTotal * scale)); });
    }
    let pool = requests.slice();
    for (let i = pool.length - 1; i > 0; i--) { let j = Math.floor(rng() * (i + 1)); let tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    let pi = 0;
    assignments.forEach(a => {
      let grp = [];
      for (let i = 0; i < a.nTotal && pi < pool.length; i++, pi++) {
        let req = pool[pi];
        req.groupId = a.group.id; req.prefixTokLen = Math.min(a.prefixTokLen, Math.round(req.inputLen * 0.7));
        req.isFounder = (i === 0); grp.push(req);
      }
      if (grp.length >= 2) prefixGroupMap[a.group.id] = { prefixTokLen: a.prefixTokLen, blkIds: [], refcount: 0, activated: false };
    });
    Object.keys(prefixGroupMap).forEach(gid => {
      let grp = requests.filter(r0 => r0.groupId === gid);
      let founder = grp.find(r0 => r0.isFounder);
      let minOther = Math.min(...grp.filter(r0 => !r0.isFounder).map(r0 => r0.arrive));
      if (founder && isFinite(minOther)) founder.arrive = Math.max(0, minOther - 0.001);
    });
    requests.sort((a, b) => a.arrive - b.arrive);
  }

  // ---------- JS 策略编译 ----------
  let jsAdmit = null, jsEvict = null, jsPrefetch = null, jsPlace = null;
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
    } catch(e) { console.warn('JS strategy compile error:', e.message); }
  }

  let s = strategy;
  let waitQueue = [], prefillQ = [], decoding = [], decodeWait = [], completedReqs = [];
  let prefilling = [], staticWaveOpen = true;

  function admitTier(req) {
    if (jsAdmit) { try { let r0 = jsAdmit(req); if (r0) return r0; } catch(e) {} }
    let tier = 'hbm';
    if (s.admission.type === 'threshold')
      tier = (pools.hbm.used / Math.max(caps.hbm,1)) < (s.admission.hbm_threshold || 0.8) ? 'hbm' : 'dram';
    else if (s.admission.type === 'cost_based') {
      if ((pools.hbm.used / Math.max(caps.hbm,1)) > 0.9) tier = 'dram';
      if ((pools.dram.used / Math.max(caps.dram,1)) > 0.9) tier = 'ssd';
    } else if (s.admission.type === 'priority')
      tier = req.inputLen < 2048 ? 'hbm' : 'dram';
    return tier;
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
    let avail = pool.blocks.filter(b => b.available);
    if (avail.length === 0) return null;
    if (jsEvict) {
      try { let v = jsEvict(pool, tier); if (v && pool.blockIndex[v.id] && v.available) return v; } catch(e) {}
    }
    let type = (tier === 'dram' && s.eviction.second) ? s.eviction.second.type : s.eviction.type;
    if (type === 'lfu') {
      return avail.reduce((a, b) => (pool.freq[a.id] || 0) <= (pool.freq[b.id] || 0) ? a : b);
    } else if (type === 'fifo') {
      return avail[0];
    } else {
      // lru 及默认：按最后访问时间戳淘汰
      return avail.reduce((a, b) => (a.lastTouch || 0) <= (b.lastTouch || 0) ? a : b);
    }
  }

  // 放置请求：真实共享前缀块(引用计数) + 自有块；容量不足时按策略淘汰并跨层搬运
  function placeRequest(req, tier) {
    if (jsPlace) { try { let t0 = jsPlace(); if (t0) tier = t0; } catch(e) {} }
    if (s.placement.type === 'tiered' && tier === 'hbm' && req.inputLen > 8192) tier = 'dram';
    if (s.placement.type === 'adaptive') tier = (pools.hbm.used / Math.max(caps.hbm,1)) < (s.placement.adaptive_threshold || 0.7) ? 'hbm' : 'dram';
    if (caps[tier] <= 0) tier = downTier(tier);

    // 1) 挂接已存在的共享/保留块（真实引用计数）
    req.prefixBlkIds = [];
    let coveredTok = 0;
    let attachIds = req.retainIds ? req.retainIds
      : (req.groupId && prefixGroupMap[req.groupId] ? prefixGroupMap[req.groupId].blkIds : []);
    let ssdCoveredTok = 0;
    attachIds.forEach(id => {
      let loc = findBlock(id);
      if (loc) { req.prefixBlkIds.push(id); loc.blk.refcount++; coveredTok += loc.blk.tokens;
        if (loc.tier === 'ssd') ssdCoveredTok += loc.blk.tokens; }
    });
    // 命中量不超过自身前缀长度：组内小输入请求的 prefixTokLen 被 clamp 到 inputLen×0.7，
    // 而组前缀块可能更长——直接累加会高估命中（覆盖掉应重算的部分）
    if (req.groupId && !req.isFounder && coveredTok > req.prefixTokLen) {
      coveredTok = req.prefixTokLen;
      ssdCoveredTok = Math.min(ssdCoveredTok, req.prefixTokLen);
    }
    // L3(SSD) 命中：前缀 KV 需从 L3 拉回 GPU，按有效带宽计费（ssdBW 反映 page_size 效应：
    // 实测 sglang mooncake page1≈1.05GB/s → page64≈27GB/s）。wait_complete 下 prefill 等 KV 到齐。
    // HBM/DRAM 前缀命中近似免费（片内/近存拷贝 ~μs-ms 级，相对 prefill 可忽略）。
    req.fetchTime = (req.groupId && !req.isFounder && ssdCoveredTok > 0)
      ? ssdCoveredTok * kvPerTok / Math.max(p.ssdBW * 1e9 * 0.9, 1) : 0;
    req._fetchDone = 0;
    // 2) 计算自有 token（前缀块被丢弃的部分需要重算）
    let groupPrefixTokens = 0, ownTokens;
    if (req.retainIds) {
      ownTokens = Math.max(0, req.prevTotalTok - coveredTok) + Math.max(64, req.inputLen - req.prevTotalTok);
    } else if (req.isFounder && req.groupId && prefixGroupMap[req.groupId] && prefixGroupMap[req.groupId].blkIds.length === 0) {
      groupPrefixTokens = req.prefixTokLen;
      ownTokens = req.inputLen - groupPrefixTokens;
    } else if (req.groupId && !req.isFounder) {
      ownTokens = Math.max(64, req.inputLen - coveredTok);
      if (coveredTok > 0) { stats.prefixHits++; stats.prefixSavedBytes += coveredTok * kvPerTok; }
    } else {
      ownTokens = req.inputLen;
    }
    if (req.retainIds && coveredTok > 0) { stats.sessionHits = (stats.sessionHits || 0) + 1; stats.prefixSavedBytes += coveredTok * kvPerTok; }
    ownTokens = Math.max(64, Math.round(ownTokens));
    // 前缀缓存的核心收益：sharer/后续轮 跳过已缓存前缀的 prefill 计算（降 TTFT）
    // founder 需全量 prefill 以建立共享块；普通请求全量 prefill
    req.prefillTokens = Math.max(64, req.inputLen - coveredTok);

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
    return true;
  }

  function findBlock(id) {
    if (pools.hbm.blockIndex[id]) return { tier: 'hbm', blk: pools.hbm.blockIndex[id] };
    if (pools.dram.blockIndex[id]) return { tier: 'dram', blk: pools.dram.blockIndex[id] };
    if (pools.ssd.blockIndex[id]) return { tier: 'ssd', blk: pools.ssd.blockIndex[id] };
    return null;
  }

  // 预取：把请求在 DRAM 中可用的块搬回 HBM（占用链路，有耗时）
  function doPrefetchFor(req) {
    if (!s.prefetch || s.prefetch.type === 'none') return;
    let thr = s.prefetch.prefetch_threshold || 0.5;
    let moved = 0;
    req.prefixBlkIds.concat(req.ownBlkIds).forEach(id => {
      if (moved >= 32) return;
      // SSD swap-in：先拉回 DRAM（FlexGen 式换入，占 ssd>dram 链路）
      let sblk = pools.ssd.blockIndex[id];
      if (sblk && sblk.available && pools.dram.used + sizeInTier(sblk, 'dram') <= caps.dram * 0.9) {
        scheduleTransfer(sblk, 'ssd', 'dram');
        moved++; stats.prefetches++;
        return;
      }
      if (pools.hbm.used / Math.max(caps.hbm, 1) >= thr) return;
      let blk = pools.dram.blockIndex[id];
      if (blk && blk.available && pools.hbm.used + blk.size <= caps.hbm * 0.95) {
        scheduleTransfer(blk, 'dram', 'hbm');
        moved++; stats.prefetches++;
      }
    });
  }

  // ---------- 完成与释放 ----------
  let pending = requests;
  let timeline = [], followUpCount = 0;

  function completeRequest(req) {
    req.state = 'done'; req.completeTime = now;
    stats.latencies.push((now - req.arrive) * 1000);
    stats.ttfts.push((req.prefillEnd - req.arrive) * 1000);
    stats.tpots.push((now - (req.decodeStart || req.prefillEnd)) / Math.max(1, req.outputLen) * 1000); // ms/token（剔除 decodeWait 排队）
    stats.queueWaits.push(req.admitTime - req.arrive);
    stats.completed++; stats.outTokens += req.outputLen;
    if (timeline.length < 320) timeline.push({ id: req.id, arrive: req.arrive, admitTime: req.admitTime,
      prefillStart: req.prefillStart, prefillEnd: req.prefillEnd, completeTime: now });

    // 多轮会话：保留KV，安排后续轮次复用（真实前缀命中）
    let retain = (!req.followUp && p.multiTurn > 0 && rng() < p.multiTurn);
    if (retain) {
      let retainIds = req.ownBlkIds.filter(id => findBlock(id));
      if (retainIds.length > 0) {
        let fu = { id: N + followUpCount++, arrive: now + 1 + rng() * 4,
          inputLen: Math.round(req.inputLen * (1.1 + 0.3 * rng())),
          outputLen: Math.max(64, Math.round(req.outputLen * (0.8 + 0.4 * rng()))),
          groupId: null, prefixTokLen: 0, isFounder: false, followUp: true,
          retainIds: retainIds, prevTotalTok: req.inputLen,
          state: 'wait', tokensGen: 0, admitTime: 0, prefillStart: 0, prefillEnd: 0, decodeStart: 0, completeTime: 0,
          prefixBlkIds: [], ownBlkIds: [], kvHbm: 0, kvDram: 0, kvSsd: 0, prefillTokens: 0 };
        pending.push(fu); pending.sort((a, b) => a.arrive - b.arrive);
        req.ownBlkIds = []; // 所有权移交给保留集
      }
    }
    req.ownBlkIds.forEach(id => { ['hbm','dram','ssd'].forEach(t0 => poolRemove(t0, id)); });
    req.prefixBlkIds.forEach(id => {
      let loc = findBlock(id);
      if (loc) { loc.blk.refcount--; if (loc.blk.refcount <= 0) poolRemove(loc.tier, id); }
    });
    completedReqs.push(req);
  }

  // ---------- 主循环 ----------
  let lastArrive = pending.length ? pending[pending.length - 1].arrive : 0;
  // 自适应仿真窗口：覆盖全部 prefill 工作 + 分波 decode 排水时间的估计，避免重负载下结果被截断
  // （estPass 需含 decode 每请求开销，与 perReqMs 校准一致——旧公式低估导致
  //   Aggressive 静态批高并发场景 0 完成、P99 显示 0；权重项保守按总权重）
  let totalPrefillEst = pending.reduce((s2, q) => s2 + 2 * r.activatedParams * q.inputLen / r.computeFlops, 0);
  let estN = Math.min(s.batching.max_batch_size || 8, N);
  let estPass = Math.max((r.modelWeightBytes + estN * r.avgLifetimeKv) / r.aggHbmBW
    + perReqMs(estN, r.activatedParams, p.gpus) / 1000, 1e-3);
  let drainEst = totalPrefillEst + p.outputLen * estPass * Math.ceil(N / Math.max(1, estN)) * 2;
  let maxTime = lastArrive + Math.min(Math.max(drainEst, 120), 1200);
  let maxSteps = Math.min(Math.ceil(maxTime / DT), 150000);
  let dirty = true;

  function refreshLocations() {
    decoding.forEach(q => {
      let h = 0, d = 0, sd = 0;
      // 在途块按源层读速计费（块未到达前对decode不可用）；丢弃块按SSD读速计（重算代价近似）
      let nIds = Math.max(1, q.prefixBlkIds.length + q.ownBlkIds.length);
      let avgBlkSize = q.inputLen * kvPerTok / nIds;
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
        if (sb) { if (sb.available) { sd += sizeInTier(sb, 'ssd'); stats.ssdAcc++; } else chargeInFlight(sb); return; }
        sd += avgBlkSize; stats.ssdAcc++; // 已丢弃 → 按重算代价（SSD读速）计
      });
      q.kvHbm = h; q.kvDram = d; q.kvSsd = sd;
    });
  }

  for (let step = 0; step < maxSteps; step++) {
    now = step * DT;

    while (pending.length && pending[0].arrive <= now) waitQueue.push(pending.shift());

    // 准入：prefill 槽位与 decode 槽位解耦（连续批）
    // 原模型把 prefill/decode 计入同一 running 上限 → decode 波次占满槽位会阻塞后续请求的
    // prefill 准入，使 TTFT 与 outputLen 强耦合（高并发长输出时 TTFT 虚高 1-2 个数量级）。
    // 修复：continuous 下 prefill 准入不受 decode 槽位数量阻塞（TTFT 只由 prefill 算力排队
    // 决定），只受 ①prefill 流水线缓冲（prefillSlots，chunked-prefill 并行度）
    // ②上层 KV 容量（HBM+DRAM）约束——容量不足时请求留在 waitQueue 等待（物理正确：资源
    // 不足则排队），而不是无限准入把 KV 挤进慢速 SSD 引发 decode 灾难。
    // decodeWait（prefill 完成等 decode 槽位）无数量上限：其 KV 已计入 pools 用量，容量
    // 检查自然约束；prefill→decode 转换处由 decode 槽位上限单独执行。static 波次不变。
    if (s.batching.type === 'priority') waitQueue.sort((a, b) => a.inputLen - b.inputLen);
    if (s.batching.type === 'static' && decoding.length === 0 && prefillQ.length === 0 && prefilling.length === 0) staticWaveOpen = true;
    let prefillSlots = Math.max(1, Math.min(s.batching.max_batch_size || 8, 4));
    let fastCap = (caps.hbm + caps.dram) * 0.98; // 快层容量：HBM+DRAM 为"软家"，SSD 是最后手段
    for (let i = 0; i < waitQueue.length; i++) {
      if (s.batching.type === 'static') {
        if (!staticWaveOpen) break;
        let running = decoding.length + prefillQ.length + prefilling.length;
        if (running >= s.batching.max_batch_size) { staticWaveOpen = false; break; }
      } else if (prefillQ.length + prefilling.length >= prefillSlots) break;
      // 快层容量：按"在途请求 KV 总量"估算（含 decodeWait），而非 pools.used——
      // 淘汰会把块移出快层导致 pools.used 虚低，只有按在途请求数×平均KV才能真实反映
      // 快层占用（放不下 → 等解码释放，物理正确：资源不足则排队）
      let kvInFlight = (decoding.length + decodeWait.length + prefillQ.length + prefilling.length) * r.avgLifetimeKv;
      if (kvInFlight > fastCap) break;
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

    // 并行 Prefill（chunked-prefill 风格；sharer 只算非前缀部分 —— 前缀缓存的 TTFT 收益）
    // 旧模型串行 prefill（一次 1 个请求，N 个请求的 prefill 时间线性累积）在并发负载下
    // 严重高估 TTFT（实测 vLLM 连续批处理并行 prefill，对比 8 并发 16 请求场景仿真 TTFT
    // 高估 1.6-2.2 倍）。修复：prefill 并发 = prefillSlots 个请求同时推进，算力按并发分时，
    // 但总利用率随并发提升（单请求启动/依赖开销大，并行 batch 把 GPU 填满）——
    // 总速率 = computeFlops × boost(n) / (2×actParams)，boost = min(n, PREFILL_UTIL_CAP/mfu)。
    while (prefilling.length < prefillSlots && prefillQ.length) {
      let rq = prefillQ.shift();
      rq.state = 'prefill'; rq.prefillStart = now;
      rq._pfTotal = rq.prefillTokens || rq.inputLen;
      rq._pfDone = 0;
      prefilling.push(rq);
      dirty = true;
    }
    if (prefilling.length) {
      // 并行 prefill 利用率提升受 GPU 数限制：多卡(TP)下单请求已利用卡间并行，增加并发请求
      // 提升有限(sglang chunked-prefill 波处理, 实测 DS-V3 8 卡 16 请求总吞吐≈单请求, 无提升)；
      // 单卡(如 Qwen3-32B 校准)下提升显著至 PREFILL_UTIL_CAP。
      // boost = 1 + (n-1)/gpus, 上限 PREFILL_UTIL_CAP/mfu
      let boost = Math.min(1 + (prefilling.length - 1) / Math.max(p.gpus, 1),
        PREFILL_UTIL_CAP / Math.max(p.mfu, 0.05));
      // 混合批耦合(sglang 非 PD 分离): decode 活跃时 prefill 与 decode 共享 GPU, prefill 速率打折。
      // 实测 DS-V3 混合批 TTFT 与 outputLen 强耦合(out256=7330ms vs out64=717ms, 前缀命中可缓解)；
      // vLLM(实测解耦)与 PD 分离模式不启用此耦合。
      let pfFactor = 1;
      if (p.framework === 'sglang' && !p.pdSep) {
        let decodeUtil = decoding.length / Math.max(1, s.batching.max_batch_size || 8);
        pfFactor = 1 - 0.85 * Math.min(1, decodeUtil); // decode 满时 prefill 仅 15% 速率
      }
      let rate = r.computeFlops * boost * pfFactor / (2 * r.activatedParams); // 总 prefill tok/s
      let perReq = rate / prefilling.length;
      for (let i = prefilling.length - 1; i >= 0; i--) {
        let q = prefilling[i];
        // L3 命中拉取阶段（wait_complete）：KV 从 SSD 拉回期间只耗墙钟、不占 prefill 算力；
        // 拉取完成才开始真正的 prefill 计算。fetchTime 计入 TTFT（prefillStart→prefillEnd）。
        if ((q.fetchTime || 0) > q._fetchDone) { q._fetchDone += DT; continue; }
        q._pfDone += perReq * DT;
        // 前缀树渐进激活（sglang RadixAttention）：founder prefill 每完成一段，已算好的前缀块
        // 即刻对组内后续请求可用（部分命中）。vLLM 整段哈希（hash）则等 founder 全部完成才激活。
        if (p.prefixCache === 'radix' && q.groupId && q.groupBlkIds && prefixGroupMap[q.groupId]) {
          let availN = Math.max(1, Math.min(q.groupBlkIds.length, Math.floor(q._pfDone / q._pfTotal * q.groupBlkIds.length)));
          prefixGroupMap[q.groupId].blkIds = q.groupBlkIds.slice(0, availN);
          prefixGroupMap[q.groupId].activated = true;
        }
        if (q._pfDone >= q._pfTotal) {
          prefilling.splice(i, 1);
          q.prefillEnd = now;
          // 前缀缓存时间窗：founder 的 prefill 完成 → 组前缀 KV 才真正可用，激活供组内后续
          // 请求命中（此前到达的组内请求按全量 prefill 处理——实测 vLLM 行为一致：
          // 组内请求同时到达时前缀完全未命中，TTFT 与 founder 相同）。
          // hash 模式在此一次性激活全部；radix 模式渐进激活到 100% 后此处兜底补齐。
          if (q.groupId && q.groupBlkIds && prefixGroupMap[q.groupId]) {
            if (p.prefixCache === 'hash' && !prefixGroupMap[q.groupId].activated) {
              prefixGroupMap[q.groupId].blkIds = q.groupBlkIds;
              prefixGroupMap[q.groupId].activated = true;
            } else if (p.prefixCache === 'radix') {
              prefixGroupMap[q.groupId].blkIds = q.groupBlkIds;
            }
          }
          // prefill 完成 → 转 decode。continuous 批下 decode 并发受 max_batch_size 约束：
          // 槽位满时先入 decodeWait（不占 prefill 流水线），槽位释放后补入。
          // （修复前：prefill 完成后若 decode 满则挂起等待，阻塞后续 prefill 准入，
          //   使 TTFT 与 outputLen 强耦合——高并发长输出时 TTFT 虚高 1-2 个数量级）
          let decodeSlots = s.batching.max_batch_size || 8;
          let decodeOk = (s.batching.type === 'static') || decoding.length < decodeSlots;
          if (decodeOk) {
            q.state = 'decode';
            q.decodeStart = now;
            if (s.prefetch && s.prefetch.type === 'on_demand') doPrefetchFor(q);
            if (jsPrefetch) { try { jsPrefetch(); } catch(e) {} }
            decoding.push(q);
          } else {
            q.state = 'decodeWait';
            decodeWait.push(q);
          }
          dirty = true;
        }
      }
    }
    // decode 槽位释放 → 从 decodeWait 补入（static 波次语义不变）
    while (decodeWait.length && (s.batching.type === 'static' || decoding.length < (s.batching.max_batch_size || 8))) {
      let q = decodeWait.shift();
      q.state = 'decode';
      q.decodeStart = now;
      decoding.push(q);
      dirty = true;
    }

    // Eager 预取：SSD swap-in 到 DRAM（DRAM 有空间即做）+ 水位线下 DRAM 拉回 HBM
    // 每10步扫描一次（与位置刷新同频，避免每步全量扫描的性能开销）
    // 覆盖 decoding + decodeWait：decodeWait 中的请求即将进入 decode，其 KV 应提前预热，
    // 否则进入 decode 时才从 SSD 读（1GB/s 级）会拖垮整个批次（修复前 SSD 场景 0 完成）。
    if (s.prefetch && s.prefetch.type === 'eager' && (decoding.length || decodeWait.length) && step % TOUCH_EVERY === 0) {
      let moved = 0;
      for (let q of decoding.concat(decodeWait)) {
        for (let id of q.prefixBlkIds.concat(q.ownBlkIds)) {
          if (moved >= 8) break;
          // SSD → DRAM swap-in（不占 HBM 水位，仅受 DRAM 空间约束）
          let sblk = pools.ssd.blockIndex[id];
          if (sblk && sblk.available && pools.dram.used + sizeInTier(sblk, 'dram') <= caps.dram * 0.9) {
            scheduleTransfer(sblk, 'ssd', 'dram'); moved++; stats.prefetches++; dirty = true;
            continue;
          }
          // DRAM → HBM（受预取水位线约束）
          if (pools.hbm.used / Math.max(caps.hbm, 1) >= (s.prefetch.prefetch_threshold || 0.5)) continue;
          let blk = pools.dram.blockIndex[id];
          if (blk && blk.available && pools.hbm.used + blk.size <= caps.hbm * 0.95) {
            scheduleTransfer(blk, 'dram', 'hbm'); moved++; stats.prefetches++; dirty = true;
          }
        }
        if (moved >= 8) break;
      }
    }

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
      let passTime = (r.modelWeightBytes * r.decodeWeightRatio + sumH) / r.aggHbmBW
        + perReqMs(decoding.length, r.activatedParams, p.gpus) / 1000
        + sumD / (p.pcieBW * 1e9)
        + sumS / (p.ssdBW * 1e9 * 0.9);
      let cmpFloor = 2 * r.activatedParams * decoding.length / r.computeFlops;
      // chunked-prefill 竞争：混合批下并行 prefill 与 decode 共享算力，只放大算力项（带宽/I-O 项不受 prefill 影响）。
      // 旧实现 passTime×2 把 I-O 读盘时间也翻倍——decode 受限(SSD 慢)场景被严重拖慢，属过度惩罚。
      // PD 分离（sglang）时 prefill/decode 各用独立资源，无算力竞争。
      if (!p.pdSep && prefilling.length) cmpFloor *= (1 + 0.5 * prefilling.length);
      passTime = Math.max(passTime, cmpFloor, 1e-6) + r.commTime(decoding.length);
      let tok = DT / passTime;
      for (let i = decoding.length - 1; i >= 0; i--) {
        let q = decoding[i];
        q.tokensGen += tok;
        if (q.tokensGen >= q.outputLen) { decoding.splice(i, 1); completeRequest(q); dirty = true; }
      }
    }

    // 显存利用率采样（峰值 + 时间加权平均）+ 并发度采样
    let u = pools.hbm.used / Math.max(caps.hbm, 1);
    stats.memUtilSum += u; stats.memUtilSamples++;
    if (u > stats.memUtilPeak) stats.memUtilPeak = u;
    if (step % 5 === 0) stats.concSamples.push([+now.toFixed(2), decoding.length, prefilling.length, waitQueue.length + prefillQ.length]);

    if (!pending.length && !waitQueue.length && !prefillQ.length && !prefilling.length && !decodeWait.length && !decoding.length) break;
  }
  let simEnd = Math.max(now, 1e-6);

  // ---------- 指标 ----------
  let totalAcc = stats.hbmAcc + stats.dramAcc + stats.ssdAcc;
  let hitRate = totalAcc > 0 ? stats.hbmAcc / totalAcc * 100 : 0;
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
  waitQueue.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: null, prefillStart: null, prefillEnd: null, completeTime: null, state: 'queued' }));
  prefillQ.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: null, prefillEnd: null, completeTime: null, state: 'prefillQ' }));
  decodeWait.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: q.prefillEnd, completeTime: null, state: 'decodeWait' }));
  prefilling.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: null, completeTime: null, state: 'prefilling' }));
  decoding.forEach(q => incomplete.push({ id: q.id, arrive: q.arrive, admitTime: q.admitTime, prefillStart: q.prefillStart, prefillEnd: q.prefillEnd, completeTime: null, state: 'decoding' }));

  return {
    name: strategy.name || autoNameStrategy(strategy),
    hitRate, p50, p99, avgTtft, p50Ttft, p99Ttft, avgTpot, p50Tpot, p99Tpot, avgQueue, fairnessCV,
    throughput: stats.outTokens / simEnd,
    memUtilAvg: stats.memUtilSamples ? stats.memUtilSum / stats.memUtilSamples * 100 : 0,
    memUtilPeak: stats.memUtilPeak * 100,
    evictions: stats.evictions, activeEvictions: stats.activeEvictions,
    prefetches: stats.prefetches, drops: stats.drops,
    transferGB: stats.transferBytes / 1e9,
    prefixHits: stats.prefixHits || 0, prefixSavedMB: (stats.prefixSavedBytes || 0) / 1e6,
    sessionHits: stats.sessionHits || 0,
    prefixGroups: Object.keys(prefixGroupMap).length,
    fragPct: r.fragPct,
    completed: stats.completed, totalReqs: N + followUpCount,
    latencies: stats.latencies, timeline: timeline, concTimeline: stats.concSamples,
    incomplete: incomplete, simEnd: simEnd,
    admission: strategy.admission.type, eviction: strategy.eviction.type, prefetch: strategy.prefetch.type,
  };
}

// ======================== STRATEGY VISUALIZATION ========================
function applyStrategies() {
  setTimeout(() => {
    try {
      saveStrategy();
      let strategies = savedStrategies.length > 0 ? [...savedStrategies] : [getCurrentStrategy()];
      simResults = strategies.map(s => runSimulation(s));
      $('strategyResults').style.display = 'block';
      $('sensitivityPanel').style.display = 'block';
      drawStrategyMetrics();
      drawStrategyComparisonGantt();
    } catch(e) {
      console.error('Simulation error:', e);
      $('strategyResults').style.display = 'block';
      $('strategyMetricsGrid').innerHTML = '<div style="color:var(--accent4);padding:8px">仿真出错: '+e.message+'</div>';
      $('sensitivityPanel').style.display = 'none';
    }
  }, 50);
}

function drawStrategyMetrics() {
  let grid = $('strategyMetricsGrid');
  if (simResults.length === 0) { grid.innerHTML = '<div style="color:var(--text-dim)">暂无仿真结果</div>'; return; }
  let rows = [];
  simResults.forEach(sr => {
    rows.push('<div style="grid-column:1/-1;font-size:.78rem;color:var(--accent);margin-bottom:2px;border-bottom:1px solid var(--border);padding-bottom:4px;margin-top:8px">📌 '+sr.name+'</div>');
    let items = [
      ['HBM命中率', sr.hitRate.toFixed(1)+'%', 'green'],
      ['TTFT(P50)', sr.p50Ttft.toFixed(0)+' ms', 'accent'],
      ['TTFT(P99)', sr.p99Ttft.toFixed(0)+' ms', 'orange'],
      ['TPOT(均值)', sr.avgTpot.toFixed(1)+' ms/tok', 'accent'],
      ['TPOT(P99)', sr.p99Tpot.toFixed(1)+' ms/tok', 'red'],
      ['P50延迟', sr.p50.toFixed(0)+' ms', 'accent'],
      ['P99延迟', sr.p99.toFixed(0)+' ms', 'red'],
      ['平均排队', sr.avgQueue.toFixed(2)+' s', 'orange'],
      ['吞吐', formatNum(sr.throughput)+' tok/s', 'green'],
      ['显存利用率(峰值)', sr.memUtilPeak.toFixed(1)+'%', 'accent'],
      ['显存利用率(平均)', sr.memUtilAvg.toFixed(1)+'%', 'accent'],
      ['淘汰次数', sr.evictions+' (活跃'+sr.activeEvictions+')', 'orange'],
      ['预取次数', sr.prefetches+' 次', 'accent'],
      ['丢弃块数', sr.drops+' 个', sr.drops>0?'red':'green'],
      ['跨层传输量', sr.transferGB.toFixed(1)+' GB', 'orange'],
      ['前缀命中请求', sr.prefixHits+' 次', 'green'],
      ['前缀节省显存', sr.prefixSavedMB.toFixed(0)+' MB', 'green'],
      ['会话复用', sr.sessionHits+' 次', 'green'],
      ['公平性(CV)', sr.fairnessCV.toFixed(0)+'%', 'accent'],
      ['完成请求', sr.completed+'/'+sr.totalReqs, 'green'],
    ];
    items.forEach(it => {
      rows.push('<div class="result-item"><div class="rl">'+it[0]+'</div><div class="rv '+it[2]+'">'+it[1]+'</div></div>');
    });
  });
  grid.innerHTML = rows.join('');
}

function drawStrategyComparisonGantt() {
  let ch = initChart('chartStrategyGantt');
  if (simResults.length === 0) return;
  ch.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['HBM命中率(%)', 'P50延迟(ms)', 'P99延迟(ms)', '显存利用率峰值(%)'], top: 0, textStyle: { color: '#9ca0b0' } },
    grid: { left: 100, right: 70, top: 50, bottom: 30 },
    xAxis: { type: 'category', data: simResults.map(s => s.name), axisLabel: { color: '#e4e4e7', rotate: 20, fontSize: 10 } },
    yAxis: [
      { type: 'value', name: '百分比/延迟', axisLabel: { color: '#9ca0b0' } },
      { type: 'value', name: '延迟(ms)', axisLabel: { color: '#9ca0b0' } }
    ],
    series: [
      { name: 'HBM命中率(%)', type: 'bar', data: simResults.map(s => +s.hitRate.toFixed(1)), itemStyle: { color: '#34d399' } },
      { name: '显存利用率峰值(%)', type: 'bar', data: simResults.map(s => +s.memUtilPeak.toFixed(1)), itemStyle: { color: '#fb923c' } },
      { name: 'P50延迟(ms)', type: 'line', yAxisIndex: 1, data: simResults.map(s => +s.p50.toFixed(0)), itemStyle: { color: '#6c63ff' }, lineStyle: { color: '#6c63ff', width: 2 } },
      { name: 'P99延迟(ms)', type: 'line', yAxisIndex: 1, data: simResults.map(s => +s.p99.toFixed(0)), itemStyle: { color: '#f87171' }, lineStyle: { color: '#f87171', width: 2 } },
    ]
  });
  setFormula('formulaStrategySim',
    '<b>📐 仿真说明（事件驱动，全部指标来自真实统计）</b><br>'+
    '• 请求生成: <code>N = min(2×并发, 256) = '+Math.min(gi('pConcurrency')*2,256)+'</code> 个 · 到达: '+($('pArrivalDist')&&$('pArrivalDist').value==='uniform'
      ? '均匀等间隔(间隔 1/λ='+(1/Math.max(gv('pQps'),0.1)).toFixed(3)+'s)'
      : '泊松过程(λ='+gv('pQps')+', seed='+gi('pSeed')+')')+' · 长度分布: '+$('pLenDist').value+' · 多轮复用: '+gi('pMultiTurn')+'%<br>'+
    '• 准入: batch槽位≤max_batch_size 且显存可放置，否则排队 · Prefill: 并行 <code>并发≤min(maxBatch,4)，总速率 = FLOPS×boost/(2×激活参数)</code>，boost随并发提升至90%（sharer 的 prefill 只含非前缀部分——前缀缓存的 TTFT 收益，且组前缀在 founder prefill 完成后才可命中）<br>'+
    '• Decode: 批次共享前向 <code>passTime = max[(W+ΣKV<sub>hbm</sub>)/BW<sub>hbm</sub> + ΣKV<sub>dram</sub>/PCIe + ΣKV<sub>ssd</sub>/NVMe, 2P×B/FLOPS]</code><br>'+
    '• 淘汰/预取的跨层搬运占用链路带宽，块到达前不可用 · 前缀共享为真实块引用计数，可被淘汰下沉'
  );
}

// ======================== SENSITIVITY ANALYSIS ========================
function runSensitivity() {
  let btn = document.querySelector('#sensitivityPanel .btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 分析中...'; }

  let baseStrategy = savedStrategies.length > 0 ? savedStrategies[0] : getCurrentStrategy();
  let param = $('sSweepParam').value, metric = $('sSweepMetric').value;
  let values, labels;
  if (param === 'max_batch_size') { values = [1,2,4,8,16,32,64,128]; labels = values.map(v=>'B='+v); }
  else if (param === 'prefix_hit') { values = [0,10,20,30,40,50,60,70,80,90]; labels = values.map(v=>v+'%'); }
  else if (param === 'ssd_bw') { values = [1,2,5,10,20,40,80]; labels = values.map(v=>v+'GB/s'); }
  else { values = [10,20,30,40,50,60,70,80,90]; labels = values.map(v=>v+'%'); }

  let metricLabel = {hit_rate:'HBM命中率(%)', p99_latency:'P99延迟(ms)', ttft:'平均TTFT(ms)', tpot:'平均TPOT(ms/tok)', throughput:'吞吐(tok/s)', mem_util:'显存利用率峰值(%)'}[metric];
  let paramLabel = {hbm_threshold:'准入阈值', evict_threshold:'淘汰触发阈值', prefetch_threshold:'预取水位线', max_batch_size:'最大Batch Size', prefix_hit:'前缀命中率', ssd_bw:'SSD带宽'}[param];

  let results = new Array(values.length);
  let chartEl = $('chartSensitivity');
  chartEl.innerHTML = '<div class="progress-note">⏳ 敏感性分析运行中... 0/'+values.length+'</div>';
  let formulaEl = $('formulaSensitivity');
  formulaEl.innerHTML = '';

  let idx = 0;
  function runNext() {
    if (idx >= values.length) {
      let ch = initChart('chartSensitivity');
      ch.setOption({
        tooltip: { trigger: 'axis' },
        grid: { left: 70, right: 20, top: 20, bottom: 40 },
        xAxis: { type: 'category', data: labels, name: paramLabel, nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' } },
        yAxis: { type: 'value', name: metricLabel, nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' } },
        series: [{ type: 'line', smooth: true, data: results.map(v => +v.toFixed(1)),
          lineStyle: { color: '#6c63ff', width: 2 }, areaStyle: { color: 'rgba(108,99,255,.1)' },
          itemStyle: { color: '#6c63ff' }, label: { show: true, color: '#9ca0b0', fontSize: 9 } }]
      });
      formulaEl.innerHTML = '<b>📐 敏感度分析方法</b><br>'+
        '固定其他策略参数与随机种子（共同随机数法），扫描 <code>'+paramLabel+'</code>，观察 <code>'+metricLabel+'</code><br>'+
        '基准策略: <code>'+baseStrategy.name+'</code> · 注意 max_batch_size 现已真实接入引擎（批次槽位+Roofline）';
      if (btn) { btn.disabled = false; btn.textContent = '📈 运行敏感性分析'; }
      return;
    }
    let v = values[idx];
    setTimeout(() => {
      try {
        let s = JSON.parse(JSON.stringify(baseStrategy));
        let overrides = { seed: gi('pSeed') }; // 固定种子保证可比
        if (param === 'hbm_threshold') s.admission.hbm_threshold = v / 100;
        if (param === 'evict_threshold') s.eviction.hbm_evict_threshold = v / 100;
        if (param === 'prefetch_threshold') s.prefetch.prefetch_threshold = v / 100;
        if (param === 'max_batch_size') s.batching.max_batch_size = v;
        if (param === 'prefix_hit') overrides.prefixHit = v / 100; // 全局负载参数，经overrides注入
        if (param === 'ssd_bw') overrides.ssdBW = v; // 硬件参数，经overrides注入
        let r = runSimulation(s, overrides);
        results[idx] = metric === 'hit_rate' ? r.hitRate : metric === 'p99_latency' ? r.p99
          : metric === 'ttft' ? r.avgTtft : metric === 'tpot' ? r.avgTpot
          : metric === 'throughput' ? r.throughput : r.memUtilPeak;
      } catch(e) {
        results[idx] = 0;
      }
      chartEl.innerHTML = '<div class="progress-note">⏳ 敏感性分析运行中... '+(idx+1)+'/'+values.length+'</div>';
      idx++;
      runNext();
    }, 0);
  }
  runNext();
}

// ======================== STRATEGY TAB INIT ========================
function initStrategyTab() {
  let bar = $('strategyPresets');
  bar.querySelectorAll('.preset-tag').forEach(b => b.remove());
  Object.keys(strategyPresets).forEach(name => {
    let btn = document.createElement('button');
    btn.className = 'preset-tag';
    btn.textContent = name;
    btn.onclick = function() {
      let text = strategyMode === 'js' ? (strategyPresetsJS[name] || strategyPresets[name]) : strategyPresets[name];
      $('sDsl').value = text;
      $('sDslError').textContent = '';
      $('sName').value = '';
      $('sName').placeholder = strategyMode === 'js' ? '自动命名: JS-'+name : '自动命名: '+autoNameStrategy(parseDSL(text));
    };
    bar.appendChild(btn);
  });
  if (!$('sDsl').value.trim()) {
    $('sDsl').value = strategyMode === 'js' ? strategyPresetsJS['Pure-HBM'] : strategyPresets['Pure-HBM'];
  }
}

// ======================== INIT ========================
function init(){
  initParamsTab();
  initStrategyTab();
  updateQuickResults();
}

