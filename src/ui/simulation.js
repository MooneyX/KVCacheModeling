import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";
import { runSimulation } from "../adapters/browser/simulation.js";
import { getCurrentStrategy } from "./strategy.js";
import { $ } from "../adapters/browser/dom.js";
import { drawStrategyMetrics, drawStrategyComparisonGantt, drawStrategyTierDemand } from "./charts.js";
import { executeSimulation } from '../execution/browser/client.ts';

let running = false;

async function runSelectedStrategies(list) {
  if (running || list.some(strategy => !strategy)) return;
  const params = getParams();
  const controls = Object.fromEntries(Array.from(document.querySelectorAll('input[id], select[id]'), el => [el.id, { value: el.value, checked: el.checked }]));
  const mode = state.strategyMode;
  const strategies = structuredClone(list);
  const buttons = document.querySelectorAll('button[onclick="applyStrategies()"], button[onclick="runAllStrategies()"]');
  running = true;
  buttons.forEach(button => { button.disabled = true; });
  try {
    const results = [];
    for (const strategy of strategies) {
      const key = JSON.stringify([params, strategy.dsl || strategy.name || '', null]);
      let result = state.simCache[key];
      if (!result) {
        result = await executeSimulation({ params, strategy, mode });
        const keys = Object.keys(state.simCache);
        if (keys.length >= 30) delete state.simCache[keys[0]];
        state.simCache[key] = result;
      }
      results.push(result);
    }
    state.simResults = results;
    state.simInput = { params, controls };
    showStrategyResults();
  } catch (error) {
    simError(error);
  } finally {
    running = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}


export function cachedSimulation(strategy, overrides) {
  let s = strategy || {};
  let key = JSON.stringify([getParams(), s.dsl || s.name || '', overrides || null]);
  if (state.simCache[key]) return state.simCache[key];
  let r = runSimulation(s, overrides);
  let keys = Object.keys(state.simCache);
  if (keys.length >= 30) delete state.simCache[keys[0]]; // FIFO 淘汰最旧
  state.simCache[key] = r;
  return r;
}



// ======================== STRATEGY VISUALIZATION ========================
// 运行当前策略（不隐式保存——"运行"与"保存"解耦）；结果走缓存
export function applyStrategies() {
  return runSelectedStrategies([getCurrentStrategy()]);
}


// 运行全部已保存策略（无保存则回退当前策略）；结果走缓存
export function runAllStrategies() {
  return runSelectedStrategies(state.savedStrategies.length > 0 ? state.savedStrategies : [getCurrentStrategy()]);
}


export function showStrategyResults(){
  $('strategyResults').style.display = 'block';
  // sensitivityPanel 不再由此解锁 —— 它初始即显示(与单次模拟零依赖)
  drawStrategyMetrics();
  drawStrategyComparisonGantt();
  drawStrategyTierDemand();
}


export function simError(e){
  console.error('Simulation error:', e);
  $('strategyResults').style.display = 'block';
  $('strategyMetricsGrid').innerHTML = '<div style="color:var(--accent4);padding:8px">仿真出错: '+e.message+'</div>';
  // 不再隐藏 sensitivityPanel —— 单次模拟出错不该把独立的敏感性扫描入口也带走
}
