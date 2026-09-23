import { getParams } from "../adapters/browser/params.js";
import { state } from "./state.js";

import { getCurrentStrategy } from "./strategy.js";
import { $ } from "../adapters/browser/dom.js";
import { drawGantt, refreshScheduleTab, drawStrategyMetrics, drawStrategyComparisonGantt, drawStrategyTierDemand } from "./charts.js";
import { executeSimulation, executeBatch, serverVersion } from '../execution/browser/client.ts';
import { createReplayJob, replaySelection, updateRunControls } from './replay.js';

const pending = new Map();
function cacheKey(params, strategy, overrides, mode, version) {
  return JSON.stringify([version, mode, params, strategy.dsl || strategy.name || '', overrides || null]);
}
function storeResult(key, result) {
  const keys = Object.keys(state.simCache);
  if (keys.length >= 30) delete state.simCache[keys[0]];
  state.simCache[key] = result;
}

function inputControls() {
  return Object.fromEntries(Array.from(document.querySelectorAll('#tab-params input[id], #tab-params select[id], #tab-params textarea[id]'))
    .filter(el => !el.closest('#sensitivityPanel') && !['paramsIo', 'replayFile', 'workloadSource', 'pPrefixHitNum'].includes(el.id))
    .map(el => [el.id, { value: el.value, checked: el.checked }]));
}

function inputKey(controls = inputControls()) {
  const inactive = state.workloadSource === 'replay' ? '#syntheticPanel' : '#replayPanel';
  const values = Object.fromEntries(Object.entries(controls).filter(([id]) => !$(id).closest(inactive)));
  return JSON.stringify([state.workloadSource, state.strategyMode, values, state.workloadSource === 'replay' ? replaySelection().generation : null]);
}

export function updateSimulationSnapshot() {
  const input = state.simInput, result = state.simResults[0];
  const label = $('simulationSnapshot'), dirty = $('simulationDirty');
  if (!label || !dirty) return;
  if (!input || !result) { label.textContent = '请先运行'; dirty.hidden = true; return; }
  const config = input.replayConfiguration || result.replay?.configuration;
  const source = result.replay ? '数据集 Replay' : '合成负载';
  const names = config ? config.strategy.name : input.strategies.map(strategy => strategy.name).join(' / ');
  label.textContent = `最近一次运行 · ${source} · 策略：${names} · ` + (config
    ? `QPS=${config.targetQps} · seed=${config.seed} · T/W/D=${config.durationSeconds}/${config.warmupSeconds}/${config.execution.simMaxTime}s · bundle=${config.bundleDigest}`
    : `请求数=${input.params.concurrency} · QPS=${input.params.qps} · seed=${input.params.seed}`)
    + (result.truncated ? ' · 已截断' : '');
  dirty.hidden = !input.inputKey || input.inputKey === inputKey();
}

export function initSimulationInputs() {
  document.addEventListener('simulation-input-change', updateSimulationSnapshot);
  for (const event of ['input', 'change', 'click']) {
    document.addEventListener(event, e => {
      if (e.target.closest('#tab-params')) queueMicrotask(updateSimulationSnapshot);
    });
  }
  $('replayDownload').addEventListener('click', downloadReplayResult);
}

async function runSelectedStrategies(list) {
  if (state.simRunning) return;
  state.simRunning = true;
  updateRunControls();
  setSimulationStatus('正在运行，保留最近一次成功结果…');
  try {
    const params = getParams();
    const controls = inputControls();
    const mode = state.strategyMode;
    const strategies = structuredClone(list);
    const workloadSource = state.workloadSource;
    const input = { params, controls, strategies, mode, workloadSource, inputKey: inputKey(controls) };
    let results;
    if (workloadSource === 'replay') {
      const job = createReplayJob(input);
      input.params = job.params;
      const { generation: _generation, ...fileSummary } = replaySelection();
      const result = await executeSimulation(job);
      if (!result.replay?.configuration || !result.replay?.windows?.measurement) throw new Error('服务器结果缺少 Replay 执行配置或测量窗口。');
      results = [result];
      input.replayConfiguration = structuredClone(result.replay.configuration);
      input.bundleSummary = { ...fileSummary, digest: result.replay.configuration.bundleDigest, ...result.replay.source };
    } else {
      if (mode === 'js') throw new Error('服务器暂不支持 JavaScript 策略，请选择 DSL。');
      if (strategies.some(strategy => !strategy)) throw new Error('当前 DSL 策略解析失败，请检查策略编辑器。');
      const version = await serverVersion();
      const keys = strategies.map(strategy => cacheKey(params, strategy, null, mode, version));
      results = keys.map(key => state.simCache[key]);
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
      results = results.map((result, index) => ({ ...result, name: strategies[index].name || result.name }));
    }
    Object.assign(state, { simResults: results, simInput: input });
    setSimulationStatus(results[0]?.truncated ? '运行完成：已截断，请查看终止原因和未完成计数。' : '运行完成');
    showStrategyResults();
  } catch (error) {
    simError(error);
  } finally {
    state.simRunning = false;
    updateRunControls();
    updateSimulationSnapshot();
  }
}


export async function cachedSimulation(strategy, overrides, params = getParams()) {
  const mode = state.strategyMode;
  if (mode === 'js') throw new Error('服务器暂不支持 JavaScript 策略，请选择 DSL。');
  if (overrides?.replay) return executeSimulation(structuredClone({ params, strategy, overrides, mode }));
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
  if (state.simRunning) return;
  if (state.workloadSource === 'replay') {
    setSimulationStatus('Replay 仅支持单策略 simulation 任务，请使用运行当前策略。', true);
    return;
  }
  return runSelectedStrategies(state.savedStrategies.length > 0 ? state.savedStrategies : [getCurrentStrategy()]);
}


export function showStrategyResults(){
  $('strategyResults').style.display = 'block';
  updateSimulationSnapshot();
  renderReplayResult();
  // sensitivityPanel 不再由此解锁 —— 它初始即显示(与单次模拟零依赖)
  drawStrategyMetrics();
  drawStrategyComparisonGantt();
  drawStrategyTierDemand();
  if ($('tab-schedule').classList.contains('active')) {
    refreshScheduleTab();
  } else if (!state.simResults.length) {
    drawGantt(state.simResults[0], state.simInput);
  }
}

function display(value) {
  if (value === null || value === undefined) return '无样本';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(3);
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
  }
  return String(value);
}

function section(parent, title, rows) {
  const heading = document.createElement('h3');
  heading.textContent = title;
  parent.append(heading);
  const list = document.createElement('dl');
  list.style.cssText = 'display:grid;grid-template-columns:minmax(150px,1fr) 2fr;gap:6px 16px;overflow-wrap:anywhere;margin:12px 0 20px';
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.style.margin = '0';
    description.textContent = display(value);
    list.append(term, description);
  }
  parent.append(list);
}

function details(parent, title, value) {
  const container = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = title;
  const content = document.createElement('pre');
  content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto';
  content.textContent = JSON.stringify(value, (_key, item) => item === null ? '无样本' : item, 2);
  container.append(heading, content);
  parent.append(container);
}

function renderReplayResult() {
  const report = state.simInput && state.simResults[0]?.replay;
  const parent = $('replaySummary');
  $('replayDownload').disabled = !report;
  parent.replaceChildren();
  parent.hidden = !report;
  if (!report) return;
  const { configuration: config, source, counts, state: status, samples } = report;
  const measurement = report.windows.measurement;
  section(parent, '本次实际执行配置', [
    ['bundle 摘要', config.bundleDigest], ['目标 QPS', config.targetQps], ['seed', config.seed],
    ['投放时长 T（秒）', config.durationSeconds], ['暖机时长 W（秒）', config.warmupSeconds],
    ['排空上限 D（秒）', config.execution.simMaxTime], ['硬截止 T+D（秒）', config.hardCutoff],
    ['策略', config.strategy.name], ['GPU 张数 / 计算实例数', `${config.execution.gpus} / ${config.execution.instances}`],
    ['物理页 token 数', config.blockMapping.physical], ['输出身份', config.outputIdentity],
  ]);
  section(parent, '模板池与实际投放（投放不等于全池一遍）', [
    ['模板数', source.sessions], ['模板池请求数', source.requests], ['模板池输入 token', source.inputTokens], ['模板池输出 token', source.outputTokens],
    ['投放 session 数', counts.launchedSessions], ['完整圈数', counts.completeCycles], ['已完成 session 数', counts.completedSessions],
    ['已投放请求数', counts.planned], ['成功请求', counts.successful], ['失败请求', counts.failed], ['取消请求', counts.cancelled], ['未完成请求', counts.unfinished],
  ]);
  section(parent, '主报告：measurement 测量窗口', [
    ['窗口起止（秒）', `[${display(measurement.start)}, ${display(measurement.end)})`], ['窗口时长（秒）', measurement.durationSeconds],
    ['到达 QPS', measurement.arrivalQps], ['完成 QPS', measurement.completionQps],
  ]);
  const note = document.createElement('p');
  note.textContent = '延迟仅统计成功请求，按到达所属窗口归属；无样本不等于 0。';
  parent.append(note);
  for (const [label, key] of [['TTFT', 'ttft'], ['TPOT', 'tpot'], ['端到端延迟', 'endToEnd']]) {
    const latency = measurement.latency[key];
    section(parent, `${label}（${key === 'tpot' ? 'ms/token' : 'ms'}）`, [['样本数', latency.count], ['平均', latency.mean], ['P50', latency.p50], ['P99', latency.p99]]);
  }
  const cache = measurement.cache;
  section(parent, '测量窗口缓存', [
    ['输入 token', cache.inputTokens], ['L1 命中 token', cache.hitL1Tokens], ['L2 命中 token', cache.hitL2Tokens],
    ['L3 命中 token', cache.hitL3Tokens], ['miss token', cache.missTokens], ['命中率', cache.hitRate == null ? null : `${display(cache.hitRate * 100)}%`],
  ]);
  section(parent, '运行状态与采样覆盖', [
    ['截断', status.truncated], ['终止原因', status.terminationReason], ['支持范围', status.supportedScope],
    ['完成依赖', status.completionDependencies], ['稳定性 / 理想缓存', `${status.stability} / ${status.idealCache}`],
    ['采样覆盖（秒）', samples.coverage.map(display).join(' – ')], ['采样桶宽（秒）', samples.bucketWidth], ['时间序列桶数', samples.series.length],
    ['请求采样 / 总数', `${samples.requestCoverage.sampled} / ${samples.requestCoverage.total}`], ['请求采样完整', samples.requestCoverage.complete],
    ['投放采样 / 总数', `${samples.launchCoverage.sampled} / ${samples.launchCoverage.total}`], ['投放采样完整', samples.launchCoverage.complete],
  ]);
  details(parent, '有效运行限额', status.limits);
  details(parent, '完整执行配置（模型、硬件及策略快照）', config);
  details(parent, '完整计数与状态', { source, counts, state: status });
}

function downloadReplayResult() {
  const result = state.simResults[0];
  if (!state.simInput || !result?.replay) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `replay-result-seed-${result.replay.configuration.seed}.json`;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
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
