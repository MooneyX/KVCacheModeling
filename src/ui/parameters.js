import { getParams } from "../adapters/browser/params.js";
import { estimatePrefillParams, prefillIntegral, calcAll, effL2LinkBW, l2AttnTp } from "../core/calculations.js";
import { $ } from "../adapters/browser/dom.js";
import { formatNum, formatBytes, formatRate } from "./format.js";
import { models, hwPresets } from "../core/presets.js";
import { state } from "./state.js";
import { switchMode, syncPrefetchSelect } from "./strategy.js";
import { setFormula, initChart } from "./charts.js";
import { refreshActiveTab } from "./init.js";



// PD 分离面板显隐(2026-08-20): 仅"真分离"档需要 P/D 划分与互联参数
export function togglePdPanel(){
  var el = document.getElementById('pdPanel');
  if (!el) return;
  var mode = parseInt((document.getElementById('pPdSep') || {}).value || '0', 10) || 0;
  el.style.display = mode === 2 ? '' : 'none';
  if (typeof applyEstimatedParams === 'function') applyEstimatedParams();
}


// 把推导值填入输入框（换模型/硬件预设/改 MFU 时自动调用；用户可在同配置下手动覆盖）
export function applyEstimatedParams(){
  let p = getParams();
  let e = estimatePrefillParams(p);
  $('pPrefillA').value = e.a.toFixed(2);
  $('pPrefillB').value = e.b.toFixed(6);
  if ($('pPrefillBIdx')) $('pPrefillBIdx').value = e.bIdx.toFixed(6);
  $('pFetchFixedUs').value = 0;   // 简化传输模型(2026-08-12): 传输延迟=大小/带宽, 每块固定开销 τ_pf 不再自动填入
  let n = $('estParamsNote');
  if (n) {
    let mode = e.mfuAuto
      ? 'Roofline自动(峰值算力 vs HBM带宽, ridge='+e.ridgePoint.toFixed(1)+' FLOP/B)'
      : 'MFU模式 '+(p.mfu*100).toFixed(0)+'%(只计算, 访存被overlap)';
    n.textContent = mode + ' → a=' + e.a.toFixed(1) + '(' + e.aBound + ') · b='
      + (e.b * 1e3).toFixed(2) + 'e-3(' + e.bBound + ')'
      + (e.sparseAttn ? ' · b_idx=' + (e.bIdx * 1e3).toFixed(3) + 'e-3(稀疏topk=' + e.sparseTopk + ')' : '')
      + ' · GEMM强度=' + e.gemmIntensity.toFixed(0) + ' / Attn强度=' + e.attnIntensity.toFixed(0) + ' FLOP/B';
  }
  renderDerivationPanel(p, e);
  recalcAll();
}



// ==================== a/b 推导明细面板（2026-08-20, 借鉴 B 的 time_formula 做法）====================
// 设计要点: 表格数据全部来自 estimatePrefillParams 返回的 e.parts —— **与引擎计算同源**,
// 不是另写一份文案。此前 UI 的公式说明是手写字符串拼接, 引擎口径变了容易忘记同步(漂移风险)。
export function toggleSparseFields(){
  let on = !!(document.getElementById('pSparseAttn') && document.getElementById('pSparseAttn').checked);
  ['sparseF1','sparseF2','sparseF3','sparseF4'].forEach(function(id){
    let el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none';
  });
}


// 单批Prefill基准模式的 UI 护栏(2026-08-20): 该模式故意跳过槽位/容量准入门控(见 runSimulation
// L3259/L3265/L3288), batch 规模改由「请求数」pConcurrency 决定(N=min(concurrency,256));
// max_batch 只作用于 decode, 而单批模式 prefill 完成即结束、不进 decode ⇒ 完全无效。
// 实测: 单批开时 pMaxBatch 4→256 / pPrefillSlots 1→64 的 TTFT/拉取/计算逐点不变;
// 只有 pConcurrency 4→64 会让 TTFT 747→10160ms。此前无提示, 极易误调 max_batch 后以为引擎有 bug。
export function toggleSingleBatchHints(){
  let on = state.workloadSource !== 'replay' && !!(document.getElementById('pSingleBatch') && document.getElementById('pSingleBatch').checked);
  // 置灰失效项 + 标注原因
  // 2026-09-03 第4批: 单批已移植到波次路径(组波预算/chunk 放开为 ∞, 一波=整个 batch) ——
  // token 预算旋钮失效的原因从"强制流体"变为"预算 ∞", 提示文案同步更新。
  // (pPrefillSlots 已随流体路径删除, 从置灰清单移除。)
  [['pMaxBatch','lblMaxBatch','Max Batch Size','单批下无效(仅decode)'],
   ['pMaxPrefillTok','lblMaxPrefillTok','Prefill token预算','单批下无效(预算放开∞)']
  ].forEach(function(t){
    let inp = document.getElementById(t[0]), lab = document.getElementById(t[1]);
    if (inp) { inp.disabled = on; inp.style.opacity = on ? '0.45' : ''; }
    if (lab) {
      lab.innerHTML = on ? t[2] + ' <span style="color:#fbbf24">⚠ ' + t[3] + '</span>' : t[2];
      lab.style.opacity = on ? '0.6' : '';
    }
  });
  // 高亮真正生效的旋钮
  let cl = document.getElementById('lblConcurrency');
  if (cl) cl.innerHTML = on
    ? '请求数 <span style="color:var(--accent2)">← 单批 batch 规模</span>'
    : '请求数';
  let ci = document.getElementById('pConcurrency');
  if (ci) ci.style.borderColor = on ? 'var(--accent2)' : '';
}



export function toggleDerivationPanel(){
  let el = $('derivPanel'); if (!el) return;
  let show = el.style.display === 'none';
  el.style.display = show ? '' : 'none';
  if (show) { let p = getParams(); renderDerivationPanel(p, estimatePrefillParams(p)); }
}


export function renderDerivationPanel(p, e){
  let el = $('derivPanel'); if (!el || el.style.display === 'none') return;
  let q = e.parts, us = 1e6;
  // 每一项: [名称, FLOP/tok(或/tok/pos), 访存B, 归属(a 或 b), 说明]
  let rows = [
    ['非attention GEMM', q.gemmFlop, q.gemmBytes, 'a',
     '2×激活参数 = 2×'+formatNum(q.act)+' FLOP/tok；权重读 激活参数×权重精度÷chunk('+q.chunk+')'],
    ['attention(位置项)', q.attnFlop, q.attnBytes, 'b',
     p.attn==='mla'
       ? (p.mlaPrefillPath==='absorb'
          ? '吸收式 2×L×nH×[(kvLora+rope)+kvLora]；KV读 kvPerTok÷chunk'
          : '解压式MHA 2×L×nH×[(nope+rope)+vHead]；KV读 kvPerTok÷chunk')
       : 'GQA 4×L×hidden；KV读 kvPerTok÷chunk'],
  ];
  if (e.sparseAttn) rows.push(['Indexer(位置项)', q.idxFlop, q.idxBytes, 'b_idx',
    '2×L×idxHeads×idxHeadDim + combine + topk；扫全历史打分, 不受 topk 截断']);
  let cmpT = f => f / q.peakFlops * us, memT = b => b / q.aggHbmBW * us;
  let effT = f => f / q.effFlops * us;
  let h = '<div style="background:var(--card,#1a1d27);border:1px solid var(--border,#2a2e3a);border-radius:8px;padding:10px 12px;font-size:.72rem">';
  h += '<div style="color:var(--accent2);margin-bottom:6px;font-weight:600">🔬 a/b 逐项推导明细'
    + (e.mfuAuto ? '（Roofline 自动：每项取 max(计算,访存)）' : '（MFU '+(p.mfu*100).toFixed(0)+'%：只计算时间，访存视为被 overlap）')
    + '　ridge point = '+e.ridgePoint.toFixed(1)+' FLOP/B</div>';
  h += '<table style="width:100%;border-collapse:collapse;font-size:.7rem">';
  h += '<tr style="color:var(--muted,#8b93a7);text-align:right">'
    + '<th style="text-align:left;padding:3px 5px">分项</th><th>FLOPs</th><th>访存B</th>'
    + '<th>算术强度</th><th>计算时间μs</th><th>访存时间μs</th><th>取值μs</th><th style="text-align:left;padding-left:8px">归属</th></tr>';
  for (let r of rows) {
    let name=r[0], f=r[1], b=r[2], to=r[3];
    let ct = e.mfuAuto ? cmpT(f) : effT(f), mt = memT(b);
    let take = e.mfuAuto ? Math.max(ct, mt) : ct;
    let bound = e.mfuAuto ? (ct>=mt ? '计算' : '访存') : '计算(MFU)';
    let intensity = f / Math.max(b, 1e-9);
    h += '<tr style="text-align:right;border-top:1px solid var(--border,#2a2e3a)">'
      + '<td style="text-align:left;padding:3px 5px" title="'+r[4]+'">'+name+'</td>'
      + '<td>'+formatNum(f)+'</td><td>'+formatNum(b)+'</td>'
      + '<td>'+intensity.toFixed(0)+'</td>'
      + '<td'+(e.mfuAuto&&ct>=mt?' style="color:var(--accent)"':'')+'>'+ct.toExponential(2)+'</td>'
      + '<td'+(e.mfuAuto&&mt>ct?' style="color:var(--accent)"':'')+'>'+mt.toExponential(2)+'</td>'
      + '<td style="font-weight:600">'+take.toExponential(3)+'</td>'
      + '<td style="text-align:left;padding-left:8px">'+to+' ('+bound+')</td></tr>';
  }
  // a 的附加项(KV 写 + TP 延迟, 始终相加)
  let kvW = memT(q.kvWBytes);
  h += '<tr style="text-align:right;border-top:1px solid var(--border,#2a2e3a);color:var(--muted,#8b93a7)">'
    + '<td style="text-align:left;padding:3px 5px" title="KV 写无计算可 overlap（MFU 模式下视为被 overlap 不计入）">KV 写</td>'
    + '<td>—</td><td>'+formatNum(q.kvWBytes)+'</td><td>—</td><td>—</td><td>'+kvW.toExponential(2)+'</td>'
    + '<td style="font-weight:600">'+(e.mfuAuto?kvW.toExponential(3):'0(overlap)')+'</td>'
    + '<td style="text-align:left;padding-left:8px">a</td></tr>';
  h += '<tr style="text-align:right;color:var(--muted,#8b93a7)">'
    + '<td style="text-align:left;padding:3px 5px" title="TP AllReduce 固定延迟 2×layers×5μs÷chunk，网络往返无法被计算 overlap，两模式都相加">TP 固定延迟</td>'
    + '<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>'
    + '<td style="font-weight:600">'+q.tp.toExponential(3)+'</td>'
    + '<td style="text-align:left;padding-left:8px">a</td></tr>';
  h += '</table>';
  h += '<div style="margin-top:7px;padding-top:6px;border-top:1px solid var(--border,#2a2e3a);line-height:1.8">'
    + '<b>合成</b>: a = '+e.a.toFixed(3)+' μs/tok　·　b = '+e.b.toExponential(4)+' μs/tok²'
    + (e.sparseAttn ? '　·　b_idx = '+e.bIdx.toExponential(4)+' μs/tok²' : '') + '<br>';
  if (e.sparseAttn) {
    let k = e.sparseTopk, L = p.inputLen;
    let attnPos = L <= k ? 0.5*L*L : 0.5*k*k + k*(L-k);
    h += '<b>τ(pos)</b> = a + b×min(pos, '+k+') + b_idx×pos　<span style="color:var(--muted,#8b93a7)">（稀疏：attention 被 top-k 截断，Indexer 仍扫全历史）</span><br>'
      + '<b>T_prefill</b>(L='+formatNum(L)+') = a·L + b·['+(L<=k?'L²/2':'k²/2 + k(L−k)')+'] + b_idx·L²/2 = '
      + (prefillIntegral(p, L)*1000).toFixed(1)+' ms<br>'
      + '<span style="color:var(--accent2)">稀疏收益: 若按稠密(不截断)则 attention 位置项 = L²/2 = '+formatNum(0.5*L*L)
      + '，实际 = '+formatNum(attnPos)+' → 该项降 '+(0.5*L*L/Math.max(attnPos,1)).toFixed(2)+'×</span>';
  } else {
    h += '<b>τ(pos)</b> = a + b×pos　·　<b>T_prefill</b>(L='+formatNum(p.inputLen)+') = a·L + b·L²/2 = '
      + (prefillIntegral(p, p.inputLen)*1000).toFixed(1)+' ms';
  }
  h += '</div></div>';
  el.innerHTML = h;
}



// ======================== TAB 1: PARAMETERS ========================
// 模型预设按钮的 tooltip(2026-08-21): 1T 级模型的关键差异在 attention 类型而非参数量 ——
// 同为 1T, GQA 的 KV/token 是 MLA 的 4.7 倍, 对存储网/L3 建模影响近 5 倍, 必须提示。
export var MODEL_TIPS = {
  'Kimi-K2': 'Moonshot Kimi K2 (2025-07, Modified MIT): 真正的 1T MoE + MLA, 激活 32B。\n'
    + '官方 config: 61层 / hidden 7168 / kv_lora 512 / rope 64 / 64 attention heads / vocab 163840 /\n'
    + '384 experts top-8 + 1 shared / 原生 FP8(e4m3) / 128K 上下文。\n'
    + '⚠️ KV 结构与 DeepSeek-V3 完全相同 ⇒ KV/token 一字不差(BF16 68.6KB / FP8 34.3KB);\n'
    + '但 qHeads 只有 64(DS-V3 是 128) ⇒ prefill attention 计算量减半, 存储网占 TTFT 比例更高。',
  'Kimi-K2-Thinking': 'Kimi K2 Thinking (2025-11, Modified MIT): 架构与 K2 完全相同。\n'
    + '差异在 256K 上下文 + 原生 INT4 量化(QAT) + 思维链, 更贴近 Agentic 长上下文场景。\n'
    + 'INT4 只量化权重不量化 KV ⇒ KV/token 与 K2 相同; 引擎权重精度最细到 FP8,\n'
    + '按 FP8 算会高估权重显存约 2×。',
  'Ling-1T': '蚂蚁 inclusionAI Ling-1T (2025-10, MIT): 1T MoE 但用 **GQA** 而非 MLA。\n'
    + '官方 config: 80层 / hidden 8192 / 8 KV heads / head_dim 128 / 64 q heads / vocab 157184 /\n'
    + '256 experts top-8 + 1 shared / BF16 / 激活约 50B。\n'
    + '⚠️★ KV/token BF16 = 320KB, 是 Kimi K2(68.6KB) 的 **4.7 倍** —— 同样 1T 参数,\n'
    + 'GQA vs MLA 让存储网压力差近 5 倍。这说明"1T 模型"这个说法不足以确定 KV 流量:\n'
    + '做存储网/L3 带宽建模必须看 attention 类型, 不能只看参数量。',
  'GLM-5.1': '智谱 GLM-5.1 (2026-04, MIT): 744B-A40B MoE + MLA + DSA 稀疏注意力。\n'
    + '官方 config: 78层(前3 dense + 75 MoE) / hidden 6144 / kv_lora 512 / rope 64 /\n'
    + '64 attention heads / qk_nope 192 / v_head_dim 256 / vocab 154880 /\n'
    + '256 experts top-8 + 1 shared / index_topk 2048 / 200K 上下文。\n'
    + '★ 与 DeepSeek 系列(61层)的两处关键差异:\n'
    + '① 层数 78 ⇒ KV/token 比 DS-V3/K2 高 27.9%(BF16 87.8KB vs 68.6KB) ⇒ L3 流量更大;\n'
    + '② 解压式 prefill 维度和 512(DS 是 320, 1.60×) ⇒ 位置斜率 b 更高, prefill 更贵\n'
    + '  ⇒ 存储网占 TTFT 的比例被计算侧摊薄。两个效应方向相反, 需实测定净向。\n'
    + 'index_n_heads 仅 32(V3.2 是 64) ⇒ Indexer 打分开销减半, 稀疏收益更纯。',
};


export function initParamsTab(){
  let bar = $('modelPresets');
  Object.keys(models).forEach(name=>{
    let btn = document.createElement('button');
    btn.className='preset-tag'+(name===state.currentModel?' active':'');
    btn.textContent=name;
    if (MODEL_TIPS[name]) btn.title = MODEL_TIPS[name];
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
        applyEstimatedParams(); // 硬件变化 → a/b 按新规格自动重估（τ_pf 简化置 0）
      }
    };
  });
  $('pPrefixHit').oninput=()=>{updatePrefixHitFill();recalcAll();};
  // 前缀命中比例数字输入框(2026-09-02): 与滑块双向同步——输入即 clamp 写回滑块再走统一刷新;
  // 失焦(onchange)时按滑块当前值回显, 收掉越界/空串等中间态
  let _phn = $('pPrefixHitNum');
  if (_phn) {
    _phn.oninput = ()=>{
      let v = +_phn.value;
      if (isNaN(v)) return;
      v = Math.max(0, Math.min(100, Math.round(v)));
      let s = $('pPrefixHit'); if (s) s.value = String(v);
      updatePrefixHitFill(); recalcAll();
    };
    _phn.onchange = ()=>{ let s = $('pPrefixHit'); if (s) _phn.value = s.value; };
  }
  updatePrefixHitFill();
  // L2 预热命中率滑块(2026-08-28): 显示同步 + 嵌套约束(max 动态绑前缀命中比例)
  let _pwl2 = $('pPrefixWarmL2');
  if (_pwl2) _pwl2.oninput = ()=>{ updatePrefixWarmL2UI(); recalcAll(); };
  $('pAttnType').onchange=()=>{toggleMlaFields(); recalcAll();};
  toggleMlaFields();
  toggleSparseFields();   // 稀疏注意力字段初始可见性(2026-08-20)
  toggleSingleBatchHints(); // 单批模式护栏初始状态(2026-08-20)
}



export function toggleMlaFields(){
  let mla = $('pAttnType').value === 'mla';
  $('mlaFields').style.display = mla ? 'flex' : 'none';
  let m2 = $('mlaFields2'); if (m2) m2.style.display = mla ? 'flex' : 'none';
}



// 前缀命中比例滑块 UI 同步: 填充色 + 数值标签(如 "40%") 随 value 刷新
// （滑到 100% 时轨道全填充、无右侧空白；oninput 与参数导入共用此函数避免遗漏）
export function updatePrefixHitFill(){
  let el = $('pPrefixHit'); if (!el) return;
  let pct = ((+el.value - +el.min) / (+el.max - +el.min)) * 100;
  el.style.background = 'linear-gradient(to right, var(--accent) 0%, var(--accent) ' + pct + '%, var(--border) ' + pct + '%, var(--border) 100%)';
  // 数字输入框同步(2026-09-02): 滑块/导入改值时回填; 输入框聚焦(正在打字)时不覆写, 避免打断输入
  let num = $('pPrefixHitNum');
  if (num && document.activeElement !== num) num.value = el.value;
  updatePrefixWarmL2UI();   // 嵌套约束: L2 命中率上限 = 前缀命中比例
}



// L2 预热命中率滑块 UI 同步(2026-08-28 双层预热): 显示标签 + 嵌套约束 h_l2 ≤ h_l3。
// 上限动态绑前缀命中比例——L2 是 L3 命中段的子集, 超出无意义(UI 层防呆; 引擎侧 warmInto
// 用 min(nTok, ...) 再兜一道)。参数导入路径经 updatePrefixHitFill 间接触发, 无需单独挂。
export function updatePrefixWarmL2UI(){
  let el = $('pPrefixWarmL2'); if (!el) return;
  let hit = $('pPrefixHit');
  let cap = hit ? +hit.value : 100;
  el.max = String(cap);
  if (+el.value > cap) el.value = String(cap);
  let pct = ((+el.value - +el.min) / Math.max(+el.max - +el.min, 1)) * 100;
  el.style.background = 'linear-gradient(to right, var(--accent) 0%, var(--accent) ' + pct + '%, var(--border) ' + pct + '%, var(--border) 100%)';
  let val = $('pPrefixWarmL2Val'); if (val) val.textContent = el.value + '%';
}



// ======================== 参数快速导入导出（2026-08-12） ========================
// 收集基础参数页全部 input/select/textarea（checkbox 存 checked，其余存 value 字符串），
// 导出为 JSON 用于跨会话/跨机器复现；导入写回 DOM 后 recalcAll 刷新派生计算。
// 2026-08-12 v2: 覆盖调度策略——sDsl(textarea) 与 _strategyMode(dsl/js) 一并导出,
// 导入时按"先恢复模式→再写回控件→同步预取下拉"顺序恢复, 保证 DSL 与 UI 一致。
export function collectParamsJson() {
  let panel = document.getElementById('tab-params');
  let els = panel ? panel.querySelectorAll('input[id], select[id], textarea[id]') : [];
  let data = {};
  els.forEach(el => {
    if (el.id === 'paramsIo' || el.id === 'workloadSource' || el.closest('#replayPanel')) return;
    if (el.id === 'pPrefixHitNum') return; // 跳过滑块的数字镜像框(2026-09-02): 值与 pPrefixHit 恒等, 不污染导出 JSON
    data[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  data._strategyMode = (typeof state.strategyMode !== 'undefined') ? state.strategyMode : 'dsl';
  return JSON.stringify(data);
}



// 参数「元信息」抽取(2026-08-26): 为导出 HTML 提供**可读**的参数展示所需的一切。
// ★ 设计原则: **运行时从活的 DOM 读**, 绝不维护一份硬编码的 id→中文名映射表 ——
//   平台已有 80 个参数且持续增加, 手写映射表必然漂移(改了输入框忘了改表 ⇒ 导出页
//   显示旧标签, 且没有任何断言能发现)。这里读到的标签就是用户当下在页面上看到的。
// 产出: { id: {label, sec, kind, opts?} }
//   label —— 输入框旁的中文标签(含单位, 如 "SSD带宽(GB/s)")
//   sec   —— 所属分区(h2 卡片标题 / h3 子分区标题, 取最近的那个)
//   kind  —— 'num' | 'select' | 'bool' | 'text', 决定值怎么渲染
//   opts  —— select 的 value→显示文本(JSON 里存的是 "1"/"gqa" 这种原始值, 直接
//            展示完全不可读; 必须映射成 "FP8 (1B)" / "MHA / GQA")
export function buildParamMeta() {
  let panel = document.getElementById('tab-params');
  if (!panel) return {};
  let meta = {};

  // ---- 1) 建立"文档序 → 所属分区"的索引 ----
  // 平台的参数区层级是 h2(卡片) + h3(子分区), 一个字段归属**它前面最近的那个标题**。
  // 用 TreeWalker 按文档序遍历, 边走边记当前分区, 天然处理嵌套而无需解析 HTML 文本。
  let secOf = new Map();
  let cur = '其他参数';
  let walker = document.createTreeWalker(panel, NodeFilter.SHOW_ELEMENT, null);
  let node = walker.currentNode;
  while (node) {
    let tag = node.tagName;
    if (tag === 'H2' || tag === 'H3') {
      let t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) cur = t;
    } else if ((tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && node.id) {
      secOf.set(node.id, cur);
    }
    node = walker.nextNode();
  }

  // ---- 2) 找每个控件的标签文本 ----
  // 平台里有 4 种写法, 都要支持(探针实测覆盖 77/80, 余 3 个本就无 label):
  //   B. <input id=x><label for="x">文本</label>            —— checkbox 常用, 最精确
  //   C. <label ...><input id=x> 文本</label>              —— input 被 label 包裹
  //   A. <div><label>文本</label><input id=x></div>        —— 最常见
  //   D. 兜底: placeholder / title 首行
  // ★★ 同一个 <label> 只能被**一个**控件认领(claimed 集合去重):
  //    平台里有「一个 label 下挂多个控件」的结构(如「③ 形状维度」下有下拉 + 3 个
  //    checkbox + 输入框)。不去重会让这些控件全都显示同一个标签, 读者根本分不清
  //    哪一行对应哪个参数 —— 这比显示 id 更糟(是**错的**信息, 不是缺信息)。
  let claimed = new Set();
  function labelOf(el) {
    // B: for= 指向 —— 一对一绑定, 最可信, 不参与去重
    if (el.id) {
      let lf = panel.querySelector('label[for="' + el.id + '"]');
      if (lf) { let t = txt(lf); if (t) { claimed.add(lf); return t; } }
    }
    // C: 被 label 包裹 —— 也是一对一(一个 label 里只会包一个控件)
    let wrap = el.closest('label');
    if (wrap) { let t = ownText(wrap); if (t) { claimed.add(wrap); return t; } }
    // A: 同父容器里的 label, 且**尚未被别的控件认领**
    let p = el.parentElement;
    for (let hop = 0; p && hop < 2; hop++, p = p.parentElement) {
      let ls = p.querySelectorAll(':scope > label');
      for (let i = 0; i < ls.length; i++) {
        if (claimed.has(ls[i])) continue;
        let t = txt(ls[i]);
        if (t) { claimed.add(ls[i]); return t; }
      }
    }
    // D: 兜底线索 —— placeholder 通常是"如 h20x8,b300x8"这类示例, 可当标签用。
    //    ⚠️ **不要**用 title 兜底: 平台的 title 是长篇说明(如 sDsl 的 title 就是整段
    //    DSL 示例), 拿来当标签会得到一坨多行文本, 比显示 id 更糟。
    if (el.placeholder) {
      let ph = el.placeholder.replace(/\s+/g, ' ').trim();
      if (ph && ph.length <= 28) return ph;
    }
    return '';
  }
  // ★ txt: 标签文本一律用 ownText(只取直接文本子节点)。
  //   用 textContent 会把 label 内嵌控件/子元素的文本也吃进来 —— 实测把 sDsl 的
  //   DSL 全文当成了标签(显示 "ADMIT: always EVICT: lru...")。
  function txt(node) { return ownText(node); }
  // ownText: 只取元素的**直接**文本子节点 —— <label><input>按实例隔离前缀池</label>
  //   用 textContent 会把嵌套 input 的 value 也带进来, 用 ownText 才拿到纯标签文字
  function ownText(node) {
    let s = '';
    for (let i = 0; i < node.childNodes.length; i++) {
      let c = node.childNodes[i];
      if (c.nodeType === 3) s += c.nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  let els = panel.querySelectorAll('input[id], select[id], textarea[id]');
  els.forEach(function (el) {
    if (el.id === 'paramsIo') return;
    let kind = el.tagName === 'SELECT' ? 'select'
      : el.tagName === 'TEXTAREA' ? 'text'
      : el.type === 'checkbox' ? 'bool'
      : el.type === 'number' ? 'num' : 'text';
    let m = { label: labelOf(el) || el.id, sec: secOf.get(el.id) || '其他参数', kind: kind };
    if (kind === 'select') {
      m.opts = {};
      for (let i = 0; i < el.options.length; i++) {
        // 选项文本可能很长(如 suffix_race 那条带解释), 截断避免撑破卡片
        let t = (el.options[i].textContent || '').replace(/\s+/g, ' ').trim();
        m.opts[el.options[i].value] = t.length > 46 ? t.slice(0, 45) + '…' : t;
      }
    }
    // 默认值: 用于在导出页标出"哪些参数被改过"。number/text 读 defaultValue,
    // checkbox 读 defaultChecked, select 读带 selected 属性的那一项。
    if (kind === 'bool') m.def = el.defaultChecked;
    else if (kind === 'select') {
      let d = '';
      for (let i = 0; i < el.options.length; i++) if (el.options[i].defaultSelected) { d = el.options[i].value; break; }
      m.def = d;
    } else m.def = el.defaultValue;
    meta[el.id] = m;
  });
  return meta;
}


export function exportParams() {
  let box = $('paramsIo'), note = $('paramsIoNote');
  if (!box) return;
  let json = collectParamsJson();
  box.value = json;
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json); } catch(e) {}
  if (note) note.textContent = '✓ ' + Object.keys(JSON.parse(json)).length + ' 个参数已生成并复制';
  box.focus(); box.select();
}


export function importParamsFromBox() {
  let box = $('paramsIo'), note = $('paramsIoNote');
  if (!box) return;
  let data;
  try { data = JSON.parse(box.value.trim()); }
  catch(e) { if (note) note.textContent = '✗ JSON 解析失败: ' + e.message; return; }
  // 先恢复策略模式(dsl/js)——switchMode 可能改写 textarea(js 空文本加载预设), 之后再写回覆盖
  if (data._strategyMode && typeof switchMode === 'function') {
    try { switchMode(data._strategyMode === 'js' ? 'js' : 'dsl'); } catch(e) {}
  }
  let panel = document.getElementById('tab-params');
  let els = panel ? panel.querySelectorAll('input[id], select[id], textarea[id]') : [];
  let applied = 0, wroteDsl = false;
  els.forEach(el => {
    if (!(el.id in data) || el.id === 'paramsIo' || el.id === 'workloadSource' || el.closest('#replayPanel')) return;
    if (el.type === 'checkbox') el.checked = !!data[el.id];
    else el.value = String(data[el.id]);
    if (el.id === 'sDsl') wroteDsl = true;
    applied++;
  });
  // 值已非预设默认 → 清除模型/硬件/策略预设高亮（视觉同步，不触发 applyFramework 避免覆盖导入值）
  (panel ? panel.querySelectorAll('.preset-tag') : []).forEach(b => b.classList.remove('active'));
  // DSL 恢复后同步预取策略下拉(避免 sPrefetchPolicy 与 DSL 的 PREFETCH 行不一致)
  if (wroteDsl && typeof syncPrefetchSelect === 'function') {
    try { syncPrefetchSelect(); } catch(e) {}
  }
  // 命中率滑块填充色同步(导入可能改了 pPrefixHit 值)
  if (typeof updatePrefixHitFill === 'function') { try { updatePrefixHitFill(); } catch(e) {} }
  // 条件显隐/置灰同步(导入可能改了 pAttnType / pSparseAttn / pSingleBatch)——
  // 尤其 pMaxBatch/pPrefillSlots 的 disabled 状态必须按导入后的单批开关重算, 否则会残留上一次的置灰
  if (typeof toggleMlaFields === 'function') { try { toggleMlaFields(); } catch(e) {} }
  if (typeof toggleSparseFields === 'function') { try { toggleSparseFields(); } catch(e) {} }
  if (typeof toggleSingleBatchHints === 'function') { try { toggleSingleBatchHints(); } catch(e) {} }
  recalcAll();
  if (note) note.textContent = '✓ 已应用 ' + applied + ' 个参数并重算' + (wroteDsl ? '（含调度策略 DSL）' : '');
}



export function applyModel(name,el){
  state.currentModel=name;
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
  // EP 架构字段(2026-08-31): moeLayers/denseB 是模型属性 ⇒ 随预设填入;
  // epSize 是**部署**旋钮 ⇒ 不动(换模型不该重置用户的部署选择)
  if ($('pMoeLayers')) $('pMoeLayers').value = m.moeLayers||0;
  if ($('pDenseB')) $('pDenseB').value = m.denseB||0;
  $('pQHeads').value=m.qHeads||0;   // MLA 必须显式(DS-V3=128); GQA 留 0 自动推导
  // MLA 解压式 prefill 维度(2026-08-20): 0 = 回退用 headDim
  if ($('pQkNope')) $('pQkNope').value = m.qkNope||0;
  if ($('pVHeadDim')) $('pVHeadDim').value = m.vHeadDim||0;
  // 稀疏注意力(2026-08-20): 是模型架构属性 ⇒ 随预设自动勾选/取消。
  // ⚠️ 非稀疏模型必须**显式置 false**: 否则从 V3.2 切到 V3 后勾选残留, 会给稠密模型
  //    套上稀疏口径(τ 的位置项被 clamp 到 topk), prefill 时间被严重低估且无任何提示。
  if ($('pSparseAttn')) {
    $('pSparseAttn').checked = !!m.sparse;
    if (m.sparse) {
      if (m.sparseTopk  != null && $('pSparseTopk'))  $('pSparseTopk').value  = m.sparseTopk;
      if (m.idxHeads    != null && $('pIdxHeads'))    $('pIdxHeads').value    = m.idxHeads;
      if (m.idxHeadDim  != null && $('pIdxHeadDim'))  $('pIdxHeadDim').value  = m.idxHeadDim;
    }
    toggleSparseFields();
  }
  toggleMlaFields();
  // 模型有实测校准值(calibA/calibB)时优先使用(如 DS-V3 8/10 校准), 否则自动推导
  if (m.calibA != null && m.calibB != null) {
    $('pPrefillA').value = m.calibA;
    $('pPrefillB').value = m.calibB;
    let n = $('estParamsNote');
    if (n) n.textContent = '实测校准: a='+m.calibA+' · b='+(m.calibB*1e3).toFixed(2)+'e-3 · 传输=大小/带宽(2026-08-10 DS-V3×8×H20)';
    recalcAll();
  } else {
    applyEstimatedParams(); // 模型变化 → a/b 按新架构自动重估（τ_pf 简化置 0）
  }
}



// ==================== 配置可行性前置校验（2026-08-20）====================
// 动机: 引擎此前只在存储页展示 availHbm 数值, 没有对"这套配置根本跑不起来"给出显式告警——
// 例如 671B FP8 权重 671GB 放进 8×96GB=768GB 后 availHbm 只剩 ~40GB, 单请求 64K 上下文
// 就要 4.4GB, 12 并发直接溢出。用户容易在"为什么 TTFT 这么离谱"上浪费时间。
// 这里在算任何指标之前先把硬约束检查一遍, 按严重程度分级并给出可操作建议。
export function renderFeasibility(p, r){
  let box = $('feasibilityBox'); if (!box) return;
  let errs = [], warns = [], infos = [];
  let totalHbm = r.totalHbm, wBytes = r.modelWeightBytes;

  // ⓪ 多实例可行性(S2, 2026-08-20): 资源从 GPU 总数切分后, **每个实例**都必须能装下整份权重
  //    (每实例是一台独立机器, 各自加载完整模型 —— 不是把权重切给不同实例)。
  //    这是多实例最容易踩的坑: 8卡能跑 671B, 但拆成 4 实例×2卡后每实例只有 192GB, 权重装不下。
  //    引擎在 availHbm=0 时不会崩, 会跑出"看似正常"的结果 ⇒ 必须显式报错。
  let nInst = Math.max(1, Math.min(p.instances || 1, Math.max(1, p.gpus)));
  if (nInst > 1) {
    let gPer = Math.floor(p.gpus / nInst);
    let hbmPer = gPer * p.hbmPerGpu * 1e9;
    if (gPer < 1) {
      errs.push('<b>实例数超过卡数</b>：'+nInst+' 个实例 > '+p.gpus+' 张卡，每实例至少需 1 张卡。');
    } else if (wBytes >= hbmPer) {
      errs.push('<b>多实例下权重装不下</b>：每实例 '+gPer+' 卡 = '+formatBytes(hbmPer)+
        '，但权重 '+formatBytes(wBytes)+' ≥ 该容量。每个实例都要加载**完整模型**（实例间不共享权重）。'+
        '当前配置最多可开 '+Math.max(1, Math.floor(p.gpus / Math.ceil(wBytes/(p.hbmPerGpu*1e9))))+
        ' 个实例，或降低权重精度/换更小模型。');
    } else {
      let availPer = Math.max(0, hbmPer - wBytes - (gPer * 6e9 + wBytes * 0.02));
      if (availPer <= 0) {
        errs.push('<b>多实例下 KV 无空间</b>：每实例 '+gPer+' 卡（'+formatBytes(hbmPer)+
          '）装完权重与固定开销后 KV 可用 = 0。减少实例数或增加卡数。');
      } else {
        infos.push('多实例：'+nInst+' 实例 × '+gPer+' 卡，每实例 KV 可用 '+formatBytes(availPer)+
          '（DRAM/SSD/PCIe/NVMe 带宽按实例数均分）。'+
          (p.pdMode === 2 ? ' ⚠️ PD 真分离已自动降级为混合批（与多实例互斥）。' : ''));
      }
    }
  }

  // ① 权重本身是否装得下(最硬的约束)
  if (wBytes >= totalHbm) {
    errs.push('<b>权重装不下</b>：模型权重 '+formatBytes(wBytes)+' ≥ 总 HBM '+formatBytes(totalHbm)+
      '（'+p.gpus+'×'+p.hbmPerGpu+'GB）。至少需要 '+Math.ceil(wBytes/(p.hbmPerGpu*1e9))+
      ' 张卡，或改用更低权重精度（当前 '+p.weightDtype+'B/参数）。');
  } else if (r.availHbm <= 0) {
    errs.push('<b>KV 无可用空间</b>：权重 '+formatBytes(wBytes)+' + 固定开销 '+formatBytes(r.overhead)+
      ' 已占满 '+formatBytes(totalHbm)+'，KV 可用 = 0。增加卡数或降低权重精度。');
  } else if (r.availHbm < totalHbm * 0.05) {
    // 权重占比过高使 KV 空间被压缩到 <5%。但"空间小"不等于"一定溢出"——
    // 要看它能否装下当前负载(maxHbmRequests vs 并发)。否则短输入场景会误报:
    // 例如 671B FP8 只剩 35.6GB, 但 4096 tok 的请求单个仅 0.17GB → 可容 206 个, 完全够用。
    let tight = '权重 '+formatBytes(wBytes)+' 占去 '+(wBytes/totalHbm*100).toFixed(0)+
      '% 的 HBM，KV 可用仅 '+formatBytes(r.availHbm)+'（总量的 '+(r.availHbm/totalHbm*100).toFixed(1)+'%）';
    if (r.maxHbmRequests < p.concurrency) {
      warns.push('<b>KV 空间极紧</b>：'+tight+'，当前负载已超出（可容 '+r.maxHbmRequests+
        ' 个 vs 并发 '+p.concurrency+'）→ KV 将大量溢出到 L2/L3，TTFT/TPOT 由外部带宽主导。');
    } else {
      infos.push('<b>KV 空间偏小但够用</b>：'+tight+'，当前输入长度下仍可容 '+r.maxHbmRequests+
        ' 个请求（并发 '+p.concurrency+'）。注意上调输入长度或并发时容易触顶。');
    }
  }

  // ② 单请求 KV 是否超出可用 HBM(即便并发=1 也放不下)
  if (r.availHbm > 0 && r.effPerReqKv > r.availHbm) {
    errs.push('<b>单请求 KV 超容</b>：一个请求需 '+formatBytes(r.effPerReqKv)+
      '（输入 '+formatNum(p.inputLen)+' tok，已扣前缀命中）> HBM 可用 '+formatBytes(r.availHbm)+
      '。即使并发=1 也无法全驻留' + (p.tieredKv ? '，将持续依赖 L2/L3 换入换出。' : '；建议开启「分层KV缓存」或缩短输入长度。'));
  }

  // ③ 并发是否超过 HBM 容量(未开分层时是硬上限)
  if (r.availHbm > 0 && r.maxHbmRequests < p.concurrency) {
    let msg = '<b>并发超出 HBM 容量</b>：HBM 仅容 '+r.maxHbmRequests+' 个请求，当前设 '+p.concurrency+
      ' 个（需 '+formatBytes(r.totalKvDemand)+' vs 可用 '+formatBytes(r.availHbm)+'）。';
    if (p.tieredKv) {
      let fastCap = r.availHbm + r.dramTotal;
      if (r.totalKvDemand > fastCap + r.ssdTotal) {
        errs.push(msg + ' 且 <b>三层总容量('+formatBytes(fastCap + r.ssdTotal)+')也不够</b> —— 请求会被准入拒绝或大量淘汰。');
      } else if (r.totalKvDemand > fastCap) {
        warns.push(msg + ' 分层已开：超出部分落到 L3(SSD)，TTFT 将受 SSD 带宽（'+p.ssdBW+'GB/s）主导。');
      } else {
        infos.push(msg + ' 分层已开：超出部分由 L2(DRAM '+formatBytes(r.dramTotal)+') 承接。');
      }
    } else {
      errs.push(msg + ' <b>未开启分层KV缓存</b> → 超出的请求将被准入拒绝/淘汰，完成数会显著低于请求数。建议开启分层或把并发降到 '+r.maxHbmRequests+'。');
    }
  }

  // ④ 负载与容量的稳态一致性(Little 定律)
  if (r.littleConcurrency > p.concurrency * 2 && p.qps > 0) {
    warns.push('<b>过载</b>：按 Little 定律 稳态并发需 '+r.littleConcurrency.toFixed(0)+
      '（QPS '+p.qps+' × 延迟 '+(r.estLatency*1000).toFixed(0)+'ms），远超设定的 '+p.concurrency+
      ' —— 队列会无界增长，TTFT 主要由排队构成。降 QPS 或提并发上限。');
  }

  // ⑤ 仿真窗口是否足够
  let estWall = p.concurrency > 0 ? r.estLatency * Math.max(1, p.concurrency / Math.max(p.maxBatch,1)) : r.estLatency;
  if (estWall > p.simMaxTime) {
    warns.push('<b>仿真窗口可能不足</b>：粗估排水需 ~'+estWall.toFixed(0)+'s > 窗口上限 '+p.simMaxTime+
      's，结果可能被截断（完成数 < 请求数）。建议调大「仿真窗口上限」。');
  }

  // ⑥ MLA 必填项提醒
  if (p.attn === 'mla' && p.qHeads <= 0) {
    warns.push('<b>MLA 未填 Q 头数</b>：自动按 hidden/headDim = '+
      Math.round(p.hidden/Math.max(p.headDim||128,1))+' 推导，而 DeepSeek-V3 实际有 128 个 head —— '+
      'attention 计算量会低估约 2.3×，请显式填写「Q头数」。');
  }

  if (!errs.length && !warns.length && !infos.length) {
    box.innerHTML = '<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.35);border-radius:6px;'+
      'padding:7px 10px;margin-bottom:8px;font-size:.73rem;color:#4ade80">✓ 配置可行性检查通过：权重与 KV 均可容纳，负载与容量匹配。</div>';
    return;
  }
  let h = '';
  let blk = (items, bg, bd, col, icon, title) => {
    if (!items.length) return '';
    return '<div style="background:'+bg+';border:1px solid '+bd+';border-radius:6px;padding:7px 10px;'+
      'margin-bottom:6px;font-size:.73rem;color:'+col+';line-height:1.7">'+
      '<b>'+icon+' '+title+'</b><ul style="margin:3px 0 0;padding-left:18px;font-size:.73rem">'+
      items.map(t=>'<li>'+t+'</li>').join('')+'</ul></div>';
  };
  h += blk(errs,  'rgba(239,68,68,.08)',  'rgba(239,68,68,.4)',  '#f87171', '⚠️', '配置不可行 / 结果不可信');
  h += blk(warns, 'rgba(245,158,11,.08)', 'rgba(245,158,11,.4)', '#fbbf24', '⚡', '需注意');
  h += blk(infos, 'rgba(99,102,241,.08)', 'rgba(99,102,241,.4)', '#a5b4fc', 'ℹ️', '说明');
  box.innerHTML = h;
}



export function updateQuickResults(){
  let p=getParams(), r=calcAll(p);
  renderFeasibility(p, r);
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
    {l:'TP/EP通信开销/步',v:(r.commOverhead*1000).toFixed(2)+' ms',c:r.commOverhead>r.passTime*0.1?'orange':'green'},
    {l:'稳态并发(Little定律)',v:r.littleConcurrency.toFixed(0)+' vs 请求数'+p.concurrency,c:littleOk?'green':'orange'},
  ].map(d=>'<div class="result-item"><div class="rl">'+d.l+'</div><div class="rv '+d.c+'">'+d.v+'</div></div>').join('');
  setFormula('formulaQuick',
    '<b>📐 核心公式（Roofline 分相建模）</b><br>'+
    '• KV/token: '+(p.attn==='mla'
      ? '<code>MLA: L×(kvLora+rope)×dt = '+p.layers+'×('+(p.kvLora+p.ropeDim)+')×'+p.dtypeBytes+' = '+formatBytes(r.kvPerToken)+'</code>'
      : '<code>2×L×kvHeads×headDim×dt = '+formatBytes(r.kvPerToken)+'</code>')+'<br>'+
    '• 单请求KV含碎片: <code>⌈S/blockSize⌉×blockSize×kv/tok = '+r.blocksPerReq+'块×'+formatBytes(r.blockBytes)+' = '+formatBytes(r.perRequestKv)+'</code>（碎片 '+r.fragPct.toFixed(1)+'%）<br>'+
    '• 前缀抵扣: <code>'+(p.prefixHit*100).toFixed(0)+'% × S<sub>in</sub> × kv/tok = '+formatBytes(r.prefixSavedPerReq)+'/请求</code> → 有效占用 '+formatBytes(r.effPerReqKv)+'（命中率=可复用前缀token占总输入的比例；前缀组结构[12/22/35/48]%决定分布，单请求覆盖量 = 命中率×组比例×S<sub>in</sub>，期望总量 = 命中率×总输入）<br>'+
    '• Prefill(位置感知): <code>τ(i)=a+b·i = '+p.prefillA+'+'+p.prefillB+'·i μs/tok</code> → T<sub>prefill</sub> = a·L + b·L²/2 = '+(r.ttftEst*1000).toFixed(0)+'ms（含 TP通信）<br>'+
    '&nbsp;&nbsp;<b>时间合成口径</b>：'+(p.mfuAuto
      ? '<b style="color:var(--accent2)">Roofline 自动判瓶颈</b>（MFU 留空）—— 每项独立取 <code>max(计算时间, 访存时间)</code>，<b>不求和</b>；计算侧用峰值算力 '+formatNum(p.tflops*1e12*p.gpus)+' FLOPS，访存侧用 HBM '+(p.hbmBW*p.gpus).toFixed(1)+'TB/s，ridge point = '+(p.tflops*1e12*p.gpus/(p.hbmBW*1e12*p.gpus)).toFixed(1)+' FLOP/B'
      : '<b style="color:var(--accent2)">MFU 计算瓶颈模式</b>（MFU='+(p.mfu*100).toFixed(0)+'%）—— 时间 = <code>FLOPs ÷ (峰值算力×MFU)</code>，<b>完全忽略访存</b>（权重读/KV读/KV写全部视为被计算 overlap）')+'<br>'+
    '&nbsp;&nbsp;物理依据：chunked-prefill 下 flash-attention 的 C='+p.chunkSize+' 个 query 共享一次 KV 读 → attention 算术强度达 10⁴ FLOP/B 量级 ≫ ridge point，prefill 是彻底的<b>计算瓶颈</b>，访存被 overlap。（旧版把计算+访存时间相加，高估 attention 位置成本约 2.3×）<br>'+
    '• Decode(<b>结构性访存瓶颈</b>，始终 Roofline 取 max): <code>passTime = max[(权重+批次KV)/HBM带宽 + 每请求开销, 2×激活参数×B/算力] + TP通信 = '+(r.passTime*1000).toFixed(2)+' ms</code>（访存项 '+(r.passMemTime*1000).toFixed(2)+'ms vs 算力项 '+(r.passCmpTime*1000).toFixed(2)+'ms → 瓶颈在<b>'+r.decodeBound+'</b>）<br>'+
    '&nbsp;&nbsp;注：decode 每 token 读全部激活权重却只做 2×P<sub>act</sub> FLOP，算术强度仅 ~'+(2*r.activatedParams/Math.max(r.modelWeightBytes*r.decodeWeightRatio/Math.max(1,Math.min(p.maxBatch,p.concurrency)),1)).toFixed(1)+' FLOP/B ≪ ridge point → MFU 的"只算计算时间"规则<b>不适用于 decode</b>（否则 TPOT 失真 ~25×）<br>'+
    '• TP通信(AllReduce): <code>2×L×(2(TP−1)/TP × B×hidden×2B)/NVLink + 2×L×5μs</code>'+((r.epSize||1)>1&&r.moeLayers>0?' + EP通信(AllToAll): <code>2×L_moe×B×hidden×2B×系数/NVLink + 2×L_moe×5μs</code>':'')+' = <code>'+(r.commOverhead*1000).toFixed(2)+' ms/步</code>（TP='+r.tpSize+((r.epSize||1)>1?' · EP='+r.epSize+'(L_moe='+r.moeLayers+')':'')+'，占 passTime '+(r.commOverhead/r.passTime*100).toFixed(0)+'%）<br>'+
    '• Little定律: <code>稳态并发 = QPS × 估计延迟('+r.estLatency.toFixed(2)+'s) = '+r.littleConcurrency.toFixed(0)+'</code>'+(littleOk?' ✓ 与请求数基本一致':' ⚠ 稳态并发与请求数('+p.concurrency+')偏差较大，仿真中请求将排队或空转')
  );
  updateTierDemand();
}



// ======================== L2/L3 资源需求估算 ========================
// 目标：回答"当前输入场景需要多大的 L2(DRAM)/L3(SSD) 容量与带宽"
// ① 容量（水注法）：总KV需求 D=并发×有效生命周期KV → 先填HBM → 溢出×下沉量化比填L2 → 再溢出填L3
// ② 读带宽（decode 稳态 Roofline）：每次前向读整个批次 KV，
//    按 L2/L3 的物理驻留占比分摊 → BW_T读 = decode吞吐(tok/s) × 平均生命周期KV/请求 × 驻留占比
// ③ 写带宽（prefill 稳态）：新KV生成速率 kvGen = prefillTps×kvPerToken × 驻留占比；
//    稳态下换出速率=生成速率，预取换入≈换出 → 链路总需求 = 读 + 2×写
// ④ 对比配置：L2 有效 = min(PCIe/C2C, DRAM介质)，L3 走 NVMe(有效带宽，已含 page_size 调度开销)
export function updateTierDemand(){
  let grid=$('tierDemandGrid'); if(!grid) return;
  let p=getParams(), r=calcAll(p);
  let tstat=$('tieredKvStatus');
  if(tstat) tstat.textContent = p.tieredKv ? '开' : '关（KV强制驻留HBM，放不下即排队）';
  // ---------- ① 容量：水注法（逻辑字节 → 物理字节） ----------
  let demand = r.totalKvDemand;                                 // 逻辑字节 = 并发 × 有效生命周期KV
  let overflow1 = Math.max(0, demand - r.availHbm);             // 超出 HBM 的逻辑字节
  let capL2Logical = p.tierQuant > 0 ? r.dramTotal / p.tierQuant : 0; // DRAM 按物理容量折算可容纳的逻辑字节
  let inDramLogical = Math.min(overflow1, capL2Logical);        // 逻辑上可放进 L2 的量
  let inSsdLogical  = Math.max(0, overflow1 - capL2Logical);    // 逻辑上必须放 L3 的量
  let l2Need = inDramLogical * p.tierQuant;                     // L2 物理字节需求
  let l3Need = inSsdLogical  * p.tierQuant;                     // L3 物理字节需求
  let physTotal = Math.max(1, (demand - overflow1) + l2Need + l3Need); // 总物理驻留（HBM 不压缩 + L2/L3 压缩）
  let fL2 = l2Need / physTotal, fL3 = l3Need / physTotal;       // 读带宽来源占比（按物理驻留）
  // ---------- ② ③ 带宽：Roofline 稳态 ----------
  let decodeRate = r.decodeTpsTotal;                            // decode 总吞吐 tok/s（批次内每请求每前向产1 token）
  let l2ReadBW = decodeRate * r.avgLifetimeKv * fL2;            // L2 读：每前向读批次 KV × 驻留占比
  let l3ReadBW = decodeRate * r.avgLifetimeKv * fL3;
  let writeRate = r.kvGenSpeed;                                 // prefill 新 KV 生成速率 B/s
  let l2WriteBW = writeRate * fL2;                              // L2 写（稳态≈换出速率）
  let l3WriteBW = writeRate * fL3;
  let l2Total = l2ReadBW + l2WriteBW + l2WriteBW;               // 读 + 换出 + 预取换入
  let l3Total = l3ReadBW + l3WriteBW + l3WriteBW;
  let l2Cfg = effL2LinkBW(p);                                // L2 有效带宽 = min(PCIe/C2C单卡×f读通道, DRAM介质)——f=gpus/attnTp(EP>1 时读复制消失 attnTp=1)
  let pcieCfg = l2Cfg * 1e9, ssdCfg = p.ssdBW * 1e9;
  let uL2 = l2Total / Math.max(pcieCfg, 1) * 100;
  let uL3 = l3Total / Math.max(ssdCfg, 1) * 100;
  let cl2Cap = inSsdLogical > 0 ? 'red' : (l2Need > 0 ? 'orange' : 'green');  // 溢出到L3 ⇒ L2已饱和
  let cl3Cap = l3Need > r.ssdTotal ? 'red' : (l3Need > 0 ? 'orange' : 'green');
  grid.innerHTML = [
    {l:'L2(DRAM) 容量需求', v:l2Need>0?formatBytes(l2Need):'0 (HBM足够)', c:cl2Cap},
    {l:'L3(SSD) 容量需求', v:l3Need>0?formatBytes(l3Need):'0', c:cl3Cap},
    {l:'L2 读带宽(decode)', v:formatRate(l2ReadBW), c:l2ReadBW>0?'orange':'green'},
    {l:'L2 写带宽(prefill)', v:formatRate(l2WriteBW), c:l2WriteBW>0?'orange':'green'},
    {l:'L2 总链路需求', v:formatRate(l2Total)+' · '+uL2.toFixed(0)+'%', c:uL2>100?'red':(uL2>50?'orange':'green')},
    {l:'L3 读带宽(decode)', v:formatRate(l3ReadBW), c:l3ReadBW>0?'orange':'green'},
    {l:'L3 写带宽(prefill)', v:formatRate(l3WriteBW), c:l3WriteBW>0?'orange':'green'},
    {l:'L3 总链路需求', v:formatRate(l3Total)+' · '+uL3.toFixed(0)+'%', c:uL3>100?'red':(uL3>50?'orange':'green')},
    {l:'L2 有效带宽(min链路,介质)', v:l2Cfg+' GB/s', c:'accent'},
    {l:'L3 链路配置(NVMe有效)', v:p.ssdBW+' GB/s', c:'accent'},
  ].map(d=>'<div class="result-item"><div class="rl">'+d.l+'</div><div class="rv '+d.c+'">'+d.v+'</div></div>').join('');
  // ---------- 图表 ----------
  let ch=initChart('chartTierDemandBW');
  ch.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(2)+' GB/s'},
    legend:{data:['decode读','prefill写(换出)','预取换入','配置带宽'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:64,right:24,top:34,bottom:24},
    xAxis:{type:'category',data:['L2 (DRAM)','L3 (SSD)'],axisLabel:{color:'#e4e4e7',fontSize:11}},
    yAxis:{type:'value',name:'带宽 (GB/s)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'decode读',type:'bar',stack:'bw',barMaxWidth:42,data:[+(l2ReadBW/1e9).toFixed(2),+(l3ReadBW/1e9).toFixed(2)],itemStyle:{color:'#6c63ff'}},
      {name:'prefill写(换出)',type:'bar',stack:'bw',barMaxWidth:42,data:[+(l2WriteBW/1e9).toFixed(2),+(l3WriteBW/1e9).toFixed(2)],itemStyle:{color:'#fb923c'}},
      {name:'预取换入',type:'bar',stack:'bw',barMaxWidth:42,data:[+(l2WriteBW/1e9).toFixed(2),+(l3WriteBW/1e9).toFixed(2)],itemStyle:{color:'#34d399'}},
      {name:'配置带宽',type:'line',data:[l2Cfg,p.ssdBW],symbol:'circle',symbolSize:7,
        itemStyle:{color:'#f87171'},lineStyle:{color:'#f87171',type:'dashed',width:2},
        label:{show:true,formatter:d=>d.value+' GB/s',color:'#f87171',fontSize:9}}
    ]
  });
  let ch2=initChart('chartTierDemandCap');
  ch2.setOption({
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(1)+' GB'},
    legend:{data:['需求容量','配置容量'],top:0,textStyle:{color:'#9ca0b0'}},
    grid:{left:64,right:24,top:34,bottom:24},
    xAxis:{type:'category',data:['L2 (DRAM)','L3 (SSD)'],axisLabel:{color:'#e4e4e7',fontSize:11}},
    yAxis:{type:'value',name:'容量 (GB)',nameTextStyle:{color:'#9ca0b0'},axisLabel:{color:'#9ca0b0'}},
    series:[
      {name:'需求容量',type:'bar',barMaxWidth:34,data:[+(l2Need/1e9).toFixed(1),+(l3Need/1e9).toFixed(1)],
        itemStyle:{color:'#6c63ff'},
        label:{show:true,position:'top',color:'#6c63ff',fontSize:9,formatter:d=>d.value>0?d.value.toFixed(1):'0'}},
      {name:'配置容量',type:'bar',barMaxWidth:34,data:[p.dram,+(p.ssd*1000).toFixed(0)],
        itemStyle:{color:'rgba(248,113,113,.55)'},
        label:{show:true,position:'top',color:'#f87171',fontSize:9,formatter:d=>d.value.toFixed(0)}}
    ]
  });
  // ---------- 公式说明 ----------
  let satNote = (p.concurrency > r.maxHbmRequests)
    ? '<span style="color:var(--accent4)">并发已超出 HBM 容纳上限 → 必须启用 L2/L3</span>'
    : '<span style="color:var(--accent2)">并发未超出 HBM 容纳上限 → L2/L3 需求为 0（全部驻留 HBM）</span>';
  setFormula('formulaTierDemand',
    '<b>📐 L2/L3 需求计算方法（水注法容量 + Roofline 稳态带宽）</b><br>'+
    '① <b>容量（水注法）</b>: 总KV需求 <code>D = 并发×有效生命周期KV = '+p.concurrency+'×'+formatBytes(r.effLifetimeKv)+' = '+formatBytes(demand)+'</code><br>'+
    '&nbsp;&nbsp;先填 HBM（可用 <code>'+formatBytes(r.availHbm)+'</code>）→ 溢出 <code>'+formatBytes(overflow1)+'</code> 按下沉量化比 '+p.tierQuant+' 压缩后填 L2 → 再溢出填 L3<br>'+
    '&nbsp;&nbsp;<code>L2需求 = min(溢出, DRAM逻辑容量)×量化 = '+formatBytes(l2Need)+'</code> · <code>L3需求 = max(0, 溢出−DRAM逻辑容量)×量化 = '+formatBytes(l3Need)+'</code> · '+satNote+'<br>'+
    '② <b>读带宽（decode 稳态）</b>: 每前向读整批 KV → <code>BW<sub>读</sub> = decode吞吐(tok/s)×平均生命周期KV/请求×驻留占比</code><br>'+
    '&nbsp;&nbsp;<code>= '+formatNum(decodeRate)+' × '+formatBytes(r.avgLifetimeKv)+' × f<sub>L2</sub>('+(fL2*100).toFixed(1)+'%) = '+formatRate(l2ReadBW)+'</code>（L3 同理 '+formatRate(l3ReadBW)+'，f<sub>L3</sub>='+(fL3*100).toFixed(1)+'%）<br>'+
    '③ <b>写带宽（prefill 稳态）</b>: 新KV生成速率 <code>kvGen = prefillTps×kv/tok = '+formatRate(r.kvGenSpeed)+'</code> × 驻留占比；稳态换出=生成、预取换入≈换出<br>'+
    '&nbsp;&nbsp;<code>链路总需求 = 读+换出+换入 = '+formatRate(l2Total)+' (L2) / '+formatRate(l3Total)+' (L3)</code> — 对应仿真 passTime 中 ΣKV<sub>L2</sub>/min(PCIe,DRAM) 与 ΣKV<sub>L3</sub>/NVMe 项<br>'+
    '④ <b>对比配置</b>: L2 有效带宽 = <code>min(PCIe/C2C '+p.pcieBW+'GB/s×f='+(p.gpus/l2AttnTp(p))+', DRAM介质 '+p.dramBW+'GB/s) = '+l2Cfg+' GB/s</code>（GPU 读 L2 受链路与介质较小者限制；f=独立读通道数=gpus/attnTp'+(l2AttnTp(p)===1&&(p.epSize||1)>1?', EP>1 读复制消失 ⇒ f='+p.gpus:'')+'；默认介质≫链路故由 PCIe 决定，利用率 '+uL2.toFixed(0)+'%）· L3 走 NVMe（<code>'+p.ssdBW+' GB/s</code>，利用率 '+uL3.toFixed(0)+'%，该值为有效带宽已含 page_size 调度开销：sglang mooncake page1≈1.05GB/s → page64≈27GB/s）<br>'+
    '&nbsp;&nbsp;利用率 &gt;100% ⇒ 该层成为 decode 瓶颈（TPOT 上升）；容量不足 ⇒ 请求排队等待 KV 释放<br>'+
    '&nbsp;&nbsp;<b>说明</b>: 本卡片为策略无关的需求上界（规划基准）；<b>考虑调度策略的需求</b>（实测 L2/L3 带宽分位、容量峰值、瓶颈归因）在「策略仿真」结果中展示'
  );
}



export function recalcAll(){
  document.dispatchEvent(new Event('simulation-input-change'));
  updateQuickResults();
  let active=document.querySelector('.tab-panel.active');
  if(active) refreshActiveTab();
}
