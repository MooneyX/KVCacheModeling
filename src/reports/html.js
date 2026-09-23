import { SENS_METRIC_LABEL, TTFT_STACK_KEY, SENS_PARAM_LABEL, sensParamUnit } from "../application/labels.js";
import { sensSnapTitle } from "../application/snapshots.js";

export function reportSnapshotContext(snapshot = {}, point = {}) {
  const saved = snapshot.workload || {};
  const measured = point.workload || point.rec?.workload || snapshot.points?.[0]?.rec?.workload || snapshot.curveRecs?.[0]?.[0]?.workload || {};
  const workload = { ...saved, ...measured };
  const experiment = point.experiment || snapshot.experiment || {};
  const states = point.rec || point.workload ? [] : (snapshot.points || []).map(item => item.workload?.state || item.rec?.workload?.state).filter(Boolean);
  return {
    source: workload.source || snapshot.workloadSource || snapshot.source || 'synthetic',
    bundleSummary: saved.bundleSummary || workload.bundleSummary || workload.bundle || experiment.bundleSummary || null,
    configuration: point.workload?.configuration || point.rec?.workload?.configuration || workload.configuration || experiment.params || snapshot.configuration || null,
    baselineConfiguration: snapshot.configuration || null,
    options: saved.options || null,
    windows: workload.windows || snapshot.windows || null,
    state: states.length ? { ...workload.state, truncated: states.some(item => item.truncated), terminationReason: [...new Set(states.map(item => item.terminationReason))].join(', ') } : workload.state || null,
    counts: workload.counts || null,
    versions: { engine: snapshot.engineVersion || null, ...workload.versions, ...experiment.versions },
    eligibleForComparison: workload.eligibleForComparison ?? null,
    experiment,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function reportPointKey(snapshot, point) {
  let params;
  try { params = JSON.parse(snapshot.paramsJson || '{}'); } catch { params = snapshot.paramsJson; }
  const context = reportSnapshotContext(snapshot, point);
  const windows = context.windows && Object.fromEntries(Object.entries(context.windows).map(([name, window]) => [name,
    { start: window?.start, end: window?.end, durationSeconds: window?.durationSeconds }]));
  return JSON.stringify(canonical({
    source: context.source, bundleSummary: context.bundleSummary,
    configuration: context.configuration, baselineConfiguration: context.baselineConfiguration, options: context.options, windows, versions: context.versions,
    experiment: context.experiment, params, point: point.params,
    strategy: snapshot.strategy || snapshot.strategyName, dsl: snapshot.dsl, mode: snapshot.mode, seed: snapshot.seed,
    version: snapshot.engineVersion || snapshot.version || null,
  }));
}

export function reportExportRestriction(snapshot) {
  if (!snapshot) return '请先运行一次敏感性分析。';
  const contexts = [reportSnapshotContext(snapshot), ...(snapshot.points || []).map(point => reportSnapshotContext(snapshot, point))];
  if (contexts.some(context => context.source === 'replay' && (!context.bundleSummary || !context.configuration || !context.windows || !context.state || !Object.values(context.versions).some(Boolean)))) {
    return '该 Replay 快照缺少来源、有效配置、窗口或版本信息，请重新运行；完整结果 JSON 下载仍可使用。';
  }
  return '';
}


// ---- 自包含可交互 HTML ----
// 结构: 标题 + 方法说明 + 交互图(CDN echarts) + 数据表(可一键复制 TSV) + 参数快照(可回填本平台)
//
// ★★ 多次扫描同页 + 参数透视(2026-08-27) ★★
// snapList(可选): 快照数组。传入时把**全部**扫描的角色无关点云一并烧进页面, 页内可
//   ①切换批次 ②任意重新指定横轴/颜色/形状 ③勾选参数值筛选。
// 设计取舍: 不重写原有渲染路径 —— 初始图/表/参数区仍由"当前快照"(st)按原逻辑生成,
//   透视能力作为**纯增量层**叠加(PIVOT_PTS + 透视面板 + applyPivot)。
//   理由: 原路径有 20+ 个投影函数与 5 个已上线的验证脚本, 重写必然引入回归; 而透视层
//   只需要点云 + 一个新的 series 构造器, 与原路径共用 rebuildAll/renderTable 的下游。
export function renderSensHtml(st, snapList) {

  // 快照列表: 未传或只有 1 条时退化为原来的单快照页(行为逐位不变)
  let snaps = (snapList && snapList.length) ? snapList : [st];
  for (const snapshot of [st, ...snaps]) {
    const restriction = reportExportRestriction(snapshot);
    if (restriction) throw new Error(restriction);
  }
  let multi = snaps.length > 1;
  // 深拷贝顺带丢掉函数字段(formatter) —— 生成页里重建, 见下方 FORMATTER
  let opt = JSON.parse(JSON.stringify(st.opt));
  let esc = function (t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  // JSON 内嵌进 <script> 时必须断开 "</" , 否则含该串会提前闭合脚本标签
  let safeJson = function (o) { return JSON.stringify(o).replace(/<\//g, '<\\/'); };

  // ===== 指标切换数据(2026-08-25) =====
  // 一次扫描的每个点本就带齐全部指标(extractSensMetrics), 把它们全部烧进导出页 ⇒
  // 收图的人无需回到平台重跑就能换纵轴看同一批仿真的其他指标。
  // 数值口径与平台绘图**完全一致**(同样 +toFixed(1)), 保证"导出页切到指标X == 平台切到指标X"。
  // 只收录 curveRecs 里真实存在该字段的指标; 老快照(无 curveRecs)则整个功能降级隐藏。
  let recs = st.curveRecs || null;
  let metricData = {}, metricKeys = [];
  if (recs && recs.length) {
    Object.keys(SENS_METRIC_LABEL).forEach(function (k) {
      let any = false;
      let cols = recs.map(function (arr) {
        return (arr || []).map(function (rec) {
          if (rec && Object.prototype.hasOwnProperty.call(rec, k)) any = true;
          return rec && typeof rec[k] === 'number' && Number.isFinite(rec[k]) ? +rec[k].toFixed(1) : null;
        });
      });
      if (any) { metricData[k] = cols; metricKeys.push(k); }
    });
  }
  let hasSwitch = metricKeys.length > 1;

  // ===== 堆叠柱数据(2026-08-26) =====
  // STACK_DATA[分量key] = 拉平后的场景数组(与 STACK_LABELS 一一对应)。
  // 与 METRIC_DATA 的区别: METRIC_DATA 是 [曲线][点] 二维(折线用), STACK_DATA 是
  // **一维拉平**(堆叠柱把曲线维也摊到 x 轴上) ⇒ 两者不能互相套用, 切换时要换整套结构。
  let stackParts = st.stackParts || null;
  let stackLabels = st.stackLabels || null;
  let stackData = {};
  let stackTotals = [];
  let canStack = !!(stackParts && stackLabels && recs && recs.length);
  if (canStack) {
    // 按 curveRecs 顺序拉平(与 paint 里 sceneLabels 同序)
    let flat = [];
    recs.forEach(function (arr) { (arr || []).forEach(function (r) { flat.push(r); }); });
    // 长度不一致说明快照被外部改过 ⇒ 关掉堆叠功能而不是画出错位的图
    if (flat.length !== stackLabels.length) { canStack = false; }
    else {
      stackParts.forEach(function (p) {
        stackData[p.key] = flat.map(function (r) {
          return r && typeof r[p.key] === 'number' && Number.isFinite(r[p.key]) ? +r[p.key].toFixed(1) : null;
        });
      });
      stackTotals = flat.map(function (r, i) {
        if (stackParts.some(p => stackData[p.key][i] == null)) return null;
        return +stackParts.reduce(function (a, p) { return a + stackData[p.key][i]; }, 0).toFixed(1);
      });
    }
  }
  // 堆叠柱指标必须真有数据才放进下拉 —— 否则用户切过去看到空图
  if (canStack && metricKeys.indexOf(TTFT_STACK_KEY) < 0) metricKeys.push(TTFT_STACK_KEY);
  if (!canStack) {
    let i = metricKeys.indexOf(TTFT_STACK_KEY);
    if (i >= 0) metricKeys.splice(i, 1);
  }
  hasSwitch = metricKeys.length > 1;

  // 数据表: 两套结构, 由页内 renderTable() 按当前指标类型整体重建 —— 不是就地改数值。
  //   折线指标 → 行=横轴档位, 列=各曲线
  //   堆叠柱   → 行=场景,     列=6 个分量 + 合计
  // 此处生成的是**当前指标**对应的那一套(离线打不开图时这份数字仍完整可用)。
  let sers = (opt.series || []);
  let head, rows;
  if (st.stackMode && canStack) {
    head = '<tr><th>场景</th>'
      + stackParts.map(function (p) { return '<th>' + esc(p.label) + '</th>'; }).join('')
      + '<th>TTFT合计</th></tr>';
    rows = stackLabels.map(function (lb, i) {
      return '<tr><td class="k">' + esc(lb) + '</td>'
        + stackParts.map(function (p) { return '<td>' + esc(stackData[p.key][i] ?? '—') + '</td>'; }).join('')
        + '<td><b>' + esc(stackTotals[i] ?? '—') + '</b></td></tr>';
    }).join('\n');
  } else {
    head = '<tr><th>' + esc(st.paramLabel) + '</th>'
      + sers.map(function (s) { return '<th>' + esc(s.name) + '</th>'; }).join('') + '</tr>';
    rows = st.labels.map(function (lb, i) {
      return '<tr><td class="k">' + esc(lb) + '</td>'
        + sers.map(function (s) {
          let v = (s.data && s.data[i] != null) ? s.data[i] : '—';
          return '<td>' + esc(v) + '</td>';
        }).join('') + '</tr>';
    }).join('\n');
  }

  // 维度摘要(纯文本, 不含 HTML 标签) —— descHtml 里有 <code>, 直接复用即可
  // 「纵轴」一项在切换指标时要跟着变 ⇒ 单独拆出来给个 id, 由页内 applyMetric() 改写,
  //  否则头部写着"纵轴：平均TTFT"而图上画的是吞吐, 收图的人会被误导。
  // 形状维标签(2026-08-27 修): 原先写死 gpu_preset ? 'GPU硬件' : '预取策略' —— 形状维
  // 已开放为任意参数, 那样会把「形状=输入长度」错标成「预取策略」。统一查 SENS_PARAM_LABEL。
  let shapeDimLabel = function (sd) {
    return (sd === 'prefetch') ? '预取策略' : (SENS_PARAM_LABEL[sd] || String(sd || ''));
  };
  let dims = [];
  dims.push('横轴：' + st.paramLabel);
  if (st.compareParam) dims.push('颜色：' + SENS_PARAM_LABEL[st.compareParam]
    + '（' + st.compareVals.join(', ') + '）');
  if (st.hasPf) dims.push('形状：' + shapeDimLabel(st.shapeDim)
    + '（' + st.shapeList.join(' / ') + '）');
  let dimsHtml = dims.map(esc).join(' ｜ ')
    + ' ｜ 纵轴：<span id="dimY">' + esc(st.metricLabel) + '</span>';

  // ===== 角色无关点云的跨批次合并(2026-08-27) =====
  // 用户洞察: 「颜色=命中率/形状=输入长度」与「颜色=输入长度/形状=命中率」两次扫描的数据
  // **本就相同**。合并后同一参数组合只存一份 ⇒ 文件更小, 且透视时可自由重新分配角色。
  // 指纹: 参数键排序后的 JSON —— 与平台侧点级缓存 key 同思路(键序无关)。
  // 重复点取**首次出现**的记录(同参数组合同种子的仿真结果本应逐位相同; 若不同则说明有
  // 未纳入 params 的隐藏差异, 此时保留先到者并计数, 由 dupCount 暴露给用户而非静默平均)。
  let pivotPts = [], pivotSeen = new Map(), pivotGroups = new Map(), dupCount = 0;
  snaps.forEach(function (sn, si) {
    const groupKey = reportPointKey(sn, { params: {} });
    if (!pivotGroups.has(groupKey)) pivotGroups.set(groupKey, pivotGroups.size);
    const group = pivotGroups.get(groupKey);
    (sn.points || []).forEach(function (p) {
      if (!p || !p.rec) return;
      let fp = reportPointKey(sn, p);
      if (pivotSeen.has(fp)) { pivotPts[pivotSeen.get(fp)].snapshots.push(si); dupCount++; return; }
      pivotSeen.set(fp, pivotPts.length);
      pivotPts.push({ p: p.params, r: p.rec, s: si, snapshots: [si], g: group, workload: reportSnapshotContext(sn, p) });
    });
  });
  // 参数索引: 每个参数在点云里出现过的**全部取值**(升序)。
  // 只有取值 ≥2 个的参数才有"扫描维"资格(能当横轴/颜色/形状); 单值参数仅作展示与筛选。
  let pivotParams = {};
  pivotPts.forEach(function (pt) {
    Object.keys(pt.p || {}).forEach(function (k) {
      if (!pivotParams[k]) pivotParams[k] = {};
      pivotParams[k][pt.p[k]] = true;
    });
  });
  let pivotIndex = {};
  Object.keys(pivotParams).forEach(function (k) {
    let vals = Object.keys(pivotParams[k]);
    // ★ 非数值维度判定(2026-08-27 修): 原先只给 gpu_preset 开字符串分支, 于是
    //   'prefetch'(取值 wait_complete/best_effort/race)被 Number() 全部过滤成空数组
    //   ⇒ 该行标签显示原始 key、值显示**空白**。
    //   判据改为"看实际取值能否转数值", 而不是硬编码参数名 —— 以后再加字符串维度自动生效。
    let numeric = vals.every(function (v) { return v !== '' && isFinite(Number(v)); });
    if (!numeric) vals.sort();
    else vals = vals.map(Number).filter(function (v) { return isFinite(v); }).sort(function (a, b) { return a - b; });
    pivotIndex[k] = {
      // prefetch 不在 SENS_PARAM_LABEL 里(它不是可扫描参数, 是策略字段) ⇒ 单独给中文名,
      // 否则面板上出现一行英文 key
      label: SENS_PARAM_LABEL[k] || (k === 'prefetch' ? '预取策略' : (k === 'maxPrefillTok' ? 'Prefill token预算' : k)),
      vals: vals,
      // 非数值维度直接用原值当显示文本(sensParamUnit 的默认分支会给它加 '%')
      texts: vals.map(function (v) {
        return (k === 'prefetch') ? String(v) : sensParamUnit(k, v);
      })
    };
  });
  // 透视只在"点云非空 且 至少有一个多取值参数"时有意义
  let pivotDims = Object.keys(pivotIndex).filter(function (k) { return pivotIndex[k].vals.length > 1; });
  let hasPivot = pivotPts.length > 0 && pivotDims.length > 0;
  // 批次摘要(批次快捷选择用): 标题 + 该批次的角色分配, 供页内一键还原
  let snapMeta = snaps.map(function (sn) {
    return {
      title: (function () { try { return sensSnapTitle(sn); } catch (e) { return sn.paramLabel + ' → ' + sn.metricLabel; } })(),
      x: sn.param, cmp: sn.compareParam || null, shape: (sn.hasPf ? sn.shapeDim : null),
      metric: sn.metric, at: (sn.at ? sn.at.toLocaleString('zh-CN') : ''),
      n: (sn.points || []).length
    };
  });
  // ★ 批次 chip 的可分辨标签: 两批次扫描配置相同时标题会撞车(真实案例: L3 图 A/B
  //   仅 pInputLen 不同, 两个 chip 文字一模一样, 用户无法分辨)。
  //   追加"区分参数" —— 在本批次内取值唯一、且跨批次有差异的参数(扫描维自然排除:
  //   它在批次内就是多值)。例: 「输入长度=32k tok」vs「输入长度=128k tok」。
  snapMeta.forEach(function (m, i) {
    let sig = [];
    Object.keys(pivotIndex).forEach(function (k) {
      let mine = {}, all = {};
      pivotPts.forEach(function (pt) {
        if (pt.p[k] === undefined) return;
        all[String(pt.p[k])] = true;
        if (pt.s === i) mine[String(pt.p[k])] = true;
      });
      let mv = Object.keys(mine);
      if (mv.length === 1 && Object.keys(all).length > 1) {
        let d = pivotIndex[k], vi = -1;
        for (let q = 0; q < d.vals.length; q++) if (String(d.vals[q]) === mv[0]) { vi = q; break; }
        sig.push(d.label + '=' + (vi >= 0 ? d.texts[vi] : mv[0]));
      }
    });
    m.sig = sig;
  });

  let L = [];
  L.push('<!DOCTYPE html>');
  L.push('<html lang="zh-CN"><head><meta charset="utf-8">');
  L.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  L.push('<title>' + esc('参数敏感性 · ' + st.paramLabel + ' → ' + st.metricLabel) + '</title>');
  L.push('<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"><\/script>');
  L.push('<style>');
  L.push(':root{--bg:#0f1117;--surface:#1a1d27;--surface2:#242837;--border:#2e3347;--accent:#6c63ff;--accent2:#34d399;--text:#e4e4e7;--text-dim:#9ca0b0}');
  L.push('*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.55}');
  L.push('.wrap{max-width:1080px;margin:0 auto}');
  L.push('h1{font-size:1.18rem;margin:0 0 4px}h1 span{color:var(--accent)}');
  L.push('.sub{color:var(--text-dim);font-size:.8rem;margin:0 0 16px}');
  L.push('.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:14px}');
  L.push('#chart{height:440px}');
  L.push('.box{background:var(--surface2);border-left:3px solid var(--accent);border-radius:6px;padding:10px 12px;font-size:.78rem;color:var(--text-dim)}');
  L.push('.box code{background:rgba(108,99,255,.14);color:var(--accent);padding:1px 5px;border-radius:3px;font-size:.95em}');
  L.push('.box b{color:var(--text)}');
  L.push('table{border-collapse:collapse;width:100%;font-size:.78rem}');
  L.push('th,td{border:1px solid var(--border);padding:5px 9px;text-align:right}');
  L.push('th{background:var(--surface2);color:var(--text-dim);font-weight:600;text-align:right}');
  L.push('th:first-child,td.k{text-align:left;color:var(--text-dim)}');
  L.push('tbody tr:hover{background:rgba(108,99,255,.07)}');
  L.push('.btn{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:.75rem;font-weight:600;cursor:pointer}');
  L.push('.btn:hover{background:#7f78ff}');
  L.push('h2{font-size:.9rem;margin:0 0 10px;display:flex;align-items:center;gap:10px}');
  L.push('pre{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;font-size:.7rem;color:var(--text-dim);max-height:220px;margin:0}');
  // 参数分组展示(2026-08-26): 模仿平台参数区的分组网格, 取代原先甩一坨 JSON 的做法
  L.push('.pgrp{margin-bottom:14px}');
  L.push('.pgrp>h3{font-size:.78rem;color:var(--accent);margin:0 0 6px;font-weight:600;display:flex;align-items:center;gap:6px}');
  L.push('.pgrp>h3 i{font-style:normal;font-size:.68rem;color:var(--text-dim);font-weight:400}');
  L.push('.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:6px}');
  L.push('.pf{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:5px 9px;display:flex;align-items:baseline;gap:8px;min-width:0}');
  // 非默认值高亮: 一眼看出这次扫描到底改了什么(左侧色条 + 强调色数值)
  L.push('.pf.mod{border-left:3px solid var(--accent2)}');
  L.push('.pf .pk{font-size:.7rem;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}');
  L.push('.pf .pv{font-size:.75rem;color:var(--text);font-weight:600;font-family:var(--mono,ui-monospace,monospace);white-space:nowrap}');
  L.push('.pf.mod .pv{color:var(--accent2)}');
  L.push('.pf .pv.off{color:var(--text-dim);font-weight:400}');
  L.push('.ptog{background:none;border:1px solid var(--border);color:var(--text-dim);border-radius:5px;padding:2px 8px;font-size:.68rem;cursor:pointer;margin-left:8px}');
  L.push('.ptog:hover{border-color:var(--accent);color:var(--text)}');
  L.push('.foot{color:var(--text-dim);font-size:.72rem;text-align:center;padding:8px 0 0}');
  // 指标切换条: 下拉 + 快捷按钮组(点一下即切, 比拉下拉快)
  L.push('.mbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}');
  L.push('.mbar label{font-size:.75rem;color:var(--text-dim)}');
  L.push('select{background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:.76rem}');
  L.push('.chip{background:var(--surface2);color:var(--text-dim);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-size:.71rem;cursor:pointer}');
  L.push('.chip:hover{border-color:var(--accent);color:var(--text)}');
  L.push('.chip.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}');
  // 统一筛选面板: 角色下拉行 + 每个可调参数一行(标签 + 档位 chip 组 + 全选/反选)
  L.push('.fbar{border-top:1px dashed var(--border);margin-top:10px;padding-top:10px}');
  // 档位 chip 用方角以区别于上方圆角的「指标」chip —— 两组 chip 语义不同, 视觉需可分辨
  L.push('.fc{background:var(--surface2);color:var(--text-dim);border:1px solid var(--border);border-radius:5px;padding:2px 9px;font-size:.71rem;cursor:pointer;font-variant-numeric:tabular-nums}');
  L.push('.fc:hover{border-color:var(--accent2);color:var(--text)}');
  L.push('.fc.on{background:rgba(52,211,153,.16);border-color:var(--accent2);color:var(--accent2);font-weight:600}');
  L.push('.fmini{background:none;border:1px solid var(--border);color:var(--text-dim);border-radius:5px;padding:2px 7px;font-size:.68rem;cursor:pointer}');
  L.push('.fmini:hover{border-color:var(--accent);color:var(--text)}');
  L.push('.fwarn{color:#f59e0b}');
  L.push('.fdanger{color:#ef4444}');
  // 统一筛选面板(2026-08-27 三次改造): 角色下拉 + 可调参数勾选都收进 fbar 这一块。
  L.push('.pvrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0}');
  L.push('.pvrow>b{font-size:.73rem;color:var(--text);min-width:52px;font-weight:600}');
  L.push('.pvnote{font-size:.71rem;color:var(--text-dim);margin-left:auto}');
  // .live = 透视引擎已接管图表(用户动过面板)。加左侧色条明确区分"面板可用"与"正在生效",
  // 否则用户分不清眼前这张图是原图还是透视结果。
  L.push('.fbar.live{border-left:3px solid #06b6d4;padding-left:8px}');
  L.push('.fbar.live .fc.on{background:rgba(6,182,212,.16);border-color:#06b6d4;color:#06b6d4}');
  L.push('</style></head><body><div class="wrap">');
  L.push('<h1>参数<span>敏感性</span>分析</h1>');
  L.push('<p class="sub">' + dimsHtml + '<br>基准策略 <b>' + esc(st.strategyName)
    + '</b> · 随机种子 ' + esc(st.seed) + ' · 导出于 ' + esc(st.at.toLocaleString('zh-CN')) + '</p>');
  L.push('<div class="card"><div class="box"><b>指标口径</b><br>throughput 为全程输出 token/s；TTFT 分解为全程口径。measurement_* 仅采用 measurement 窗口；Replay 延迟按到达窗口归属，完成 QPS 按完成事件归窗。无样本显示“—”，失败或截断不记为零延迟最优点。</div></div>');
  L.push('<div class="card">');
  if (hasSwitch) {
    // 只在有 ≥2 个可用指标时才出现切换条 —— 单指标时下拉是噪音
    L.push('<div class="mbar"><label>纵轴指标</label><select id="mSel">'
      + metricKeys.map(function (k) {
          let txt = (k === TTFT_STACK_KEY) ? ('📊 ' + SENS_METRIC_LABEL[k]) : SENS_METRIC_LABEL[k];
          return '<option value="' + esc(k) + '"' + (k === st.metric ? ' selected' : '') + '>'
            + esc(txt) + '</option>';
        }).join('')
      + '</select>');
    // 常用指标快捷 chip(只放本次扫描确实有数据的)
    // ttft_stack 放**第一位** —— 它是信息量最大的一张(一眼看出时间花在哪), 优先给到手边
    let quick = ['ttft_stack', 'ttft', 'ttft_p99', 'latency', 'tpot', 'throughput', 'fetch_ratio',
      'prefix_hit_rate', 'compute_net', 'compute_wait'].filter(function (k) { return metricKeys.indexOf(k) >= 0; });
    if (quick.length) {
      L.push('<span style="color:var(--border)">|</span>');
      L.push(quick.map(function (k) {
        // 堆叠柱 chip 加图标提示它是结构不同的一张图
        let txt = (k === TTFT_STACK_KEY) ? ('📊 ' + SENS_METRIC_LABEL[k]) : SENS_METRIC_LABEL[k];
        return '<button class="chip" data-m="' + esc(k) + '">' + esc(txt) + '</button>';
      }).join(''));
    }
    L.push('<span id="mNote" style="font-size:.71rem;color:var(--text-dim);margin-left:auto">'
      + '共 ' + metricKeys.length + ' 个指标 · 同一批仿真结果，切换零重算</span>');
    L.push('</div>');
  }
  // ===== 统一筛选面板(2026-08-27 三次改造) =====
  // 沿革: ①最初是「维度筛选」fbar(按原批次的横轴/颜色/形状角色做减法);
  //   ②后来加了独立的「参数透视」pvbar(角色无关点云 + 重新分配角色), 两块并存;
  //   ③现在按用户要求合并 —— **拆掉 pvbar 整块卡片**, 只在绿色 fbar 里放:
  //     · 第一行: 横轴/颜色/形状 角色下拉 + 状态提示 + 「↺ 恢复原图」
  //     · 其后每行: 一个**可调参数**(本文件数据里取值 ≥2 个)的档位勾选 chips
  //   单值参数**完全不显示**(用户明确: 无法调节的参数不显示);
  //   批次聚焦 chips 也一并移除(等价操作 = 勾选该批次对应的参数取值)。
  //
  // 旧「维度筛选」(SENS_DIMS/data-dim chips)整体下线 —— 它的能力(固定某维度档位
  // 看另一维度)是透视勾选的子集: 透视面板里勾掉同一些档位即可达到同样效果,
  // 且还能跨批次。页内投影函数(viewXIdx/viewCurves 等)保留 —— 原图渲染仍走它们
  // (SEL 恒为 null ⇒ 恒等投影), 只是不再有 UI 去改 SEL。
  //
  // 懒激活保留: 面板可见但引擎待命, 初始渲染平台原图(堆叠柱能力不丢);
  // 用户一旦动了面板(改角色/勾档位/全选反选)才 pvEnter() 接管, 出现「恢复原图」。
  let pivHint = pivotPts.length + ' 个参数组合'
    + (multi ? ' · 合并自 ' + snaps.length + ' 次扫描' : '')
    + (dupCount ? ' · 去重 ' + dupCount + ' 个' : '');
  if (hasPivot) {
    L.push('<div class="fbar" id="fbar">');
    // 角色分配下拉: 横轴必选, 颜色/形状可空。选项只含可调参数(pivotDims)。
    let optsOf = function (sel, allowNone) {
      let o = allowNone ? ['<option value="">无</option>'] : [];
      pivotDims.forEach(function (k) {
        o.push('<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>'
          + esc(pivotIndex[k].label) + '</option>');
      });
      return o.join('');
    };
    // 初始角色 = 当前快照的角色(若它在 pivotDims 里), 否则取第一个可用维度
    let iniX = (pivotDims.indexOf(st.param) >= 0) ? st.param : pivotDims[0];
    let iniC = (st.compareParam && pivotDims.indexOf(st.compareParam) >= 0 && st.compareParam !== iniX) ? st.compareParam : '';
    let iniS = (st.hasPf && st.shapeDim && pivotDims.indexOf(st.shapeDim) >= 0
      && st.shapeDim !== iniX && st.shapeDim !== iniC) ? st.shapeDim : '';
    L.push('<div class="pvrow">');
    L.push('<b>横轴</b><select id="pvX">' + optsOf(iniX, false) + '</select>');
    L.push('<b>颜色</b><select id="pvC">' + optsOf(iniC, true) + '</select>');
    L.push('<b>形状</b><select id="pvS">' + optsOf(iniS, true) + '</select>');
    // 「恢复原图」只在已接管时有意义(初始隐藏)
    L.push('<button class="fmini" id="pvReset" style="display:none">↺ 恢复原图</button>');
    L.push('<span class="pvnote" id="pvNote">' + esc(pivHint) + ' —— 改动任一项即按所选角色重绘</span>');
    L.push('</div>');
    // 批次快捷选择(2026-08-27 应用户要求加回): 一键把"角色分配 + 全部参数勾选"
    // 还原到某次扫描 —— 等价于手工勾该批次的所有参数值, 但一步到位。
    // 只在多批次时出现(单批次无选择意义)。
    if (multi) {
      L.push('<div class="pvrow"><b>批次</b>');
      snapMeta.forEach(function (m, i) {
        // 标签 = 序号 + 标题 + 区分参数(标题撞车时的可分辨信息)
        let label = '#' + (i + 1) + ' ' + m.title
          + (m.sig && m.sig.length ? '（' + m.sig.join(' ') + '）' : '');
        L.push('<button class="fc" data-snap="' + i + '" title="' + esc(m.title + ' · ' + m.n + ' 点 · ' + m.at)
          + '">' + esc(label) + '</button>');
      });
      L.push('<span class="pvnote">点击即选中该批次的全部参数配置</span></div>');
    }
    // 可调参数勾选区: 每行一个参数。**只列多值参数**(pivotDims 即取值 ≥2 的参数集)
    L.push('<div id="pvVals">');
    pivotDims.forEach(function (k) {
      let d = pivotIndex[k];
      L.push('<div class="pvrow" data-pk="' + esc(k) + '">');
      L.push('<b>' + esc(d.label) + '</b>');
      L.push(d.vals.map(function (v, i) {
        return '<button class="fc on" data-pk="' + esc(k) + '" data-vi="' + i + '">'
          + esc(d.texts[i]) + '</button>';
      }).join(''));
      L.push('<button class="fmini" data-pact="all" data-pk="' + esc(k) + '">全选</button>');
      L.push('<button class="fmini" data-pact="inv" data-pk="' + esc(k) + '">反选</button>');
      L.push('</div>');
    });
    L.push('</div>');
    L.push('</div>');
  }
  L.push('<div id="chart"></div></div>');
  L.push('<div class="card"><div class="box"><b>📐 敏感度分析方法</b><br>' + st.descHtml
    + '<br>共同随机数法：扫描时固定其他全部参数与随机种子，因此曲线差异只来自横轴（与颜色/形状）维度本身。</div></div>');
  L.push('<div class="card"><h2>📋 数据表 <button class="btn" onclick="copyTsv()">复制为 TSV（可直接粘贴到 Excel）</button>'
    + '<span id="copyNote" style="color:var(--accent2);font-size:.72rem"></span></h2>');
  L.push('<table id="tbl"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>');
  // ===== 参数展示(2026-08-26 初版 / 2026-08-31 批次跟随改造) =====
  // 原先只把 JSON 原文塞 <pre> 里 —— 拿到图的人根本读不懂 `"pDtype":"1"` 是什么。
  // 现改为**按平台的分区分组 + 中文标签 + 可读值**呈现, 原始 JSON 折叠保留(复现用)。
  //
  // ★ 2026-08-31: 多批次导出时, 参数区原先只渲染 st(当前快照)一份且**不随批次切换** ——
  //   用户点「批次 #8」后看到的仍是第 1 批的参数(实测困惑)。现把**每个快照**的参数区
  //   HTML 都在生成时各自渲染好, 烧进 SNAP_PARAMS_HTML; 点批次 chip 时整段换入 #pWrap。
  // paramsInnerOf: 渲染一个快照的参数区内部 HTML(分组网格 + 原始JSON块), 返回 {inner, count}
  function paramsInnerOf(sn) {
    let pMeta = sn.paramMeta || {};
    let pData = {};
    try { pData = JSON.parse(sn.paramsJson); } catch (e) { pData = {}; }
    let pKeys = Object.keys(pData).filter(function (k) { return k.charAt(0) !== '_' && k !== 'workload'; });
    // 有元信息才分组; 老快照(无 paramMeta)安全降级为纯 JSON
    let hasMeta = pKeys.some(function (k) { return pMeta[k]; });
    const context = reportSnapshotContext(sn);
    let B = ['<div class="pgrp"><h3>负载来源与有效实验快照</h3>'
      + '<p>来源：' + esc(context.source) + ' · 状态：' + esc(context.state?.truncated ? '截断' : context.state?.terminationReason || '见快照') + '</p>'
      + '<pre>' + esc(JSON.stringify(context, null, 2)) + '</pre></div>'];
    if ((sn.points || []).length) {
      B.push('<details class="pgrp"><summary>逐点有效配置、窗口与状态（' + sn.points.length + ' 点）</summary><pre>'
        + esc(JSON.stringify(sn.points.map(point => ({ params: point.params, ...reportSnapshotContext(sn, point) })), null, 2)) + '</pre></details>');
    }
    if (hasMeta) {
      // 值渲染: select 取 option 文本(而非 "1"/"gqa"), bool 取 开/关, 数字加千分位
      let fmtVal = function (id, v) {
        let m = pMeta[id];
        if (!m) return { text: String(v), off: false };
        if (m.kind === 'bool') return { text: (v === true || v === 'true') ? '✓ 开' : '— 关', off: !(v === true || v === 'true') };
        if (m.kind === 'select') {
          let t = (m.opts && m.opts[String(v)] != null) ? m.opts[String(v)] : String(v);
          return { text: t === '' ? '(无)' : t, off: false };
        }
        if (m.kind === 'num') {
          let n = Number(v);
          if (!isFinite(n)) return { text: String(v), off: false };
          // 大整数加千分位(128000 → 128,000); 小数保留原样避免精度误导
          let t = (Math.abs(n) >= 10000 && n === Math.round(n))
            ? n.toLocaleString('en-US') : String(v);
          return { text: t, off: (n === 0) };
        }
        let s = String(v);
        return { text: s.length > 34 ? s.slice(0, 33) + '…' : (s === '' ? '(空)' : s), off: s === '' };
      };
      // 是否非默认: defaultValue/defaultChecked 与当前值比较。
      // ⚠️ 数字要按数值比(defaultValue 是字符串 "80", 而 JSON 里可能是 "80" 也可能是 80)
      let isMod = function (id, v) {
        let m = pMeta[id];
        if (!m || m.def === undefined) return false;
        if (m.kind === 'bool') return (!!v) !== (!!m.def);
        if (m.kind === 'num') {
          let a = Number(v), b = Number(m.def);
          return (isFinite(a) && isFinite(b)) ? (a !== b) : (String(v) !== String(m.def));
        }
        return String(v) !== String(m.def);
      };
      // ★ 多行文本(策略 DSL)不进网格 —— 它有十几行, 塞进 215px 的卡片只能截断成
      //   "ADMIT: always EVICT: l…", 等于没展示。单独成块用 <pre> 显示全文。
      let longKeys = pKeys.filter(function (k) {
        return String(pData[k] == null ? '' : pData[k]).indexOf('\n') >= 0;
      });
      let gridKeys = pKeys.filter(function (k) { return longKeys.indexOf(k) < 0; });
      // 分组: 保持**首次出现顺序**(= 平台页面上从上到下的顺序), 读者的视觉顺序才一致
      let groups = [], gIdx = {};
      gridKeys.forEach(function (k) {
        let sec = (pMeta[k] && pMeta[k].sec) || '其他参数';
        if (gIdx[sec] == null) { gIdx[sec] = groups.length; groups.push({ sec: sec, ids: [] }); }
        groups[gIdx[sec]].ids.push(k);
      });
      B.push('<div id="pView">');
      groups.forEach(function (g) {
        let nMod = g.ids.filter(function (k) { return isMod(k, pData[k]); }).length;
        B.push('<div class="pgrp"><h3>' + esc(g.sec)
          + '<i>' + g.ids.length + ' 项' + (nMod ? ' · ' + nMod + ' 项已改' : '') + '</i></h3>');
        B.push('<div class="pgrid">');
        g.ids.forEach(function (k) {
          let m = pMeta[k] || {};
          let fv = fmtVal(k, pData[k]);
          let mod = isMod(k, pData[k]);
          // title 里带上 id 与默认值 —— 便于对照平台/回填, 又不占版面
          let tip = k + (m.def !== undefined && m.def !== '' ? '  (默认 ' + m.def + ')' : '');
          B.push('<div class="pf' + (mod ? ' mod' : '') + '" title="' + esc(tip) + '">'
            + '<span class="pk">' + esc(m.label || k) + '</span>'
            + '<span class="pv' + (fv.off ? ' off' : '') + '">' + esc(fv.text) + '</span></div>');
        });
        B.push('</div></div>');
      });
      // 多行文本(策略 DSL)单独成块 —— 用 <pre> 保留换行与缩进, 这是调度语义的核心,
      // 比任何单个数字都重要, 值得占版面
      longKeys.forEach(function (k) {
        let m = pMeta[k] || {};
        // 无 label 时给个友好名(sDsl 是策略 DSL 全文, 平台里那个 textarea 确实无 label)
        let nm = (m.label && m.label !== k) ? m.label
          : (k === 'sDsl' ? '📜 策略 DSL（调度语义）' : k);
        let nLine = String(pData[k]).split('\n').length;
        B.push('<div class="pgrp"><h3>' + esc(nm) + '<i>' + nLine + ' 行'
          + (m.sec ? ' · ' + m.sec : '') + '</i></h3>');
        B.push('<pre style="max-height:160px">' + esc(String(pData[k])) + '</pre></div>');
      });
      B.push('</div>');
    }
    // 原始 JSON: 默认折叠(hasMeta 时), 无元信息时直接展开 —— 保证任何情况下都能复现
    B.push('<div id="pJson"' + (hasMeta ? ' style="display:none"' : '') + '>');
    B.push('<p style="font-size:.71rem;color:var(--text-dim);margin:0 0 6px">'
      + (context.source === 'replay'
        ? '可复制回平台恢复参数；必须重新选择并核验 bundle 后再运行。此配置仅含摘要，不是独立可复现包。'
        : '可全选复制后粘回平台「导入参数」恢复本次扫描参数。') + '</p>');
    B.push('<pre>' + esc(sn.paramsJson) + '</pre></div>');
    return {
      inner: B.join('\n'),
      count: '共 ' + pKeys.length + ' 项'
        + (hasMeta ? ' · <span style="border-left:3px solid var(--accent2);padding-left:5px">左侧色条 = 非默认值</span>' : ''),
      hasMeta: hasMeta
    };
  }
  // 每个批次各自的参数区 HTML(无 paramsJson 的老快照给占位说明)
  let snapParamsHtml = snaps.map(function (sn) {
    if (!sn.paramsJson) {
      return { html: '<p style="font-size:.75rem;color:var(--text-dim);margin:4px 0">该批次无可回填参数配置；以下为保存的实验元信息。</p><pre>'
        + esc(JSON.stringify(reportSnapshotContext(sn), null, 2)) + '</pre>', count: '该批次无参数快照' };
    }
    let r = paramsInnerOf(sn);
    return { html: r.inner, count: r.count };
  });
  let stParams = st.paramsJson ? paramsInnerOf(st) : null;
  // 卡片渲染条件: st 或任一批次有参数快照(st 可能不在勾选列表里, 与初始图 = st.opt 同语义)
  let anyParams = stParams || snapParamsHtml.some(function (x) { return x.html; });
  if (anyParams) {
    let ini = stParams || snapParamsHtml[0];
    let iniInner = stParams ? stParams.inner : snapParamsHtml[0].html;
    let iniCount = stParams ? stParams.count : snapParamsHtml[0].count;
    L.push('<div class="card"><h2>🔧 参数配置'
      + '<span id="pCount" style="font-size:.7rem;color:var(--text-dim);font-weight:400">' + iniCount + '</span>'
      + (multi ? '<span style="font-size:.7rem;color:var(--text-dim);font-weight:400"> · 随批次切换</span>' : '')
      + '<button class="ptog" id="pJsonTog" style="margin-left:auto">{ } 原始 JSON</button></h2>');
    L.push('<div id="pWrap">' + iniInner + '</div>');
    L.push('</div>');
  }
  L.push('<p class="foot">由 KV Cache 建模分析平台导出 · 图表交互（tooltip / 图例开关 / 缩放'
    + (hasSwitch ? ' / 指标切换' : '')
    + (hasPivot ? ' / 参数筛选与角色切换' : '')
    + '）需联网加载 echarts；离线时数据表仍完整可用'
    + (multi ? ' · 本文件含 ' + snaps.length + ' 次扫描的数据' : '') + '</p>');
  L.push('</div>');
  L.push('<script>');
  L.push('var OPT = ' + safeJson(opt) + ';');
  // ---- 指标切换的三份数据(2026-08-25) ----
  // METRIC_DATA[key][seriesIndex][pointIndex] = 数值(已 toFixed(1), 与平台绘图同口径)
  // 无切换能力时(老快照/单指标)这三份为空, 页内逻辑走 hasSwitch=false 分支
  L.push('var METRIC_DATA = ' + safeJson(metricData) + ';');
  L.push('var METRIC_LABEL = ' + safeJson((function () {
    let m = {}; metricKeys.forEach(function (k) { m[k] = SENS_METRIC_LABEL[k]; }); return m;
  })()) + ';');
  L.push('var CUR_METRIC = ' + safeJson(st.metric) + ';');
  L.push('var X_LABEL = ' + safeJson(st.paramLabel) + ';');
  // IS_MULTI: 多曲线(有颜色/形状维) ⇒ series.name 是"档位·形状"标签, 切指标时**不能**改;
  //           单曲线 ⇒ series.name 本身就是指标名(平台绘图口径), 切指标时必须同步改。
  L.push('var IS_MULTI = ' + (st.isMulti ? 'true' : 'false') + ';');
  // ---- 堆叠柱所需的四份数据(2026-08-26) ----
  // 折线与堆叠柱是**两种结构**(前者 [曲线][点] 二维 + labels 轴; 后者一维拉平 + 场景轴),
  // 所以导出页必须同时持有两套 x 轴标签、两套 series 模板, 切换时整体重建 series。
  L.push('var STACK_KEY = ' + safeJson(TTFT_STACK_KEY) + ';');
  L.push('var STACK_PARTS = ' + safeJson(canStack ? stackParts : []) + ';');
  L.push('var STACK_DATA = ' + safeJson(canStack ? stackData : {}) + ';');
  L.push('var STACK_TOTALS = ' + safeJson(canStack ? stackTotals : []) + ';');
  L.push('var STACK_LABELS = ' + safeJson(canStack ? stackLabels : []) + ';');
  L.push('var LINE_LABELS = ' + safeJson(st.labels || []) + ';');
  // LINE_TPL: 折线样式模板。堆叠柱状态下导出时 OPT.series 里只有 bar, 折线的
  // 名称/配色/符号全丢 ⇒ 必须靠模板还原(见平台侧 lineTpl 注释)
  L.push('var LINE_TPL = ' + safeJson(st.lineTpl || []) + ';');
  L.push('var CUR_IS_STACK = ' + (st.stackMode && canStack ? 'true' : 'false') + ';');
  // 折线模式下的轴名(切回折线时恢复); 堆叠柱固定用"TTFT 构成(ms)"
  L.push('var LINE_X_NAME = ' + safeJson(st.paramLabel) + ';');
  L.push('var STACK_X_NAME = ' + safeJson((st.lineTpl && st.lineTpl.length > 1)
    ? (st.paramLabel + ' × 场景') : st.paramLabel) + ';');
  // ---- 原图投影(2026-08-27 简化) ----
  // CURVE_COORDS[i] = 第 i 条曲线的 (ci,pi) 坐标。SEL 是旧「维度筛选」的勾选状态,
  // 该 UI 已下线(能力被透视勾选覆盖) ⇒ SEL 恒为 null, viewXIdx/viewCurves 退化为
  // 恒等投影(全部保留)。投影函数本身保留 —— 原图渲染(折线/堆叠柱/数据表)仍走它们。
  L.push('var CURVE_COORDS = ' + safeJson(st.curveCoords || []) + ';');
  L.push('var SEL = {x:null,cmp:null,shape:null};');
  // 重建 tooltip formatter: 与平台内实现等价(图例小图标随 series.symbol 变化)
  L.push('function symbolMarker(sym,color){');
  L.push('  var W=\'width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle;margin-right:5px;flex:none"\';');
  L.push('  if(sym==="square") return "<svg "+W+"><rect x=\\"1\\" y=\\"1\\" width=\\"8\\" height=\\"8\\" fill=\\""+color+"\\"/></svg>";');
  L.push('  if(sym==="triangle") return "<svg "+W+"><polygon points=\\"5,1 9,9 1,9\\" fill=\\""+color+"\\"/></svg>";');
  L.push('  if(sym==="diamond") return "<svg "+W+"><polygon points=\\"5,1 9,5 5,9 1,5\\" fill=\\""+color+"\\"/></svg>";');
  L.push('  if(sym==="roundRect") return "<svg "+W+"><rect x=\\"1\\" y=\\"1\\" width=\\"8\\" height=\\"8\\" rx=\\"3\\" fill=\\""+color+"\\"/></svg>";');
  L.push('  if(sym==="pin") return "<svg "+W+"><path d=\\"M5 1C3 1 1.6 2.4 1.6 4.3C1.6 6.3 5 9 5 9S8.4 6.3 8.4 4.3C8.4 2.4 7 1 5 1Z\\" fill=\\""+color+"\\"/></svg>";');
  L.push('  return "<svg "+W+"><circle cx=\\"5\\" cy=\\"5\\" r=\\"4\\" fill=\\""+color+"\\"/></svg>";');
  L.push('}');
  L.push('OPT.tooltip = OPT.tooltip || {}; OPT.tooltip.trigger = "axis";');
  L.push('OPT.tooltip.formatter = function(ps){');
  L.push('  if(!ps||!ps.length) return "";');
  L.push('  var h = "<div style=\\"font-weight:600;margin-bottom:4px\\">"+(ps[0].axisValueLabel||ps[0].name)+"</div>";');
  // 堆叠柱: 显示 分量/绝对值/占比 + 合计行(与平台内 tooltip 逐字等价)
  L.push('  if(CUR_IS_STACK){');
  L.push('    var valid = ps.every(function(p){ return typeof p.value === "number" && isFinite(p.value); });');
  L.push('    if(!valid) return h + "无完整样本（—）";');
  L.push('    var tot = 0; ps.forEach(function(p){ tot += p.value; });');
  L.push('    ps.forEach(function(p){');
  L.push('      var v = p.value, pct = tot>0 ? (100*v/tot) : 0;');
  L.push('      h += "<div style=\\"display:flex;align-items:center;line-height:18px\\">"');
  L.push('        + "<span style=\\"display:inline-block;width:9px;height:9px;border-radius:2px;background:"+p.color+";margin-right:6px;flex:none\\"></span>"');
  L.push('        + "<span style=\\"color:#9ca0b0;margin-right:10px\\">"+p.seriesName+"</span>"');
  L.push('        + "<span style=\\"margin-left:auto\\"><b style=\\"color:#e4e4e7\\">"+v.toFixed(1)+"</b>"');
  L.push('        + "<span style=\\"color:#9ca0b0\\"> ms · "+pct.toFixed(1)+"%</span></span></div>";');
  L.push('    });');
  L.push('    h += "<div style=\\"border-top:1px solid #2e3347;margin-top:4px;padding-top:4px;display:flex;line-height:18px\\">"');
  L.push('      + "<span style=\\"color:#9ca0b0;margin-right:10px\\">TTFT 合计</span>"');
  L.push('      + "<span style=\\"margin-left:auto;font-weight:600;color:#e4e4e7\\">"+tot.toFixed(1)+" ms</span></div>";');
  L.push('    return h;');
  L.push('  }');
  L.push('  ps.forEach(function(p){');
  L.push('    var sym = (OPT.series[p.seriesIndex]&&OPT.series[p.seriesIndex].symbol)||"circle";');
  L.push('    h += "<div style=\\"display:flex;align-items:center;line-height:18px\\">"+symbolMarker(sym,p.color)');
  L.push('      + "<span style=\\"color:#9ca0b0;margin-right:8px\\">"+p.seriesName+"</span>"');
  L.push('      + "<span style=\\"margin-left:auto;color:#9ca0b0\\">"+(p.value==null?"—":p.value)+"</span></div>";');
  L.push('  });');
  L.push('  return h;');
  L.push('};');
  // 导出页额外给一个工具栏(平台内没有, 这里方便二次保存图片)
  // saveAsImage 的文件名随当前指标变 ⇒ 连切几个指标各存一张图不会互相覆盖
  L.push('OPT.toolbox = {right:8,top:0,feature:{saveAsImage:{title:"保存为图片",name:"敏感性_"+(METRIC_LABEL[CUR_METRIC]||"").replace(/[\\/:*?"<>|()\\s]+/g,""),pixelRatio:2,backgroundColor:"#1a1d27"},dataZoom:{title:{zoom:"区域缩放",back:"还原"}},restore:{title:"还原"}},iconStyle:{borderColor:"#9ca0b0"}};');
  L.push('var ch = null;');
  L.push('if(window.echarts){ ch = echarts.init(document.getElementById("chart")); ch.setOption(OPT);');
  L.push('  window.addEventListener("resize", function(){ try{ch.resize()}catch(e){} }); }');
  L.push('else { document.getElementById("chart").innerHTML = "<div style=\\"padding:24px;color:#9ca0b0;font-size:.82rem\\">⚠ 未能加载 echarts（当前离线？）——图表无法渲染，但下方数据表完整可用。</div>"; }');
  // ---- 切换指标: 只换 series.data 与 yAxis.name, 不动颜色/形状/图例 ----
  // 用 setOption 的**增量合并**(不传 notMerge) ⇒ 用户已做的图例开关/缩放状态不被重置。
  // 单曲线场景平台会开 label.show(数值直接标在点上), 增量合并保留该设置, 无需特殊处理。
  // ⚠️ 例外: 折线 ↔ 堆叠柱互切时 series 的**数量与类型都变**, 增量合并会残留旧 series
  //    (echarts 按索引合并, 多出来的旧 series 不会消失) ⇒ 该情况必须走 notMerge=true 全量重建。
  //
  // renderTable(2026-08-26 改造): 从"就地改数值"升级为"整表重建" ——
  // 折线表(行=档位, 列=曲线)与堆叠柱表(行=场景, 列=6分量+合计)行列数都不同,
  // 就地改数值只能应付前者。重建 thead+tbody 才能两种结构互切。
  L.push('function esc2(t){ return String(t==null?"":t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }');
  // ===== 筛后视图投影(2026-08-26) =====
  // 筛选只做"减法": 不重算仿真, 只从已有数据里挑出勾选的曲线与横轴档位。
  // 三个投影函数是所有绘图/建表的**唯一数据入口**, 保证图与表永远一致:
  //   viewXIdx()    → 保留的横轴档位下标数组
  //   viewCurves()  → 保留的曲线下标数组(按 CURVE_COORDS 的 ci/pi 是否在 SEL 里判定)
  //   viewSceneIdx()→ 保留的堆叠柱场景下标数组(场景 = 曲线 × 档位, 两者都要过筛)
  // ⚠️ 用**下标**判定而非解析曲线名: 名字里的 ' · ' 分隔符与档位标签可能撞车, 解析不可靠。
  L.push('function inSel(dim, idx){');
  L.push('  if(idx < 0) return true;');                    // 该维度不存在 ⇒ 恒通过
  L.push('  var s = SEL[dim]; if(!s) return true;');
  L.push('  return s.indexOf(idx) >= 0;');
  L.push('}');
  L.push('function viewXIdx(){');
  // x 维度恒存在(横轴就是它) ⇒ 直接按下标查 SEL.x, 无需 inSel 的 -1 兜底
  L.push('  var n = LINE_LABELS.length, out = [];');
  L.push('  for(var i=0;i<n;i++) if(!SEL.x || SEL.x.indexOf(i)>=0) out.push(i);');
  L.push('  return out;');
  L.push('}');
  L.push('function viewCurves(){');
  L.push('  var out = [];');
  L.push('  for(var i=0;i<LINE_TPL.length;i++){');
  L.push('    var c = CURVE_COORDS[i] || {ci:-1,pi:-1};');
  L.push('    if(inSel("cmp", c.ci) && inSel("shape", c.pi)) out.push(i);');
  L.push('  }');
  L.push('  return out;');
  L.push('}');
  // 场景下标 = 曲线序 × 档位序 的行主序展开(与平台侧 sceneLabels 生成规则一致)
  L.push('function viewSceneIdx(){');
  L.push('  var nPt = LINE_LABELS.length, keepC = viewCurves(), keepX = viewXIdx(), out = [];');
  L.push('  for(var a=0;a<keepC.length;a++) for(var b=0;b<keepX.length;b++)');
  L.push('    out.push(keepC[a]*nPt + keepX[b]);');
  L.push('  return out;');
  L.push('}');
  // 筛选后若只剩 1 条曲线, 场景名里的"· 维度组合"后缀就成了每根柱重复的冗余 ⇒ 去掉,
  // 让横轴回到干净的档位名(这正是"固定 GPU 单独看带宽"想要的效果)
  L.push('function sceneLabelAt(i){');
  L.push('  var lb = STACK_LABELS[i]||"";');
  L.push('  if(viewCurves().length === 1){');
  L.push('    var nPt = LINE_LABELS.length;');
  L.push('    return LINE_LABELS[i % nPt] || lb;');
  L.push('  }');
  L.push('  return lb;');
  L.push('}');
  //
  // renderTable(2026-08-26 改造): 从"就地改数值"升级为"整表重建" ——
  // 折线表(行=档位, 列=曲线)与堆叠柱表(行=场景, 列=6分量+合计)行列数都不同,
  // 就地改数值只能应付前者。重建 thead+tbody 才能两种结构互切。
  // 再次改造: 行列都取**筛后视图**, 表与图始终一致(否则筛完图变了表没变, 更误导)。
  L.push('function renderTable(){');
  L.push('  var tbl = document.getElementById("tbl"); if(!tbl) return;');
  L.push('  var th = tbl.querySelector("thead"), tb = tbl.querySelector("tbody");');
  L.push('  if(!th||!tb) return;');
  L.push('  if(CUR_IS_STACK){');
  L.push('    var sIdx = viewSceneIdx();');
  L.push('    th.innerHTML = "<tr><th>场景</th>" + STACK_PARTS.map(function(p){ return "<th>"+esc2(p.label)+"</th>"; }).join("") + "<th>TTFT合计</th></tr>";');
  L.push('    tb.innerHTML = sIdx.map(function(i){');
  L.push('      return "<tr><td class=\\"k\\">"+esc2(sceneLabelAt(i))+"</td>"');
  L.push('        + STACK_PARTS.map(function(p){ var v=(STACK_DATA[p.key]||[])[i]; return "<td>"+esc2(v==null?"—":v)+"</td>"; }).join("")');
  L.push('        + "<td><b>"+esc2(STACK_TOTALS[i]==null?"—":STACK_TOTALS[i])+"</b></td></tr>";');
  L.push('    }).join("");');
  L.push('    return;');
  L.push('  }');
  L.push('  var cols = METRIC_DATA[CUR_METRIC]; if(!cols) return;');
  // 折线表的表头 = 横轴名 + 各曲线名(单曲线时曲线名 = 当前指标名, 故需重建而非只改数值)
  L.push('  var lb = METRIC_LABEL[CUR_METRIC]||CUR_METRIC;');
  L.push('  var keepC = viewCurves(), keepX = viewXIdx();');
  L.push('  th.innerHTML = "<tr><th>"+esc2(LINE_X_NAME)+"</th>"');
  L.push('    + keepC.map(function(ci){ return "<th>"+esc2(IS_MULTI ? LINE_TPL[ci].name : lb)+"</th>"; }).join("") + "</tr>";');
  L.push('  tb.innerHTML = keepX.map(function(xi){');
  L.push('    return "<tr><td class=\\"k\\">"+esc2(LINE_LABELS[xi])+"</td>"');
  L.push('      + keepC.map(function(ci){ var v=(cols[ci]||[])[xi]; return "<td>"+esc2(v!=null?v:"—")+"</td>"; }).join("") + "</tr>";');
  L.push('  }).join("");');
  L.push('}');
  // buildStackSeries / buildLineSeries: 两种图形的 series 构造器(与平台侧逐字对应)
  // 均已改为按筛后视图取数
  L.push('function buildStackSeries(){');
  L.push('  var sIdx = viewSceneIdx();');
  L.push('  var ss = STACK_PARTS.map(function(p){');
  L.push('    var src = STACK_DATA[p.key]||[];');
  L.push('    return {name:p.label, type:"bar", stack:"ttft", barMaxWidth:48,');
  L.push('      itemStyle:{color:p.color}, emphasis:{focus:"series"},');
  L.push('      data:sIdx.map(function(i){ return src[i]; })};');
  L.push('  });');
  // 总计标签只挂最后一个 series(堆叠柱 position:"top" 仅顶层可见), 与平台一致
  // ⚠️ formatter 的 dataIndex 是**筛后**下标 ⇒ 必须经 sIdx 映射回原始下标再取 TOTALS
  L.push('  if(ss.length){ ss[ss.length-1].label = {show: sIdx.length<=24, position:"top",');
  L.push('    color:"#e4e4e7", fontSize:9, fontWeight:600, formatter:function(p){');
  L.push('      var t = STACK_TOTALS[sIdx[p.dataIndex]]; if(t==null) return "";');
  L.push('      return t>=10000 ? (t/1000).toFixed(1)+"s" : t.toFixed(0); }}; }');
  L.push('  return ss;');
  L.push('}');
  L.push('function buildLineSeries(k){');
  L.push('  var cols = METRIC_DATA[k]||[], lb = METRIC_LABEL[k]||k;');
  L.push('  var keepX = viewXIdx();');
  L.push('  return viewCurves().map(function(ci){');
  L.push('    var s = JSON.parse(JSON.stringify(LINE_TPL[ci]));');
  L.push('    if(!IS_MULTI) s.name = lb;');
  L.push('    var src = cols[ci]||[];');
  L.push('    s.data = keepX.map(function(xi){ return src[xi]; });');
  L.push('    return s;');
  L.push('  });');
  L.push('}');
  // 筛后 x 轴标签
  L.push('function viewXLabels(){ return viewXIdx().map(function(i){ return LINE_LABELS[i]; }); }');
  L.push('function viewSceneLabels(){ return viewSceneIdx().map(sceneLabelAt); }');
  L.push('function applyMetric(k){');
  // ★ 透视模式下切指标必须仍走透视渲染(2026-08-28): 原实现没有 PV_ON 分支,
  //   透视中点指标 chip 会把图表静默画回**原始批次视图**(fbar 还亮着 live 色条,
  //   用户以为在看透视结果)。这里拦截: 只换纵轴口径, 数据仍按当前角色/勾选投影。
  L.push('  if(typeof PV_ON!=="undefined" && PV_ON){');
  L.push('    var toStackP = (k===STACK_KEY);');
  L.push('    if(toStackP ? !STACK_PARTS.length : !METRIC_DATA[k]) return;');
  L.push('    CUR_METRIC = k; CUR_IS_STACK = toStackP;');
  L.push('    var lbP = METRIC_LABEL[k]||k;');
  L.push('    var selP = document.getElementById("mSel"); if(selP && selP.value!==k) selP.value = k;');
  L.push('    var chipsP = document.querySelectorAll(".chip[data-m]");');
  L.push('    for(var ci2=0;ci2<chipsP.length;ci2++){ chipsP[ci2].className = "chip" + (chipsP[ci2].getAttribute("data-m")===k ? " on" : ""); }');
  L.push('    var dyP = document.getElementById("dimY"); if(dyP) dyP.textContent = lbP;');
  L.push('    document.title = "参数敏感性 · " + X_LABEL + " → " + lbP;');
  L.push('    pvRebuild();');
  L.push('    return;');
  L.push('  }');
  // 堆叠柱与折线的数据源不同: 前者查 STACK_PARTS 是否可用, 后者查 METRIC_DATA
  L.push('  var toStack = (k===STACK_KEY);');
  L.push('  if(toStack ? !STACK_PARTS.length : !METRIC_DATA[k]) return;');
  L.push('  var wasStack = CUR_IS_STACK;');
  L.push('  CUR_METRIC = k; CUR_IS_STACK = toStack;');
  L.push('  var lb = METRIC_LABEL[k]||k;');
  L.push('  if(ch){');
  L.push('    if(toStack !== wasStack){');
  // ★ 类型切换: series 数量/类型/x轴长度全变 ⇒ 必须 notMerge 全量重建。
  //   这是唯一允许 notMerge 的路径(会重置图例开关/缩放, 但结构已变, 保留旧状态反而错乱)。
  //   2026-08-26: 具体重建逻辑抽到 rebuildAll(), 与「维度筛选」共用同一份 —— 否则两处
  //   各写一遍 rotate/zoom/grid 规则, 改一处忘另一处必然漂移。
  L.push('      rebuildAll(k);');
  L.push('    } else if(toStack){');
  // 堆叠柱内部无需重绘(数据不随 metric 变) —— 但仍要走后续 UI 同步
  L.push('    } else {');
  // 同类型(折线→折线): 走增量补丁, 保留用户的图例开关/缩放
  // ⚠️ 补丁必须按**筛后视图**取数, 否则筛选后切指标会把被筛掉的点又带回来
  L.push('      var cols = METRIC_DATA[k], keepX = viewXIdx(), keepC = viewCurves();');
  L.push('      var ns = keepC.map(function(ci,i){');
  L.push('        var src = cols[ci]||[];');
  L.push('        var patch = {data: keepX.map(function(xi){ return src[xi]; })};');
  L.push('        if(!IS_MULTI){ patch.name = lb; if(OPT.series[i]) OPT.series[i].name = lb; }');
  L.push('        if(OPT.series[i]) OPT.series[i].data = patch.data.slice();');
  L.push('        return patch;');
  L.push('      });');
  L.push('      OPT.yAxis.name = lb;');
  L.push('      ch.setOption({series: ns, yAxis: {name: lb}});');
  L.push('    }');
  L.push('    try{ ch.setOption({toolbox:{feature:{saveAsImage:{name:"敏感性_"+lb.replace(/[\\/:*?"<>|()\\s]+/g,"")}}}}); }catch(e){}');
  L.push('  }');
  L.push('  var dy = document.getElementById("dimY"); if(dy) dy.textContent = lb;');
  L.push('  document.title = "参数敏感性 · " + X_LABEL + " → " + lb;');
  L.push('  var sel = document.getElementById("mSel"); if(sel && sel.value!==k) sel.value = k;');
  L.push('  var chips = document.querySelectorAll(".chip[data-m]");');
  L.push('  for(var i=0;i<chips.length;i++){ chips[i].className = "chip" + (chips[i].getAttribute("data-m")===k ? " on" : ""); }');
  L.push('  renderTable();');
  L.push('}');
  // ===== rebuildAll: 按当前 CUR_IS_STACK **全量重建** option =====
  // 被两处调用: ①applyMetric 的类型切换分支 ②透视退出时还原原图。
  // 两者都改变 series 数量/x轴长度 ⇒ 都必须 notMerge, 逻辑完全一致, 故合并成一处。
  L.push('function rebuildAll(k){');
  L.push('  if(!ch) return;');
  L.push('  k = k || CUR_METRIC;');
  L.push('  var toStack = CUR_IS_STACK, lb = METRIC_LABEL[k]||k;');
  L.push('  var xs = toStack ? viewSceneLabels() : viewXLabels();');
  L.push('  var nSc = xs.length;');
  L.push('  var rot = toStack ? (nSc>10?30:(nSc>6?20:0)) : 0;');
  L.push('  var zoom = toStack && nSc>16;');
  L.push('  OPT.series = toStack ? buildStackSeries() : buildLineSeries(k);');
  L.push('  OPT.xAxis.data = xs;');
  // 筛到只剩 1 条曲线时, 堆叠柱横轴退回"纯档位轴" ⇒ 轴名也不该再写"× 场景"
  L.push('  OPT.xAxis.name = toStack ? ((viewCurves().length>1) ? STACK_X_NAME : LINE_X_NAME) : LINE_X_NAME;');
  L.push('  OPT.xAxis.axisLabel = OPT.xAxis.axisLabel||{};');
  L.push('  OPT.xAxis.axisLabel.rotate = rot; OPT.xAxis.axisLabel.interval = 0;');
  L.push('  OPT.xAxis.axisLabel.color = "#9ca0b0";');
  L.push('  OPT.xAxis.axisLabel.formatter = function(v){ return (CUR_IS_STACK && String(v).length>22) ? String(v).slice(0,21)+"…" : v; };');
  L.push('  OPT.yAxis.name = toStack ? "TTFT 构成(ms)" : lb;');
  // 折线筛到只剩 1 条时图例已无信息量, 但保留也无害(用户可能还想切回) ⇒ 与初始规则一致
  L.push('  OPT.legend = (toStack||IS_MULTI) ? {top:0,textStyle:{color:"#9ca0b0",fontSize:10}} : undefined;');
  L.push('  OPT.grid = {left:70,right:20,top:(toStack||IS_MULTI)?36:20,bottom: zoom?76:(rot?62:40)};');
  L.push('  OPT.tooltip.axisPointer = toStack ? {type:"shadow"} : undefined;');
  L.push('  OPT.dataZoom = zoom ? [{type:"slider",bottom:8,height:18,borderColor:"#2e3347",');
  L.push('    textStyle:{color:"#9ca0b0",fontSize:9},fillerColor:"rgba(108,99,255,.18)",startValue:0,endValue:15}] : undefined;');
  L.push('  ch.setOption(OPT, true);');
  L.push('}');
  L.push('(function(){');
  L.push('  var sel = document.getElementById("mSel");');
  L.push('  if(sel) sel.addEventListener("change", function(){ applyMetric(sel.value); });');
  L.push('  var chips = document.querySelectorAll(".chip[data-m]");');
  L.push('  for(var i=0;i<chips.length;i++){ (function(c){ c.addEventListener("click", function(){ applyMetric(c.getAttribute("data-m")); }); })(chips[i]); }');
  // 初始高亮当前指标的 chip(若当前指标恰在快捷列表里)
  L.push('  for(var j=0;j<chips.length;j++){ if(chips[j].getAttribute("data-m")===CUR_METRIC) chips[j].className="chip on"; }');
  // 键盘 ←/→ 在指标列表里前后切换 —— 汇报时不用回鼠标点下拉
  L.push('  var keys = Object.keys(METRIC_LABEL);');
  L.push('  if(keys.length>1) document.addEventListener("keydown", function(e){');
  L.push('    if(e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;');
  L.push('    var d = (e.key==="ArrowRight")?1:((e.key==="ArrowLeft")?-1:0); if(!d) return;');
  L.push('    var i = keys.indexOf(CUR_METRIC); if(i<0) i=0;');
  L.push('    applyMetric(keys[(i+d+keys.length)%keys.length]); e.preventDefault();');
  L.push('  });');
  L.push('})();');
  // ======================== 参数透视引擎(2026-08-27) ========================
  // 核心思想(用户提出): 存储不区分横轴/颜色/形状, 展示时动态分配。
  //   PIVOT_PTS[i] = {p: {参数key: 值}, r: {全指标}, s: 来源批次}
  // 于是「颜色=命中率 形状=输入长度」与「颜色=输入长度 形状=命中率」只是同一份点云的
  // 两种投影 —— 无需重跑, 页内下拉一换即可。
  L.push('var PIVOT_PTS = ' + safeJson(pivotPts) + ';');
  L.push('var PIVOT_IDX = ' + safeJson(hasPivot ? pivotIndex : {}) + ';');
  L.push('var PIVOT_DIMS = ' + safeJson(hasPivot ? pivotDims : []) + ';');
  L.push('var HAS_PIVOT = ' + (hasPivot ? 'true' : 'false') + ';');
  L.push('var SNAP_META = ' + safeJson(snapMeta) + ';');
  // 每个批次的参数区 HTML(批次切换时整段换入 #pWrap; 2026-08-31)
  L.push('var SNAP_PARAMS_HTML = ' + safeJson(snapParamsHtml) + ';');
  // 面板待机时的提示文案(含点云规模信息) —— pvToggle(false) 退回原图时也恢复成它
  L.push('var PV_HINT = ' + safeJson(pivHint + ' —— 改动任一项即按所选角色重绘') + ';');
  L.push('var PV_ON = false, PV_SNAPSHOT = null;');
  // PV_SEL[参数key] = 勾选的取值下标数组(初始全选)
  L.push('var PV_SEL = {};');
  L.push('var PV_ROLE = {x:null,c:null,s:null};');
  L.push('var PV_PALETTE = ["#6c63ff","#f59e0b","#10b981","#ef4444","#06b6d4","#8b5cf6","#84cc16"];');
  L.push('var PV_SYMBOLS = ["circle","square","triangle","diamond","roundRect","pin"];');
  if (hasPivot) {
    L.push('(function(){ Object.keys(PIVOT_IDX).forEach(function(k){');
    L.push('  PV_SEL[k] = PIVOT_IDX[k].vals.map(function(_,i){ return i; }); }); })();');
  }
  // ---- 投影: 按当前角色分配 + 勾选状态, 从点云生成"曲线列表" ----
  // 返回 {xs:[横轴显示标签], xv:[横轴原始值], curves:[{name,ci,pi,vals:{横轴值→rec}}]}
  // ⚠️ 关键设计: 曲线的身份 = (颜色值, 形状值) 二元组; 未指定的角色视为单一空值。
  //   其余参数(既非横轴也非颜色/形状)只参与**过滤**, 不参与分组 —— 若它们仍有多个取值,
  //   同一 (x,颜色,形状) 会对应多个点, 此时取平均并计数(pvAvgN), 由提示告知用户。
  L.push('function pvProject(){');
  L.push('  var kx = PV_ROLE.x, kc = PV_ROLE.c, ks = PV_ROLE.s;');
  L.push('  if(!kx || !PIVOT_IDX[kx]) return null;');
  // 1) 过滤: 每个参数都要落在其勾选集合内(未在 PV_SEL 里的参数不过滤)
  L.push('  var keep = [];');
  L.push('  for(var i=0;i<PIVOT_PTS.length;i++){');
  L.push('    var pt = PIVOT_PTS[i], ok = true;');
  L.push('    if(PV_SNAPSHOT!==null && (pt.snapshots||[pt.s]).indexOf(PV_SNAPSHOT)<0) continue;');
  L.push('    for(var k in PV_SEL){');
  L.push('      var idx = PIVOT_IDX[k]; if(!idx) continue;');
  L.push('      var v = pt.p[k]; if(v===undefined) continue;');
  // 值→下标: 用 String 比较避免 1 与 "1" 的类型差异(JSON 往返后数值可能变字符串)
  L.push('      var vi = -1; for(var q=0;q<idx.vals.length;q++){ if(String(idx.vals[q])===String(v)){ vi=q; break; } }');
  L.push('      if(vi>=0 && PV_SEL[k].indexOf(vi)<0){ ok=false; break; }');
  L.push('    }');
  L.push('    if(ok) keep.push(pt);');
  L.push('  }');
  L.push('  if(!keep.length) return {xs:[],xv:[],curves:[],avgN:0,n:0};');
  // 2) 横轴取值: 只取过滤后**实际存在**的档位(升序), 不是索引表的全部
  L.push('  var xset = {}; keep.forEach(function(pt){ if(pt.p[kx]!==undefined) xset[pt.p[kx]] = true; });');
  L.push('  var xv = Object.keys(xset);');
  // 横轴取值排序: 与平台侧 pivotIndex 用**同一判据** —— 看实际取值能否转数值,
  // 不硬编码参数名(否则新增字符串维度时这里会把它 Number() 成空数组, 横轴直接消失)
  L.push('  var xNum = xv.every(function(v){ return v!=="" && isFinite(Number(v)); });');
  L.push('  if(!xNum) xv.sort(); else xv = xv.map(Number).filter(isFinite).sort(function(a,b){return a-b;});');
  // 3) 分组: 曲线键 = 颜色值 + "\u0001" + 形状值
  L.push('  var groups = {}, order = [];');
  L.push('  keep.forEach(function(pt){');
  L.push('    var cv = kc ? pt.p[kc] : "", sv = ks ? pt.p[ks] : "";');
  L.push('    var gk = JSON.stringify([pt.g, cv, sv]);');
  L.push('    if(!groups[gk]){ groups[gk] = {cv:cv, sv:sv, group:pt.g, batch:pt.s, byX:{}}; order.push(gk); }');
  L.push('    var xk = String(pt.p[kx]);');
  L.push('    if(!groups[gk].byX[xk]) groups[gk].byX[xk] = [];');
  L.push('    groups[gk].byX[xk].push(pt.r);');
  L.push('  });');
  // 4) 曲线排序: 先按颜色值再按形状值(数值升序) —— 图例顺序要可预期, 不能随 Object 键序
  L.push('  function numOr(v){ var n = Number(v); return isFinite(n) ? n : null; }');
  L.push('  order.sort(function(a,b){');
  L.push('    var ga = groups[a], gb = groups[b];');
  L.push('    var ca = numOr(ga.cv), cb = numOr(gb.cv);');
  L.push('    if(ca!==null && cb!==null && ca!==cb) return ca-cb;');
  L.push('    if(String(ga.cv)!==String(gb.cv)) return String(ga.cv)<String(gb.cv)?-1:1;');
  L.push('    var sa = numOr(ga.sv), sb = numOr(gb.sv);');
  L.push('    if(sa!==null && sb!==null && sa!==sb) return sa-sb;');
  L.push('    return String(ga.sv)<String(gb.sv)?-1:(String(ga.sv)>String(gb.sv)?1:0);');
  L.push('  });');
  // 5) 颜色/形状下标: 同一颜色值共用一个色号(不同形状值不换色), 反之亦然 —— 这才是
  //    "颜色编码某参数、形状编码另一参数"的正确语义(否则 6 条线 6 个颜色, 维度信息丢失)
  L.push('  var cKeys = [], sKeys = [];');
  L.push('  order.forEach(function(gk){');
  L.push('    var g = groups[gk];');
  L.push('    if(cKeys.indexOf(String(g.cv))<0) cKeys.push(String(g.cv));');
  L.push('    if(sKeys.indexOf(String(g.sv))<0) sKeys.push(String(g.sv));');
  L.push('  });');
  L.push('  var avgN = 0;');
  L.push('  var curves = order.map(function(gk){');
  L.push('    var g = groups[gk];');
  L.push('    var nm = [];');
  if (pivotGroups.size > 1) L.push('    nm.push("批次 #" + (g.batch+1));');
  L.push('    if(kc) nm.push(pvFmt(kc, g.cv));');
  L.push('    if(ks) nm.push(pvFmt(ks, g.sv));');
  L.push('    var data = xv.map(function(x){');
  L.push('      var arr = g.byX[String(x)];');
  // 缺值插 null(echarts 会断线) —— 不能填 0, 那会画出一条假的"归零"曲线
  L.push('      if(!arr || !arr.length) return null;');
  L.push('      if(arr.length>1) avgN++;');
  L.push('      return arr;');
  L.push('    });');
  L.push('    return {name: nm.length?nm.join(" · "):(METRIC_LABEL[CUR_METRIC]||CUR_METRIC),');
  L.push('      ci: cKeys.indexOf(String(g.cv)), pi: sKeys.indexOf(String(g.sv)), recs: data};');
  L.push('  });');
  L.push('  return {xs: xv.map(function(x){ return pvFmt(kx, x); }), xv: xv, curves: curves,');
  L.push('    avgN: avgN, n: keep.length, nc: cKeys.length, ns: sKeys.length};');
  L.push('}');
  // pvFmt: 参数值 → 显示标签。直接查索引表里预先算好的 texts(与平台 sensParamUnit 同口径),
  // 查不到时回退原值 —— 不在页内重写一份单位规则, 避免两处漂移。
  L.push('function pvFmt(k, v){');
  L.push('  var d = PIVOT_IDX[k]; if(!d) return String(v);');
  L.push('  for(var i=0;i<d.vals.length;i++) if(String(d.vals[i])===String(v)) return d.texts[i];');
  L.push('  return String(v);');
  L.push('}');
  // ---- 透视模式下的 series 构造 ----
  // 折线与堆叠柱都支持(2026-08-28): 点云的 rec 自带六分量, 且六分量之和 == TTFT
  // (逐场景验证过恒等式); 多点平均是线性的 ⇒ 平均后恒等式仍成立, 堆叠柱高即 TTFT。
  // 场景轴 = 曲线 × 横轴档位 拉平(曲线主序, 与原图 sceneLabels 同序), 不是另一套语义。
  L.push('function pvMetricVal(recs, k){');
  L.push('  if(recs===null) return null;');
  L.push('  var arr = recs, sum = 0, n = 0;');
  L.push('  for(var i=0;i<arr.length;i++){');
  L.push('    var v = arr[i] ? arr[i][k] : null;');
  L.push('    if(v!=null && isFinite(v)){ sum += Number(v); n++; }');
  L.push('  }');
  L.push('  return n ? +(sum/n).toFixed(1) : null;');
  L.push('}');
  L.push('function pvBuildSeries(proj, k){');
  L.push('  var single = proj.curves.length===1 && !PV_ROLE.c && !PV_ROLE.s;');
  L.push('  return proj.curves.map(function(cv){');
  L.push('    var s = {name: cv.name, type:"line", smooth:true,');
  L.push('      data: cv.recs.map(function(recs){ return pvMetricVal(recs, k); }),');
  L.push('      lineStyle:{color: PV_PALETTE[cv.ci % PV_PALETTE.length], width:2},');
  L.push('      itemStyle:{color: PV_PALETTE[cv.ci % PV_PALETTE.length]},');
  L.push('      symbol: PV_ROLE.s ? PV_SYMBOLS[cv.pi % PV_SYMBOLS.length] : "circle",');
  L.push('      symbolSize: PV_ROLE.s ? 7 : 6,');
  // 断线处("缺该参数组合的仿真点")要显式连过去还是断开? 断开 —— 假连线会让人误以为
  // 扫过那个档位。connectNulls 保持默认 false。
  L.push('      connectNulls:false};');
    // 被平均的曲线画虚线(2026-08-28): 该曲线至少有一个位置是多点均值,
    // 视觉上必须与"单一配置的真实曲线"区分开
    L.push('    var hasAvg = cv.recs.some(function(r){ return r && r.length>1; });');
    L.push('    if(hasAvg){ s.lineStyle.type = "dashed"; s.lineStyle.width = 2.5; }');
    L.push('    if(single){ s.areaStyle={color:"rgba(108,99,255,.1)"}; s.label={show:true,color:"#9ca0b0",fontSize:9}; }');
    L.push('    return s;');
    L.push('  });');
    L.push('}');
  // ---- 透视模式下的堆叠柱(2026-08-28) ----
  // 返回 {series, scenes, totals}: 场景顺序与原图一致(曲线主序 × 横轴档位);
  // 缺点的场景(该参数组合无仿真点)全部分量为 null ⇒ 不画柱, 不假装有数据。
  // totals 用分量之和而非直接平均 ttft —— 柱高就是分量之和, 标签必须与柱高严格一致。
  L.push('function pvBuildStack(proj){');
  L.push('  var scenes = [], sceneRecs = [];');
  L.push('  proj.curves.forEach(function(c){');
  L.push('    for(var xi=0; xi<proj.xs.length; xi++){');
  L.push('      scenes.push(proj.curves.length>1 ? (proj.xs[xi] + " \\u00b7 " + c.name) : proj.xs[xi]);');
  L.push('      sceneRecs.push(c.recs[xi]);');
  L.push('    }');
  L.push('  });');
  L.push('  var totals = sceneRecs.map(function(recs){');
  L.push('    if(recs===null) return null;');
  L.push('    var t = 0, complete = STACK_PARTS.length > 0;');
  L.push('    STACK_PARTS.forEach(function(p){ var v = pvMetricVal(recs, p.key); if(v==null) complete=false; else t+=v; });');
  L.push('    return complete ? +t.toFixed(1) : null;');
  L.push('  });');
  L.push('  var ss = STACK_PARTS.map(function(p){');
  L.push('    return {name:p.label, type:"bar", stack:"ttft", barMaxWidth:48,');
  L.push('      itemStyle:{color:p.color}, emphasis:{focus:"series"},');
  L.push('      data: sceneRecs.map(function(recs){ return pvMetricVal(recs, p.key); })};');
  L.push('  });');
  // 总计标签只挂最后一个 series(position:"top" 仅顶层可见), 与原图一致
  L.push('  if(ss.length){ ss[ss.length-1].label = {show: scenes.length<=24, position:"top",');
  L.push('    color:"#e4e4e7", fontSize:9, fontWeight:600, formatter:function(p){');
  L.push('      var t = totals[p.dataIndex];');
  L.push('      if(t==null) return "";');
  L.push('      return t>=10000 ? (t/1000).toFixed(1)+"s" : t.toFixed(0); }}; }');
  L.push('  return {series: ss, scenes: scenes, totals: totals};');
  L.push('}');
  // ---- 透视重绘: 图 + 表 + 提示, 与原路径共用 ch 实例 ----
  L.push('function pvRebuild(){');
  L.push('  var proj = pvProject();');
  L.push('  var note = document.getElementById("pvNote");');
  L.push('  if(!proj || !proj.curves.length || !proj.xv.length){');
  L.push('    if(note){ note.className="pvnote fwarn"; note.textContent="⚠ 当前勾选下没有数据点，请放宽筛选"; }');
  L.push('    return;');
  L.push('  }');
  // 横轴塌缩(只剩 1 档)时仍绘制(单点), 但要提示 —— 用户可能没意识到把横轴筛没了
  L.push('  var k = CUR_METRIC;');
  // 堆叠柱在透视下也支持(2026-08-28): 场景 = 曲线×档位, 分量取平均(线性, 恒等式保持)。
  // 用户场景: 切好 TTFT 构成后勾掉一款显卡 ⇒ 图应保持堆叠柱只剩另一款, 而非退回折线。
  L.push('  var isStack = (k===STACK_KEY) && STACK_PARTS.length>0;');
  L.push('  var lb = METRIC_LABEL[k]||k;');
  L.push('  if(ch){');
  L.push('    if(isStack){');
  L.push('      var stv = pvBuildStack(proj);');
  L.push('      OPT.series = stv.series;');
  L.push('      OPT.xAxis.data = stv.scenes;');
  L.push('      var xlab = PIVOT_IDX[PV_ROLE.x] ? PIVOT_IDX[PV_ROLE.x].label : "";');
  // 与原图同规则: 多曲线时轴名带"× 场景", 单曲线退回纯档位轴
  L.push('      OPT.xAxis.name = proj.curves.length>1 ? (xlab + " × 场景") : xlab;');
  L.push('      var nSc = stv.scenes.length;');
  // 旋转/缩放阈值与原图 rebuildAll 逐字一致 —— 同一场景数在两处长得一样
  L.push('      var rot = nSc>10?30:(nSc>6?20:0);');
  L.push('      var zoom = nSc>16;');
  L.push('      OPT.xAxis.axisLabel = OPT.xAxis.axisLabel||{};');
  L.push('      OPT.xAxis.axisLabel.rotate = rot; OPT.xAxis.axisLabel.interval = 0;');
  L.push('      OPT.xAxis.axisLabel.color = "#9ca0b0";');
  L.push('      OPT.xAxis.axisLabel.formatter = function(v){ return (String(v).length>22) ? String(v).slice(0,21)+"…" : v; };');
  L.push('      OPT.yAxis.name = "TTFT 构成(ms)";');
  L.push('      OPT.legend = {top:0,textStyle:{color:"#9ca0b0",fontSize:10}};');
  L.push('      OPT.grid = {left:70,right:20,top:36,bottom: zoom?76:(rot?62:40)};');
  L.push('      OPT.tooltip.axisPointer = {type:"shadow"};');
  L.push('      OPT.dataZoom = zoom ? [{type:"slider",bottom:8,height:18,borderColor:"#2e3347",');
  L.push('        textStyle:{color:"#9ca0b0",fontSize:9},fillerColor:"rgba(108,99,255,.18)",startValue:0,endValue:15}] : undefined;');
  L.push('    } else {');
  L.push('    OPT.series = pvBuildSeries(proj, k);');
  L.push('    OPT.xAxis.data = proj.xs;');
  L.push('    OPT.xAxis.name = PIVOT_IDX[PV_ROLE.x] ? PIVOT_IDX[PV_ROLE.x].label : "";');
  L.push('    OPT.xAxis.axisLabel = OPT.xAxis.axisLabel||{};');
  L.push('    OPT.xAxis.axisLabel.rotate = 0; OPT.xAxis.axisLabel.interval = 0;');
  L.push('    OPT.xAxis.axisLabel.color = "#9ca0b0";');
  L.push('    OPT.xAxis.axisLabel.formatter = function(v){ return v; };');
  L.push('    OPT.yAxis.name = lb;');
  L.push('    var multiCurve = proj.curves.length>1;');
  L.push('    OPT.legend = multiCurve ? {top:0,textStyle:{color:"#9ca0b0",fontSize:10}} : undefined;');
  L.push('    OPT.grid = {left:70,right:20,top:multiCurve?36:20,bottom:40};');
  L.push('    OPT.tooltip.axisPointer = undefined;');
  L.push('    OPT.dataZoom = undefined;');
  L.push('    }');
  L.push('    ch.setOption(OPT, true);');
  L.push('  }');
  L.push('  pvRenderTable(proj, k);');
  L.push('  var dy = document.getElementById("dimY"); if(dy) dy.textContent = lb;');
  L.push('  if(note){');
  L.push('    note.className = "pvnote";');
  // 提示口径随图形而变: 折线报"曲线 n 条", 堆叠柱报"柱 n 根"(场景数)
  L.push('    var msg = isStack');
  L.push('      ? ("柱 " + (proj.curves.length * proj.xv.length) + " 根(曲线 " + proj.curves.length + " × 档位 " + proj.xv.length + ") · 命中 " + proj.n + " 点")');
  L.push('      : ("曲线 " + proj.curves.length + " 条 · 横轴 " + proj.xv.length + " 档 · 命中 " + proj.n + " 点");');
  L.push('    if(proj.xv.length<2) msg += " ⚠ 横轴只剩 1 档(无法成线)";');
  // ★ 强警告(2026-08-28): 有"勾了多个值但没占到通道"的参数 ⇒ 同位置多点被平均,
  //   平均跨负载区制时结果不对应任何真实配置。升级为红色 + 报离散度倍数,
  //   并给出可操作的指引(自动指派已在勾选时做过, 走到这说明通道已满)。
  //   离散度用当前指标在多点位置的 max/min; 堆叠柱用 ttft。
  L.push('    var un2 = pvVaryingUnassigned();');
  L.push('    if(un2.length){');
  L.push('      var worst = 0, kk = isStack ? "ttft" : k;');
  L.push('      proj.curves.forEach(function(c){ c.recs.forEach(function(recs){');
  L.push('        if(!recs || recs.length<2) return;');
  L.push('        var mn = Infinity, mx = -Infinity;');
  L.push('        recs.forEach(function(r){ var v = r ? r[kk] : null;');
  L.push('          if(v!=null && isFinite(v)){ if(v<mn) mn=v; if(v>mx) mx=v; } });');
  L.push('        if(mx>0){ var rt = mn>0 ? mx/mn : Infinity; if(rt>worst) worst = rt; }');
  L.push('      }); });');
  L.push('      msg += " ⚠ " + un2.map(function(u){ return PIVOT_IDX[u]?PIVOT_IDX[u].label:u; }).join("/")');
  L.push('        + " 未指派通道，多点已平均"');
  L.push('        + (worst>1.05 ? (worst===Infinity||worst>99 ? "（相差 >99×）" : "（最大相差 "+worst.toFixed(1)+"×）") : "")');
  L.push('        + " —— 把它指派给颜色/形状可分开画";');
  L.push('      note.className = "pvnote fdanger";');
  L.push('    }');
  L.push('    note.textContent = msg;');
  L.push('  }');
  L.push('}');
  // 透视数据表: 折线指标 → 行=横轴档位, 列=曲线; 堆叠柱 → 行=场景, 列=6分量+合计。
  // 与图共用同一份 proj ⇒ 图表永远一致。
  L.push('function pvRenderTable(proj, k){');
  L.push('  var tbl = document.getElementById("tbl"); if(!tbl) return;');
  L.push('  var th = tbl.querySelector("thead"), tb = tbl.querySelector("tbody");');
  L.push('  if(!th||!tb) return;');
  // 堆叠柱表: 与原图堆叠表同构(行=场景, 列=分量+合计) —— 离线时这份数字完整可用
  L.push('  if(k===STACK_KEY){');
  L.push('    var stv = pvBuildStack(proj);');
  L.push('    th.innerHTML = "<tr><th>场景</th>"');
  L.push('      + STACK_PARTS.map(function(p){ return "<th>"+esc2(p.label)+"</th>"; }).join("")');
  L.push('      + "<th>TTFT合计</th></tr>";');
  L.push('    tb.innerHTML = stv.scenes.map(function(sc, i){');
  L.push('      return "<tr><td class=\\"k\\">"+esc2(sc)+"</td>"');
  L.push('        + stv.series.map(function(s){');
  L.push('            var v = s.data[i];');
  L.push('            return "<td>"+esc2(v==null?"—":v)+"</td>"; }).join("")');
  L.push('        + "<td><b>"+esc2(stv.totals[i]==null?"—":stv.totals[i])+"</b></td></tr>";');
  L.push('    }).join("");');
  L.push('    return;');
  L.push('  }');
  L.push('  var xlb = PIVOT_IDX[PV_ROLE.x] ? PIVOT_IDX[PV_ROLE.x].label : "";');
  L.push('  th.innerHTML = "<tr><th>"+esc2(xlb)+"</th>"');
  L.push('    + proj.curves.map(function(c){ return "<th>"+esc2(c.name)+"</th>"; }).join("") + "</tr>";');
  L.push('  tb.innerHTML = proj.xs.map(function(x,i){');
  L.push('    return "<tr><td class=\\"k\\">"+esc2(x)+"</td>"');
  L.push('      + proj.curves.map(function(c){');
  L.push('          var v = pvMetricVal(c.recs[i], k);');
  L.push('          return "<td>"+esc2(v==null?"—":v)+"</td>"; }).join("") + "</tr>";');
  L.push('  }).join("");');
  L.push('}');
  // ---- 角色分配的互斥: 三个下拉不能选同一参数 ----
  // 撞车时**清空低优先级的那个**(而不是拒绝操作/回退高优先级的) —— 用户改下拉的意图是
  // "我要这个参数当这个角色", 强行回退会让人以为下拉坏了。
  // changed 参数保留(调用方标明是谁触发的), 当前裁决逻辑不依赖它, 但排错时有用。
  L.push('function pvSyncRoles(changed){');
  L.push('  var ex = document.getElementById("pvX"), ec2 = document.getElementById("pvC"), es = document.getElementById("pvS");');
  L.push('  if(!ex) return;');
  L.push('  var x = ex.value, c = ec2?ec2.value:"", s = es?es.value:"";');
  // 优先级 横轴 > 颜色 > 形状: 低优先级的撞了高优先级的就被清空。
  // 无论 changed 是谁都按这个固定优先级裁决 —— 按"谁刚被改"决定保留谁会产生
  // 不可预期的连锁(改横轴把颜色顶掉、再改颜色又把横轴顶掉), 固定优先级更好预测。
  L.push('  if(c && c===x) c = "";');
  L.push('  if(s && (s===x || s===c)) s = "";');
  L.push('  if(ec2 && ec2.value!==c) ec2.value = c;');
  L.push('  if(es && es.value!==s) es.value = s;');
  L.push('  PV_ROLE.x = x; PV_ROLE.c = c||null; PV_ROLE.s = s||null;');
  L.push('}');
  // ---- 差异参数的自动指派与强警告(2026-08-28) ----
  // 背景(用户): 同时勾 32k+128k 而 input_len 未指派角色时, 图上画的是两个负载区制的
  // 算术平均 —— 不对应任何真实配置, 分析上基本没意义。
  // 信息无损的充要条件: 每个"有变化"的参数都必须独占一个视觉通道(横轴/颜色/形状)。
  // 策略(软约束, 不做硬拒绝):
  //   ① 勾选使某参数变为"有变化"且未指派 ⇒ 自动占空闲通道(先颜色后形状)
  //   ② 通道全满仍有未指派多值参数 ⇒ 红色警告 + 离散度倍数, 被平均的曲线画虚线
  //   ③ 不禁止平均本身(探索时有用), 但视觉上无处遁形
  // pvVaryingUnassigned: 勾选值 >1 且未占通道的参数(只可能是可调参数, 行只给它们渲染)
  L.push('function pvVaryingUnassigned(){');
  L.push('  var out = [];');
  L.push('  Object.keys(PV_SEL).forEach(function(k){');
  L.push('    if(PIVOT_DIMS.indexOf(k)<0) return;');
  L.push('    if(k===PV_ROLE.x||k===PV_ROLE.c||k===PV_ROLE.s) return;');
  L.push('    if(PV_SEL[k].length>1) out.push(k);');
  L.push('  });');
  L.push('  return out;');
  L.push('}');
  // pvAutoAssign: 把未指派的有变化参数依次塞进空闲通道。只在**勾选变更**后调用;
  // 角色下拉的 change 不调(用户改下拉是显式意图, 比如故意把颜色设为「无」)。
  L.push('function pvAutoAssign(){');
  L.push('  var un = pvVaryingUnassigned();');
  L.push('  for(var i=0;i<un.length;i++){');
  L.push('    var k = un[i], target = null;');
  L.push('    if(!PV_ROLE.c && k!==PV_ROLE.x) target = ' + "'c'" + ';');
  L.push('    else if(!PV_ROLE.s && k!==PV_ROLE.x && k!==PV_ROLE.c) target = ' + "'s'" + ';');
  L.push('    if(!target) break;');
  L.push('    PV_ROLE[target] = k;');
  L.push('    var el = document.getElementById(target==="c"?"pvC":"pvS");');
  L.push('    if(el) el.value = k;');
  L.push('  }');
  L.push('}');
  // ---- 透视的进入/退出(懒激活, 无开关) ----
  // pvToggle(on) 语义保留(内部与验证脚本都在用):
  //   · on=true  ⇒ 接管图表(fbar 加 .live 色条, 显示「恢复原图」)
  //   · on=false ⇒ 交还给原路径(rebuildAll 重画平台那张图)
  //   fbar 始终可见 —— 它就是面板本体(2026-08-27 三次改造后不再有独立 pvbar)。
  L.push('function pvToggle(on){');
  L.push('  PV_ON = !!on; if(!PV_ON) PV_SNAPSHOT = null;');
  L.push('  var bar = document.getElementById("fbar");');
  L.push('  if(bar) bar.className = "fbar" + (PV_ON ? " live" : "");');
  // 「恢复原图」只在已接管时有意义
  L.push('  var rb = document.getElementById("pvReset"); if(rb) rb.style.display = PV_ON ? "" : "none";');
  L.push('  if(PV_ON){ pvSyncRoles("x"); pvRebuild(); }');
  L.push('  else {');
  L.push('    rebuildAll(CUR_METRIC); renderTable();');
  // 退回原图后清掉透视提示, 免得停留在上一次的"曲线 n 条"读数上引起误解
  L.push('    var nt = document.getElementById("pvNote");');
  L.push('    if(nt){ nt.className = "pvnote"; nt.textContent = PV_HINT; }');
  L.push('  }');
  L.push('}');
  // pvEnter: 懒激活入口 —— 面板任一交互都先调它。已激活则只重绘。
  L.push('function pvEnter(){ if(PV_ON){ pvRebuild(); } else { pvToggle(true); } }');
  if (hasPivot) {
    L.push('(function(){');
    // 「恢复原图」按钮: 退回平台原始视图(含堆叠柱能力)
    L.push('  var rb = document.getElementById("pvReset");');
    L.push('  if(rb) rb.addEventListener("click", function(){ pvToggle(false); });');
    // 角色下拉
    L.push('  ["pvX","pvC","pvS"].forEach(function(id){');
    L.push('    var el = document.getElementById(id); if(!el) return;');
    L.push('    el.addEventListener("change", function(){');
    L.push('      pvSyncRoles(id==="pvX"?"x":(id==="pvC"?"c":"s"));');
    L.push('      pvEnter();');
    L.push('    });');
    L.push('  });');
    // 参数值 chip
    L.push('  var vcs = document.querySelectorAll(".fc[data-pk]");');
    L.push('  for(var i=0;i<vcs.length;i++){ (function(el){');
    L.push('    el.addEventListener("click", function(){');
    L.push('      var pk = el.getAttribute("data-pk"), vi = parseInt(el.getAttribute("data-vi"),10);');
    L.push('      var s = PV_SEL[pk]; if(!s) return;');
    L.push('      var at = s.indexOf(vi);');
    L.push('      if(at>=0) s.splice(at,1); else { s.push(vi); s.sort(function(a,b){return a-b;}); }');
    L.push('      el.className = "fc" + (s.indexOf(vi)>=0 ? " on" : "");');
    // 勾选变更后: 有变化但未指派角色的参数自动占空闲通道(避免无意义的多点平均)
    L.push('      pvAutoAssign();');
    L.push('      pvEnter();');
    L.push('    });');
    L.push('  })(vcs[i]); }');
    // 全选/反选
    L.push('  var pms = document.querySelectorAll(".fmini[data-pact]");');
    L.push('  for(var j=0;j<pms.length;j++){ (function(el){');
    L.push('    el.addEventListener("click", function(){');
    L.push('      var pk = el.getAttribute("data-pk"), act = el.getAttribute("data-pact");');
    L.push('      var d = PIVOT_IDX[pk]; if(!d) return;');
    L.push('      var all = d.vals.map(function(_,i){ return i; });');
    L.push('      PV_SEL[pk] = (act==="all") ? all : all.filter(function(i){ return PV_SEL[pk].indexOf(i)<0; });');
    L.push('      var cs = document.querySelectorAll(\'.fc[data-pk="\'+pk+\'"]\');');
    L.push('      for(var q=0;q<cs.length;q++){');
    L.push('        var ii = parseInt(cs[q].getAttribute("data-vi"),10);');
    L.push('        cs[q].className = "fc" + (PV_SEL[pk].indexOf(ii)>=0 ? " on" : "");');
    L.push('      }');
    L.push('      pvAutoAssign();');
    L.push('      pvEnter();');
    L.push('    });');
    L.push('  })(pms[j]); }');
    // 批次快捷选择: 一键还原该次扫描的"角色分配 + 参数勾选"(2026-08-27 加回)
    // 勾选收窄到该批次的点实际覆盖的取值 —— 否则会把其他批次的点混进来取平均
    L.push('  var sbs = document.querySelectorAll(".fc[data-snap]");');
    L.push('  for(var m=0;m<sbs.length;m++){ (function(el){');
    L.push('    el.addEventListener("click", function(){');
    L.push('      var si = parseInt(el.getAttribute("data-snap"),10);');
    L.push('      var meta = SNAP_META[si]; if(!meta) return; PV_SNAPSHOT = si;');
    L.push('      var ex = document.getElementById("pvX"), ec2 = document.getElementById("pvC"), es = document.getElementById("pvS");');
    L.push('      if(ex && PIVOT_DIMS.indexOf(meta.x)>=0) ex.value = meta.x;');
    L.push('      if(ec2) ec2.value = (meta.cmp && PIVOT_DIMS.indexOf(meta.cmp)>=0) ? meta.cmp : "";');
    L.push('      if(es) es.value = (meta.shape && PIVOT_DIMS.indexOf(meta.shape)>=0) ? meta.shape : "";');
    L.push('      Object.keys(PIVOT_IDX).forEach(function(k){');
    L.push('        var seen = {};');
    L.push('        PIVOT_PTS.forEach(function(pt){ if((pt.snapshots||[pt.s]).indexOf(si)>=0 && pt.p[k]!==undefined) seen[String(pt.p[k])] = true; });');
    L.push('        var idx = PIVOT_IDX[k], keep = [];');
    L.push('        for(var q=0;q<idx.vals.length;q++) if(seen[String(idx.vals[q])]) keep.push(q);');
    L.push('        if(keep.length) PV_SEL[k] = keep;');
    L.push('      });');
    L.push('      var cs = document.querySelectorAll(".fc[data-pk]");');
    L.push('      for(var q2=0;q2<cs.length;q2++){');
    L.push('        var pk2 = cs[q2].getAttribute("data-pk"), ii2 = parseInt(cs[q2].getAttribute("data-vi"),10);');
    L.push('        cs[q2].className = "fc" + ((PV_SEL[pk2]||[]).indexOf(ii2)>=0 ? " on" : "");');
    L.push('      }');
    L.push('      for(var w=0;w<sbs.length;w++) sbs[w].className = "fc" + (w===si ? " on" : "");');
    // 底部参数配置区跟随批次(2026-08-31): 换成该批次的参数快照
    L.push('      if(typeof pvSwapParams === "function") pvSwapParams(si);');
    // 点批次即视为要用透视看 ⇒ 懒激活(角色已在上面按该批次设好, 这里只需进入并重绘)
    L.push('      pvSyncRoles("x"); pvEnter();');
    L.push('    });');
    L.push('  })(sbs[m]); }');
    L.push('})();');
  }
  L.push('function copyTsv(){');
  L.push('  var rs = document.querySelectorAll("#tbl tr");');
  L.push('  var out = [];');
  L.push('  for(var i=0;i<rs.length;i++){');
  L.push('    var cs = rs[i].querySelectorAll("th,td"), line = [];');
  L.push('    for(var j=0;j<cs.length;j++) line.push(cs[j].textContent.trim());');
  L.push('    out.push(line.join("\\t"));');
  L.push('  }');
  L.push('  var txt = out.join("\\n"), note = document.getElementById("copyNote");');
  L.push('  function ok(){ if(note){ note.textContent = "✓ 已复制 "+rs.length+" 行"; setTimeout(function(){note.textContent=""},2500); } }');
  L.push('  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(ok,fallback); } else fallback();');
  L.push('  function fallback(){ var ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta); ta.select();');
  L.push('    try{document.execCommand("copy"); ok();}catch(e){ if(note) note.textContent="⚠ 复制失败，请手动选中表格"; } document.body.removeChild(ta); }');
  L.push('}');
  // 参数区: 「原始 JSON」折叠开关。有分组视图时默认收起 JSON, 点一下展开供复制回填。
  // ⚠️ #pJson/#pView 必须**每次点击时重新解析** —— 批次切换会整段替换 #pWrap 的
  //   innerHTML, 初始化时缓存的引用会变成已分离的旧节点(点了没反应)。
  L.push('(function(){');
  L.push('  var tog = document.getElementById("pJsonTog");');
  L.push('  if(!tog) return;');
  L.push('  tog.addEventListener("click", function(){');
  L.push('    var box = document.getElementById("pJson"), view = document.getElementById("pView");');
  L.push('    if(!box) return;');
  L.push('    var showJson = (box.style.display === "none");');
  L.push('    box.style.display = showJson ? "" : "none";');
  // 有分组视图时二者互斥切换(避免页面被撑得很长); 无分组视图时 JSON 常显
  L.push('    if(view) view.style.display = showJson ? "none" : "";');
  L.push('    tog.textContent = showJson ? "▤ 分组视图" : "{ } 原始 JSON";');
  L.push('  });');
  L.push('})();');
  // pvSwapParams: 批次切换时把该批次的参数区 HTML 换入 #pWrap, 并重置计数与折叠状态
  L.push('function pvSwapParams(si){');
  L.push('  var w = document.getElementById("pWrap");');
  L.push('  if(!w || typeof SNAP_PARAMS_HTML==="undefined" || !SNAP_PARAMS_HTML.length) return;');
  L.push('  var it = SNAP_PARAMS_HTML[si]; if(!it) return;');
  L.push('  w.innerHTML = it.html;');
  L.push('  var c = document.getElementById("pCount"); if(c) c.innerHTML = it.count;');
  L.push('  var tog = document.getElementById("pJsonTog"); if(tog) tog.textContent = "{ } 原始 JSON";');
  L.push('}');
  L.push('<\/script></body></html>');
  return L.join('\n');
}
