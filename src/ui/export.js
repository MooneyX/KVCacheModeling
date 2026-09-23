import { state } from "./state.js";
import { SENS_PARAM_LABEL } from "../application/labels.js";
import { echarts } from "./echarts.js";
import { renderSensHtml } from "../reports/html.js";
import { sensSnapSelected, sensSnapKeyOf } from "./snapshots.js";



let sensExportReady = false;
const replayExportRestriction = '最近一次运行结果为 Replay，旧 HTML 报告和敏感性图片导出不适用；请使用结果区的“下载完整结果 JSON”。切换输入不会改变结果来源。';
const isReplayResult = () => !!state.simResults[0]?.replay;

export function refreshSensExportControls() {
  const blocked = isReplayResult();
  for (const id of ['btnSensExportPng', 'btnSensExportJpg', 'btnSensExportHtml']) {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = blocked || !sensExportReady;
      if (el.dataset.syntheticTitle === undefined) el.dataset.syntheticTitle = el.title;
      el.title = blocked ? replayExportRestriction : el.dataset.syntheticTitle;
    }
  }
  const note = document.getElementById('sensExportRestriction');
  if (note) { note.hidden = !blocked; note.textContent = blocked ? replayExportRestriction : ''; }
  const status = document.getElementById('sensExportNote');
  if (!blocked && status?.textContent === replayExportRestriction) status.textContent = '';
}

export function setSensExportEnabled(on) {
  sensExportReady = !!on;
  refreshSensExportControls();
}

function allowSensExport() {
  if (!isReplayResult()) return true;
  refreshSensExportControls();
  sensExportNote(replayExportRestriction, true);
  return false;
}



// 文件名带上「横轴_颜色维_纵轴_时间戳」—— 批量导出多张后不至于分不清哪张是哪张
export function sensExportFileName(ext) {
  let st = state.sensExportState;
  let ts = (st && st.at) ? st.at : new Date();
  let pad = function (n) { return String(n).padStart(2, '0'); };
  let stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate())
    + '_' + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
  // 去掉文件名非法字符与括号单位(如 "平均TTFT(ms)" → "平均TTFT")
  let clean = function (t) { return String(t || '').replace(/\([^)]*\)/g, '').replace(/[\\\/:*?"<>|%\s]+/g, ''); };
  let parts = ['敏感性'];
  if (st) {
    parts.push(clean(st.paramLabel));
    if (st.compareParam) parts.push('x' + clean(SENS_PARAM_LABEL[st.compareParam]));
    parts.push(clean(st.metricLabel));
  }
  return parts.join('_') + '_' + stamp + '.' + ext;
}



export function triggerDownload(href, filename, isBlob) {
  let a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  // Blob URL 需手动释放(dataURL 不需要); 延迟以确保下载已开始
  if (isBlob) setTimeout(function () { try { URL.revokeObjectURL(href); } catch (e) {} }, 4000);
}



export function sensExportNote(msg, isErr) {
  let el = document.getElementById('sensExportNote');
  if (el) { el.textContent = msg; el.style.color = isErr ? 'var(--accent4)' : 'var(--accent2)'; }
}



// ---- PNG / JPG ----
export function exportSensImage(type) {
  if (!allowSensExport()) return;
  let el = document.getElementById('chartSensitivity');
  let ch = (el && window.echarts) ? echarts.getInstanceByDom(el) : null;
  if (!ch || !state.sensExportState) { sensExportNote('⚠ 请先运行一次敏感性分析', true); return; }
  try {
    let url = ch.getDataURL({
      type: type,                  // 'png' | 'jpeg'
      pixelRatio: 2,               // 2× 超采样, 贴进文档缩放后不发虚
      backgroundColor: '#1a1d27'   // ⚠️ 见文件头注释: JPEG 无 alpha, 不给会变纯黑
    });
    triggerDownload(url, sensExportFileName(type === 'jpeg' ? 'jpg' : 'png'));
    sensExportNote('✓ 已导出 ' + (type === 'jpeg' ? 'JPG' : 'PNG') + '（2× 高清）');
  } catch (e) {
    sensExportNote('⚠ 导出失败: ' + ((e && e.message) ? e.message : e), true);
  }
}

export function buildSensHtml(snapList) {
  if (isReplayResult()) throw new Error(replayExportRestriction);
  return renderSensHtml(state.sensExportState, snapList);
}



export function exportSensHtml() {
  if (!allowSensExport()) return;
  if (!state.sensExportState) { sensExportNote('⚠ 请先运行一次敏感性分析', true); return; }
  try {
    // 快照列表(2026-08-27): 勾选的**全部**扫描一并打包。
    // 兜底: 列表为空或全不勾时退回单快照(当前图) —— 不能因为忘了勾选就导出空文件。
    let snaps = [];
    try { snaps = sensSnapSelected(); } catch (e) { snaps = []; }
    if (!snaps.length) snaps = [state.sensExportState];
    // 当前图对应的快照必须在列表里且**排首位** —— 导出页的初始图/参数区取自 snaps[0] 之外的
    // st(=sensExportState), 若当前扫描没被勾选, 初始图与点云会来自不同批次, 令人困惑。
    let curKey = (function () { try { return sensSnapKeyOf(state.sensExportState); } catch (e) { return null; } })();
    let hasCur = snaps.some(function (s) { try { return sensSnapKeyOf(s) === curKey; } catch (e) { return false; } });
    if (!hasCur) snaps = [state.sensExportState].concat(snaps);
    let html = buildSensHtml(snaps);
    let url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    triggerDownload(url, sensExportFileName('html'), true);
    // 提示里报出可切换的指标数 —— 让用户知道导出文件里带了多少东西(不只是当前那一张图)
    let nm = (function () {
      try { return Object.keys(state.sensExportState.curveRecs && state.sensExportState.curveRecs[0] && state.sensExportState.curveRecs[0][0] || {}).length; } catch (e) { return 0; }
    })();
    let nPt = snaps.reduce(function (a, s) { return a + ((s.points || []).length); }, 0);
    sensExportNote('✓ 已导出可交互 HTML（' + (html.length / 1024).toFixed(0) + ' KB'
      + (snaps.length > 1 ? '，含 ' + snaps.length + ' 次扫描共 ' + nPt + ' 个参数组合，可页内透视' : '')
      + (nm > 1 ? '，可页内切换 ' + nm + ' 个指标' : '') + '，含数据表与参数配置详情）');
  } catch (e) {
    sensExportNote('⚠ 导出失败: ' + ((e && e.message) ? e.message : e), true);
  }
}
