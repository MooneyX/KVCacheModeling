import { sensSnapTitle } from "../application/snapshots.js";
export { sensSnapTitle } from "../application/snapshots.js";
import { state } from "./state.js";
import { $ } from "../adapters/browser/dom.js";


export const SENS_SNAP_MAX = 20;


export function sensSnapKeyOf(st) {
  return (st && st._cacheKey ? st._cacheKey : '') + '|' + (st ? st.metric : '');
}





export function collectSensSnapshot(st) {
  if (!st) return;
  let k = sensSnapKeyOf(st);
  let at = -1;
  for (let i = 0; i < state.sensSnapshots.length; i++) {
    if (sensSnapKeyOf(state.sensSnapshots[i]) === k) { at = i; break; }
  }
  // 新快照默认勾选(用户跑了就是想看), 重跑时**保留**原勾选状态
  if (at >= 0) { st._sel = state.sensSnapshots[at]._sel !== false; state.sensSnapshots[at] = st; }
  else {
    st._sel = true;
    state.sensSnapshots.push(st);
    if (state.sensSnapshots.length > SENS_SNAP_MAX) state.sensSnapshots.shift();
  }
  renderSensSnapList();
}


export function sensSnapSelected() {
  return state.sensSnapshots.filter(function (s) { return s._sel !== false; });
}


export function toggleSensSnap(i) {
  if (state.sensSnapshots[i]) { state.sensSnapshots[i]._sel = (state.sensSnapshots[i]._sel === false); renderSensSnapList(); }
}


export function removeSensSnap(i) {
  if (i >= 0 && i < state.sensSnapshots.length) { state.sensSnapshots.splice(i, 1); renderSensSnapList(); }
}


export function clearSensSnaps() { state.sensSnapshots = []; renderSensSnapList(); }


export function renderSensSnapList() {
  let box = $('sensSnapList');
  if (!box) return;
  if (!state.sensSnapshots.length) {
    box.innerHTML = '<span style="font-size:.72rem;color:var(--text-dim)">'
      + '尚未收集扫描结果 —— 每运行一次敏感性分析会自动收录一条，可勾选多条一并导出到同一个 HTML。</span>';
    return;
  }
  let nSel = sensSnapSelected().length;
  let L = ['<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">'
    + '<span style="font-size:.73rem;color:var(--text)">已收集 <b>' + state.sensSnapshots.length
    + '</b> 次扫描，勾选 <b style="color:var(--accent2)">' + nSel + '</b> 条导出</span>'
    + '<button class="btn btn-sm" onclick="selectAllSensSnaps(true)" style="padding:2px 8px;font-size:.68rem">全选</button>'
    + '<button class="btn btn-sm" onclick="selectAllSensSnaps(false)" style="padding:2px 8px;font-size:.68rem">全不选</button>'
    + '<button class="btn btn-sm" onclick="clearSensSnaps()" style="padding:2px 8px;font-size:.68rem;background:var(--accent4)">清空</button>'
    + '</div>'];
  L.push('<div style="display:flex;flex-direction:column;gap:3px">');
  state.sensSnapshots.forEach(function (s, i) {
    let on = s._sel !== false;
    let nPt = (s.points || []).length;
    L.push('<div style="display:flex;align-items:center;gap:8px;font-size:.72rem;'
      + 'background:var(--surface2);border:1px solid var(--border);border-left:3px solid '
      + (on ? 'var(--accent2)' : 'var(--border)') + ';border-radius:5px;padding:3px 8px">'
      + '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="toggleSensSnap(' + i + ')" style="margin:0">'
      + '<span style="color:var(--text-dim);min-width:16px">' + (i + 1) + '</span>'
      + '<span style="color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      + sensSnapTitle(s) + '</span>'
      + '<span style="color:var(--text-dim)">' + nPt + ' 点</span>'
      + '<span style="color:var(--text-dim)">' + (s.at ? s.at.toLocaleTimeString('zh-CN') : '') + '</span>'
      + '<button class="btn btn-sm" onclick="removeSensSnap(' + i + ')" '
      + 'style="padding:1px 6px;font-size:.66rem;background:none;border:1px solid var(--border);color:var(--text-dim)">✕</button>'
      + '</div>');
  });
  L.push('</div>');
  box.innerHTML = L.join('');
}


export function selectAllSensSnaps(on) {
  state.sensSnapshots.forEach(function (s) { s._sel = !!on; });
  renderSensSnapList();
}
