import { updateQuickResults, initParamsTab, applyEstimatedParams } from "./parameters.js";
import { initStrategyTab } from "./strategy.js";
import { refreshStorageTab, refreshScheduleTab } from "./charts.js";
import { refreshCrossTab } from "./cross.js";
import { $ } from "../adapters/browser/dom.js";
import { renderSensSnapList } from "./snapshots.js";
import { toggleShapeDim, guardCompareParam } from "./sensitivity.js";
import { state } from "./state.js";



export function refreshActiveTab(){
  let active = document.querySelector('.tab-panel.active');
  if(!active) return;
  switch(active.id){
    case 'tab-params': updateQuickResults(); initStrategyTab(); break;
    case 'tab-storage': refreshStorageTab(); break;
    case 'tab-schedule': refreshScheduleTab(); break;
    case 'tab-cross': refreshCrossTab(); break;
  }
}



// ======================== INIT ========================
export function init(){
  initParamsTab();
  initStrategyTab();
  applyEstimatedParams(); // 初始即用纯推导的 a/b（τ_pf 简化置 0），用户可手动覆盖
  // 策略仿真结果区初始占位（运行入口在结果卡片内）
  let mg = $('strategyMetricsGrid');
  if (mg) mg.innerHTML = '<div style="color:var(--text-dim);padding:10px 0;grid-column:1/-1;font-size:.8rem">暂无结果 —— 点击上方「▶️ 运行当前策略」或「📋 运行全部已保存」开始仿真（同一策略×参数只跑一次，结果缓存）</div>';
  // 扫描快照列表与形状维控件的初始态(2026-08-27): 不初始化的话空列表区没有引导文案,
  // 且形状维档位输入框的显隐会停在 HTML 的静态默认值上
  try { renderSensSnapList(); } catch (e) {}
  try { toggleShapeDim(); } catch (e) {}
}

export function bindPageEvents() {
window.addEventListener('resize',()=>{state.chartRegistry.forEach(c=>{try{c.resize()}catch(e){}})});
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    $(btn.dataset.tab).classList.add('active');
    setTimeout(refreshActiveTab,100);
  });
});
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'sSweepCompareParam') { guardCompareParam(); toggleShapeDim(); }
  if (e.target && e.target.id === 'sSweepParam') { guardCompareParam(); toggleShapeDim(); }
  if (e.target && e.target.id === 'sShapeDim') toggleShapeDim();
});
}
