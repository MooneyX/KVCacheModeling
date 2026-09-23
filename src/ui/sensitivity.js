import { gi, gv, $ } from "../adapters/browser/dom.js";
import { getCurrentStrategy } from "./strategy.js";
import { hwPresets } from "../core/presets.js";
import { SENS_LEVELS, sensParamUnit, SENS_METRIC_LABEL, SENS_PARAM_LABEL, isTtftStack, TTFT_STACK_PARTS } from "../application/labels.js";
import { setSensExportEnabled } from "./export.js";
import { parseRangeOrList, buildSensPoints, applyParamVal, sortedJson } from "../application/sweep.js";
import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";
import { initChart } from "./charts.js";
import { collectParamsJson, buildParamMeta } from "./parameters.js";
import { collectSensSnapshot } from "./snapshots.js";
import { executeBatch, serverVersion } from '../execution/browser/client.ts';
import { allowSyntheticAnalysis, updateRunControls } from './replay.js';



// ======================== 角色无关点云 2026-08-27 ========================
// baseValsOf: 读出**全部可扫描参数**当前在页面上的基准值(与 SENS_PARAM_LABEL 的键一一对应)。
// 用途: 点云的 params 必须是**完整**的参数组合 —— 只记被扫描的那 1~3 个维度不够, 因为
// 跨批次比较时需要知道"这个点的 qps 是多少"才能判断两批次的点是否真的同一个点。
// ⚠️ 单位口径与 sensParamUnit / SENS_LEVELS 保持一致(百分比参数记 0~100 的整数而非小数),
//    否则透视面板显示 "0.4%" 而档位 chip 是 "40%", 两边对不上。
export function baseValsOf() {
  let out = {};
  try {
    out.prefix_hit = gi('pPrefixHit');
    out.prefix_warm_l2 = gi('pPrefixWarmL2');
    out.ssd_bw = gv('pSsdBW');
    out.input_len = gi('pInputLen');
    out.qps = gv('pQps');
    out.concurrency = gi('pConcurrency');
    // 策略侧参数: 引擎内是 0~1 小数, 这里统一换算回百分比整数
    let st = (typeof getCurrentStrategy === 'function') ? getCurrentStrategy() : null;
    if (st) {
      if (st.eviction && st.eviction.hbm_evict_threshold != null) out.evict_threshold = Math.round(st.eviction.hbm_evict_threshold * 100);
      if (st.prefetch && st.prefetch.prefetch_threshold != null) out.prefetch_threshold = Math.round(st.prefetch.prefetch_threshold * 100);
      if (st.batching && st.batching.max_batch_size != null) out.max_batch_size = st.batching.max_batch_size;
    }
    // GPU 预设(2026-08-27 改判定): 它没有下拉框, 只有一排按钮。
    // ⚠️ 原实现读 `.preset-tag.active` —— 但**导入参数不会给按钮加 active 类**(导入只写
    //    输入框), 于是"导入参数 → 跑扫描"这条最常用的路径永远读不到 gpu_preset。
    // ⇒ 改为**反查**: 拿当前硬件字段去比对 hwPresets, 完全吻合则认定是该预设。
    //    这与"用户是否点过按钮"无关, 对导入路径同样有效。
    //    比对 tflops/hbm/hbmBW/gpus 四项即可唯一确定(九款预设两两不同)。
    try {
      if (typeof hwPresets !== 'undefined' && hwPresets) {
        let cur = { gpus: gi('pGpuCount'), hbm: gv('pHbm'), hbmBW: gv('pHbmBW'), tflops: gv('pTflops') };
        for (let pk in hwPresets) {
          let h = hwPresets[pk];
          if (!h) continue;
          if (Number(h.gpus) === cur.gpus && Number(h.hbm) === cur.hbm
            && Number(h.hbmBW) === cur.hbmBW && Number(h.tflops) === cur.tflops) {
            out.gpu_preset = pk; break;
          }
        }
      }
      // 反查不中(手改过硬件字段, 不对应任何预设) ⇒ 退回按钮 active 态; 仍取不到就留空,
      // 导出页会把该参数整行省略(而不是显示一个错的预设名)
      if (!out.gpu_preset) {
        let hb = $('hwPresets');
        if (hb && hb.querySelectorAll) {
          let tags = hb.querySelectorAll('.preset-tag') || [];
          for (let i = 0; i < tags.length; i++) {
            let t = tags[i];
            let act = t.classList && t.classList.contains && t.classList.contains('active');
            if (act) { out.gpu_preset = (t.dataset && t.dataset.hw) || (t.getAttribute && t.getAttribute('data-hw')) || ''; break; }
          }
        }
      }
      if (!out.gpu_preset) delete out.gpu_preset;
    } catch (e) { delete out.gpu_preset; }
  } catch (e) {}
  return out;
}



// 扫描/对比参数互斥提示（运行时自动忽略相同项，UI 上也即时标注）
export function guardCompareParam() {
  let sp = $('sSweepParam').value, cp = $('sSweepCompareParam').value;
  if (cp && cp === sp) { $('sSweepCompareParam').value = ''; }
}


// 形状维度控件联动(2026-08-25; 2026-08-27 开放为任意参数): 切换绑定对象时显示对应输入区,
// 并做**三方互斥**(横轴/颜色/形状必须绑不同参数, 否则同一变量控两个视觉通道, 图例自相矛盾
// 且白跑 N² 次仿真) ⇒ 冲突时形状回退为 'prefetch'(唯一不与扫描参数域重叠的选项)。
// 档位输入框在切换参数时自动填该参数的默认档位 —— 否则会拿 GPU 的 key 去当数值参数档位。
export function toggleShapeDim() {
  let sd = $('sShapeDim') ? $('sShapeDim').value : 'prefetch';
  let sp = $('sSweepParam') ? $('sSweepParam').value : '';
  let cp = $('sSweepCompareParam') ? $('sSweepCompareParam').value : '';
  // prefetch 不在扫描参数域内, 恒不冲突; 其余任意参数都要与横轴/颜色比对
  if (sd !== 'prefetch' && (sd === sp || sd === cp)) {
    if ($('sShapeDim')) $('sShapeDim').value = 'prefetch';
    sd = 'prefetch';
  }
  let pfBox = $('sShapePfBox'), valBox = $('sShapeVals');
  if (pfBox) pfBox.style.display = (sd === 'prefetch') ? 'flex' : 'none';
  if (valBox) {
    valBox.style.display = (sd === 'prefetch') ? 'none' : '';
    // 切换参数后原档位对新参数无意义(GPU key ↔ 数值) ⇒ 自动换成新参数的默认档位。
    // 用 _shapeDimAt 记住上次绑定对象, 只在**真的切换**时覆盖, 避免每次联动都擦掉用户手填的值。
    if (sd !== 'prefetch' && valBox._shapeDimAt !== sd) {
      let dv = SENS_LEVELS[sd] || [];
      valBox.value = dv.join(',');
      valBox._shapeDimAt = sd;
    }
    if (sd === 'prefetch') valBox._shapeDimAt = null;
  }
}



export async function runSensitivity() {
  if (!allowSyntheticAnalysis('sensitivityStatus') || state.sensitivityRunning) return;
  state.sensitivityRunning = true;
  updateRunControls();
  try { await runSensitivityRemote(); }
  catch (error) {
    setSensExportEnabled(false);
    $('chartSensitivity').textContent = error.message;
  }
  finally {
    state.sensitivityRunning = false;
    const button = $('btnRunSens');
    if (button) button.textContent = '运行敏感性分析';
    updateRunControls();
  }
}

async function runSensitivityRemote() {
  if (state.strategyMode === 'js') throw new Error('服务器暂不支持 JavaScript 策略，请选择 DSL。');
  // 按 id 取运行按钮(2026-08-25): 原先用 '#sensitivityPanel .btn' 取面板内第一个 .btn,
  // 依赖 DOM 顺序 —— 一旦有人在其上方加按钮就会误禁用别的按钮。
  let btn = $('btnRunSens') || document.querySelector('#sensitivityPanel .btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 分析中...'; }
  // 新扫描开始 ⇒ 旧图即将被进度提示覆盖(chartEl.innerHTML 被替换会销毁 echarts 实例),
  // 此时导出会取到已销毁的画布, 故先禁用导出, 由 paint() 成功后重新解锁。
  setSensExportEnabled(false);

  let baseStrategy = getCurrentStrategy(); // 敏感性基准 = 当前配置的策略（与甘特图/运行当前一致）
  let param = $('sSweepParam').value, metric = $('sSweepMetric').value;
  // 扫描档位：优先「扫描范围(起,止,步长 或 逗号列表)」，空则用参数默认档位
  let values = null;
  let rangeRaw = ($('sSweepRange') ? $('sSweepRange').value : '').trim();
  if (rangeRaw) {
    let rv = parseRangeOrList(rangeRaw, param);
    if (rv.length) values = rv;
  }
  if (!values) {
    if (param === 'max_batch_size') values = [1,2,4,8,16,32,64,128,256];
    else if (param === 'prefix_hit') values = [0,10,20,30,40,50,60,70,80,90];
    else if (param === 'ssd_bw') values = [50,100,150,200,250,300,350,400]; // 8卡聚合带宽收益区间(2026-08-18)
    else if (param === 'input_len') values = [2048,4096,8192,16384,32768,65536];
    else if (param === 'qps') values = [0.1,0.3,1,3,8];
    else if (param === 'concurrency') values = [8,16,32,64,128,256];
    else if (param === 'gpu_preset') values = SENS_LEVELS.gpu_preset.slice();  // 非数值维度
    else values = [10,20,30,40,50,60,70,80,90];
  }
  let labels = values.map(v => sensParamUnit(param, v));

  let metricLabel = SENS_METRIC_LABEL[metric];
  let paramLabel = SENS_PARAM_LABEL[param];

  // ===== ③ 第三维 = 节点形状(2026-08-25 改造: 由「固定预取策略」改为「可绑定」) =====
  // 动机: 原设计把形状硬编码给预取策略, 于是"颜色+形状"两个**非策略**自变量无法同时表达
  // (例: 横轴L3带宽 × 颜色输入长度 × 形状GPU)。现改为下拉选择绑定对象:
  //   'prefetch'(默认, 与改造前**逐位一致**) | 'gpu_preset'
  // 形状维度的取值列表统一叫 shapeList, 符号统一由 SHAPE_SYMBOLS 按序号分配。
  // ⚠️ 形状与颜色必须绑不同东西: 若 shapeDim === compareParam 则形状降级为无(否则同一变量
  //    既控颜色又控形状, 图例自相矛盾且白跑 N² 次仿真)。
  const SHAPE_SYMBOLS = ['circle', 'square', 'triangle', 'diamond', 'roundRect', 'pin'];
  let shapeDim = ($('sShapeDim') ? $('sShapeDim').value : 'prefetch') || 'prefetch';
  const PF_SYMBOL = { wait_complete: 'circle', best_effort: 'square', race: 'triangle' };
  const PF_TYPE = { wait_complete: 'none', best_effort: 'best_effort', race: 'race' };

  let prefetchList = [];
  if ($('sPfWait') && $('sPfWait').checked) prefetchList.push('wait_complete');
  if ($('sPfBest') && $('sPfBest').checked) prefetchList.push('best_effort');
  if ($('sPfRace') && $('sPfRace').checked) prefetchList.push('race');

  // 对比参数（第二维=颜色）：显式下拉选择，档位从输入框读取（自动填充默认，可编辑）
  // 注意: 此块必须在 shapeList 定案**之前**求值 —— 形状要和颜色做互斥判定。
  let compareParam = ($('sSweepCompareParam') ? $('sSweepCompareParam').value : '') || null;
  let compareVals = [];
  if (compareParam) {
    if (compareParam === param) compareParam = null; // 与扫描参数相同 → 回退单参数
    else {
      let cmpRaw = ($('sSweepCompare') ? $('sSweepCompare').value : '').trim();
      compareVals = cmpRaw ? parseRangeOrList(cmpRaw, compareParam) : (SENS_LEVELS[compareParam] || []);
      if (!compareVals.length) compareVals = SENS_LEVELS[compareParam] || [];
    }
  }

  // 形状维度定案: shapeList = 取值列表, shapeLabelOf = 图例文案, shapeSymbolOf = 符号
  // 2026-08-27: 由「只支持 prefetch/gpu_preset」开放为**任意扫描参数**。
  // ⇒ 形状与横轴/颜色是完全对等的第三个自变量, 例如「横轴 L3带宽 × 颜色 前缀命中率 × 形状 输入长度」。
  // 互斥: shapeDim 与 param/compareParam 撞车时降级为无形状维(不静默跑 N² 次重复仿真)。
  let shapeList = [], shapeLabel = '';
  if (shapeDim === 'prefetch') {
    shapeList = prefetchList;
    shapeLabel = '预取策略';
  } else if (shapeDim && shapeDim !== param && shapeDim !== compareParam && SENS_PARAM_LABEL[shapeDim]) {
    let shRaw = ($('sShapeVals') ? $('sShapeVals').value : '').trim();
    shapeList = shRaw ? parseRangeOrList(shRaw, shapeDim) : (SENS_LEVELS[shapeDim] || []).slice();
    if (!shapeList.length) shapeList = (SENS_LEVELS[shapeDim] || []).slice();
    shapeLabel = SENS_PARAM_LABEL[shapeDim];
  }
  let hasPf = shapeList.length >= 1;   // 变量名保留(下游大量引用), 语义已推广为"形状维度启用"
  // 形状档位的图例文案: prefetch 用策略名原文, 其余参数走统一的 sensParamUnit(带单位)
  function shapeLabelOf(sv) { return shapeDim === 'prefetch' ? String(sv) : sensParamUnit(shapeDim, sv); }
  function shapeSymbolOf(si, sv) {
    return shapeDim === 'prefetch' ? (PF_SYMBOL[sv] || 'circle') : SHAPE_SYMBOLS[si % SHAPE_SYMBOLS.length];
  }
  let cmpLabel = compareParam ? (v => sensParamUnit(compareParam, v)) : null;

  // 缓存 key：全参数指纹（策略 + 全局参数 + 扫描参数 + 扫描档位 + 对比参数/档位 + 种子），不含 metric——
  // 同一扫描切换纵轴直接复用同一批全指标记录，零仿真重跑；含扫描档位 values（修复 2026-08-11:
  // 旧版漏 values → 改扫描档位重跑命中旧缓存显示旧曲线）
  let paramsFp = getParams(); // 基础参数指纹（含基础 prefixHit/ssdBW，扫描/对比值经 overrides 注入，不在此指纹内）
  const snapshot = { baseVals: baseValsOf(), paramsJson: collectParamsJson(), paramMeta: buildParamMeta() };
  const mode = state.strategyMode;
  const version = await serverVersion();
  let cacheKey = JSON.stringify([version, mode, paramsFp, baseStrategy.dsl || baseStrategy.name || '', param, values, compareParam, compareVals, shapeDim, shapeList, paramsFp.seed]);
  let cached = state.sensCache[cacheKey];

  let chartEl = $('chartSensitivity');
  let formulaEl = $('formulaSensitivity');
  function metricOf(rec) { return rec && rec[metric] != null ? rec[metric] : 0; }

  // 统一绘图：results 元素 = 全指标记录(rec) 或 null；按当前 metric 提取
  function paint(results) {
    let ch = initChart('chartSensitivity');
    let series = [];
    // curveRecs[i] = 第 i 条曲线的**全指标记录数组**(与 series[i] 一一对应, 顺序必须同步维护)。
    // 用途: 导出 HTML 时把全部指标一次性烧进页面, 使导出页可离线切换纵轴(2026-08-25)。
    // 之所以存 rec 而不是只存当前 metric 的数值 —— 扫描一次的代价是几十次仿真, 结果里
    // 每个 rec 本来就带齐 20 个指标(见 extractSensMetrics), 不额外花任何计算。
    let curveRecs = [];
    let palette = ['#6c63ff', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#8b5cf6', '#84cc16'];

    // ===== 先把多维结果**拉平**成"曲线列表" =====
    // 无论折线还是堆叠柱, 底层数据都是"若干条曲线 × 若干横轴档位"。此处统一拉平,
    // 后面两种图形共用同一份 flatCurves ⇒ curveRecs 与场景标签只需维护一处。
    // flatCurves[i] = { recs: 全指标记录数组, name: 该曲线的维度组合名(不含横轴) }
    let flatCurves = [];
    if (compareParam || hasPf) {
      let cmpLoop = compareParam ? compareVals.length : 1;
      let pfLoop = hasPf ? shapeList.length : 1;
      for (let ci = 0; ci < cmpLoop; ci++) {
        for (let pi = 0; pi < pfLoop; pi++) {
          let data;
          if (hasPf) data = compareParam ? results[ci][pi] : results[pi];
          else data = results[ci];
          let nameParts = [];
          if (compareParam) nameParts.push(cmpLabel(compareVals[ci]));
          if (hasPf) nameParts.push(shapeLabelOf(shapeList[pi]));
          // cmpVal/shapeVal: 该曲线在颜色/形状维度上的**原始档位值**(不是显示标签)。
          // 供 buildSensPoints 重建每个点的完整参数组合(角色无关点云) —— 必须用原始值,
          // 因为显示标签带单位("8k tok"), 无法与其他批次的数值做等值比较。
          flatCurves.push({ recs: data, name: nameParts.join(' · '), ci: ci, pi: pi,
            cmpVal: compareParam ? compareVals[ci] : undefined,
            shapeVal: hasPf ? shapeList[pi] : undefined });
        }
      }
    } else {
      flatCurves.push({ recs: results, name: metricLabel, ci: 0, pi: 0 });
    }
    flatCurves.forEach(function (fc) { curveRecs.push(fc.recs); });

    // ===== 折线 series 样式模板(2026-08-26) =====
    // 无论当前画的是折线还是堆叠柱, 都**恒定**生成一份折线样式模板并存进导出快照。
    // 原因: 若用户在堆叠柱状态下导出, opt.series 里只有 6 个 bar —— 折线的
    // 名称/配色/符号信息全丢, 导出页切回折线指标时就无法还原原本的图例与配色。
    // (反向同理: 堆叠柱的 6 个分量是全局常量, 不需要模板。)
    let lineTpl = flatCurves.map(function (fc, i) {
      let t = {
        name: (compareParam || hasPf) ? fc.name : metricLabel,
        type: 'line', smooth: true,
        lineStyle: { color: palette[fc.ci % palette.length], width: 2 },
        itemStyle: { color: palette[fc.ci % palette.length] },
        symbol: hasPf ? shapeSymbolOf(fc.pi, shapeList[fc.pi]) : 'circle',
        symbolSize: hasPf ? 7 : 6
      };
      // 单曲线时平台会额外给面积填充与点上数值标签 —— 模板要一致, 否则导出页切到
      // 折线指标后样式与平台不符
      if (!(compareParam || hasPf)) {
        t.areaStyle = { color: 'rgba(108,99,255,.1)' };
        t.label = { show: true, color: '#9ca0b0', fontSize: 9 };
      }
      return t;
    });
    // 场景标签同样**恒定**计算(不只在 stackMode 下) —— 导出页从折线切到堆叠柱时要用。
    // ⚠️ 生成规则必须与下方 stackScenes 完全一致, 否则两处场景名不同会让人以为是两张图。
    let sceneLabels = [];
    flatCurves.forEach(function (fc) {
      (fc.recs || []).forEach(function (rec, idx) {
        let lb = labels[idx] || String(idx);
        sceneLabels.push(flatCurves.length > 1 ? lb + ' · ' + fc.name : lb);
      });
    });

    // ===== 维度结构(2026-08-26): 供导出页做「固定某维度、单独看另一维度」的筛选 =====
    // 动机: 4 档 × 3 长度 × 3 策略 = 36 根柱/12 条线挤一张图, 根本没法比较。
    // 导出页需要按**维度**筛选(如"只看 H20"), 而它此前只有曲线名字符串, 无维度坐标 ⇒
    // 这里把三个维度的档位列表 + 每条曲线的维度坐标一并存进快照。
    //
    // 三个维度的角色(与绘图的视觉通道对应):
    //   x     — 扫描参数(横轴), 档位 = values/labels。筛它 = 缩小横轴范围
    //   cmp   — 对比参数(折线的颜色), 档位 = compareVals
    //   shape — 形状维(预取策略 / GPU硬件), 档位 = shapeList
    // ⚠️ 每条曲线的 (ci, pi) 就是它在 (cmp, shape) 上的坐标 —— 筛选时靠这两个下标判定去留,
    //    不靠解析曲线名字符串(名字里含 '·' 分隔符, 而档位标签本身也可能含 '·', 解析不可靠)。
    let sensDims = {
      x: {
        key: param, label: paramLabel,
        // 档位原始值与显示标签一一对应; gpu_preset 维度的值是字符串 key
        vals: values.slice(), texts: labels.slice()
      },
      cmp: compareParam ? {
        key: compareParam, label: SENS_PARAM_LABEL[compareParam],
        vals: compareVals.slice(), texts: compareVals.map(v => sensParamUnit(compareParam, v))
      } : null,
      shape: hasPf ? {
        key: shapeDim, label: shapeLabel,
        vals: shapeList.slice(), texts: shapeList.map(shapeLabelOf)
      } : null
    };
    // 每条曲线的维度坐标(与 curveRecs / lineTpl 同序)
    let curveCoords = flatCurves.map(function (fc) {
      return { ci: sensDims.cmp ? fc.ci : -1, pi: sensDims.shape ? fc.pi : -1 };
    });

    // ===== 分支 A: TTFT 构成堆叠柱(2026-08-26) =====
    // 与折线的根本差异: 折线用「颜色」表达维度组合, 而堆叠柱的颜色通道必须让给 6 个分量。
    // ⇒ 把「横轴档位 × 维度组合」**拉平成 x 轴上的场景**, 每根柱子 = 一个具体场景。
    //   这正好对应"用柱状图看各种场景下的 TTFT 构成": 场景横向排开, 分量纵向堆叠。
    // 场景数 = 档位数 × 曲线数, 可能很多 ⇒ 超过阈值时自动开 dataZoom(见下)。
    let stackMode = isTtftStack(metric);
    let stackScenes = [];     // [{label, rec}] 与 x 轴一一对应
    if (stackMode) {
      // 场景列表直接复用上面恒定算好的 sceneLabels(同序), 保证平台与导出页场景名一致
      let flatRecs = [];
      flatCurves.forEach(function (fc) { (fc.recs || []).forEach(function (rec) { flatRecs.push(rec); }); });
      stackScenes = sceneLabels.map(function (lb, i) { return { label: lb, rec: flatRecs[i] }; });
      // 每个分量一个 series, 全部 stack 到同一组 ⇒ 柱高 = Σ分量 = TTFT(已验证加性恒等)
      TTFT_STACK_PARTS.forEach(function (part) {
        series.push({
          name: part.label, type: 'bar', stack: 'ttft',
          // barMaxWidth 防止场景很少时柱子胖得离谱; 不设 barWidth 让 echarts 自适应
          barMaxWidth: 48,
          itemStyle: { color: part.color },
          emphasis: { focus: 'series' },
          data: stackScenes.map(function (sc) {
            let v = (sc.rec && sc.rec[part.key] != null && isFinite(sc.rec[part.key])) ? sc.rec[part.key] : 0;
            return +v.toFixed(1);
          })
        });
      });
      // 顶部总计标签: 挂在**最后一个** series 上(堆叠柱的 position:'top' 只在顶层可见)。
      // ⚠️ 不能挂在第一个 —— 那样标签会画在最底层分段的顶部, 落在柱子中间。
      // 值用 Σ 而非 series 自身 value, 否则显示的是最后一个分量而非总高。
      let totals = stackScenes.map(function (sc) {
        return TTFT_STACK_PARTS.reduce(function (a, p) {
          let v = (sc.rec && isFinite(sc.rec[p.key])) ? sc.rec[p.key] : 0; return a + v;
        }, 0);
      });
      let lastSer = series[series.length - 1];
      lastSer.label = {
        show: stackScenes.length <= 24,   // 场景过多时标签会糊成一片 ⇒ 自动隐藏, 靠 tooltip 看
        position: 'top', color: '#e4e4e7', fontSize: 9, fontWeight: 600,
        formatter: function (p) {
          let t = totals[p.dataIndex] || 0;
          return t >= 10000 ? (t / 1000).toFixed(1) + 's' : t.toFixed(0);
        }
      };
      // 供 tooltip / 导出复用
      stackScenes._totals = totals;
    } else if (compareParam || hasPf) {
      flatCurves.forEach(function (fc) {
        series.push({
          name: fc.name, type: 'line', smooth: true,
          data: fc.recs.map(rec => +metricOf(rec).toFixed(1)),
          lineStyle: { color: palette[fc.ci % palette.length], width: 2 },
          itemStyle: { color: palette[fc.ci % palette.length] },
          symbol: hasPf ? shapeSymbolOf(fc.pi, shapeList[fc.pi]) : 'circle',
          symbolSize: hasPf ? 7 : 6
        });
      });
    } else {
      series.push({ name: metricLabel, type: 'line', smooth: true, data: results.map(rec => +metricOf(rec).toFixed(1)),
        lineStyle: { color: '#6c63ff', width: 2 }, areaStyle: { color: 'rgba(108,99,255,.1)' },
        itemStyle: { color: '#6c63ff' }, label: { show: true, color: '#9ca0b0', fontSize: 9 } });
    }
    // tooltip 图例小图标: 需与 series.symbol 的取值域保持同步(2026-08-25 形状维度可绑定后
    // 新增 diamond/roundRect/pin, 若不补分支会全部退化成圆形 ⇒ tooltip 与图上符号不一致)
    function symbolMarker(sym, color) {
      let W = 'width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle;margin-right:5px;flex:none"';
      if (sym === 'square') return '<svg '+W+'><rect x="1" y="1" width="8" height="8" fill="'+color+'"/></svg>';
      if (sym === 'triangle') return '<svg '+W+'><polygon points="5,1 9,9 1,9" fill="'+color+'"/></svg>';
      if (sym === 'diamond') return '<svg '+W+'><polygon points="5,1 9,5 5,9 1,5" fill="'+color+'"/></svg>';
      if (sym === 'roundRect') return '<svg '+W+'><rect x="1" y="1" width="8" height="8" rx="3" fill="'+color+'"/></svg>';
      if (sym === 'pin') return '<svg '+W+'><path d="M5 1C3 1 1.6 2.4 1.6 4.3C1.6 6.3 5 9 5 9S8.4 6.3 8.4 4.3C8.4 2.4 7 1 5 1Z" fill="'+color+'"/></svg>';
      return '<svg '+W+'><circle cx="5" cy="5" r="4" fill="'+color+'"/></svg>';
    }
    // 堆叠柱的 x 轴用「场景」标签, 且轴名要说明它是组合维度而非单一参数
    let stackLabels = sceneLabels;
    let xData = stackMode ? stackLabels : labels;
    let xName = stackMode
      ? (flatCurves.length > 1 ? paramLabel + ' × 场景' : paramLabel)
      : paramLabel;
    // 场景数多时标签会互相压盖 ⇒ 旋转 + 开区域缩放。阈值按经验取: >6 转 20°, >10 转 30°
    let nSc = stackMode ? stackLabels.length : labels.length;
    let xRotate = stackMode ? (nSc > 10 ? 30 : (nSc > 6 ? 20 : 0)) : 0;
    let needZoom = stackMode && nSc > 16;
    let opt = {
      tooltip: {
        trigger: 'axis',
        // 堆叠柱模式下 axisPointer 用阴影更贴合柱状图(默认的十字线在柱图上不易对位)
        axisPointer: stackMode ? { type: 'shadow' } : undefined,
        formatter: function(params) {
          if (!params || !params.length) return '';
          let html = '<div style="font-weight:600;margin-bottom:4px">' + (params[0].axisValueLabel || params[0].name) + '</div>';
          if (stackMode) {
            // 堆叠柱: 显示 分量 / 绝对值 / 占比, 末行给总计 —— 占比是"时间花在哪"的核心读数。
            // 分母用当前柱的 Σ(而非全局最大值), 因此每根柱的百分比各自归一到 100%。
            let tot = params.reduce(function (a, p) { return a + (+p.value || 0); }, 0);
            params.forEach(function(p) {
              let v = +p.value || 0;
              let pct = tot > 0 ? (100 * v / tot) : 0;
              html += '<div style="display:flex;align-items:center;line-height:18px">'
                + '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'
                + p.color + ';margin-right:6px;flex:none"></span>'
                + '<span style="color:#9ca0b0;margin-right:10px">' + p.seriesName + '</span>'
                + '<span style="margin-left:auto"><b style="color:#e4e4e7">' + v.toFixed(1) + '</b>'
                + '<span style="color:#9ca0b0"> ms · ' + pct.toFixed(1) + '%</span></span></div>';
            });
            html += '<div style="border-top:1px solid #2e3347;margin-top:4px;padding-top:4px;'
              + 'display:flex;line-height:18px"><span style="color:#9ca0b0;margin-right:10px">TTFT 合计</span>'
              + '<span style="margin-left:auto;font-weight:600;color:#e4e4e7">' + tot.toFixed(1) + ' ms</span></div>';
            return html;
          }
          params.forEach(function(p) {
            let sym = (series[p.seriesIndex] && series[p.seriesIndex].symbol) || 'circle';
            html += '<div style="display:flex;align-items:center;line-height:18px">' + symbolMarker(sym, p.color) + '<span style="color:#9ca0b0;margin-right:8px">' + p.seriesName + '</span><span style="margin-left:auto;color:#9ca0b0">' + p.value + '</span></div>';
          });
          return html;
        }
      },
      // 堆叠柱恒有图例(6 个分量必须能对上颜色, 且可点击隐藏某分量单看其余)
      legend: (stackMode || compareParam || hasPf) ? { top: 0, textStyle: { color: '#9ca0b0', fontSize: 10 } } : undefined,
      grid: { left: 70, right: 20, top: (stackMode || compareParam || hasPf) ? 36 : 20,
        // 旋转标签/缩放条需要更多底部空间, 否则场景名被裁掉
        bottom: needZoom ? 76 : (xRotate ? 62 : 40) },
      xAxis: { type: 'category', data: xData, name: xName, nameTextStyle: { color: '#9ca0b0' },
        axisLabel: { color: '#9ca0b0', rotate: xRotate, interval: 0,
          // 场景名可能很长("400GB/s · 32k tok · race"), 超长截断避免挤爆画布
          formatter: function (v) { return (stackMode && String(v).length > 22) ? String(v).slice(0, 21) + '…' : v; } } },
      yAxis: { type: 'value', name: stackMode ? 'TTFT 构成(ms)' : metricLabel,
        nameTextStyle: { color: '#9ca0b0' }, axisLabel: { color: '#9ca0b0' } },
      dataZoom: needZoom ? [{ type: 'slider', bottom: 8, height: 18, borderColor: '#2e3347',
        textStyle: { color: '#9ca0b0', fontSize: 9 }, fillerColor: 'rgba(108,99,255,.18)',
        // 默认只展示前 16 根柱, 其余拖动查看 —— 一屏 40 根柱等于什么都看不清
        startValue: 0, endValue: 15 }] : undefined,
      series: series
    };
    ch.setOption(opt);
    let desc;
    if (stackMode) {
      // 堆叠柱的方法说明与折线完全不同: 要讲清"柱高=TTFT(加性恒等)"和"分量互不重叠"
      let scDesc = flatCurves.length > 1
        ? '横轴为「<code>' + paramLabel + '</code> × '
          + [compareParam ? SENS_PARAM_LABEL[compareParam] : null, hasPf ? shapeLabel : null]
            .filter(Boolean).join(' × ') + '」拉平后的 <b>' + nSc + '</b> 个场景'
        : '横轴为 <code>' + paramLabel + '</code> 的 <b>' + nSc + '</b> 个档位';
      desc = 'TTFT 构成堆叠柱：' + scDesc + '，每根柱子自下而上依次堆叠 '
        + TTFT_STACK_PARTS.map(p => p.label).join(' → ')
        + '。<b>柱高 = TTFT</b>（六分量为互不重叠的墙钟分段，已验证 Σ 分量恒等于平均 TTFT）。'
        + '<br>读图：<code>排队等待</code>占主体 ⇒ 系统过载（降 qps / 加实例）；'
        + '<code>算力竞争等待</code>占主体 ⇒ 收紧 <code>Prefill并发准入</code> 而非加卡；'
        + '<code>纯计算</code>占主体 ⇒ 真缺算力；<code>L3拉取等待</code>占主体 ⇒ 提带宽/换预取策略。';
    }
    else if (compareParam && hasPf) desc = '四维敏感性：横轴 <code>'+paramLabel+'</code> × 颜色 <code>'+SENS_PARAM_LABEL[compareParam]+'</code> × 形状「'+shapeLabel+'」('+shapeList.map(shapeLabelOf).join(' / ')+')，纵轴 <code>'+metricLabel+'</code>（共同随机数法，固定其他参数与种子）';
    else if (compareParam) desc = '三参数敏感性：横轴 <code>'+paramLabel+'</code> × 颜色 <code>'+SENS_PARAM_LABEL[compareParam]+'</code>（'+compareVals.map(v=>sensParamUnit(compareParam,v)).join(', ')+'），纵轴 <code>'+metricLabel+'</code>';
    else if (hasPf) desc = '双维敏感性：横轴 <code>'+paramLabel+'</code> × 形状「'+shapeLabel+'」('+shapeList.map(shapeLabelOf).join(' / ')+')，纵轴 <code>'+metricLabel+'</code>';
    else desc = '固定其他策略参数与随机种子（共同随机数法），扫描 <code>'+paramLabel+'</code>，观察 <code>'+metricLabel+'</code>';
    formulaEl.innerHTML = '<b>📐 敏感度分析方法</b><br>'+desc+
      '<br>基准策略: <code>'+baseStrategy.name+'</code> · 同一扫描切换纵轴即时（缓存）'+
      (cached ? ' · <span style="color:var(--accent)">⚡ 缓存命中，未重跑仿真（切换纵轴即时）</span>' : '');
    // ---- 导出快照(2026-08-25): 供 PNG/JPG/HTML 三种导出复用 ----
    // 存 option 与元信息, 而不是重新算一遍 —— 保证"导出的就是你看到的那张图"。
    // ⚠️ opt.tooltip.formatter 是闭包函数, JSON 序列化会丢失; HTML 导出时单独重建等价实现
    //    (见 buildSensHtml 里内联的 formatter), 故此处只需原样保留 opt 供位图导出用。
    state.sensExportState = {
      opt: opt, labels: labels, series: series,
      param: param, paramLabel: paramLabel, metric: metric, metricLabel: metricLabel,
      compareParam: compareParam, compareVals: compareVals,
      shapeDim: shapeDim, shapeList: shapeList, hasPf: hasPf,
      // curveRecs: 每条曲线的全指标记录, 供导出 HTML 内的「切换指标」下拉使用(2026-08-25)。
      // ⚠️ 与 series 同序; 单曲线时长度为 1。位图导出不用它。
      curveRecs: curveRecs,
      isMulti: !!(compareParam || hasPf),
      // ---- 堆叠柱信息(2026-08-26) ----
      // stackMode: 当前是否堆叠柱。导出 HTML 需据此决定初始渲染类型, 且切换指标时
      //   要能在「堆叠柱 ↔ 折线」之间来回变(图表 type/stack/x轴 都要换) ⇒ 必须存下场景标签。
      // stackLabels: 拉平后的场景名(与堆叠柱 x 轴一一对应); 折线模式下的 x 轴仍是 labels。
      //   两套 x 轴标签都要带上, 否则导出页从堆叠柱切到折线时横轴会错位。
      stackMode: stackMode,
      stackLabels: stackLabels,
      // lineTpl: 折线样式模板(恒定生成), 使导出页从堆叠柱切回折线时能还原原配色/符号/图例
      lineTpl: lineTpl,
      // ---- 维度筛选(2026-08-26) ----
      // sensDims: 三个维度(x/cmp/shape)各自的档位值与显示标签
      // curveCoords: 每条曲线在 (cmp, shape) 上的坐标(与 curveRecs 同序), 筛选按下标判定
      sensDims: sensDims,
      curveCoords: curveCoords,
      // 堆叠分量定义快照: 导出页据此重建 6 个 bar series(颜色与顺序必须与平台一致)
      stackParts: TTFT_STACK_PARTS.map(function (p) { return { key: p.key, label: p.label, color: p.color }; }),
      // ---- 角色无关点云(2026-08-27) ----
      // points[i] = { params: {参数key: 值, ...}, rec: 全指标 }
      // 与 curveRecs 的区别: curveRecs 是"曲线×档位"的**带角色**嵌套结构(谁当横轴写死了),
      // points 则把每个点的**完整参数组合**摊平, 不含任何角色信息 ⇒ 导出页可任意重新分配
      // 横轴/颜色/形状(见 buildSensHtml 的透视面板), 且跨批次可按 params 去重合并。
      // ⚠️ params 只含"被扫描的维度"+"基准值不同于默认的关键参数", 完整基准见 paramsJson。
      points: buildSensPoints(flatCurves, values, param, compareParam, shapeDim, hasPf, shapeList, snapshot.baseVals),
      // 本次扫描的三个角色分配(导出页透视面板的初始状态)
      roles: { x: param, cmp: compareParam || null, shape: hasPf ? shapeDim : null },
      descHtml: desc, strategyName: baseStrategy.name,
      dsl: baseStrategy.dsl || '', seed: paramsFp.seed,
      // 全参数快照: 导出的 HTML 附带它, 别人拿到图能复现同一次扫描
      paramsJson: snapshot.paramsJson,
      // 参数元信息(2026-08-26): 让导出页能像平台一样**分组 + 中文标签 + 可读值**地展示
      // 参数, 而不是甩一坨 JSON。运行时从 DOM 抽取, 见 buildParamMeta 的设计说明。
      paramMeta: snapshot.paramMeta,
      // _cacheKey: 快照列表的去重依据(与 metric 合成 key)。加下划线前缀表示"内部字段",
      // 不参与导出页的任何展示。
      _cacheKey: cacheKey,
      at: new Date()
    };
    setSensExportEnabled(true);
    // 自动收录进快照列表(2026-08-27): 平台仍只展示当前这一次扫描, 但列表把历次攒起来,
    // 导出 HTML 时可勾选多条打包进同一个文件(见 collectSensSnapshot 的设计说明)。
    try { collectSensSnapshot(state.sensExportState); } catch (e) {}
    if (btn) btn.textContent = '运行敏感性分析';
    // 注意: 不要清空 chartEl.innerHTML——echarts.init 已接管元素并渲染 canvas, 清空会销毁图表
  }

  if (cached) { paint(cached); return; } // 缓存命中：零仿真，按当前指标直接重绘（快速切换纵轴）
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 分析中...'; }

  // results: 单参数→一维; 双参数→compareVals×values 二维; 三维(含预取策略)→compareVals×策略×values（元素=全指标记录）
  let results;
  if (hasPf) results = compareParam ? compareVals.map(() => shapeList.map(() => new Array(values.length))) : shapeList.map(() => new Array(values.length));
  else results = compareParam ? compareVals.map(() => new Array(values.length)) : new Array(values.length);
  let totalRuns = (compareParam ? compareVals.length : 1) * (hasPf ? shapeList.length : 1) * values.length;
  formulaEl.innerHTML = '';

  // ===== 任务列表(与旧 setTimeout 循环同顺序 ci→pi→idx): 点级缓存命中直接填充, 未命中进 jobs =====
  //
  // ★★ 2026-08-27 角色无关化改造 ★★
  // 原实现有两个问题, 都源于「把参数的视觉角色写进了数据」:
  //   ① 三份几乎相同的 if 链(横轴/颜色/形状各一份) —— 加一个可扫描参数要改三处, 必然漂移
  //   ② 点级缓存 key 含 param/compareParam/shapeDim **参数名** ⇒ 角色互换后 key 不同、
  //      不命中、白重跑。而单点仿真只依赖「参数的实际值」, 与「谁当横轴/颜色/形状」无关:
  //      扫描1(横轴 ssd_bw × 颜色 prefix_hit × 形状 input_len) 与
  //      扫描2(横轴 ssd_bw × 颜色 input_len × 形状 prefix_hit) 的点集**完全相同**。
  // 改法: 抽出 applyParamVal(s, ov, key, val) 做唯一的参数落地入口(三个角色共用),
  //       key 改为 [策略s, overrides排序序列化, seed] —— 即**完整仿真输入指纹**。
  //       ⇒ 角色互换 / 横轴与颜色互换 / 档位范围重叠, 一律命中缓存零重跑。
  // ⚠️ 顺序要求: 必须先构造 s/overrides 再算 key(原实现是先算 key 后构造, 已重排)。
  let jobs = [], filled = 0;
  for (let _ci = 0; _ci < (compareParam ? compareVals.length : 1); _ci++) {
    for (let _pi = 0; _pi < (hasPf ? shapeList.length : 1); _pi++) {
      for (let _idx = 0; _idx < values.length; _idx++) {
        let v = values[_idx];
        let cv = compareParam ? compareVals[_ci] : null;
        let pf = hasPf ? shapeList[_pi] : null;
        let s = JSON.parse(JSON.stringify(baseStrategy));
        let overrides = { seed: paramsFp.seed }; // 固定种子保证可比
        // 三个视觉角色共用同一个落地函数 —— 落地顺序 横轴 → 颜色 → 形状 与原实现一致
        // (后写覆盖先写; 三者已做互斥判定, 正常不会撞同一字段)
        applyParamVal(s, overrides, param, v);
        if (compareParam) applyParamVal(s, overrides, compareParam, cv);
        if (hasPf) {
          // 'prefetch' 是唯一的非扫描参数维度(改策略对象的 prefetch.type), 单独分派;
          // 其余任意参数走与横轴/颜色**完全相同**的落地路径
          if (shapeDim === 'prefetch') s.prefetch.type = PF_TYPE[pf]; // wait_complete→none（命中即等拉取）, best_effort/race 直接用其类型
          else applyParamVal(s, overrides, shapeDim, pf);
        }
        // 角色无关的点级缓存 key = 完整仿真输入指纹(全局参数 + 策略 + 参数覆盖 + 种子)。
        // ★ paramsFp 必须在内: s/overrides 只含**被扫描的**参数, 模型/dtype/卡数等全局参数
        //   不在其中 —— 少了它, 换个模型重跑会误命中上个模型的结果(静默给出错误曲线)。
        // ★ overrides 用 sortedJson 序列化: 对象字面量的键序随赋值顺序变(横轴/颜色互换会导致
        //   {prefixHit,ssdBW} vs {ssdBW,prefixHit}), 不排序则同一输入产生两个 key ⇒ 仍不命中。
        // ★ 剔除 s.name: 它是纯展示字段(改个策略名不改任何语义), 留着会让重命名后全部失配。
        //   s.dsl 保留 —— 那才是调度语义的权威来源。
        let sFp = JSON.parse(JSON.stringify(s)); delete sFp.name;
        let pointKey = sortedJson([version, mode, paramsFp, sFp, overrides]);
        let hit = state.sensPointCache[pointKey];
        if (hit !== undefined) {
          if (hasPf) { if (compareParam) results[_ci][_pi][_idx] = hit; else results[_pi][_idx] = hit; }
          else if (compareParam) results[_ci][_idx] = hit; else results[_idx] = hit;
          filled++;
          continue;
        }
        jobs.push({ key: pointKey, ci: _ci, pi: _pi, idx: _idx, s: s, overrides: overrides });
      }
    }
  }

  function storePoint(job, rec) {
    if (rec) {
      state.sensPointCache[job.key] = rec;
      let pkeys = Object.keys(state.sensPointCache);
      if (pkeys.length >= 1000) delete state.sensPointCache[pkeys[0]]; // 点级 FIFO 淘汰（上限1000点）
    }
    if (hasPf) { if (compareParam) results[job.ci][job.pi][job.idx] = rec; else results[job.pi][job.idx] = rec; }
    else if (compareParam) results[job.ci][job.idx] = rec; else results[job.idx] = rec;
  }
  function finish() {
    state.sensCache[cacheKey] = results; // 全指标记录入缓存（后续切纵轴/重跑直接复用）
    let keys = Object.keys(state.sensCache);
    if (keys.length >= 20) delete state.sensCache[keys[0]]; // FIFO 淘汰最旧
    paint(results);
  }
  if (!jobs.length) { finish(); return; }
  const controller = new AbortController();
  chartEl.replaceChildren();
  const note = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.id = "sensCancelBtn"; cancel.className = "btn btn-sm"; cancel.textContent = "取消服务器计算";
  cancel.onclick = () => { cancel.disabled = true; controller.abort(); };
  chartEl.append(note, cancel);
  await executeBatch(jobs.map(job => ({ params: paramsFp, strategy: job.s, overrides: job.overrides, mode })), "scan", {
    label: paramLabel + "敏感性扫描", signal: controller.signal,
    onTask: task => { note.textContent = "服务器任务 " + task.status + " · 已完成 " + filled + "/" + totalRuns + " "; },
    onPoint: point => { storePoint(jobs[point.index], point.result); filled++; },
  });
  finish();
}
