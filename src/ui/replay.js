import { state } from './state.js';
import { REPLAY_SWEEP_PARAMETERS } from '../application/sweep.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const parameterIds = ['replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain'];
let bundle = null;
let fileSummary = null;
let reading = false;
let generation = 0;
let initialized = false;
let onInputChanged = () => {};
const element = id => document.getElementById(id);

export function replaySelection() {
  return { generation, ...fileSummary };
}

const analysisRestriction = 'Replay 使用固定 bundle、seed 和投放窗口；支持目标 QPS、batch、硬件、分层淘汰与四档预取，不支持合成生成维度。每次提交新任务，不复用结果缓存。';
let expectedBundleSummary = null;
const inputsBusy = () => state.simRunning || state.sensitivityRunning || state.crossRunning;

export function replayControls() {
  return Object.fromEntries(parameterIds.map(id => [id, { value: element(id).value }]));
}

export function allowSyntheticAnalysis(statusId) {
  const message = state.workloadSource !== 'replay' ? '' : reading || !bundle ? '请先选择并完成读取 Replay bundle。' : state.strategyMode !== 'dsl' ? 'Replay 仅支持 DSL 策略。' : '';
  const note = element(statusId);
  if (note && message) { note.textContent = message; note.hidden = false; note.dataset.analysisRestriction = message; }
  else if (note?.dataset.analysisRestriction) {
    if (note.textContent === note.dataset.analysisRestriction) { note.textContent = ''; note.hidden = true; }
    delete note.dataset.analysisRestriction;
  }
  return !message;
}

export function updateRunControls() {
  const running = inputsBusy();
  const replay = state.workloadSource === 'replay';
  element('workloadSource').disabled = running;
  element('replayFile').disabled = running;
  for (const id of parameterIds) element(id).disabled = running;
  for (const [handler, busy] of [['applyStrategies', state.simRunning], ['runAllStrategies', state.simRunning], ['runSensitivity', state.sensitivityRunning], ['runCrossAnalysis', state.crossRunning]]) {
    document.querySelectorAll(`button[onclick="${handler}()"]`).forEach(button => {
      button.disabled = busy || (replay && (reading || !bundle || state.strategyMode !== 'dsl'));
      if (button.dataset.syntheticTitle === undefined) button.dataset.syntheticTitle = button.title;
      button.title = replay ? analysisRestriction : button.dataset.syntheticTitle;
    });
  }
  for (const id of ['sSweepParam', 'sSweepCompareParam', 'sShapeDim']) {
    const select = element(id);
    if (!select) continue;
    for (const option of select.options) option.disabled = replay && !!option.value && !REPLAY_SWEEP_PARAMETERS.includes(option.value);
  }
  const metrics = element('sSweepMetric');
  if (metrics) {
    for (const option of metrics.options) if (option.value.startsWith('measurement_')) option.disabled = !replay;
    if (!replay && metrics.value.startsWith('measurement_')) metrics.value = 'hit_rate';
  }
  const note = element('simulationModeNote');
  if (note) { note.hidden = !replay; note.textContent = replay ? analysisRestriction : ''; }
  element('replayPanel').setAttribute('aria-busy', String(running || reading));
}

function numberValue(controls, id, label) {
  const raw = controls[id].value.trim();
  if (!raw) throw new Error(`${label}不能为空。`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}必须为有限数。`);
  return value;
}

export function createReplayJob({ params, controls, strategies, mode }) {
  if (reading || !bundle) throw new Error('请先选择并完成读取 Replay bundle。');
  if (mode !== 'dsl') throw new Error('Replay 仅支持 DSL 策略，请先切换策略模式。');
  if (!strategies.length || strategies.some(strategy => !strategy)) throw new Error('请选择有效的 DSL 策略。');
  const qps = numberValue(controls, 'replayQps', '目标 QPS');
  const seed = numberValue(controls, 'replaySeed', 'seed');
  const durationSeconds = numberValue(controls, 'replayDuration', '投放时长 T');
  const warmupSeconds = numberValue(controls, 'replayWarmup', '暖机时长 W');
  const simMaxTime = numberValue(controls, 'replayDrain', '排空上限 D');
  if (qps <= 0) throw new Error('目标 QPS 必须大于 0。');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed 必须为 uint32 整数（0–4294967295）。');
  if (durationSeconds <= 0) throw new Error('投放时长 T 必须大于 0。');
  if (warmupSeconds < 0 || warmupSeconds >= durationSeconds) throw new Error('暖机时长 W 必须满足 0 ≤ W < T。');
  if (simMaxTime < 0) throw new Error('排空上限 D 必须大于等于 0。');
  const blockSize = params.blockSize;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || (64 % blockSize !== 0 && blockSize % 64 !== 0)) throw new Error('Replay 页大小必须是 64 的正整数因子或倍数。');
  if (params.instances > 1 && params.pdMode === 2) throw new Error('多实例与物理 P/D 分离不能同时启用。');
  const replayParams = { ...params, qps, seed, simMaxTime,
    concurrency: 1, inputLen: 0, outputLen: 0, lenDist: 'fixed', arrivalDist: 'poisson',
    multiTurn: 0, prefixHit: 0, prefixWarm: false, prefixWarmL2: 0, singleBatch: false,
  };
  return structuredClone({ params: replayParams, strategy: strategies[0], mode, overrides: {
    qps, seed, simMaxTime,
    replay: { bundle, options: { durationSeconds, warmupSeconds, arrivalModel: 'closed', superblocks: false } },
  } });
}

export function getReplayWorkloadConfig() {
  if (state.workloadSource !== 'replay') return { source: 'synthetic' };
  const controls = replayControls();
  return {
    source: 'replay',
    options: {
      qps: numberValue(controls, 'replayQps', '目标 QPS'), seed: numberValue(controls, 'replaySeed', 'seed'),
      durationSeconds: numberValue(controls, 'replayDuration', '投放时长 T'),
      warmupSeconds: numberValue(controls, 'replayWarmup', '暖机时长 W'),
      simMaxTime: numberValue(controls, 'replayDrain', '排空上限 D'), arrivalModel: 'closed', superblocks: false,
    },
    bundleSummary: structuredClone(fileSummary || expectedBundleSummary),
  };
}

export function validateReplayWorkloadConfig(workload) {
  if (workload == null) return { source: 'synthetic' };
  if (!workload || typeof workload !== 'object' || Array.isArray(workload) || !['synthetic', 'replay'].includes(workload.source)) throw new Error('workload.source 必须为 synthetic 或 replay。');
  if (workload.source === 'synthetic') return { source: 'synthetic' };
  const options = workload.options;
  if (!options || ['qps', 'seed', 'durationSeconds', 'warmupSeconds', 'simMaxTime'].some(key => typeof options[key] !== 'number' || !Number.isFinite(options[key]))) throw new Error('Replay 配置缺少有效的投放参数。');
  if (options.qps <= 0 || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff || options.durationSeconds <= 0 || options.warmupSeconds < 0 || options.warmupSeconds >= options.durationSeconds || options.simMaxTime < 0) throw new Error('Replay 配置的 QPS、seed 或 T/W/D 不合法。');
  if (options.arrivalModel !== 'closed' || options.superblocks !== false) throw new Error('Replay 仅支持 closed 到达模型且关闭超级块。');
  if (!/^[a-f0-9]{64}$/.test(workload.bundleSummary?.digest || '')) throw new Error('Replay 配置必须包含有效的 bundle SHA-256 摘要，请先选择 bundle。');
  return structuredClone({ source: 'replay', options, bundleSummary: workload.bundleSummary });
}

export function applyReplayWorkloadConfig(workload) {
  if (inputsBusy()) throw new Error('任务运行期间不能导入负载配置。');
  const config = validateReplayWorkloadConfig(workload);
  ++generation;
  bundle = null; fileSummary = null; reading = false;
  expectedBundleSummary = config.source === 'replay' ? config.bundleSummary : null;
  element('replayFile').value = '';
  state.workloadSource = config.source;
  element('workloadSource').value = config.source;
  element('syntheticPanel').hidden = config.source !== 'synthetic';
  element('replayPanel').hidden = config.source !== 'replay';
  if (config.source === 'replay') {
    for (const [id, key] of [['replayQps', 'qps'], ['replaySeed', 'seed'], ['replayDuration', 'durationSeconds'], ['replayWarmup', 'warmupSeconds'], ['replayDrain', 'simMaxTime']]) element(id).value = String(config.options[key]);
  }
  element('replayFileInfo').textContent = expectedBundleSummary ? `请重选 bundle，期望 SHA-256：${expectedBundleSummary.digest}` : '尚未选择文件；可选择仓库 data/replay/sample.json。';
  element('replayStatus').textContent = expectedBundleSummary ? '已导入实验设置；重选并核验 bundle 后才可运行，配置不包含原始数据。' : '请选择 Replay bundle。';
  updateRunControls();
  onInputChanged();
}

function basicBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== 1 || value.blockSize !== 64 || !Array.isArray(value.sessions) || !value.sessions.length
      || value.sessions.some(session => !session || !Array.isArray(session.req) || !session.req.length)) {
    throw new Error('请选择已构建的 bundle v1（version=1、blockSize=64、非空 sessions/req），不是原始 trace、报告或配置文件。');
  }
  return value;
}

async function selectFile() {
  if (inputsBusy()) return;
  const current = ++generation;
  bundle = null;
  fileSummary = null;
  reading = false;
  updateRunControls();
  onInputChanged();
  const files = element('replayFile').files;
  const file = files?.[0];
  if (!file) {
    element('replayFileInfo').textContent = '尚未选择文件；可选择仓库 data/replay/sample.json。';
    element('replayStatus').textContent = '请选择 Replay bundle。';
    return;
  }
  element('replayFileInfo').textContent = `${file.name} · ${file.size.toLocaleString()} 字节`;
  try {
    if (files.length !== 1 || !/\.json$/i.test(file.name)) throw new Error('只接受一个 .json bundle 文件。');
    if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 8 MiB 读取上限；请选择小型 bundle。');
    reading = true;
    updateRunControls();
    element('replayStatus').textContent = '正在读取并检查 bundle…';
    const bytes = await file.arrayBuffer();
    if (current !== generation) return;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('文件不是有效的 JSON。'); }
    basicBundle(parsed);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parsed)));
    if (current !== generation) return;
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (expectedBundleSummary && expectedBundleSummary.digest !== digest) throw new Error('bundle 摘要与导入配置不一致，请重选原 bundle；如需新实验请先导入合成配置以清除校验要求。');
    bundle = parsed;
    fileSummary = { name: file.name, sizeBytes: file.size, digest, version: parsed.version, blockSize: parsed.blockSize };
    element('replayStatus').textContent = '文件已就绪；完整字段、RLE、锚点和资源量由服务器校验。可运行当前/全部策略、扫描或交叉分析。';
  } catch (error) {
    if (current !== generation) return;
    bundle = null;
    element('replayStatus').textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (current === generation) { reading = false; updateRunControls(); onInputChanged(); }
  }
}

export function initReplay(inputChanged) {
  if (initialized || !element('replayPanel')) return;
  initialized = true;
  onInputChanged = inputChanged || onInputChanged;
  for (const [target, source] of [['replayQps', 'pQps'], ['replaySeed', 'pSeed']]) element(target).value = element(source).value;
  element('workloadSource').addEventListener('change', () => {
    if (inputsBusy()) { element('workloadSource').value = state.workloadSource; return; }
    state.workloadSource = element('workloadSource').value === 'replay' ? 'replay' : 'synthetic';
    element('syntheticPanel').hidden = state.workloadSource !== 'synthetic';
    element('replayPanel').hidden = state.workloadSource !== 'replay';
    updateRunControls();
    onInputChanged();
  });
  element('replayFile').addEventListener('change', selectFile);
  for (const id of parameterIds) {
    const changed = () => {
      if (inputsBusy()) return;
      element('replayStatus').textContent = bundle ? '参数已变更，请重新运行。' : '请选择 Replay bundle。';
      onInputChanged();
    };
    element(id).addEventListener('input', changed);
    element(id).addEventListener('change', changed);
  }
  updateRunControls();
}
