import { state } from "./state.js";
import { $ } from "../adapters/browser/dom.js";
import { strategyPresetsJS, strategyPresets } from "../core/presets.js";
import { parseDSL, autoNameStrategy, dslToText } from "../core/strategy.js";



export function switchMode(mode) {
  state.strategyMode = mode;
  $('modeDsl').classList.toggle('active', mode === 'dsl');
  $('modeJs').classList.toggle('active', mode === 'js');
  let ref = $('strategyRef');
  if (mode === 'js') {
    $('strategySubtitle').textContent = 'JavaScript模式：自由编写调度函数。引擎在每个决策点调用你的 admit/evict/prefetch/place';
    if (!$('sDsl').value.trim() || $('sDsl').value.match(/^ADMIT:/m)) {
      $('sDsl').value = strategyPresetsJS['Pure-HBM'];
      syncPrefetchSelect();
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
      syncPrefetchSelect();
    }
    ref.innerHTML = '<b style="color:var(--accent)">DSL 语法参考</b><br>'+
      '<code>ADMIT: always</code><br>'+
      '<code>EVICT: lru from hbm when 85% -> dram</code><br>'+
      '<code>PREFETCH: none | best_effort | timeout | race</code><br>'+
      '<code>BATCH: continuous max(8)</code><br>'+
      '<code>PLACE: hbm_first</code>';
  }
}



// ======================== DSL PARSER ========================
// L3 预取策略开关 → DSL PREFETCH 行（2026-08-12）:
// wait_complete→none(等拉齐), best_effort→best_effort(边拉边算), suffix_race→race(前缀双向夹逼相遇即停, 再算后缀)
export function setPrefetchPolicy(v) {
  let map = { wait_complete: 'none', best_effort: 'best_effort', timeout: 'timeout', suffix_race: 'race' };
  let dsl = $('sDsl');
  if (!dsl) return;
  let lines = dsl.value.split('\n');
  let newLine = 'PREFETCH: ' + (map[v] || 'none');
  let idx = lines.findIndex(l => l.trim().startsWith('PREFETCH:'));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  dsl.value = lines.join('\n');
  let note = $('prefetchPolicyNote');
  if (note) note.textContent = '';
}


// DSL 被编辑/预设加载后同步下拉（从 PREFETCH 行反查）; 同时把 DSL 的 BATCH max(N) 回填 pMaxBatch 输入框(双向同步 2026-08-14)
export function syncPrefetchSelect() {
  let dslEl = $('sDsl'), sel = $('sPrefetchPolicy');
  if (!dslEl || !sel) return;
  let m = dslEl.value.match(/^PREFETCH:\s*(\w+)/m);
  let t = m ? m[1] : '';
  sel.value = t === 'race' ? 'suffix_race' : (t === 'best_effort' ? 'best_effort' : (t === 'timeout' ? 'timeout' : 'wait_complete'));
  let bm = dslEl.value.match(/^BATCH:\s*\w+\s*max\(\s*(\d+)\s*\)/m);
  let mb = $('pMaxBatch');
  if (bm && mb) mb.value = bm[1];
}


// pMaxBatch 输入框 → DSL BATCH 行(仿真唯一生效来源): 改输入框自动改写 DSL, 消除两处冲突(2026-08-14)
export function syncMaxBatchFromInput() {
  let v = Math.max(1, parseInt($('pMaxBatch') ? $('pMaxBatch').value : '8') || 8);
  let dslEl = $('sDsl');
  if (!dslEl) return;
  let lines = dslEl.value.split('\n');
  let idx = lines.findIndex(l => l.trim().startsWith('BATCH:'));
  if (idx >= 0) {
    let nl = lines[idx].replace(/max\(\s*\d+\s*\)/i, 'max(' + v + ')');
    if (nl === lines[idx]) nl = lines[idx].replace(/^(\s*BATCH:\s*\w+).*$/i, '$1 max(' + v + ')');
    lines[idx] = nl;
  } else {
    lines.push('BATCH: continuous max(' + v + ')');
  }
  dslEl.value = lines.join('\n');
  if (typeof syncPrefetchSelect === 'function') syncPrefetchSelect();
}



export function getCurrentStrategy() {
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



export function saveStrategy() {
  let s = getCurrentStrategy();
  if (!s) return;
  if (!s.name) s.name = autoNameStrategy(s);
  $('sName').value = s.name;
  s.dsl = $('sDsl').value;
  let idx = state.savedStrategies.findIndex(x => x.name === s.name);
  if (idx >= 0) state.savedStrategies[idx] = s;
  else state.savedStrategies.push(s);
  renderSavedStrategies();
}



export function deleteStrategy(name) {
  state.savedStrategies = state.savedStrategies.filter(s => s.name !== name);
  renderSavedStrategies();
}



export function renderSavedStrategies() {
  let el = $('savedStrategiesList');
  if (state.savedStrategies.length === 0) { el.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);padding:8px 0">暂无已保存策略，配置DSL并点击"保存策略"</div>'; return; }
  el.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);margin-bottom:6px">已保存的策略 ('+state.savedStrategies.length+'个):</div>' +
    state.savedStrategies.map((s,i) => '<div style="display:inline-flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border);border-radius:5px;padding:4px 10px;margin:0 6px 6px 0;font-size:.75rem">'+
      '<span style="color:var(--accent);cursor:pointer" onclick="loadStrategy('+i+')">'+s.name+'</span>'+
      '<span style="color:var(--text-dim);font-size:.6rem">['+autoNameStrategy(s)+']</span>'+
      '<span style="color:var(--accent4);cursor:pointer;font-size:.65rem" onclick="deleteStrategy(\''+s.name+'\')">✕</span></div>'
    ).join('');
}



export function loadStrategy(idx) {
  let s = state.savedStrategies[idx];
  if (!s) return;
  $('sName').value = s.name;
  $('sDsl').value = s.dsl || dslToText(s);
  syncPrefetchSelect();
  $('sDslError').textContent = '';
}



// ======================== STRATEGY TAB INIT ========================
export function initStrategyTab() {
  let bar = $('strategyPresets');
  bar.querySelectorAll('.preset-tag').forEach(b => b.remove());
  Object.keys(strategyPresets).forEach(name => {
    let btn = document.createElement('button');
    btn.className = 'preset-tag';
    btn.textContent = name;
    btn.onclick = function() {
      let text = state.strategyMode === 'js' ? (strategyPresetsJS[name] || strategyPresets[name]) : strategyPresets[name];
      $('sDsl').value = text;
      $('sDslError').textContent = '';
      $('sName').value = '';
      $('sName').placeholder = state.strategyMode === 'js' ? '自动命名: JS-'+name : '自动命名: '+autoNameStrategy(parseDSL(text));
      syncPrefetchSelect();
    };
    bar.appendChild(btn);
  });
  if (!$('sDsl').value.trim()) {
    $('sDsl').value = state.strategyMode === 'js' ? strategyPresetsJS['Pure-HBM'] : strategyPresets['Pure-HBM'];
  }
  syncPrefetchSelect();
}
