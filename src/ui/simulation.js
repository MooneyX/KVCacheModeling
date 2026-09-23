import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";

import { getCurrentStrategy } from "./strategy.js";
import { $ } from "../adapters/browser/dom.js";
import { drawGantt, drawStrategyMetrics, drawStrategyComparisonGantt, drawStrategyTierDemand } from "./charts.js";
import { executeSimulation, executeBatch, serverVersion } from '../execution/browser/client.ts';

const pending = new Map();
function cacheKey(params, strategy, overrides, mode, version) {
  return JSON.stringify([version, mode, params, strategy.dsl || strategy.name || '', overrides || null]);
}
function storeResult(key, result) {
  const keys = Object.keys(state.simCache);
  if (keys.length >= 30) delete state.simCache[keys[0]];
  state.simCache[key] = result;
}

let running = false;

async function runSelectedStrategies(list) {
  if (running || list.some(strategy => !strategy)) return;
  const params = getParams();
  const controls = Object.fromEntries(Array.from(document.querySelectorAll('input[id], select[id], textarea[id]'), el => [el.id, { value: el.value, checked: el.checked }]));
  const mode = state.strategyMode;
  const strategies = structuredClone(list);
  const buttons = document.querySelectorAll('button[onclick="applyStrategies()"], button[onclick="runAllStrategies()"]');
  running = true;
  buttons.forEach(button => { button.disabled = true; });
  setSimulationStatus('正在运行，保留最近一次成功结果…');
  try {
    if (mode === 'js') throw new Error('服务器暂不支持 JavaScript 策略，请选择 DSL。');
    const version = await serverVersion();
    const keys = strategies.map(strategy => cacheKey(params, strategy, null, mode, version));
    const results = keys.map(key => state.simCache[key]);
    const missing = strategies.map((strategy, index) => ({ strategy, index })).filter(({ index }) => !results[index]);
    if (missing.length) {
      await executeBatch(missing.map(({ strategy }) => ({ params, strategy, mode })), missing.length === 1 ? 'simulation' : 'batch', {
        label: strategies.length === 1 ? strategies[0].name : '全部已保存策略',
        onPoint: point => {
          const index = missing[point.index].index;
          results[index] = point.result;
          storeResult(keys[index], point.result);
        },
      });
    }
    state.simResults = results.map((result, index) => ({ ...result, name: strategies[index].name || result.name }));
    state.simInput = { params, controls, strategies, mode };
    setSimulationStatus('运行完成');
    showStrategyResults();
  } catch (error) {
    simError(error);
  } finally {
    running = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}


export async function cachedSimulation(strategy, overrides, params = getParams()) {
  const mode = state.strategyMode;
  if (mode === 'js') throw new Error('服务器暂不支持 JavaScript 策略，请选择 DSL。');
  const version = await serverVersion();
  const key = cacheKey(params, strategy, overrides, mode, version);
  if (state.simCache[key]) return state.simCache[key];
  if (!pending.has(key)) pending.set(key, executeSimulation({ params, strategy, overrides, mode })
    .then(result => { storeResult(key, result); return result; }).finally(() => pending.delete(key)));
  return pending.get(key);
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
  if (!state.simResults.length || $('tab-schedule').classList.contains('active')) {
    drawGantt(state.simResults[0], state.simInput);
  }
}

function setSimulationStatus(message, failed = false) {
  const el = $('simulationStatus');
  el.textContent = message;
  el.style.color = failed ? 'var(--accent4)' : 'var(--text-dim)';
}

export function simError(e){
  console.error('Simulation error:', e);
  setSimulationStatus('仿真出错: ' + e.message, true);
}
